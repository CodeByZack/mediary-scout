#!/usr/bin/env node
// 重置地球超新鲜 S02E19/E20 假入库(2026-08-31 run eaade691 由 AI 假映射 mark)
// 用法: node reset-ep19-ep20.cjs <线上db路径>
const path = process.argv[2] || '/vol1/@appdata/mediary-scout/mediary.db';
const Database = require('/vol1/@appdata/deepseek_harness/profiles/home/mediary-scout/node_modules/better-sqlite3');
const db = new Database(path, { fileMustExist: true });
const codes = ['S02E19', 'S02E20'];
const sel = db.prepare('SELECT episode_code, payload FROM episode_states WHERE tracked_season_id = \'tmdb_tv_296202_s2\' AND episode_code IN (?, ?)');
const upd = db.prepare('UPDATE episode_states SET payload = json_set(payload, \'$.obtained\', json(\'false\'), \'$.verifiedFileIds\', json(\'[]\')) WHERE tracked_season_id = \'tmdb_tv_296202_s2\' AND episode_code = ?');
const before = codes.map((c) => { const r = sel.get(c, codes[1]); return r ? [c, JSON.parse(r.payload).obtained] : [c, 'NOT FOUND']; });
console.log('重置前:', JSON.stringify(before));
const tx = db.transaction(() => { for (const c of codes) upd.run(c); });
tx();
const after = codes.map((c) => { const r = sel.get(c, codes[1]); return r ? [c, JSON.parse(r.payload).obtained, JSON.parse(r.payload).verifiedFileIds] : [c, 'NOT FOUND']; });
console.log('重置后:', JSON.stringify(after));
console.log('OK: S02E19/E20 已恢复为缺集(obtained=false, verifiedFileIds=[])');
console.log('注: 若 Season 目录里有误归位的 地球超新鲜.S02E19/S02E20.* 文件,请手动删掉/改回原名。');
db.close();