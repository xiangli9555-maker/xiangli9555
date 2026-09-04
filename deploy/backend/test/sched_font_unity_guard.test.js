// 录制档期页"数字字体统一"守卫（2026-09-04 用户定稿）
//
// 规则要点：
//   所有页内数字/时间/进度/统计相关元素的 font-family 必须统一为 var(--font-ui)
//   （即 Microsoft YaHei UI，无衬线），不再使用 JetBrains Mono / Inter 优先。
//
// 覆盖：日历日期 / 月份标题 / 预约进度 / 4 状态统计 / 筛选芯片计数 /
//       风险预警数字 / 表格行内数字 / toast / etc.

'use strict';
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'preview-录制档期-精修版.html');
const DEPLOY = path.join(ROOT, 'deploy', 'frontend', 'preview-录制档期-精修版.html');

function read(p){ return fs.readFileSync(p, 'utf8'); }

let html;
test('源文件存在', () => {
  assert.ok(fs.existsSync(SRC), 'preview-录制档期-精修版.html 应存在');
  html = read(SRC);
});

// ---------- 1. CSS 规则层：6 处用户截图重点元素 ----------
// 某些选择器可能出现多次（如 .mp-pr-val 被不同模块复用）；只要任一规则含 var(--font-ui) 即视为已统一。
function anyRuleHasFontUi(cls){
  const escSel = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escSel + '\\s*\\{[^}]+\\}', 'g');
  const matches = html.match(re) || [];
  return { matches, hit: matches.some(s => /font-family:\s*var\(--font-ui\)/.test(s)) };
}

test('CSS：日历日期（.mp-cal-day）字体为 var(--font-ui)', () => {
  const { matches, hit } = anyRuleHasFontUi('.mp-cal-day');
  assert.ok(matches.length, '.mp-cal-day 规则应存在');
  assert.ok(hit, 'mp-cal-day 应至少一条规则使用 var(--font-ui)，不再用 JetBrains Mono');
});

test('CSS：月份标题（.mp-cal-title）字体为 var(--font-ui)', () => {
  const { matches, hit } = anyRuleHasFontUi('.mp-cal-title');
  assert.ok(matches.length, '.mp-cal-title 规则应存在');
  assert.ok(hit, 'mp-cal-title 应至少一条规则使用 var(--font-ui)');
});

test('CSS：周几（.mp-cal-dow）字体为 var(--font-ui)', () => {
  const { matches, hit } = anyRuleHasFontUi('.mp-cal-dow');
  assert.ok(matches.length, '.mp-cal-dow 规则应存在');
  assert.ok(hit, 'mp-cal-dow 应至少一条规则使用 var(--font-ui)');
});

test('CSS：预约进度（.stat-value）字体为 var(--font-ui)', () => {
  const { matches, hit } = anyRuleHasFontUi('.stat-value');
  assert.ok(matches.length, '.stat-value 规则应存在');
  assert.ok(hit, 'stat-value 应至少一条规则使用 var(--font-ui)（24/24 等数字）');
});

test('CSS：筛选芯片计数（.actor-toolbar .tb-btn .dim-count）字体为 var(--font-ui)', () => {
  const { matches, hit } = anyRuleHasFontUi('.actor-toolbar .tb-btn .dim-count');
  assert.ok(matches.length, 'actor-toolbar .tb-btn .dim-count 规则应存在');
  assert.ok(hit, '筛选芯片计数应至少一条规则使用 var(--font-ui)（全部 8 / SOL 2 等）');
});

test('CSS：line-head 4 状态数字（.lh-stat-n）字体为 var(--font-ui)', () => {
  const { matches, hit } = anyRuleHasFontUi('.lh-stat-n');
  assert.ok(matches.length, '.lh-stat-n 规则应存在');
  assert.ok(hit, 'lh-stat-n 应至少一条规则使用 var(--font-ui)（4 状态数字）');
});

test('CSS：风险预警数字（.risk-stats .risk-stat .v）字体为 var(--font-ui)', () => {
  const { matches, hit } = anyRuleHasFontUi('.risk-stats .risk-stat .v');
  assert.ok(matches.length, '.risk-stats .risk-stat .v 规则应存在');
  assert.ok(hit, '风险预警数字应至少一条规则使用 var(--font-ui)（受影响需求数 / 距 VO 资源交付）');
});

test('CSS：风险区域 pill 数字（.risk-area-pill .num）字体为 var(--font-ui)', () => {
  const { matches, hit } = anyRuleHasFontUi('.risk-area-pill .num');
  assert.ok(matches.length, '.risk-area-pill .num 规则应存在');
  assert.ok(hit, '风险区域 pill 数字应至少一条规则使用 var(--font-ui)');
});

// ---------- 2. CSS 规则层：剩余与数字相关的元素 ----------
test('CSS：录制日历附加元素（.mp-pr-val / .mp-pr-legend）字体为 var(--font-ui)', () => {
  for (const cls of ['.mp-pr-val', '.mp-pr-legend', '.mp-up-meta', '.mp-up-pill']) {
    const { matches, hit } = anyRuleHasFontUi(cls);
    assert.ok(matches.length, `${cls} 规则应存在`);
    assert.ok(hit, `${cls} 应至少一条规则使用 var(--font-ui)`);
  }
});

test('CSS：表格头 / tag / 截止日期 / sync-hint / tab-hint 字体为 var(--font-ui)', () => {
  const selectors = [
    '.sched-table th',
    '.tag',
    '.page-title .deadline-meta .deadline-rel',
    '.page-title .deadline-meta .deadline-dates',
    '.page-title .deadline-meta .deadline-slash',
    '.sync-hint',
    '.view-tab .tab-hint',
    '.actor-table th',
    '.actor-stat .lbl',
    '.actor-current-release',
    '.sched-cell',
    '.sched-collapsed-count',
    '.actor-tag-lang',
    '.actor-cov-item .est',
    '.actor-lines-total',
    '.actor-status',
  ];
  for (const sel of selectors) {
    const { matches, hit } = anyRuleHasFontUi(sel);
    assert.ok(matches.length, `${sel} 规则应存在`);
    assert.ok(hit, `${sel} 应至少一条规则使用 var(--font-ui)`);
  }
});

// ---------- 3. CSS 规则层：.main 容器字体归一 ----------
test('CSS：.main 容器使用 var(--font-ui)（不再用 Inter + JetBrains Mono）', () => {
  const { matches, hit } = anyRuleHasFontUi('.main, .main table, .main td, .main th, .main p, .main li, .main .wrap');
  assert.ok(matches.length, '.main 容器规则应存在');
  assert.ok(hit, '.main 容器应至少一条规则使用 var(--font-ui)');
});

// ---------- 4. 反向：禁止 JetBrains Mono 与 monospace 出现在数字相关位置 ----------
test('反向：CSS 规则中不再有 JetBrains Mono 字体声明（除注释外）', () => {
  // 抠出所有 CSS 规则体，排除 /* 注释 */ 行
  const cssStripped = html.replace(/\/\*[\s\S]*?\*\//g, '');
  const hits = cssStripped.match(/font-family:\s*'JetBrains Mono'[^;}]*/g) || [];
  assert.deepStrictEqual(hits, [],
    `CSS 规则中不应再有 JetBrains Mono 字体声明：\n${hits.join('\n')}`);
});

test('反向：CSS 规则中不再有 font-family: monospace（除已有合法 fallback 链）', () => {
  const cssStripped = html.replace(/\/\*[\s\S]*?\*\//g, '');
  // monospace 仅允许作为 fallback 链末尾（generic family）；不允许作为唯一/优先字体
  const bad = (cssStripped.match(/font-family:[^;}]*monospace[^;}]*/g) || [])
    .filter(s => !/,\s*sans-serif/.test(s) && !/,\s*serif/.test(s));
  assert.deepStrictEqual(bad, [],
    `CSS 中不应再单独使用 monospace 作数字字体：\n${bad.join('\n')}`);
});

// ---------- 5. 行内 style：表格内数字与 toast 提示 ----------
test('行内：表格内"X h"与行数列字体为 var(--font-ui)', () => {
  const styleHits = html.match(/style="font-family:[^"]+"/g) || [];
  // 不应再含 JetBrains Mono
  const monoHits = styleHits.filter(s => /JetBrains Mono/.test(s));
  assert.deepStrictEqual(monoHits, [],
    `行内 style 不应再用 JetBrains Mono：\n${monoHits.join('\n')}`);
});

test('行内：toast 提示字体为 var(--font-ui)', () => {
  assert.ok(/t\.style\.cssText='[^']*font-family:var\(--font-ui\)/.test(html),
    'toast 提示应使用 var(--font-ui)');
});

// ---------- 6. deploy 副本同步 ----------
test('deploy 副本与根文件 byte-equal', () => {
  assert.ok(fs.existsSync(DEPLOY), 'deploy 副本应存在');
  const a = read(SRC).replace(/\r\n/g, '\n');
  const b = read(DEPLOY).replace(/\r\n/g, '\n');
  assert.equal(b, a, 'deploy 副本必须与根文件 byte-equal（去除 CRLF）');
});