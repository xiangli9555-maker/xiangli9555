// 录制档期「需求视图」骨架可见性守卫（2026-09-03）
//
// 背景：线上 37 条真实需求 release_plan=Yang1.0、AREA 齐全，但 voice_estimates 全为 null。
// 旧实现 aggregateByDemand 里 `if(!Array.isArray(ves)) return;` 会把这类需求整条丢弃，
// 导致整页只剩空态文案，用户无法验证已搭好的框架。
//
// 契约：voice_estimates 缺失时仍要产出一条「占位行」，让语种产线 × 3 状态板照常渲染，
//       占位行沉底为「待录入声优预估」提示条，且占位行不得被计入状态分流与角色构成统计。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const HTML = path.join(ROOT, 'preview-录制档期-精修版.html');
const DEPLOY = path.join(ROOT, 'deploy', 'frontend', 'preview-录制档期-精修版.html');
const SRC = fs.readFileSync(HTML, 'utf8');

// ---------- 1. 不再整条丢弃无预估的需求 ----------
test('voice_estimates 缺失时不得整条 return 丢弃需求', () => {
  const i0 = SRC.indexOf('function aggregateByDemand(');
  assert.ok(i0 > 0, '应存在 aggregateByDemand');
  const block = SRC.slice(i0, SRC.indexOf('\nfunction ', i0 + 10));
  assert.doesNotMatch(block, /if\(!Array\.isArray\(ves\)\)\s*return;/, '旧的整条丢弃分支必须移除');
  assert.match(block, /PLACEHOLDER|isPlaceholder/, '应产出占位行标记');
});

// ---------- 2. 占位行字段契约 ----------
test('占位行保留 AREA 与需求名，便于骨架分组', () => {
  const i0 = SRC.indexOf('function aggregateByDemand(');
  const block = SRC.slice(i0, SRC.indexOf('\nfunction ', i0 + 10));
  assert.match(block, /isPlaceholder:\s*true/, '占位行应带 isPlaceholder:true');
  assert.match(block, /area:\s*area/, '占位行须保留 area 供 AREA 分组');
  assert.match(block, /story:\s*story/, '占位行须保留 story 供需求卡标题');
});

// ---------- 3. 占位行不污染统计 ----------
test('占位行不计入状态板与统计', () => {
  // 2026-09-03 改版：需求视图 = 语种产线 × 3 状态板（6 块向下看板），
  // 占位行不进板、沉底为 ph-strip 提示条；板内条目只来自剔除占位行后的 realRows。
  assert.match(SRC, /const realRows = list\.filter\(r => !r\.isPlaceholder\)/, '需求视图渲染须先剔除占位行');
  assert.match(SRC, /const phRows = list\.filter\(r => r\.isPlaceholder\)/, '占位行应单独收集沉底');
});

// ---------- 4. 骨架 UI 呈现 ----------
test('状态板对全占位渲染骨架文案，占位行沉底提示条', () => {
  assert.match(SRC, /lb-skeleton/, '应存在看板骨架样式类');
  assert.match(SRC, /lbe-skel/, '板内条目应有骨架形态');
  assert.match(SRC, /待录入声优预估/, '应给出明确的骨架文案');
  assert.match(SRC, /ph-strip/, '占位行应有沉底提示条容器');
});

test('占位需求卡的头部状态不显示「待预约」误导文案', () => {
  assert.match(SRC, /allPlaceholder/, '应区分全占位的需求卡');
});

// ---------- 5. 空态文案只在真的没有需求时出现 ----------
test('空态判定基于需求条数，而非声优预估条数', () => {
  // 2026-09-03 第三轮：renderActorDemandTable 改为 renderActorSixBoard 的薄包装，
  // 空态节点引用 actorDemandEmpty 由公共函数处理
  assert.match(SRC, /function renderActorSixBoard\(/, '应保留共用渲染入口');
  assert.match(SRC, /function renderActorDemandTable\(\)\{\s*return\s*renderActorSixBoard\('demand'\);?\s*\}/, '需求视图应是 renderActorSixBoard 的 demand 薄包装');
  assert.match(SRC, /actorDemandEmpty/, '公共函数应保留空态节点引用');
});

// ---------- 6. deploy 副本一致 ----------
test('deploy 副本与根权威文件一致', () => {
  assert.ok(fs.existsSync(DEPLOY), 'deploy 副本应存在');
  assert.equal(fs.readFileSync(DEPLOY, 'utf8'), SRC, '根文件与 deploy 副本必须一致');
});
