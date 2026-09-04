// 录制档期 4 个中英文看板标题行守卫（2026-09-04 修订）
//
// 规则要点（用户 2026-09-04 定稿）：
//   1. .lh-title 退化为透明 flex 容器（无胶囊样式，标题文字直接外露）。
//   2. .lh-tag 是「前面那一小块」胶囊（24×24 圆形 + 中/英专属色底/边框）。
//   3. 4 状态统计保留：数字在上（24px 着色）/ 标签在下（11px 白字）。
//   4. 下方 3 板（待预约 / 部分已约 / 已约完）保留不动。
//   5. 计数 tot = pend + up + done 求和。
//
// 显式否定：line-head 不再是胶囊（去除 border-radius / backdrop-filter / padding），
//           line-group[data-lang="cn/en"] 专属色只挂在 .lh-tag 上，不再挂在 .lh-title。

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

// ---------- 1. CSS：lh-title 退化为透明容器 ----------
test('CSS：.lh-title 是透明 flex 容器（无胶囊样式）', () => {
  const m = html.match(/\.lh-title\{[^}]+\}/);
  assert.ok(m, '.lh-title 规则应存在');
  const css = m[0];
  assert.ok(!/border-radius:\s*999px/.test(css), 'lh-title 不应再有 999px 胶囊圆角');
  assert.ok(!/backdrop-filter:\s*blur/.test(css), 'lh-title 不应再有 backdrop-filter 玻璃');
  assert.ok(!/box-shadow/.test(css), 'lh-title 不应再有 inset 边框/阴影');
  assert.ok(!/background:/.test(css), 'lh-title 不应再有底色（透明容器）');
  assert.ok(/display:\s*flex/.test(css), 'lh-title 应保留 flex 布局');
  assert.ok(/align-items:\s*center/.test(css), 'lh-title 应保留居中对齐');
});

test('CSS：line-head 也不再是胶囊（无 border-radius / backdrop / padding 8 16）', () => {
  const m = html.match(/\.line-head\{[^}]+\}/);
  assert.ok(m, '.line-head 规则应存在');
  const css = m[0];
  assert.ok(!/border-radius:\s*999px/.test(css), 'line-head 不应是整条胶囊（无 999px）');
  assert.ok(!/backdrop-filter:\s*blur/.test(css), 'line-head 不应再有玻璃 blur');
  assert.ok(!/padding:\s*8px\s+16px/.test(css), 'line-head 不应是 8/16 胶囊');
});

test('CSS：原 .line-group[data-lang] 专属色不应挂在 .lh-title', () => {
  // 反向断言：搜「line-group[data-lang][xxx] .lh-title{」专属色规则——应已删除
  assert.ok(!/\.line-group\[data-lang="cn"\]\s+\.lh-title\{/.test(html),
    'cn 专属色不应再挂在 .lh-title 上');
  assert.ok(!/\.line-group\[data-lang="en"\]\s+\.lh-title\{/.test(html),
    'en 专属色不应再挂在 .lh-title 上');
});

// ---------- 2. CSS：lh-tag 是前面那块小胶囊 ----------
test('CSS：.lh-tag 是 24×24 圆形胶囊', () => {
  const m = html.match(/\.lh-tag\{[^}]+\}/);
  assert.ok(m, '.lh-tag 规则应存在');
  const css = m[0];
  assert.ok(/border-radius:\s*50%/.test(css), 'lh-tag 应为圆形（border-radius:50%）');
  assert.ok(/width:\s*24px/.test(css), 'lh-tag 宽度应为 24px');
  assert.ok(/height:\s*24px/.test(css), 'lh-tag 高度应为 24px');
});

test('CSS：.lh-tag.cn 与 .lh-tag.en 都有专属色背景 + 边框', () => {
  assert.ok(/\.lh-tag\.cn\{[^}]*background:rgba\(140,168,189/.test(html),
    'cn tag 应有蓝灰半透明背景 rgba(140,168,189,...)');
  assert.ok(/\.lh-tag\.cn\{[^}]*border:1px solid rgba\(140,168,189/.test(html),
    'cn tag 应有蓝灰边框');
  assert.ok(/\.lh-tag\.en\{[^}]*background:rgba\(15,247,150/.test(html),
    'en tag 应有品牌绿背景 rgba(15,247,150,...)');
  assert.ok(/\.lh-tag\.en\{[^}]*border:1px solid rgba\(15,247,150/.test(html),
    'en tag 应有品牌绿边框');
});

// ---------- 3. CSS：4 状态统计保留 ----------
test('CSS：4 状态统计样式保留（lh-stats/lh-stat/lh-stat-n/lh-stat-l）', () => {
  assert.ok(/\.lh-stats\{display:flex[^}]*margin-left:auto/.test(html), 'lh-stats 应右对齐（margin-left:auto）');
  assert.ok(/\.lh-stat\{display:flex;flex-direction:column/.test(html), 'lh-stat 应为纵向');
  assert.ok(/\.lh-stat-n\{font-size:24px/.test(html), '数字字号 24px');
  assert.ok(/\.lh-stat-l\{font-size:11px/.test(html), '标签字号 11px');
});

test('CSS：4 状态数字颜色与状态对应（橙 / 蓝 / 绿 / 灰）', () => {
  assert.ok(/\.lh-stat\.pend \.lh-stat-n\{color:#FFD24C\}/.test(html), '待预约数字应为主色黄 #FFD24C');
  assert.ok(/\.lh-stat\.up \.lh-stat-n\{color:#8CA8C1\}/.test(html), '部分已约数字应为蓝灰 #8CA8C1');
  assert.ok(/\.lh-stat\.done \.lh-stat-n\{color:var\(--c-primary\)\}/.test(html), '已约完数字应为主色绿');
  assert.ok(/\.lh-stat\.tot \.lh-stat-n\{color:rgba\(255,255,255,\.55\)\}/.test(html), '总计数字应为浅灰');
});

// ---------- 4. HTML 输出：renderActorSixBoard 内嵌结构 ----------
test('HTML：line-head 包含 lh-title + lh-stats 两段（lh-divider 不应存在）', () => {
  const m = html.match(/<div class="line-head">[\s\S]*?<\/div>\s*<\/div>'/);
  assert.ok(m, 'line-head 模板应存在于 renderActorSixBoard 内');
  const tpl = m[0];
  assert.ok(/class="lh-title"/.test(tpl), 'line-head 应包含 .lh-title');
  assert.ok(/class="lh-stats"/.test(tpl), 'line-head 应包含 .lh-stats');
  assert.ok(!/class="lh-divider"/.test(tpl), 'line-head 不应再含 .lh-divider（已并入 lh-tag 胶囊）');
});

test('HTML：lh-title 内嵌 lh-tag + lh-name（tag 在前 / 标题在后）', () => {
  const m = html.match(/<div class="lh-title">[\s\S]*?<\/div>/);
  assert.ok(m, 'lh-title 模板应存在');
  const tpl = m[0];
  // lh-tag 必须在 lh-name 前面
  const tagIdx = tpl.indexOf('class="lh-tag');
  const nameIdx = tpl.indexOf('class="lh-name"');
  assert.ok(tagIdx > -1, 'lh-title 应包含 lh-tag');
  assert.ok(nameIdx > -1, 'lh-title 应包含 lh-name');
  assert.ok(tagIdx < nameIdx, 'lh-tag 应在 lh-name 前面（前面那块胶囊在前）');
  // lh-tag 应有 cn/en 动态类
  assert.ok(/class="lh-tag \$\{grp\.lang\}"/.test(tpl), 'lh-tag 应按 grp.lang 切换 cn/en 类');
  // lh-tag 内文字按 cn/en 切「中/英」
  assert.ok(/grp\.lang === 'cn' \? '中' : '英'/.test(tpl), 'lh-tag 内文字应为 cn→中 / en→英');
});

test('HTML：4 状态统计顺序与内容（pend / up / done / tot）', () => {
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
  const m = html.match(/<div class="lh-stat tot"><span class="lh-stat-n">\$\{tot\}<\/span>/);
  assert.ok(m, 'tot 数字应来自 ${tot} 变量');
  assert.ok(/const tot = pend\.length\s*\+\s*up\.length\s*\+\s*done\.length/.test(html),
    'tot 变量必须由 pend + up + done 求和');
});

test('HTML：移除旧 lh-count（"N 项"），避免与新统计重复', () => {
  assert.ok(!/class="lh-count"/.test(html), '旧 .lh-count 应已移除（避免与 4 状态统计重复）');
  assert.ok(!/lh-count/.test(html), '任何 lh-count 引用都应清除');
});

// ---------- 5. 下方 3 板结构保留 ----------
test('HTML：下方 3 板（待预约 / 部分已约 / 已约完）保留', () => {
  const m = html.match(/boardHtml\('pend'[\s\S]*?boardHtml\('done'[\s\S]*?\)/);
  assert.ok(m, '3 板 boardHtml 调用应保留');
  assert.ok(/boardHtml\('pend', '待预约'/.test(html), '待预约板保留');
  assert.ok(/boardHtml\('up',   '部分已约'/.test(html), '部分已约板保留');
  assert.ok(/boardHtml\('done', '已约完'/.test(html), '已约完板保留');
});

// ---------- 6. deploy 副本同步 ----------
test('deploy 副本与根文件 byte-equal', () => {
  assert.ok(fs.existsSync(DEPLOY), 'deploy 副本应存在');
  const a = read(SRC).replace(/\r\n/g, '\n');
  const b = read(DEPLOY).replace(/\r\n/g, '\n');
  assert.equal(b, a, 'deploy 副本必须与根文件 byte-equal（去除 CRLF）');
});