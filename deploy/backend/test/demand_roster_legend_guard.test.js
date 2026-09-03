// 需求视图角色构成条 · 视觉与交互契约守卫（2026-09-03 用户截图定稿 4 点）
//   1. 色条不能有空隙 —— 段间不得用背景色描边切开
//   2. 图例 hover 有底色高亮
//   3. 图例点击直接触发分类筛选，与顶部筛选芯片联动
//   4. 色块 10×10 圆角方块；图例字体走正文字体（非等宽/非缩小号）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..', 'preview-录制档期-精修版.html');
const MIRROR = path.join(__dirname, '..', '..', 'frontend', 'preview-录制档期-精修版.html');
const SRC = fs.readFileSync(ROOT, 'utf8');

const rule = name => {
  const i = SRC.indexOf(name + '{');
  assert.ok(i > -1, `应存在样式规则 ${name}`);
  return SRC.slice(i + name.length + 1, SRC.indexOf('}', i));
};

// ---------- 1. 色条无空隙 ----------
test('色条分段之间不留空隙', () => {
  const seg = rule('.demand-roster-seg');
  assert.ok(!/border-right:\s*\dpx solid var\(--c-bg-0\)/.test(seg), '不得用背景色描边把色条切开');
  assert.ok(!/\bgap:/.test(rule('.demand-roster-bar')), '色条容器不得有 gap');
});

// ---------- 4. 色块 10×10 圆角方块 ----------
test('图例色块为 10×10 圆角方块', () => {
  const dot = rule('.demand-roster-dot');
  assert.match(dot, /width:10px/, '色块宽 10px');
  assert.match(dot, /height:10px/, '色块高 10px');
  assert.match(dot, /border-radius:3px/, '圆角方块而非圆点');
});

// ---------- 4. 图例字体走正文字体 ----------
test('图例使用正文字体与正文字号', () => {
  const li = rule('.demand-roster-li');
  assert.ok(!/10\.5px/.test(li), '不再使用 10.5px 迷你字号');
  assert.match(li, /font-size:13px/, '字号对齐正文 13px');
  assert.ok(!/font:\s*500 /.test(li), '不得用 font 简写覆盖继承的正文字体');
  assert.match(li, /font-family:inherit/, '字体族继承页面正文');
});

// ---------- 2. hover 底色高亮 ----------
test('图例 hover / 选中态有底色高亮', () => {
  assert.ok(SRC.includes('.demand-roster-li:hover{'), '应单独定义 hover 态');
  const hover = rule('.demand-roster-li:hover');
  assert.match(hover, /background:/, 'hover 必须有底色');
  const on = rule('.demand-roster-li.on');
  assert.match(on, /background:/, '选中态必须有底色');
  const li = rule('.demand-roster-li');
  assert.match(li, /padding:/, '有底色就必须有内边距，否则底色贴字');
  assert.match(li, /border-radius:/, '底色块需圆角');
});

// ---------- 3. 点击联动筛选芯片 ----------
test('图例点击后同步顶部筛选芯片状态', () => {
  const i0 = SRC.indexOf('function setDemandRosterCat(cat)');
  assert.ok(i0 > -1, '应存在分类筛选函数');
  const block = SRC.slice(i0, SRC.indexOf('\n}', i0));
  assert.match(block, /ACTOR_STATE\.demandCat/, '应写入分类筛选状态');
  assert.match(block, /syncDemandCatChips\(\)/, '应调用芯片同步');
  assert.ok(SRC.includes('function syncDemandCatChips()'), '应提供芯片同步函数');
  const sync = SRC.slice(SRC.indexOf('function syncDemandCatChips()'));
  assert.match(sync.slice(0, 700), /data-cat/, '芯片同步应按 data-cat 匹配');
});

// ---------- 部署副本 ----------
test('部署副本与根权威文件保持一致', () => {
  assert.equal(fs.readFileSync(MIRROR, 'utf8'), SRC, 'deploy/frontend 副本必须与根文件一致');
});
