#!/usr/bin/env node
/**
 * deploy.mjs — One-command deployment for tmdb-proxy.
 *
 * Usage:
 *   cp deploy.config.example.json deploy.config.json
 *   # Edit deploy.config.json with your tokens
 *   node deploy.mjs
 *
 * Requires: wrangler (npm i -g wrangler), logged in (wrangler login)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "deploy.config.json");
const WRANGLER_CONFIG = join(__dirname, "wrangler.jsonc");

// ── Read config ──────────────────────────────────────────────────────────

let cfgText;
try {
  cfgText = readFileSync(CONFIG_PATH, "utf8");
} catch {
  console.error("❌ deploy.config.json not found.");
  console.error("   cp deploy.config.example.json deploy.config.json");
  console.error("   Edit it with your tokens, then run again.");
  process.exit(1);
}

const cfg = JSON.parse(cfgText);
const { workerName, tmdbToken, corsOrigins, customDomain, kvNamespace, storeSecret = true, cfApiToken } = cfg;

if (!workerName) { console.error("❌ workerName is required"); process.exit(1); }

// Use CF API token if provided (optional — browser login also works)
if (cfApiToken) {
  process.env.CLOUDFLARE_API_TOKEN = cfApiToken;
  console.log("🔑 CF API token loaded from config");
} else if (process.env.CLOUDFLARE_API_TOKEN) {
  console.log("🔑 CF API token loaded from environment");
}

const cfgArg = "--config " + WRANGLER_CONFIG;

// ── Check wrangler ───────────────────────────────────────────────────────

console.log("\n🔧 Checking wrangler...");
try {
  execSync("npx wrangler --version", { stdio: "pipe" });
} catch {
  console.error("❌ wrangler not found. Install: npm i -g wrangler (or run with npx)");
  process.exit(1);
}

console.log("🔑 Checking login status...");
let loggedIn = false;
try {
  const out = execSync("npx wrangler whoami", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  // "not authenticated" contains "authenticated" so check for the negative first
  if (out.toLowerCase().includes("not authenticated") || out.toLowerCase().includes("please run")) {
    console.log("\n❌ Not logged in.");
    console.log("   Run this first, then retry:");
    console.log("   npx wrangler login");
    process.exit(1);
  }
  if (out.includes("Account ID") || out.toLowerCase().includes("logged in")) {
    loggedIn = true;
    console.log("✅ Logged in");
  } else {
    console.log("\n❌ Could not verify login status.");
    console.log("   Run this first, then retry:");
    console.log("   npx wrangler login");
    process.exit(1);
  }
} catch {
  console.log("\n❌ Not logged in.");
  console.log("   Run this first, then retry:");
  console.log("   npx wrangler login");
  process.exit(1);
}

// ── Step 1: KV namespace ─────────────────────────────────────────────────

let kvId;
console.log(`\n📦 Creating KV namespace: ${kvNamespace}...`);
try {
  const out = execSync(`npx wrangler kv namespace create ${kvNamespace} ${cfgArg}`, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const match = out.match(/Namespace id:\s*([a-f0-9]+)/i);
  if (!match) throw new Error("Could not parse namespace id from: " + out);
  kvId = match[1];
  console.log(`✅ KV namespace created: ${kvId}`);
} catch (e) {
  // Namespace might already exist — list and find it
  console.log(`⚠️  Create failed, listing existing namespaces...`);
  try {
    const out = execSync(`npx wrangler kv namespace list ${cfgArg}`, { encoding: "utf8" });
    console.log("Existing namespaces:");
    console.log(out);
    // Try JSON parsing first (wrangler outputs JSON)
    let namespaces = [];
    try {
      namespaces = JSON.parse(out);
    } catch {
      // Not JSON — try line-by-line
    }
    if (namespaces.length > 0) {
      const ns = namespaces.find(n => n.title === kvNamespace || n.id === kvNamespace);
      if (ns) {
        kvId = ns.id;
        console.log(`✅ Found existing namespace: ${kvId}`);
      }
    }
    // Fallback: line-by-line search for hex id near the namespace name
    if (!kvId) {
      const lines = out.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(kvNamespace)) {
          // Look at this line and the next few for an id
          for (let j = Math.max(0, i - 2); j < Math.min(lines.length, i + 3); j++) {
            const match = lines[j].match(/"id":\s*"([a-f0-9]{32})"/);
            if (match) {
              kvId = match[1];
              console.log(`✅ Found existing namespace: ${kvId}`);
              break;
            }
          }
          if (kvId) break;
        }
      }
    }
  } catch (listErr) {
    console.error("List also failed:", listErr.message);
  }
  if (!kvId) {
    console.error("\n❌ Could not find or create KV namespace.");
    console.error("   Manual steps:");
    console.error(`   1. npx wrangler kv namespace list ${cfgArg}`);
    console.error("   2. Find the id for your namespace");
    console.error("   3. Set it in wrangler.jsonc manually");
    process.exit(1);
  }
}

// ── Step 2: Generate wrangler.jsonc ───────────────────────────────────────

console.log(`\n✏️  Generating wrangler.jsonc...`);

// Build the config object
const config = {
  name: workerName,
  main: "src/index.ts",
  compatibility_date: "2026-06-01",
  workers_dev: true,
  kv_namespaces: [
    { binding: "TMDB_CACHE", id: kvId }
  ],
  triggers: {
    crons: ["0 22 * * *"]
  }
};

// Add routes if custom domain
if (customDomain) {
  config.routes = [{ pattern: customDomain, custom_domain: true }];
}

// Write as pretty JSON (with comments stripped)
const jsonc = JSON.stringify(config, null, 2) + "\n";
writeFileSync(WRANGLER_CONFIG, jsonc);
console.log(`✅ wrangler.jsonc generated (name: ${workerName}, kv: ${kvId})`);

// ── Step 3: Set secrets ──────────────────────────────────────────────────

function setSecret(name, value) {
  return new Promise((resolve) => {
    const child = spawn("npx", ["wrangler", "secret", "put", name, cfgArg], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.write(value);
    child.stdin.end();
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => {
      if (code === 0) console.log(`✅ Secret ${name} set`);
      else console.error(`❌ Failed to set secret ${name}:`, out);
      resolve();
    });
  });
}

if (tmdbToken && storeSecret) {
  await setSecret("TMDB_READ_TOKEN", tmdbToken);
} else if (tmdbToken && !storeSecret) {
  console.log("⏭️  TMDB_READ_TOKEN skipped (storeSecret: false, token used for test only)");
} else {
  console.log("⏭️  TMDB_READ_TOKEN skipped (will use Authorization header)");
}

if (corsOrigins) {
  await setSecret("CORS_ALLOWED_ORIGINS", corsOrigins);
}

// ── Step 4: Deploy ───────────────────────────────────────────────────────

let deployOut;
try {
  deployOut = execSync(`npx wrangler deploy ${cfgArg}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  console.log(deployOut);
  console.log("\n✅ Deployment complete!");
} catch (e) {
  console.error("\n❌ Deployment failed:", e.message);
  process.exit(1);
}

// ── Step 5: Verify ───────────────────────────────────────────────────────

// Extract Worker URL from deploy output
let workerUrl = null;
const urlMatch = deployOut.match(/https:\/\/[^\s]+\.workers\.dev/);
if (urlMatch) workerUrl = urlMatch[0];
else if (customDomain) workerUrl = `https://${customDomain}`;

if (!workerUrl) {
  console.log("\n⚠️  Could not determine Worker URL. Test manually with wrangler output.");
  process.exit(0);
}

console.log(`\n🔍 Verifying deployment...`);
console.log(`  URL: ${workerUrl}\n`);

function curlStatus(url, headers = {}) {
  const headerStr = Object.entries(headers).map(([k, v]) => `-H "${k}: ${v}"`).join(" ");
  try {
    return execSync(`curl -s -o /dev/null -w "%{http_code}" ${headerStr} "${url}"`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return "000";
  }
}

const testUrl = `${workerUrl}/movie/278?language=zh-CN`;

// Test 1: No token → should be 401
const noTokenStatus = curlStatus(testUrl);
console.log(`  ${noTokenStatus === "401" ? "✅" : "❌"} No token → ${noTokenStatus} (expect 401)`);

// Test 2: With token → should be 200
if (tmdbToken) {
  const withTokenStatus = curlStatus(testUrl, { Authorization: `Bearer ${tmdbToken}` });
  console.log(`  ${withTokenStatus === "200" ? "✅" : "❌"} With token → ${withTokenStatus} (expect 200)`);
} else {
  console.log(`  ⏭️  With token → skipped (no tmdbToken in config)`);
}

// Test 3: Disallowed path → should be 404
const badPathStatus = curlStatus(`${workerUrl}/account/x`, tmdbToken ? { Authorization: `Bearer ${tmdbToken}` } : {});
console.log(`  ${badPathStatus === "404" ? "✅" : "❌"} Disallowed path → ${badPathStatus} (expect 404)`);

console.log("\n✅ All done!");
console.log("   Worker URL:", workerUrl);
console.log("\n💡 Tips:");
console.log("   npx wrangler login   - Login with Cloudflare");
console.log("   npx wrangler logout  - Logout");
console.log("   npx wrangler whoami  - Check current account");
