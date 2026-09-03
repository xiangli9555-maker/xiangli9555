// 全站「点击空白处清除筛选」统一行为守卫（2026-09-03）
//
// 用户诉求：所有页面点了筛选后，再点空白处默认清掉筛选、回到界面默认值。
//
// 用户拍板的三条边界（2026-09-03）：
//   1. 需求汇总页原有的筛选持久化（vo_filters_v1，7-24 定的"刷新不丢"）被本次覆盖
//      —— 点空白不仅清当前视图，也要清掉 localStorage，刷新后同样是默认态。
//   2. 版本 / release 属于导航状态（受外壳 ?release= 控制），**不清**。
//   3. 清除范围 = 筛选芯片与下拉 + 搜索框 + 日期 focus/日历选中 + 排序状态。
//
// 空白判定统一口径：命中任何交互元素（按钮/输入/链接/卡片/芯片/表头/浮层等）都不算空白。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const PAGES = {
  roster: 'preview-声优库-精修版.html',
  schedule: 'preview-录制档期-精修版.html',
  demands: 'preview-需求汇总-精修版.html',
  version: 'preview-版本节点-精修版.html',
};
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SRC = Object.fromEntries(Object.entries(PAGES).map(([k, f]) => [k, read(f)]));

// ---------- 1. 四页都要有统一入口 ----------
for (const [key, file] of Object.entries(PAGES)) {
  test(`${file} 提供 clearAllFilters 并绑定空白点击`, () => {
    const s = SRC[key];
    assert.match(s, /function clearAllFilters\(\)/, '应有统一的清除入口 clearAllFilters');
    assert.match(s, /function isBlankAreaClick\(/, '应有统一的空白判定 isBlankAreaClick');
    assert.match(s, /addEventListener\('click'/, '应绑定全局 click');
  });
}

// ---------- 2. 空白判定不得误伤交互元素 ----------
for (const [key, file] of Object.entries(PAGES)) {
  test(`${file} 空白判定排除按钮/输入/链接等交互元素`, () => {
    const s = SRC[key];
    const i0 = s.indexOf('function isBlankAreaClick(');
    const block = s.slice(i0, i0 + 2000);
    assert.match(block, /BUTTON/, '按钮不算空白');
    assert.match(block, /INPUT/, '输入框不算空白');
    assert.match(block, /SELECT|TEXTAREA/, '下拉/文本域不算空白');
    assert.match(block, /\[onclick\]|button,a,input/, '应用 closest 兜住内部子元素');
  });
}

// ---------- 3. 版本 / release 不得被清 ----------
test('需求汇总页清筛选时保留 release（导航状态）', () => {
  const s = SRC.demands;
  const i0 = s.indexOf('function clearAllFilters()');
  const block = s.slice(i0, s.indexOf('\nfunction ', i0 + 10));
  assert.doesNotMatch(block, /filterRelease\s*=\s*''/, 'release 属导航状态，不得清空');
  assert.match(block, /filterArea\s*=\s*''/, 'AREA 应清空');
  assert.match(block, /filterStatus\s*=\s*''/, '状态应清空');
  assert.match(block, /filterCw\s*=\s*''/, '文案策划应清空');
});

test('版本节点页清筛选时保留版本选择', () => {
  const s = SRC.version;
  const i0 = s.indexOf('function clearAllFilters()');
  const block = s.slice(i0, s.indexOf('\nfunction ', i0 + 10));
  assert.doesNotMatch(block, /currentFilter\s*=\s*'all'/, '版本筛选属导航状态，不得重置');
  assert.match(block, /roleFilter\s*=\s*null/, '视角过滤应清');
  assert.match(block, /nodeFilter\s*=\s*null/, '关键节点过滤应清');
  assert.match(block, /catFilter\s*=\s*null/, '分类过滤应清');
});

// ---------- 4. 搜索 / 排序 / 日期 focus ----------
test('需求汇总页清筛选时同时清搜索与排序栈', () => {
  const s = SRC.demands;
  const i0 = s.indexOf('function clearAllFilters()');
  const block = s.slice(i0, s.indexOf('\nfunction ', i0 + 10));
  assert.match(block, /searchTxt\s*=\s*''/, '搜索词应清空');
  assert.match(block, /sortStack\.length\s*=\s*0|sortStack\s*=\s*\[\]/, '排序栈应复位');
  assert.match(block, /headerFilters\s*=\s*\{\}/, '表头筛选应清空');
});

test('声优库页清筛选时清大类/性别/搜索', () => {
  const s = SRC.roster;
  const i0 = s.indexOf('function clearAllFilters()');
  const block = s.slice(i0, s.indexOf('\nfunction ', i0 + 10));
  assert.match(block, /ROSTER_CAT\s*=\s*''/, '大类应清空');
  assert.match(block, /ROSTER_GENDER\s*=\s*''/, '性别应清空');
  assert.match(block, /rosterSearch/, '搜索框应清空');
});

test('录制档期页清筛选时清日期 focus', () => {
  const s = SRC.schedule;
  const i0 = s.indexOf('function clearAllFilters()');
  const block = s.slice(i0, s.indexOf('\nfunction ', i0 + 10));
  assert.match(block, /MID_FOCUS_YMD\s*=\s*null/, '日历日期聚焦应清除');
  assert.match(block, /ACTOR_STATE\.lang\s*=\s*'all'/, '语种应回全部');
});

// ---------- 5. 持久化一并清除（用户明确覆盖 7-24 规则）----------
test('需求汇总页清筛选时同步清掉 localStorage 持久化', () => {
  const s = SRC.demands;
  const i0 = s.indexOf('function clearAllFilters()');
  const block = s.slice(i0, s.indexOf('\nfunction ', i0 + 10));
  assert.match(block, /saveFilters\(\)/, '应回写持久化，使刷新后同为默认态');
});

// ---------- 6. 无筛选时不做无谓重渲染 ----------
for (const [key, file] of Object.entries(PAGES)) {
  test(`${file} 无激活筛选时点空白不重复渲染`, () => {
    const s = SRC[key];
    assert.match(s, /function hasActiveFilters\(/, '应有 hasActiveFilters 短路判断');
  });
}

// ---------- 7. deploy 副本一致 ----------
for (const [key, file] of Object.entries(PAGES)) {
  test(`${file} deploy 副本与根权威文件一致`, () => {
    const dep = path.join(ROOT, 'deploy', 'frontend', file);
    assert.ok(fs.existsSync(dep), 'deploy 副本应存在');
    assert.equal(fs.readFileSync(dep, 'utf8'), SRC[key], '根文件与 deploy 副本必须一致');
  });
}
