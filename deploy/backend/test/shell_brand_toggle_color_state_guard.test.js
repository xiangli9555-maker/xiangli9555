// 外壳页 brand-toggle 按钮按侧栏状态切换颜色守卫（2026-09-03）
//
// 背景：用户截图定稿
//   - 展开态（侧栏可见）: 描边 + 三角都用品牌绿
//   - 缩进态（侧栏已收）: 描边 + 三角都回到白色
// 在 .brand-toggle 默认（白）的基础上，新增 body:not(.sidebar-collapsed) 选择器把
// 展开态切到品牌绿；缩进态因为回到默认 --c-text 即白色，不需额外规则。
// hover 规则保持原样（任何状态 hover 都会再尝试转绿），由旧守卫覆盖。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const SHELL = path.join(ROOT, 'vo-manager-refined.html');
const DEPLOY = path.join(ROOT, 'deploy', 'frontend', 'vo-manager-refined.html');
const SRC = fs.readFileSync(SHELL, 'utf8');

function readRule(selector){
  // 形如 ".brand-toggle{" / "body:not(.sidebar-collapsed) .brand-toggle{"
  const idx = SRC.indexOf(selector + '{');
  if(idx < 0) return null;
  const end = SRC.indexOf('}', idx);
  if(end < 0) return null;
  return SRC.slice(idx, end + 1);
}

// ---------- 1. 展开态：默认用品牌绿 ----------
test('展开态（侧栏可见）brand-toggle 默认描边 + 三角用品牌绿', () => {
  const rule = readRule('body:not(.sidebar-collapsed) .brand-toggle');
  assert.ok(rule, '应存在 body:not(.sidebar-collapsed) .brand-toggle 规则');
  assert.match(rule, /border-color\s*:\s*var\(--c-primary\)/, '展开态描边应为主色');
  assert.match(rule, /color\s*:\s*var\(--c-primary\)/, '展开态图标应为主色');
});

// ---------- 2. 缩进态：默认沿用白（--c-text）----------
test('缩进态 brand-toggle 默认仍用白色（--c-text）', () => {
  const rule = readRule('.brand-toggle');
  assert.ok(rule, '应存在 .brand-toggle 默认规则');
  assert.match(rule, /color\s*:\s*var\(--c-text\)/, '默认 color 应为白色');
  assert.match(rule, /border\s*:[^;]*solid\s+var\(--c-border\)/, '默认描边应为中性色 --c-border');
});

// ---------- 3. hover 规则未被误改（保证展开态 hover 也能再转绿，背景 + svg translateX 仍有反馈）----------
test('hover 规则保留：描边 + 图标转主色 + svg translateX(1px)', () => {
  const hover = readRule('.brand-toggle:hover');
  assert.ok(hover, '应保留 .brand-toggle:hover 规则');
  assert.match(hover, /border-color\s*:\s*var\(--c-primary\)/);
  assert.match(hover, /color\s*:\s*var\(--c-primary\)/);
  const svgHover = readRule('.brand-toggle:hover svg');
  assert.match(svgHover, /translateX\(1px\)/, 'svg 应有 translateX(1px) 反馈');
});

// ---------- 4. 三角方向仍恒定朝右（禁止再因新增状态规则引入 rotate / scaleX）----------
test('展开态 / 缩进态都不得旋转或翻转三角', () => {
  assert.doesNotMatch(SRC, /body:not\(\.sidebar-collapsed\) \.brand-toggle[^{]*\{[^}]*rotate\(/);
  assert.doesNotMatch(SRC, /body\.sidebar-collapsed \.brand-toggle[^{]*\{[^}]*rotate\(/);
  assert.doesNotMatch(SRC, /body:not\(\.sidebar-collapsed\) \.brand-toggle[^{]*\{[^}]*scaleX\(-1\)/);
  assert.doesNotMatch(SRC, /body\.sidebar-collapsed \.brand-toggle[^{]*\{[^}]*scaleX\(-1\)/);
});

// ---------- 5. deploy 副本同步 ----------
test('deploy 副本与根权威文件一致', () => {
  assert.ok(fs.existsSync(DEPLOY), 'deploy 副本应存在');
  assert.equal(fs.readFileSync(DEPLOY, 'utf8'), SRC, 'deploy 副本必须与根文件 byte-equal');
});

// ---------- 6. 子页同步（按"外壳与子页一致"长期规则）----------
const SUBPAGES = [
  'preview-需求汇总-精修版.html',
  'preview-录制档期-精修版.html',
  'preview-版本节点-精修版.html',
  'preview-声优库-精修版.html',
  'preview-AI助手-精修版.html',
];
for(const name of SUBPAGES){
  test(`子页 ${name} 同步展开态绿色 + deploy 一致`, () => {
    const root = path.join(ROOT, name);
    const dep = path.join(ROOT, 'deploy', 'frontend', name);
    assert.ok(fs.existsSync(root), `${name} 根源文件应存在`);
    assert.ok(fs.existsSync(dep), `${name} deploy 副本应存在`);
    const rootSrc = fs.readFileSync(root, 'utf8');
    const depSrc = fs.readFileSync(dep, 'utf8');
    assert.equal(rootSrc, depSrc, `${name} 根与 deploy 必须 byte-equal`);
    assert.match(rootSrc, /body:not\(\.sidebar-collapsed\) \.brand-toggle\{[^}]*border-color\s*:\s*var\(--c-primary\)/,
      `${name} 展开态描边必须为品牌绿`);
    assert.match(rootSrc, /body:not\(\.sidebar-collapsed\) \.brand-toggle\{[^}]*color\s*:\s*var\(--c-primary\)/,
      `${name} 展开态图标必须为品牌绿`);
  });
}