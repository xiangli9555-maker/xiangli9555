// 录制档期 4 个中英文看板标题行胶囊化 + 末尾 4 状态统计守卫
// 2026-09-03 用户定稿：仅 4 个中/英看板（中文声优 / 英文声优 / 中文 Vo 需求 / 英文 Vo 需求）
//   标题行改为胶囊外框（pill 形 + 中/英专属色边框 + 玻璃底）；
//   末尾追加 4 个状态统计（数字在上 / 标签在下，颜色与状态对应）；
//   下方 3 板（待预约 / 部分已约 / 已约完）保留不动。

'use strict';
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'preview-录制档期-精修版.html');
const DEPLOY = path.join(ROOT, 'deploy', 'frontend', 'preview-录制档期-精修版.html');

function read(p){ return fs.readFileSync(p, 'utf8'); }

let html;
test('源文件存在', () => {
  assert.ok(fs.existsSync(SRC), 'preview-录制档期-精修版.html 应存在');
  html = read(SRC);
});

// ---------- 1. CSS：胶囊外框 + 4 状态统计样式 ----------
test('CSS：.line-head 胶囊化（border-radius:999px + backdrop-filter）', () => {
  // 抽出 .line-head 规则块
  const m = html.match(/\.line-head\{[^}]+\}/);
  assert.ok(m, '.line-head 规则应存在');
  const css = m[0];
  assert.ok(/border-radius:\s*999px/.test(css), 'line-head 应为 pill 形（999px 圆角）');
  assert.ok(/backdrop-filter:\s*blur\(/.test(css), 'line-head 应有玻璃 blur');
  assert.ok(/padding:\s*8px\s+16px/.test(css), 'line-head padding 应为 8px 16px');
});

test('CSS：中/英专属色边框（box-shadow inset + 渐变）', () => {
  assert.ok(/\.line-group\[data-lang="cn"\] \.line-head\{[^}]*box-shadow[^}]*rgba\(140,168,189/.test(html),
    '中文看板应带蓝灰边框 rgba(140,168,189,...)');
  assert.ok(/\.line-group\[data-lang="en"\] \.line-head\{[^}]*box-shadow[^}]*rgba\(15,247,150/.test(html),
    '英文看板应带品牌绿边框 rgba(15,247,150,...)');
});

test('CSS：4 状态统计 + 数字在上 / 标签在下', () => {
  assert.ok(/\.lh-stats\{display:flex[^}]*gap:18px/.test(html), '.lh-stats 应为 flex 容器 gap:18px');
  assert.ok(/\.lh-stat\{display:flex;flex-direction:column/.test(html), '.lh-stat 应为纵向（数字在上 / 标签在下）');
  assert.ok(/\.lh-stat-n\{font-size:24px/.test(html), '数字字号应为 24px（大号）');
  assert.ok(/\.lh-stat-l\{font-size:11px/.test(html), '标签字号应为 11px（小号）');
});

test('CSS：4 状态数字颜色与状态对应（橙 / 蓝 / 绿 / 灰）', () => {
  assert.ok(/\.lh-stat\.pend \.lh-stat-n\{color:#FFD24C\}/.test(html), '待预约数字应为主色黄 #FFD24C');
  assert.ok(/\.lh-stat\.up \.lh-stat-n\{color:#8CA8C1\}/.test(html), '部分已约数字应为蓝灰 #8CA8C1');
  assert.ok(/\.lh-stat\.done \.lh-stat-n\{color:var\(--c-primary\)\}/.test(html), '已约完数字应为主色绿');
  assert.ok(/\.lh-stat\.tot \.lh-stat-n\{color:rgba\(255,255,255,\.55\)\}/.test(html), '总计数字应为浅灰');
});

// ---------- 2. HTML 输出：renderActorSixBoard 内嵌结构 ----------
test('HTML：line-head 包含 lh-title / lh-divider / lh-stats 三段', () => {
  // 抓 renderActorSixBoard 内嵌的 `<div class="line-head">...</div>` 模板
  const m = html.match(/<div class="line-head">[\s\S]*?<\/div>\s*<\/div>'/);
  assert.ok(m, 'line-head 模板应存在于 renderActorSixBoard 内');
  const tpl = m[0];
  assert.ok(/class="lh-title"/.test(tpl), 'line-head 应包含 .lh-title');
  assert.ok(/class="lh-divider"/.test(tpl), 'line-head 应包含 .lh-divider 分隔条');
  assert.ok(/class="lh-stats"/.test(tpl), 'line-head 应包含 .lh-stats 4 状态统计');
});

test('HTML：4 状态统计顺序与内容（pend / up / done / tot）', () => {
  // 直接抓 4 个 lh-stat 出现顺序（不管外层 div 边界）
  const re = /class="lh-stat (pend|up|done|tot)"/g;
  const order = [];
  let r;
  while ((r = re.exec(html)) !== null) order.push(r[1]);
  assert.deepStrictEqual(order, ['pend', 'up', 'done', 'tot'],
    '4 状态统计必须按 待预约 / 部分已约 / 已约完 / 总计 顺序');
  assert.ok(/<span class="lh-stat-l">待预约<\/span>/.test(html), '标签应含「待预约」');
  assert.ok(/<span class="lh-stat-l">部分已约<\/span>/.test(html), '标签应含「部分已约」');
  assert.ok(/<span class="lh-stat-l">已约完<\/span>/.test(html), '标签应含「已约完」');
  assert.ok(/<span class="lh-stat-l">总计<\/span>/.test(html), '标签应含「总计」');
});

test('HTML：line-head 末尾 4 数字 = 板数量累计', () => {
  // 模板中 tot = pend.length + up.length + done.length 求和
  const m = html.match(/<div class="lh-stat tot"><span class="lh-stat-n">\$\{tot\}<\/span>/);
  assert.ok(m, 'tot 数字应来自 ${tot} 变量');
  // 该变量必须在 line-head 模板之前定义，且由 3 板求和
  assert.ok(/const tot = pend\.length\s*\+\s*up\.length\s*\+\s*done\.length/.test(html),
    'tot 变量必须由 pend + up + done 求和');
});

test('HTML：移除旧 lh-count（"N 项"），避免与新统计重复', () => {
  assert.ok(!/class="lh-count"/.test(html), '旧 .lh-count 应已移除（避免与 4 状态统计重复）');
  assert.ok(!/lh-count/.test(html), '任何 lh-count 引用都应清除');
});

// ---------- 3. 下方 3 板结构保留 ----------
test('HTML：下方 3 板（待预约 / 部分已约 / 已约完）保留', () => {
  const m = html.match(/boardHtml\('pend'[\s\S]*?boardHtml\('done'[\s\S]*?\)/);
  assert.ok(m, '3 板 boardHtml 调用应保留');
  assert.ok(/boardHtml\('pend', '待预约'/.test(html), '待预约板保留');
  assert.ok(/boardHtml\('up',   '部分已约'/.test(html), '部分已约板保留');
  assert.ok(/boardHtml\('done', '已约完'/.test(html), '已约完板保留');
});

// ---------- 4. deploy 副本同步 ----------
test('deploy 副本与根文件 byte-equal', () => {
  assert.ok(fs.existsSync(DEPLOY), 'deploy 副本应存在');
  const a = read(SRC).replace(/\r\n/g, '\n');
  const b = read(DEPLOY).replace(/\r\n/g, '\n');
  assert.equal(b, a, 'deploy 副本必须与根文件 byte-equal（去除 CRLF）');
});
