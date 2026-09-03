// 外壳页「收起侧栏」按钮 tooltip 与状态持久化守卫（2026-09-03）
//
// 背景：按钮 DOM / JS / CSS 早已在线（349 / 873 行 + 24 条 collapsed 规则），
//   但用的是浏览器原生 title="收起/展开侧栏" —— 灰色小方块、延迟约 1s 才出，
//   与声优库子页已定稿的深色玻璃气泡 [data-tip] 规格不一致（用户截图即子页效果）。
//
// 契约：
//   1. 外壳页按钮改用 data-tip，并接入与子页同规格的玻璃浮层
//   2. tooltip 文案随状态切换：展开态「收起侧栏」/ 收起态「展开侧栏」
//   3. 收起状态写入 localStorage，刷新后保持
//   4. 不得保留原生 title（否则双 tooltip 叠加）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const HTML = path.join(ROOT, 'vo-manager-refined.html');
const DEPLOY = path.join(ROOT, 'deploy', 'frontend', 'vo-manager-refined.html');
const SRC = fs.readFileSync(HTML, 'utf8');

// ---------- 1. 按钮使用 data-tip 而非原生 title ----------
test('收起侧栏按钮使用 data-tip 玻璃气泡', () => {
  const m = SRC.match(/<button class="brand-toggle"[^>]*>/);
  assert.ok(m, '应存在 brand-toggle 按钮');
  const tag = m[0];
  assert.match(tag, /data-tip="收起侧栏"/, '应使用 data-tip 且文案为「收起侧栏」');
  assert.doesNotMatch(tag, /\stitle=/, '不得保留原生 title，避免双 tooltip 叠加');
  assert.match(tag, /aria-label=/, '移除 title 后须补 aria-label 保证可访问性');
});

// ---------- 2. tooltip 文案随状态切换 ----------
test('tooltip 文案随收起状态切换', () => {
  const i0 = SRC.indexOf('function toggleSidebar()');
  assert.ok(i0 > 0, '应存在 toggleSidebar');
  const block = SRC.slice(i0, i0 + 800);
  assert.match(block, /展开侧栏/, '收起态文案应为「展开侧栏」');
  assert.match(block, /data-tip/, 'toggle 时应回写 data-tip');
});

// ---------- 3. 状态持久化 ----------
test('收起状态写入 localStorage 且刷新后恢复', () => {
  assert.match(SRC, /vo-sidebar-collapsed/, '应使用固定的 localStorage key');
  const i0 = SRC.indexOf('function toggleSidebar()');
  const block = SRC.slice(i0, i0 + 800);
  assert.match(block, /localStorage\.setItem\('vo-sidebar-collapsed'/, 'toggle 应写入状态');
  assert.match(SRC, /localStorage\.getItem\('vo-sidebar-collapsed'\)/, '应有启动恢复逻辑');
});

test('状态读写包在 try/catch 内，隐私模式不得整页报错', () => {
  const i0 = SRC.indexOf('function toggleSidebar()');
  const block = SRC.slice(i0, i0 + 800);
  assert.match(block, /try\{/, 'localStorage 访问须 try/catch 包裹');
});

// ---------- 4. 玻璃浮层运行时 ----------
test('外壳页接入与子页同规格的 data-tip 玻璃浮层', () => {
  assert.match(SRC, /vomi-tip-host-pop/, '应复用同名浮层类，保证全站规格一致');
  assert.match(SRC, /\[data-tip\]/, '应有事件委托选择器');
  assert.match(SRC, /backdrop-filter:blur/, '应为深色玻璃质感');
  assert.match(SRC, /rgba\(15,247,150,\.42\)/, '描边应为主色绿细边，与子页一致');
});

// ---------- 5. deploy 副本一致 ----------
test('deploy 副本与根权威文件一致', () => {
  assert.ok(fs.existsSync(DEPLOY), 'deploy 副本应存在');
  assert.equal(fs.readFileSync(DEPLOY, 'utf8'), SRC, '根文件与 deploy 副本必须一致');
});
