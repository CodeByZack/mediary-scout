#!/usr/bin/env node
// One live notification through the REAL pipeline (sendPushNotifications →
// dispatchNotifications → buildNotifyMessage → channels), using a real tracked
// title's poster + the user's configured Server酱 sendkey (read from the DB).
// Proves the new L2 format renders for real. Sends ONE message; no DB writes.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function loadDotEnv(p) { let raw; try { raw = readFileSync(p, "utf8"); } catch { return; }
  for (const line of raw.split("\n")) { const t = line.trim(); if (!t || t.startsWith("#")) continue; const eq = t.indexOf("="); if (eq === -1) continue; const k = t.slice(0, eq).trim(); let v = t.slice(eq + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (process.env[k] === undefined) process.env[k] = v; } }
loadDotEnv(path.join(repoRoot, ".env"));

const { createSqliteWorkflowRepository, buildMovieReport, formatReportPushText, buildNotifyMessage, sendPushNotifications } =
  await import(path.join(repoRoot, "packages/workflow/dist/index.js"));
const SQLITE_PATH = process.env.MEDIA_TRACK_SQLITE_PATH || "/data/mediary.db";
const repo = createSqliteWorkflowRepository({ path: SQLITE_PATH });

// 热辣滚烫 — real tracked movie, real TMDB poster.
const report = buildMovieReport("热辣滚烫", "2160p", {
  posterPath: "/fI5BIp48yERyYhu7O6XlDT4puSZ.jpg",
  tmdbId: 1229349,
  mediaType: "movie",
  year: 2024,
});
const notification = {
  id: `notiftest_${Date.now()}`,
  workflowRunId: "notiftest",
  kind: "movie_init",
  title: report.titleName,
  body: formatReportPushText(report),
  createdAt: new Date().toISOString(),
  trigger: "user",
  report,
};

console.log("--- the Server酱 desp that will be sent ---\n" + buildNotifyMessage(report).markdown + "\n");
const sentTo = await sendPushNotifications({ repository: repo, notification });
console.log("sent to channels:", sentTo.length ? sentTo.join(", ") : "(none configured — check push_serverchan in app_settings)");
process.exit(0);
