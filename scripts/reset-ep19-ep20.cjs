#!/usr/bin/env node
// 地球超新鲜 S02E19/E20 假入库重置 —— 零依赖版(用 Node 24 内置 node:sqlite,无需 better-sqlite3)
// 用法: node reset-ep19-ep20.cjs [线上db路径]
// 默认路径: /vol1/@appdata/mediary-scout/mediary.db
// 干的事:
//   1) 诊断: 打印季 status、E19/E20 当前 obtained/verifiedFileIds
//   2) 重置集级: S02E19/E20 → obtained=false, verifiedFileIds=[]
//   3) 回滚季级: status completed → active(否则巡检跳过该季)
//   4) 列出线上全部季 status,方便你核对扫描范围

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');

const dbPath = process.argv[2] || '/vol1/@appdata/mediary-scout/mediary.db';
if (!fs.existsSync(dbPath)) { console.error('DB 不存在: ' + dbPath); process.exit(1); }

const db = new DatabaseSync(dbPath, { fileMustExist: true });
const SEASON_ID = 'tmdb_tv_296202_s2';
const CODES = ['S02E19', 'S02E20'];

console.log('=== 1. 诊断 ===');
const seasonRow = db.prepare("SELECT payload FROM tracked_seasons WHERE id = ?").get(SEASON_ID);
if (!seasonRow) {
  console.error('季不存在: ' + SEASON_ID);
  db.close();
  process.exit(1);
}
const sp = JSON.parse(seasonRow.payload);
console.log('季 status:', sp.status, '| totalEpisodes:', sp.totalEpisodes, '| latestAired:', sp.latestAiredEpisode);
for (const c of CODES) {
  const r = db.prepare("SELECT payload FROM episode_states WHERE tracked_season_id = ? AND episode_code = ?").get(SEASON_ID, c);
  if (!r) { console.log(c + ': NOT FOUND'); continue; }
  const p = JSON.parse(r.payload);
  console.log(c + ': obtained=' + p.obtained + ' verifiedFileIds=' + JSON.stringify(p.verifiedFileIds));
}

console.log('\n=== 2. 重置集级 ===');
const updEp = db.prepare("UPDATE episode_states SET payload = json_set(payload, '$.obtained', json('false'), '$.verifiedFileIds', json('[]')) WHERE tracked_season_id = ? AND episode_code = ?");
for (const c of CODES) {
  updEp.run(SEASON_ID, c);
  console.log('重置 ' + c + ' → obtained=false, verifiedFileIds=[]');
}

console.log('\n=== 3. 回滚季级 ===');
if (sp.status !== 'active') {
  sp.status = 'active';
  db.prepare("UPDATE tracked_seasons SET payload = ? WHERE id = ?").run(JSON.stringify(sp), SEASON_ID);
  console.log('季 status: ' + sp.status + ' → active(巡检恢复参与)');
} else {
  console.log('季已是 active,无需回滚。');
}

console.log('\n=== 4. 线上全部季(seasonNumber=2 且 completed 的标出来) ===');
const all = db.prepare('SELECT id, payload FROM tracked_seasons').all();
for (const r of all) {
  const p = JSON.parse(r.payload);
  if (p.seasonNumber === 2 && p.status === 'completed') console.log('  [completed] ' + r.id);
  else if (p.seasonNumber === 2) console.log('  [active] ' + r.id);
}

console.log('\nOK。下一步: 手动触发巡检 force 或等明日 06:00 定时巡检。');
console.log('零依赖提示: 若出现 ExperimentalWarning,属正常(Node 24 内置 sqlite 仍标记实验性)。');
db.close();
