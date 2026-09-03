// 声优库编制分布图例 · 视觉与交互契约守卫（2026-09-03 用户截图定稿）
// 口径与录制档期需求视图一致，另加一条：分类芯片行整体下线，筛选改由图例承载
//   1. 色条不能有空隙
//   2. 图例 hover 有底色高亮
//   3. 图例点击直接触发分类筛选（原芯片能力平移过来，不丢功能）
//   4. 色块 10×10 圆角方块；图例走正文字体
//   5. 工具行下方的分类芯片按钮已移除（性别芯片保留）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..', 'preview-声优库-精修版.html');
const MIRROR = path.join(__dirname, '..', '..', 'frontend', 'preview-声优库-精修版.html');
const SRC = fs.readFileSync(ROOT, 'utf8');

const rule = name => {
  const i = SRC.indexOf(name + '{');
  assert.ok(i > -1, `应存在样式规则 ${name}`);
  return SRC.slice(i + name.length + 1, SRC.indexOf('}', i));
};

// ---------- 1. 色条无空隙 ----------
test('色条分段之间不留空隙', () => {
  assert.ok(!SRC.includes('.meter-seg:not(:last-child){border-right'), '不得用背景色描边把色条切开');
  assert.ok(!/\bgap:/.test(rule('.meter-bar')), '色条容器不得有 gap');
});

// ---------- 4. 色块 10×10 圆角方块 ----------
test('图例色块为 10×10 圆角方块', () => {
  const sw = rule('.meter-legend .sw');
  assert.match(sw, /width:10px/, '色块宽 10px');
  assert.match(sw, /height:10px/, '色块高 10px');
  assert.match(sw, /border-radius:3px/, '圆角方块');
});

// ---------- 4. 正文字体 ----------
test('图例使用正文字体与正文字号', () => {
  const legend = rule('.meter-legend');
  assert.ok(!/JetBrains Mono/.test(legend), '图例容器不得锁等宽字体');
  const li = rule('.meter-legend .li');
  assert.match(li, /font-family:inherit/, '条目字体继承正文');
  assert.match(li, /font-size:13px/, '字号对齐正文 13px');
  const bold = rule('.meter-legend .li b');
  assert.ok(!/JetBrains Mono/.test(bold), '数字也不得锁等宽字体');
});

// ---------- 2. hover 底色高亮 ----------
test('图例 hover / 选中态有底色高亮', () => {
  const li = rule('.meter-legend .li');
  assert.match(li, /padding:/, '需内边距承载底色');
  assert.match(li, /border-radius:/, '底色块需圆角');
  assert.ok(!/border-right:1px solid var\(--c-hairline\)/.test(li), '改为底色块后不应再有竖分隔线');
  const hover = rule('.meter-legend .li:hover');
  assert.match(hover, /background:/, 'hover 必须有底色');
  const on = rule('.meter-legend .li.on');
  assert.match(on, /background:/, '选中态必须有底色');
});

// ---------- 3. 点击筛选 ----------
test('图例可点击并复用既有分类筛选逻辑', () => {
  assert.match(SRC, /const cls = 'li' \+ \(active === c \?/, '图例条目应按选中态拼 li 类名');
  assert.match(SRC, /data-cat="\$\{/, '图例条目应带 data-cat 供状态匹配');
  assert.match(SRC, /onclick="setRosterCat/, '图例点击应走既有 setRosterCat');
  assert.match(SRC, /role="button"/, '图例条目需可达');
});

test('setRosterCat 兼容无按钮调用并支持再点取消', () => {
  const i0 = SRC.indexOf('function setRosterCat(cat, btn)');
  assert.ok(i0 > -1, '应存在 setRosterCat');
  const block = SRC.slice(i0, SRC.indexOf('\n}', i0));
  assert.match(block, /ROSTER_CAT === next/, '再点同类应取消回全部');
  assert.match(block, /renderMeter\(\)/, '应回写图例选中态');
  assert.ok(!/btn\.classList\.add/.test(block), '不得强依赖传入按钮，图例点击不传 btn');
});

// ---------- 5. 分类芯片下线 ----------
test('工具行分类芯片已移除，性别芯片保留', () => {
  assert.ok(!/data-cat="指挥官"[^>]*onclick="setRosterCat\('指挥官',this\)"/.test(SRC), '分类芯片按钮应已移除');
  assert.ok(!/>全部<\/button>/.test(SRC), '「全部」芯片按钮应已移除');
  assert.match(SRC, /data-gender="男"/, '性别筛选必须保留');
  assert.match(SRC, /data-gender="女"/, '性别筛选必须保留');
});

// ---------- 部署副本 ----------
test('部署副本与根权威文件保持一致', () => {
  assert.equal(fs.readFileSync(MIRROR, 'utf8'), SRC, 'deploy/frontend 副本必须与根文件一致');
});
