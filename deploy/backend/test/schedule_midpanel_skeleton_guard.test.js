// 录制档期「中栏面板 + 声优视图」骨架可见性守卫（2026-09-03）
//
// 背景 A：renderSched() 开头有 `var body=document.getElementById('schedBody'); if(!body) return;`。
//   档期草稿区块早已从主页面移除，schedBody 不存在 → 函数立即 return →
//   位于其尾部的 renderMidPanel(panelRows) 永远执行不到 →
//   「预约进度 / 录制日历 / 即将录制」三块永久停在初始占位文案「数据加载中…」。
//
// 背景 B：声优视图在「有需求、无声优预估」时走空态文案，同样看不到已搭好的框架。
//
// 契约：无录制数据时也要渲染出结构骨架（进度条 0/0、完整月历、空月提示、声优视图表头骨架），
//       且不得引入任何虚构业务数据。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const HTML = path.join(ROOT, 'preview-录制档期-精修版.html');
const DEPLOY = path.join(ROOT, 'deploy', 'frontend', 'preview-录制档期-精修版.html');
const SRC = fs.readFileSync(HTML, 'utf8');

// ---------- 1. renderSched 早退不得吞掉中栏渲染 ----------
test('schedBody 缺失时仍要渲染中栏三块', () => {
  const i0 = SRC.indexOf('function renderSched()');
  assert.ok(i0 > 0, '应存在 renderSched');
  const head = SRC.slice(i0, i0 + 900);
  assert.doesNotMatch(head, /var body=document\.getElementById\('schedBody'\);\s*\n\s*if\(!body\) return;/,
    '不得在渲染中栏前无条件 return');
  assert.match(head, /renderMidPanel/, 'schedBody 缺失分支必须先渲染中栏再返回');
});

// ---------- 2. 空数据时中栏出骨架而非「数据加载中」 ----------
test('预约进度在零数据时显示 0/0 骨架而非加载中', () => {
  const i0 = SRC.indexOf('function renderMidProgress(');
  const block = SRC.slice(i0, SRC.indexOf('\n  function ', i0 + 10));
  assert.doesNotMatch(block, /暂无可展示的录制数据/, '不应直接吐空文案，需渲染 0/0 骨架');
  assert.match(block, /if\(!allT\)\{[\s\S]*?mp-pr-legend skeleton/, '零数据应渲染三条 0/0 骨架 + 骨架图例');
});

test('录制日历零数据时仍画出完整月历网格', () => {
  const i0 = SRC.indexOf('function renderMidCalendar(');
  const block = SRC.slice(i0, SRC.indexOf('\n  // ★ 即将录制', i0));
  assert.match(block, /mp-cal-dow/, '应始终渲染星期表头');
  assert.match(block, /for\(var d=1; d<=last; d\+\+\)/, '应始终渲染整月日格');
});

test('即将录制零数据时显示当月无安排提示', () => {
  assert.match(SRC, /function upcomingEmptyText\(\)/, '应存在空月文案函数');
  assert.match(SRC, /月暂无待录制安排/, '空月提示文案应保留');
});

// ---------- 3. 声优视图骨架（2026-09-03 第三轮：声优视图与需求视图统一为 6 板架构） ----------
test('声优视图在有需求无预估时给出骨架提示而非纯空态', () => {
  // 声优视图与需求视图共用 renderActorSixBoard，骨架语义（lb-skeleton / 待录入声优预估）
  // 由公共函数统一处理；薄包装 renderActorRoleTable / renderActorDemandTable 保持简单
  assert.match(SRC, /function renderActorSixBoard\(/, '应存在共用 6 板入口');
  assert.match(SRC, /function renderActorRoleTable\(\)\{\s*return\s*renderActorSixBoard\('role'\);?\s*\}/, '声优视图应是 role 薄包装');
  assert.match(SRC, /lbe-skel|lb-skeleton|待录入声优预估/, '应给出与需求视图一致的骨架语义');
});

// ---------- 4. 不得引入虚构数据 ----------
test('骨架不得注入任何虚构业务数据', () => {
  const i0 = SRC.indexOf('function renderSched()');
  // 只截取 `if(!body){ ... return; }` 这一段早退分支，不要连带后面正常的 mock 逻辑
  const seg = SRC.slice(i0, SRC.indexOf('var rows=loadSched();', i0));
  assert.ok(seg.length > 0 && seg.length < 1200, '应能定位到早退分支');
  assert.doesNotMatch(seg, /buildMockDraftRows|buildMidPanelMockRows/, 'schedBody 缺失分支不得塞 mock');
  assert.match(seg, /PUBLISHED_ROWS/, '应改用真实已发布档期渲染中栏');
});

// ---------- 5. deploy 副本一致 ----------
test('deploy 副本与根权威文件一致', () => {
  assert.ok(fs.existsSync(DEPLOY), 'deploy 副本应存在');
  assert.equal(fs.readFileSync(DEPLOY, 'utf8'), SRC, '根文件与 deploy 副本必须一致');
});
