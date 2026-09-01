#!/usr/bin/env node
// 重置地球超新鲜 S02E19/E20 假入库(2026-08-31 run eaade691 由 AI 假映射 mark)
// 用法: node reset-ep19-ep20.cjs <线上db路径>
// 自动探测 better-sqlite3(本脚本不假设 node_modules 位置):
//   1. 环境变量 MEDIARY_BS3_PATH(可显式指定)
//   2. fpk 应用可能位置(server/node_modules、app/server/node_modules、根 node_modules)
//   3. 当前脚本同层 node_modules(仓库开发环境)
// 全部失败 → 打印候选清单退出,不瞎猜。

const fs = require('node:fs');
const path = require('node:path');
const dbPath = process.argv[2] || '/vol1/@appdata/mediary-scout/mediary.db';
const candidates = [
  process.env.MEDIARY_BS3_PATH,
  '/vol1/@appdata/mediary-scout/server/node_modules/better-sqlite3',
  '/vol1/@appdata/mediary-scout/app/server/node_modules/better-sqlite3',
  '/vol1/@appdata/mediary-scout/node_modules/better-sqlite3',
  '/vol1/@appdata/deepseek_harness/profiles/home/mediary-scout/node_modules/better-sqlite3',
].filter(Boolean);
let Database = null;
for (const c of candidates) {
  try { if (fs.existsSync(path.join(c, 'package.json'))) { Database = require(c); break; } } catch {}
}
if (!Database) {
  console.error('找不到 better-sqlite3。试过的候选路径:');
  candidates.forEach((c) => console.error('  - ' + c));
  console.error('请设置 MEDIARY_BS3_PATH 指向 fpk 应用内置的 better-sqlite3 目录后重试。');
  process.exit(1);
}
if (!fs.existsSync(dbPath)) { console.error('DB 不存在: ' + dbPath); process.exit(1); }
const db = new Database(dbPath, { fileMustExist: true });
const codes = ['S02E19', 'S02E20'];
const sel = db.prepare("SELECT episode_code, payload FROM episode_states WHERE tracked_season_id = 'tmdb_tv_296202_s2' AND episode_code IN (?, ?)");
const upd = db.prepare("UPDATE episode_states SET payload = json_set(payload, '$.obtained', json('false'), '$.verifiedFileIds', json('[]')) WHERE tracked_season_id = 'tmdb_tv_296202_s2' AND episode_code = ?");
const before = codes.map((c) => { const row = sel.get(c, codes[1]); return row ? [c, JSON.parse(row.payload).obtained] : [c, 'NOT FOUND']; });
console.log('重置前:', JSON.stringify(before));
const tx = db.transaction(() => { for (const c of codes) upd.run(c); });
tx();
const after = codes.map((c) => { const row = sel.get(c, codes[1]); return row ? [c, JSON.parse(row.payload).obtained, JSON.parse(row.payload).verifiedFileIds] : [c, 'NOT FOUND']; });
console.log('重置后:', JSON.stringify(after));
// ★ 季级 status 回滚:假入库把季抬成 completed → 巡检直接跳过(worker.ts 514 行
//   status !== 'active' continue)。completed 永不回退,必须手动改回 active 才能
//   让巡检重新把 E19/E20 当缺集获取。幂等:当前已是 active 则不动。
const seasonRow = db.prepare("SELECT payload FROM tracked_seasons WHERE id = 'tmdb_tv_296202_s2'").get();
if (seasonRow) {
  const sp = JSON.parse(seasonRow.payload);
  if (sp.status !== 'active') {
    sp.status = 'active';
    db.prepare("UPDATE tracked_seasons SET payload = ? WHERE id = 'tmdb_tv_296202_s2'").run(JSON.stringify(sp));
    console.log('季级: tmdb_tv_296202_s2 status completed → active(巡检恢复参与)');
  } else {
    console.log('季级: tmdb_tv_296202_s2 已是 active(无需回滚)');
  }
}
console.log('OK: S02E19/E20 已恢复为缺集,季已回到 active(下次巡检会重新尝试获取)');
console.log('注: 若 Season 目录里有误归位的 地球超新鲜.S02E19/S02E20.* 文件,请手动删掉/改回原名。');
db.close();
