// 「角色信息」hover 卡定高守卫（2026-09-03）
//
// 用户定稿：卡片内容负载过多（选角备注含基础信息 + 声音要求 + 背景故事，
// 动辄上千字），原实现不限高，整卡被撑到 1000px+ 直接超出视口。
// 要求：卡片总高固定为截图红框大小（≈470px），备注区超出部分以省略号收束。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const HTML = path.join(ROOT, 'preview-声优库-精修版.html');
const DEPLOY = path.join(ROOT, 'deploy', 'frontend', 'preview-声优库-精修版.html');
const SRC = fs.readFileSync(HTML, 'utf8');

test('卡片容器定高，不再被长文撑爆', () => {
  const m = SRC.match(/\.vomi-casting-tip\{([^}]*)\}/);
  assert.ok(m, '应存在 .vomi-casting-tip 容器样式');
  const css = m[1];
  assert.match(css, /height:4[0-9]{2}px/, '总高应固定在 4xx px 区间（对齐用户红框）');
  assert.match(css, /display:flex/, '需用 flex 纵向布局才能让备注区吃掉剩余空间');
  assert.match(css, /flex-direction:column/, '应为纵向 flex');
});

test('头部与底部不参与压缩，始终可见', () => {
  assert.match(SRC, /\.ct-hd\{[^}]*flex-shrink:0/, '头部不得被压缩');
  assert.match(SRC, /\.ct-foot\{[^}]*flex-shrink:0/, '底部操作条不得被压缩');
});

test('备注区独立收束，超出以省略号呈现', () => {
  // 备注块吃掉剩余高度，内部 .ct-quote 用 line-clamp 截断
  assert.match(SRC, /\.ct-block\.ct-block-note\{[^}]*(flex:1|min-height:0)/,
    '备注块应占据剩余空间并允许收缩');
  const q = SRC.match(/\.vomi-casting-tip \.ct-quote\{([^}]*)\}/);
  assert.ok(q, '应存在 .ct-quote 样式');
  assert.match(q[1], /-webkit-line-clamp:\s*\d+/, '应用 line-clamp 截断为省略号');
  assert.match(q[1], /-webkit-box-orient:vertical/, 'line-clamp 需配 box-orient');
  assert.match(q[1], /overflow:hidden/, '截断需 overflow:hidden 生效');
});

test('备注块渲染时带专属类名，供定高样式命中', () => {
  const i0 = SRC.indexOf('选角备注');
  assert.ok(i0 > 0, '应存在选角备注区块');
  const block = SRC.slice(Math.max(0, i0 - 400), i0 + 200);
  assert.match(block, /ct-block ct-block-note/, '备注块应带 ct-block-note 类名');
});

test('内容被截断时给出可查看完整内容的提示', () => {
  // 省略号会隐藏信息，必须让用户知道「还有内容、去哪看」
  assert.match(SRC, /ct-quote-more|完整内容|下载 Word/, '应提示完整内容的获取途径');
});

test('deploy 副本与根权威文件一致', () => {
  assert.ok(fs.existsSync(DEPLOY), 'deploy 副本应存在');
  assert.equal(fs.readFileSync(DEPLOY, 'utf8'), SRC, '根文件与 deploy 副本必须一致');
});
