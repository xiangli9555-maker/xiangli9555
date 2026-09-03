// 录制档期「需求视图」骨架可见性守卫（2026-09-03）
//
// 背景：线上 37 条真实需求 release_plan=Yang1.0、AREA 齐全，但 voice_estimates 全为 null。
// 旧实现 aggregateByDemand 里 `if(!Array.isArray(ves)) return;` 会把这类需求整条丢弃，
// 导致整页只剩空态文案，用户无法验证已搭好的框架。
//
// 契约：voice_estimates 缺失时仍要产出一条「占位行」，让 AREA 分组 / 需求卡骨架照常渲染，
//       角色区显示「待录入声优预估」，且占位行不得被计入待约数、完成度与角色构成统计。
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
test('占位行不计入待约数与完成度', () => {
  assert.match(SRC, /!r\.isPlaceholder\s*&&\s*r\.status === 'pending'/, '待约计数须排除占位行');
  assert.match(SRC, /rows\.filter\(r\s*=>\s*!r\.isPlaceholder\)/, '档期总数须排除占位行');
});

test('角色构成统计仅统计真实 role，占位行无 role 自然被跳过', () => {
  const i0 = SRC.indexOf('function collectDemandRosterStats(');
  const block = SRC.slice(i0, SRC.indexOf('\nfunction ', i0 + 10));
  assert.match(block, /if\(!role \|\| roleCats\.has\(role\)\) return;/, '无 role 应跳过，占位行不入统计');
});

// ---------- 4. 骨架 UI 呈现 ----------
test('需求卡对占位行渲染骨架提示而非角色芯片', () => {
  assert.match(SRC, /dcard-skeleton/, '应存在骨架样式类');
  assert.match(SRC, /待录入声优预估/, '应给出明确的骨架文案');
});

test('占位需求卡的头部状态不显示「待预约」误导文案', () => {
  assert.match(SRC, /allPlaceholder/, '应区分全占位的需求卡');
});

// ---------- 5. 空态文案只在真的没有需求时出现 ----------
test('空态判定基于需求条数，而非声优预估条数', () => {
  const i0 = SRC.indexOf('function renderActorDemandTable(');
  const block = SRC.slice(i0, i0 + 2600);
  assert.match(block, /actorDemandEmpty/, '应保留空态节点引用');
});

// ---------- 6. deploy 副本一致 ----------
test('deploy 副本与根权威文件一致', () => {
  assert.ok(fs.existsSync(DEPLOY), 'deploy 副本应存在');
  assert.equal(fs.readFileSync(DEPLOY, 'utf8'), SRC, '根文件与 deploy 副本必须一致');
});
