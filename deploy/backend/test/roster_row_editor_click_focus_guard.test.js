// 声优库「行编辑 Popover 默认不抢焦，按点击位置 focus」守卫（2026-09-03）
//
// 用户原话：「这里的声优库信息修改，现在都默认是游戏角色中这里了，
// 我点击到哪里的时候，就自动调到对应框的位置」。
//
// 修复前：openRowEditor 末尾用 `first.focus() + first.select()` 强制把光标
// 抢到「角色（中）」并全选，浏览器原生 click→focus 反而被覆盖，
// 用户点击「角色（英）」无法让光标停在那里。
//
// 修复后：
//   ① 卡片根 .row-editor-pop 带 tabindex="-1"，让卡片整体可获焦
//   ② 卡片根 focus({preventScroll:true})，焦点在卡片根（不在任一 input）
//   ③ 卡片根 outline:none，避免被聚焦时显示原生蓝边
//   ④ 移除 first.focus+first.select，浏览器原生 click→focus 自然接管
//   ⑤ Enter 提交挂在卡片根 keydown 上，焦点在根或任一 input 都能触发
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const HTML = path.join(ROOT, 'preview-声优库-精修版.html');
const DEPLOY = path.join(ROOT, 'deploy', 'frontend', 'preview-声优库-精修版.html');
const SRC = fs.readFileSync(HTML, 'utf8');

// 抓取 openRowEditor 函数体（到下一个顶层函数/常量声明前为止）
function getOpenRowEditorBlock() {
  const i0 = SRC.indexOf('function openRowEditor(');
  assert.ok(i0 > 0, '应有 openRowEditor 定义');
  return SRC.slice(i0, SRC.indexOf('\nasync function saveRowEditor(', i0));
}

// ---------- 1. 不得默认聚焦首个 input ----------
test('openRowEditor 不再默认 focus 首个 input', () => {
  const block = getOpenRowEditorBlock();
  assert.doesNotMatch(
    block,
    /first\.focus\(/,
    '禁用 default focus 抢焦，让浏览器原生 click→focus 接管'
  );
  assert.doesNotMatch(
    block,
    /first\.select\(/,
    '禁用默认 select() 全选，避免用户首键即覆盖'
  );
  // 不得再有 .rep-input 的 focus 调用
  assert.doesNotMatch(
    block,
    /rep-input[^]{0,40}\.focus\(/,
    '卡片内不得针对任一 rep-input 直接 focus'
  );
});

// ---------- 2. 卡片根带 tabindex=-1，可获焦 ----------
test('卡片根带 tabindex=-1 让 pop 整体可获焦（不抢 input 焦点）', () => {
  const block = getOpenRowEditorBlock();
  assert.match(
    block,
    /pop\.setAttribute\(\s*['"]tabindex['"]\s*,\s*['"]-1['"]\s*\)/,
    '卡片根应设置 tabindex=-1'
  );
  assert.match(
    block,
    /pop\.focus\(\{\s*preventScroll:\s*true\s*\}\)/,
    '卡片根应 focus({preventScroll:true})，焦点放在卡片根'
  );
});

// ---------- 3. 卡片根 CSS 去掉 outline，避免被聚焦显示原生蓝边 ----------
test('.row-editor-pop CSS 取消 outline，避免根获焦显示原生蓝边', () => {
  assert.match(
    SRC,
    /\.row-editor-pop\s*\{[^}]*outline:\s*none/,
    '卡片根必须 outline:none，焦点落在卡片上不能有蓝色描边'
  );
});

// ---------- 4. Enter 提交挂在卡片根 keydown，焦点在根或 input 都生效 ----------
test('Enter 提交挂在卡片根 keydown，不论焦点在根还是 input 都能触发', () => {
  const block = getOpenRowEditorBlock();
  assert.match(
    block,
    /pop\.addEventListener\(\s*['"]keydown['"]\s*,[\s\S]{0,200}saveRowEditor/,
    'Enter 应绑定在 pop 的 keydown，并通过冒泡被 input 也触发'
  );
  // 必须在 focus 之后绑 keydown，这样绑定时 pop 已存在
  const focusIdx = block.indexOf('pop.focus(');
  const keydownIdx = block.indexOf("pop.addEventListener('keydown'");
  assert.ok(focusIdx > 0 && keydownIdx > 0, 'focus 与 keydown 绑定都要存在');
  assert.ok(
    keydownIdx > focusIdx,
    'keydown listener 必须在 pop.focus 之后绑，避免 pop 引用缺失'
  );
});

// ---------- 5. 修复后无副作用：卡片定位/切换/关闭原契约不动 ----------
test('修复后定位与切换逻辑保留', () => {
  const block = getOpenRowEditorBlock();
  assert.match(block, /ROW_EDITOR\.rid === id/, '同行再点应关闭');
  assert.match(block, /ROW_EDITOR_MOUSE/, '鼠标位置定位逻辑保留');
  assert.match(block, /pop\.classList\.add\(['"]show['"]\)/, '卡片入场动画保留');
});

// ---------- 6. deploy 副本与根权威文件一致 ----------
test('deploy 副本与根权威文件 byte-equal', () => {
  assert.ok(fs.existsSync(DEPLOY), 'deploy 副本应存在');
  assert.equal(
    fs.readFileSync(DEPLOY, 'utf8'),
    SRC,
    '根文件与 deploy 副本必须一致，发布后才算线上生效'
  );
});
