'use strict';
/**
 * 打印每个人的专属口令（「口令即身份」用）。
 *
 * 用法（在 CVM 上跑，保证 VOMI_OWNER_KEY 与线上容器一致）：
 *   cd /root/deploy/backend
 *   set -a; . ../.env; set +a
 *   VOMI_PER_ACCOUNT_KEYS=true node tools/gen-user-keys.js
 *
 * 输出四列：企微账号 / 姓名 / 职能组 / 专属口令 —— 私发本人即可。
 * 打开开关：在 deploy/.env 里加 VOMI_PER_ACCOUNT_KEYS=true 后重建 backend 容器。
 */
const path = require('path');

process.env.VOMI_PER_ACCOUNT_KEYS = 'true';
const security = require(path.resolve(__dirname, '../src/security'));

const rows = security.listUsers().map((u) => [
  u.account,
  u.name,
  u.group === 'copy' ? '文案' : '音频',
  security.accountKeyFor(u.account),
]);

const width = [12, 24, 6, 18];
const head = ['企微账号', '姓名', '组', '专属口令'];
console.log(head.map((h, i) => h.padEnd(width[i])).join('  '));
console.log(width.map((w) => '-'.repeat(w)).join('  '));
for (const row of rows) console.log(row.map((c, i) => String(c).padEnd(width[i])).join('  '));
console.log(`\n共 ${rows.length} 人。${
  process.env.VOMI_OWNER_KEY ? '' : '⚠️ 当前未设置 VOMI_OWNER_KEY，用的是内置默认口令，请先配置强口令再发。'
}`);
