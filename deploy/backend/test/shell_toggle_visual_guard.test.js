// 外壳页 brand-toggle 按钮视觉对齐子页原型守卫（2026-09-03）
//
// 背景：用户截图指的是子页那颗「绿色描边 + 实心播放三角」按钮，
//   而外壳页一直是 32×32 / 5px 圆角 / 深色底 / 三条横线描边的汉堡图标，两者对不上。
//
// 契约（以 preview-声优库-精修版.html 的 .brand-toggle 为基准）：
//   1. 36×36 / 8px 圆角 / 透明底 / hover 主色描边
//   2. 图标为实心填充三角（fill:currentColor + stroke:none），路径与子页一致
//   3. 收起态三角翻转朝左（子页缺这一步，外壳页必须补：否则收起后箭头仍指"收起"方向，语义反了）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const SHELL = path.join(ROOT, 'vo-manager-refined.html');
const SUB = path.join(ROOT, 'preview-声优库-精修版.html');
const DEPLOY = path.join(ROOT, 'deploy', 'frontend', 'vo-manager-refined.html');
const SRC = fs.readFileSync(SHELL, 'utf8');
const SUBSRC = fs.readFileSync(SUB, 'utf8');

const TRI = 'M8 5.2 L8 18.8 L19.5 12 Z';

// ---------- 1. 图标换成实心播放三角 ----------
test('外壳页按钮使用与子页相同的实心三角图标', () => {
  assert.ok(SUBSRC.includes(TRI), '基准：子页应含该三角路径');
  assert.ok(SRC.includes(TRI), '外壳页应改用同一条三角路径');
  const m = SRC.match(/<button class="brand-toggle"[\s\S]*?<\/button>/);
  assert.ok(m, '应能取到按钮片段');
  assert.doesNotMatch(m[0], /<line /, '不得再保留三条横线的汉堡图标');
});

test('三角为实心填充而非描边', () => {
  const i0 = SRC.indexOf('.brand-toggle svg{');
  assert.ok(i0 > 0, '应存在 .brand-toggle svg 规则');
  const rule = SRC.slice(i0, SRC.indexOf('}', i0));
  assert.match(rule, /fill:currentColor/, '应实心填充');
  assert.match(rule, /stroke:none/, '不得再用描边');
});

// ---------- 2. 尺寸与圆角对齐子页 ----------
test('按钮尺寸圆角与子页一致（36×36 / 8px / 透明底）', () => {
  const i0 = SRC.indexOf('.brand-toggle{');
  const rule = SRC.slice(i0, SRC.indexOf('}', i0));
  assert.match(rule, /width:36px/, '宽应为 36px');
  assert.match(rule, /height:36px/, '高应为 36px');
  assert.match(rule, /border-radius:8px/, '圆角应为 8px');
  assert.match(rule, /background:transparent/, '底色应透明');
});

test('hover 时描边与图标转为主色', () => {
  const i0 = SRC.indexOf('.brand-toggle:hover{');
  assert.ok(i0 > 0, '应存在 hover 规则');
  const rule = SRC.slice(i0, SRC.indexOf('}', i0));
  assert.match(rule, /border-color:var\(--c-primary\)/, 'hover 描边应为主色');
  assert.match(rule, /color:var\(--c-primary\)/, 'hover 图标应为主色');
});

// ---------- 3. 三角方向恒定（用户 2026-09-03 明确要求）----------
test('收起态三角不得翻转，方向始终朝右', () => {
  assert.doesNotMatch(SRC, /body\.sidebar-collapsed .brand-toggle svg\{[^}]*rotate\(/,
    '用户明确要求三角方向恒定，不得随收起态旋转');
  assert.doesNotMatch(SRC, /body\.sidebar-collapsed .brand-toggle svg\{[^}]*scaleX\(-1\)/,
    '也不得用 scaleX 镜像翻转');
});

// ---------- 4. 既有能力不得回退 ----------
test('保留 data-tip 玻璃气泡与状态持久化', () => {
  const m = SRC.match(/<button class="brand-toggle"[^>]*>/);
  assert.match(m[0], /data-tip="收起侧栏"/, 'tooltip 不得回退为原生 title');
  assert.doesNotMatch(m[0], /\stitle=/, '不得出现原生 title');
  assert.match(SRC, /localStorage\.setItem\('vo-sidebar-collapsed'/, '状态持久化不得丢失');
});

// ---------- 5. deploy 副本一致 ----------
test('deploy 副本与根权威文件一致', () => {
  assert.ok(fs.existsSync(DEPLOY), 'deploy 副本应存在');
  assert.equal(fs.readFileSync(DEPLOY, 'utf8'), SRC, '根文件与 deploy 副本必须一致');
});
