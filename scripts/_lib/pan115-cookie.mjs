// Shared probe-script helper: load .env and pull the live 115 cookie from
// SQLite (app_settings key "pan115.cookie"), then set process.env.PAN115_COOKIE.
// (The project is SQLite-only; the Postgres-backed reader was removed.)
// Returns the cookie string (also sets the env var).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Database from "better-sqlite3";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function loadDotEnv(envPath = path.join(repoRoot, ".env")) {
  let raw;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[t.slice(0, i).trim()] === undefined) process.env[t.slice(0, i).trim()] = v;
  }
}

export async function loadPan115Cookie() {
  loadDotEnv();
  const dbPath = process.env.MEDIA_TRACK_SQLITE_PATH?.trim();
  if (!dbPath) {
    throw new Error("MEDIA_TRACK_SQLITE_PATH is required (the project is SQLite-only)");
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get("pan115.cookie");
    const cookie = row?.value;
    if (!cookie) {
      throw new Error("No pan115.cookie in SQLite app_settings — is the 115 account scanned/connected?");
    }
    process.env.PAN115_COOKIE = String(cookie);
    return String(cookie);
  } finally {
    db.close();
  }
}
