// 分享面板 Popover 化守卫（2026-09-03）
//
// 背景：用户要求「分享按钮优化，弹出的界面跟提示一样大小，且也显示在下方左侧」。
//   即：把原来的全屏遮罩 + 居中大模态，改成与通知中心 .notification-popover 完全一致
//   的锚定 popover —— 同样 ~430px 宽、同款玻璃质感、无全屏遮罩、从按钮正下方偏左弹出。
//
// 契约（以 .notification-popover 为基准）：
//   1. 彻底移除 .share-overlay / .share-picker-overlay 全屏遮罩
//   2. #shareBtn 外包 .share-wrap（position:relative），popover 相对按钮绝对定位
//   3. .share-popover 与 .share-picker-popover 均为 position:absolute + top:calc(100%+13px)
//      + right:-10px + width:min(430px,...)，即「下方偏左」锚定
//   4. 玻璃质感：backdrop-filter blur + 绿细边 + 16px 圆角 + opacity/visibility 过渡
//   5. JS：toggleShare(event) 读写 #shareBtn 的 aria-expanded；点外部用 wrap.contains 关闭
//   6. deploy/frontend 副本与根权威文件 byte-equal
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', 'vo-manager-refined.html');
const MIRROR = path.join(__dirname, '..', '..', 'frontend', 'vo-manager-refined.html');
const SRC = fs.readFileSync(ROOT, 'utf8');

const has = (re, message) => assert.ok(re.test(SRC), message);

// ---------- 1. 全屏遮罩彻底移除 ----------
test('不再存在全屏遮罩 .share-overlay / .share-picker-overlay', () => {
  assert.doesNotMatch(SRC, /\.share-overlay/, '旧的全屏遮罩应已删除');
  assert.doesNotMatch(SRC, /\.share-picker-overlay/, '旧的联系选择全屏遮罩应已删除');
});

// ---------- 2. 按钮入 wrap，popover 相对按钮定位 ----------
test('分享按钮外包 .share-wrap，popover 与 picker 均在 wrap 内', () => {
  const wrap = SRC.indexOf('id="shareWrap"');
  const btn = SRC.indexOf('id="shareBtn"');
  const modal = SRC.indexOf('id="shareModal"');
  const picker = SRC.indexOf('id="sharePicker"');
  assert.ok(wrap > -1, '应存在 .share-wrap 容器');
  assert.ok(wrap < btn && btn < modal, '按钮应位于 wrap 内、modal 之前');
  assert.ok(modal < picker, '联系选择面板应位于分享面板之后');
  assert.match(SRC, /\.share-wrap\{position:relative/, '.share-wrap 必须相对定位作为锚点');
});

test('分享按钮携带 popover 语义属性', () => {
  const m = SRC.match(/<button[^>]*id="shareBtn"[^>]*>/);
  assert.ok(m, '应能取到分享按钮片段');
  assert.match(m[0], /onclick="toggleShare\(event\)"/, '点击应走 toggleShare');
  assert.match(m[0], /aria-expanded="false"/, '初始应为收起态');
  assert.match(m[0], /aria-controls="shareModal"/, '应关联分享面板');
  assert.match(m[0], /aria-haspopup="dialog"/, '应声明弹出对话框');
});

// ---------- 3. 锚定定位：下方偏左，与通知中心一致 ----------
test('分享面板为绝对定位 popover，锚定按钮下方偏左', () => {
  const i0 = SRC.indexOf('.share-popover{');
  assert.ok(i0 > -1, '应存在 .share-popover 规则');
  const rule = SRC.slice(i0, SRC.indexOf('}', i0));
  assert.match(rule, /position:absolute/, '必须绝对定位，不能是全屏 fixed');
  assert.match(rule, /top:calc\(100% \+ 13px\)/, '应从按钮正下方 13px 弹出');
  assert.match(rule, /right:-10px/, '右对齐向左展开（下方偏左）');
  assert.match(rule, /width:min\(430px,calc\(100vw - 24px\)\)/, '宽度应与通知中心一致 ~430px');
  assert.match(rule, /max-height:min\(680px,calc\(100vh - 88px\)\)/, '应限制最大高度');
});

test('联系选择面板同为锚定 popover，覆盖在分享面板之上', () => {
  const i0 = SRC.indexOf('.share-picker-popover{');
  assert.ok(i0 > -1, '应存在 .share-picker-popover 规则');
  const rule = SRC.slice(i0, SRC.indexOf('}', i0));
  assert.match(rule, /position:absolute/, '必须绝对定位');
  assert.match(rule, /z-index:6300/, '应高于分享面板（6200）');
  assert.match(rule, /width:min\(430px,calc\(100vw - 24px\)\)/, '宽度一致');
});

// ---------- 4. 玻璃质感 ----------
test('popover 具备同款玻璃质感（blur + 绿边 + 圆角 + 过渡）', () => {
  const i0 = SRC.indexOf('.share-popover{');
  const rule = SRC.slice(i0, SRC.indexOf('}', i0));
  assert.match(rule, /backdrop-filter:blur\(24px\)/, '必须玻璃模糊');
  assert.match(rule, /border:1px solid rgba\(15,247,150,\.42\)/, '必须绿色细边');
  assert.match(rule, /border-radius:16px/, '必须 16px 圆角');
  assert.match(rule, /opacity:0/, '初始隐藏');
  assert.match(rule, /visibility:hidden/, '初始不可见');
  assert.match(rule, /transition:opacity \.16s ease/, '必须带过渡动画');
});

// ---------- 5. JS 交互：aria 同步 + 点外部关闭 ----------
test('toggleShare 读写 aria-expanded，open/close 双向同步', () => {
  has(/function toggleShare\(event\)/, '应提供 toggleShare 入口');
  has(/event\.stopPropagation\(\)/, '按钮点击应 stopPropagation 避免立即被外部关闭');
  has(/getAttribute\('aria-expanded'\) === 'true'/, 'toggle 应根据 aria 状态决定开关');
  has(/setAttribute\('aria-expanded','true'\)/, '打开时应同步 aria-expanded=true');
  has(/setAttribute\('aria-expanded','false'\)/, '关闭时应同步 aria-expanded=false');
});

test('点外部关闭改用 wrap.contains，ESC 关闭保留', () => {
  has(/!wrap\.contains\(e\.target\)/, '外部点击判定必须用 wrap.contains');
  assert.doesNotMatch(SRC, /e\.target\.id === 'shareModal'/, '不得再用「点击面板自身即关闭」的旧逻辑');
  has(/if\(e\.key === 'Escape'\)/, 'ESC 关闭入口应保留');
});

// ---------- 6. 部署副本一致 ----------
test('部署副本与根权威文件保持一致', () => {
  assert.ok(fs.existsSync(MIRROR), 'deploy 副本应存在');
  assert.equal(fs.readFileSync(MIRROR, 'utf8'), SRC, '根文件与 deploy 副本必须一致');
});
