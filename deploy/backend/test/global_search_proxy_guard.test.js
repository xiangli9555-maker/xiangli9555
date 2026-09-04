// 顶栏 #globalSearch 代理守卫（2026-09-04，B 方案）
//
// 背景：用户在顶栏「搜索任务、声优、GP Event、文件…」输「test」无反应。
// 真相：input 元素全文件仅出现 1 次（自身），零 JS 绑定 → 死元素。
// 方案：把顶栏搜索代理到当前 iframe 子页对应搜索框。
//   - 单向 top→inner：top 输值 → 写到子页 #searchInput / #rosterSearch / #actorSearch 并派发 input 事件，
//                     让子页自处理函数（addEventListener('input',...) 或 oninput="..."）触发重渲染
//   - 双向 inner→top：监听子页 isTrusted=true 的真实输入事件，反向同步顶栏（合成事件 isTrusted=false 跳过，避免反馈循环）
//   - 视图无搜索框（milestones / ai）静默 no-op
//   - 切视图时清空顶栏 + 挂起值，避免上一个视图的搜索词污染新视图
//   - iframe 未就绪 / 子页元素未挂时挂起值，等 iframe load 补发
//
// 契约（保护期不被回退）：
//   1. VIEW_SEARCH_MAP 三个映射 + 注释含方案名（B 方案）
//   2. proxyGlobalSearchToIframe 存在并实现「派发 input 事件」核心
//   3. attachInnerToTopSync 存在并实现「e.isTrusted 跳过合成事件」反反馈
//   4. #globalSearch 有 input 监听器
//   5. applyView 中清空 #globalSearch + 清挂起值
//   6. viewFrame load 钩子挂同步监听 + 补发挂起
//   7. 部署副本与根权威文件 byte-equal
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', 'vo-manager-refined.html');
const MIRROR = path.join(__dirname, '..', '..', 'frontend', 'vo-manager-refined.html');
const SRC = fs.readFileSync(ROOT, 'utf8');
const has = (re, msg) => assert.ok(re.test(SRC), msg);

// ---------- 1. 映射 + 注释 ----------
test('VIEW_SEARCH_MAP 含三个映射（demands/actors/calendar）', () => {
  assert.match(SRC, /VIEW_SEARCH_MAP\s*=\s*\{[^}]*demands\s*:\s*['"]searchInput['"]/, 'demands→searchInput');
  assert.match(SRC, /VIEW_SEARCH_MAP\s*=\s*\{[^}]*actors\s*:\s*['"]rosterSearch['"]/, 'actors→rosterSearch');
  assert.match(SRC, /VIEW_SEARCH_MAP\s*=\s*\{[^}]*calendar\s*:\s*['"]actorSearch['"]/, 'calendar→actorSearch');
  assert.match(SRC, /B 方案/, '应标注 B 方案字样');
});
test('不映射版本节点 / AI 助手（这俩页无搜索框）', () => {
  assert.doesNotMatch(SRC, /VIEW_SEARCH_MAP\s*=\s*\{[^}]*milestones\s*:/, 'milestones 不应在映射表里');
  assert.doesNotMatch(SRC, /VIEW_SEARCH_MAP\s*=\s*\{[^}]*ai\s*:/, 'ai 不应在映射表里');
});

// ---------- 2. top→inner 代理核心 ----------
test('proxyGlobalSearchToIframe 派发 input 事件让子页自处理函数跑', () => {
  has(/function\s+proxyGlobalSearchToIframe\s*\(\s*\)\s*\{/, '应存在 proxyGlobalSearchToIframe 函数');
  has(/VIEW_SEARCH_MAP\[view\]/, '应通过 VIEW_SEARCH_MAP 取子页搜索框 id');
  has(/target\.dispatchEvent\(\s*new\s+Event\(\s*['"]input['"]/, '应派发 input 事件');
  has(/bubbles:\s*true/, '派发应冒泡');
});

// ---------- 3. inner→top 反向同步（反反馈） ----------
test('attachInnerToTopSync 监听 isTrusted 真实事件，跳过合成事件避免反馈', () => {
  has(/function\s+attachInnerToTopSync\s*\(\s*\)\s*\{/, '应存在 attachInnerToTopSync 函数');
  has(/e\.isTrusted/, '应通过 e.isTrusted 区分真实 vs 合成事件');
  has(/target\.__globalSearchBound/, '应通过属性标记避免重复挂载（每个子页搜索框只挂一次）');
});

// ---------- 4. 顶栏 input 监听 + 挂起机制 ----------
test('#globalSearch 监听 input 事件', () => {
  has(/document\.getElementById\(\s*['"]globalSearch['"]\s*\)\?\.addEventListener\(\s*['"]input['"]/, '应绑定 input 事件');
});
test('input 监听内含挂起值逻辑（iframe 未就绪时挂起，load 时补发）', () => {
  has(/_pendingGlobalSearch\s*=/, '应有 _pendingGlobalSearch 挂起变量');
  has(/if\(\s*!ok\s*\)\s*_pendingGlobalSearch/, '转发失败时挂起当前值');
});

// ---------- 5. applyView 清理 ----------
test('applyView 中清空顶栏 + 挂起值', () => {
  // 取 applyView 函数体
  const i0 = SRC.indexOf('function applyView(');
  assert.ok(i0 > -1, '应存在 applyView 函数');
  const end = SRC.indexOf('\n}\n', i0);
  const body = SRC.slice(i0, end > -1 ? end : i0 + 3000);
  assert.match(body, /if\(gs\)\s*gs\.value\s*=\s*['"]['"]/, '应清空顶栏搜索框');
  assert.match(body, /_pendingGlobalSearch\s*=\s*null/, '应清挂起值');
});

// ---------- 6. iframe load 钩子 ----------
test('viewFrame load 钩子挂 inner→top 同步监听 + 补发挂起', () => {
  has(/addEventListener\(\s*['"]load['"][\s\S]{0,300}attachInnerToTopSync/, 'load 钩子应调 attachInnerToTopSync');
  has(/setTimeout\(\s*proxyGlobalSearchToIframe\s*,\s*0\s*\)/, 'load 时应用 setTimeout 补发挂起值');
});

// ---------- 7. 部署副本一致 ----------
test('部署副本与根权威文件保持一致', () => {
  assert.ok(fs.existsSync(MIRROR), 'deploy 副本应存在');
  assert.equal(fs.readFileSync(MIRROR, 'utf8'), SRC, '根文件与 deploy 副本必须一致');
});
