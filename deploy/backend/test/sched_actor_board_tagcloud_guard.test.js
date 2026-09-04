// 录制档期页 · 声优/需求视图看板 → 标签云式卡片（2026-09-04 用户定稿）
// 守卫目标：
//   1. 卡片只两行（上行=角色名+总句数，下行=需求标签），不再显示演员名
//   2. 需求标签三态：已约=绿底划线✓、待约=虚线灰底—、未约=按句数着色（黄≥50/蓝20-49/灰<20）
//   3. 部分已约列额外显示「已约/总需求」进度
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

const projectRoot = path.resolve(__dirname, '../../..');
const SRC = path.join(projectRoot, 'preview-录制档期-精修版.html');
const DEPLOY = path.join(projectRoot, 'deploy/frontend/preview-录制档期-精修版.html');
const read = (p) => fs.readFileSync(p, 'utf8');

test('1. 部署镜像与根文件 byte-equal', () => {
  assert.ok(fs.existsSync(DEPLOY), 'deploy 副本应存在');
  assert.equal(read(DEPLOY), read(SRC), 'deploy 副本必须与根文件 byte-equal');
});

test('2. 标签云 CSS 必备类（cat-band / cardB / cardB-tag / col-body）', () => {
  const css = read(SRC);
  assert.match(css, /\.col-body\{[^}]*display:flex[^}]*flex-direction:column/, '.col-body 列内容器定义缺失');
  assert.match(css, /\.cat-band\{[^}]*border-left:3px solid/, '.cat-band 左侧色条缺失');
  assert.match(css, /\.cat-band[^}]*--cat-color/, 'cat-band 色条应通过 --cat-color CSS 变量绑定');
  assert.match(css, /\.cardB\{[^}]*display:flex[^}]*flex-direction:column/, '.cardB 卡片容器定义缺失');
  assert.match(css, /\.cardB-head\{/, '.cardB-head 头部容器缺失');
  assert.match(css, /\.cardB-name\{/, '.cardB-name 角色名/需求名样式缺失');
  assert.match(css, /\.cardB-total\{/, '.cardB-total 总数样式缺失');
  assert.match(css, /\.cardB-progress\{/, '.cardB-progress 进度样式缺失');
  assert.match(css, /\.cardB-tags\{/, '.cardB-tags 标签云容器缺失');
  assert.match(css, /\.cardB-tag\{/, '.cardB-tag 单标签样式缺失');
  assert.match(css, /\.cardB-tag \.tn\{/, 'tag 文字 .tn 样式缺失');
  assert.match(css, /\.cardB-tag \.tc\{/, 'tag 计数 .tc 样式缺失');
  assert.match(css, /\.cardB-tag \.tc\.hi\{/, '未约标签高句数着色（黄≥50）缺失');
  assert.match(css, /\.cardB-tag \.tc\.mid\{/, '未约标签中句数着色（蓝 20-49）缺失');
  assert.match(css, /\.cardB-tag \.tc\.lo\{/, '未约标签低句数着色（灰<20）缺失');
  assert.match(css, /\.cardB-tag\.done\{/, '已约 tag 样式缺失');
  assert.match(css, /\.cardB-tag\.done \.tn\{[^}]*text-decoration:line-through/, '已约 tag 应带删除线');
  assert.match(css, /\.cardB-tag\.wait\{/, '待约 tag 样式缺失');
  assert.match(css, /\.cardB-tag\.wait\{[^}]*border-style:dashed/, '待约 tag 应为虚线边框');
  assert.match(css, /\.cardB-req \.cardB-tags\{[^}]*padding-left:0/, '需求视图应去掉头像左 padding');
});

test('3. JS · 二次聚合函数 buildCardBList 存在并按 viewType 区分 key', () => {
  const js = read(SRC);
  assert.match(js, /function buildCardBList\(viewType, arr\)\{[\s\S]*?viewType === 'role' \? \(r\.role \|\| ''\) : \(r\.story \|\| ''\)[\s\S]*?\}/,
    'buildCardBList 必须按 viewType=role 走 r.role / viewType=demand 走 r.story');
  assert.match(js, /function buildCardBList[\s\S]*?CAT_ORDER\s*=\s*\['指挥官','干员','Boss','AI兵','NPC','AI系统音'\]/,
    'buildCardBList 必须按固定 6 类 CAT_ORDER 输出');
});

test('4. JS · boardHtml 渲染模板使用 cardB，不再用 lbe', () => {
  const js = read(SRC);
  // 抽取 boardHtml 函数体范围
  const m = js.match(/const boardHtml = \(kind, label, arr, skeleton\) => \{[\s\S]*?^\s*\};/m);
  assert.ok(m, '必须能找到 boardHtml 箭头函数定义');
  const body = m[0];
  assert.match(body, /<div class="cardB/, 'boardHtml 必须输出 <div class="cardB">');
  assert.match(body, /cardB-tag/, 'boardHtml 必须输出 .cardB-tag 标签云');
  assert.match(body, /<div class="col-body">/, 'boardHtml 主体容器必须用 .col-body');
  assert.equal(/class="lbe/.test(body), false, 'boardHtml 函数体不应再输出 .lbe 旧卡片');
  assert.equal(/class="lbe-skel/.test(body), false, 'boardHtml 函数体不应再输出 .lbe-skel 骨架');
  assert.equal(/class="lbe-none/.test(body), false, 'boardHtml 函数体不应再输出 .lbe-none 空态');
});

test('5. JS · boardHtml 不再渲染 actor 字段（用户要求去掉演员名）', () => {
  const js = read(SRC);
  const m = js.match(/const boardHtml = \(kind, label, arr, skeleton\) => \{[\s\S]*?^\s*\};/m);
  assert.ok(m, '必须能找到 boardHtml 函数体');
  const body = m[0];
  // 旧代码里有 r.actor / actor 出现在模板字面量里
  assert.equal(/r\.actor/.test(body), false, 'boardHtml 函数体不应再读 r.actor 字段');
  // 模板字符串里包含"· "加 actor 的旧版拼接也禁掉
  assert.equal(/\$\{r\.actor/.test(body), false, 'boardHtml 函数体不应再插值 r.actor');
});

test('6. JS · 部分已约列渲染 cardB-progress 进度（已约/总需求）', () => {
  const js = read(SRC);
  const m = js.match(/const boardHtml = \(kind, label, arr, skeleton\) => \{[\s\S]*?^\s*\};/m);
  assert.ok(m, '必须能找到 boardHtml 函数体');
  const body = m[0];
  // 进度只在 kind === 'up' 时输出
  assert.match(body, /kind === 'up'[\s\S]*?cardB-progress/, 'boardHtml 必须在 kind===up 时输出 .cardB-progress');
  // 进度格式：<span class="booked">N</span>/M
  assert.match(body, /<span class="booked">\$\{card\.bookedCount\}<\/span>\/\$\{card\.totalCount\}/,
    'cardB-progress 必须显示 已约数/总需求数');
});

test('7. JS · 待预约列按句数三态着色（hi/mid/lo）', () => {
  const js = read(SRC);
  const m = js.match(/const boardHtml = \(kind, label, arr, skeleton\) => \{[\s\S]*?^\s*\};/m);
  assert.ok(m);
  const body = m[0];
  // 待预约列：t.est >= 50 → hi，>= 20 → mid，else lo（用 \s* 容忍任意缩进/换行）
  assert.match(body, /if\s*\(n\s*>=\s*50\)\s*tcCls\s*=\s*'tc hi';\s*else if\s*\(n\s*>=\s*20\)\s*tcCls\s*=\s*'tc mid';\s*else\s*tcCls\s*=\s*'tc lo'/,
    '待预约列必须按句数三档着色（≥50=hi / 20-49=mid / <20=lo）');
});

test('8. JS · 已约/待约 tag 三态：done/wait 走固定样式，done 数字带 ✓', () => {
  const js = read(SRC);
  const m = js.match(/const boardHtml = \(kind, label, arr, skeleton\) => \{[\s\S]*?^\s*\};/m);
  assert.ok(m);
  const body = m[0];
  // 已约（done）走 cardB-tag.done + tc 文本为 "N ✓"
  assert.match(body, /cls \+= ' done';\s*\n?\s*tcTxt = `\$\{t\.est \|\| 0\} \u2713`/,
    '已约 tag 必须 .cardB-tag.done + tc 文案 "N ✓"');
  // 待约（wait）走 cardB-tag.wait + tc 文本为 "—"
  assert.match(body, /cls \+= ' wait';\s*\n?\s*tcTxt = '—'/,
    '待约 tag 必须 .cardB-tag.wait + tc 文案 "—"');
});

test('9. JS · 需求视图 tag 拼「角色 · 大类」，声优视图 tag 为需求名', () => {
  const js = read(SRC);
  const m = js.match(/const boardHtml = \(kind, label, arr, skeleton\) => \{[\s\S]*?^\s*\};/m);
  assert.ok(m);
  const body = m[0];
  // demand 视图：tagLabel = 角色名 · 大类
  assert.match(body, /viewType === 'role'\s*\n?\s*\?\s*t\.label\s*\n?\s*:\s*`\$\{t\.label\} \u00b7 \$\{t\.cat \|\| '未分类'\}`/,
    'demand 视图 tag 文字必须为「角色 · 大类」');
});
