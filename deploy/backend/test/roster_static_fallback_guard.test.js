// 静态兜底数据一致性守卫（2026-09-03）
// 事故：2026-09-02 只修了 assets/roster.json 的 id=303 脏名，漏了 assets/roster.js。
// roster.js 是 file:// 直开时的兜底真源（loadRoster 优先读 window.ROSTER），
// 脏名被清洗防线剔除 → 待选角从 5 掉到 4，页面总数 104 → 103。
// 本测试锁定：两份静态兜底必须条数一致、名称一致、且全部括号闭合。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT = path.join(__dirname, '..', '..', '..');
const FILES = {
  rootJs:   path.join(PROJECT, 'assets', 'roster.js'),
  rootJson: path.join(PROJECT, 'assets', 'roster.json'),
  depJs:    path.join(PROJECT, 'deploy', 'frontend', 'assets', 'roster.js'),
  depJson:  path.join(PROJECT, 'deploy', 'frontend', 'assets', 'roster.json')
};

function loadJs(file){
  const src = fs.readFileSync(file, 'utf8');
  const sandbox = { window: {} };
  new Function('window', src)(sandbox.window);
  const rows = sandbox.window.ROSTER;
  assert.ok(Array.isArray(rows) && rows.length, `${file} 应导出非空 window.ROSTER`);
  return rows;
}
function loadJson(file){
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = Array.isArray(j) ? j : (j.data || j.rows || []);
  assert.ok(rows.length, `${file} 应含数据行`);
  return rows;
}
// 与前端 rosterNameBalanced 同口径：半角 + 全角括号必须成对
const balanced = s => {
  const t = String(s == null ? '' : s);
  const open = (t.match(/[（(]/g) || []).length;
  const close = (t.match(/[)）]/g) || []).length;
  return open === close;
};

test('roster.js 与 roster.json 行数一致', () => {
  assert.equal(loadJs(FILES.rootJs).length, loadJson(FILES.rootJson).length, '根目录两份静态兜底行数必须一致');
});

test('roster.js 所有角色名括号闭合，不会被清洗防线剔除', () => {
  const bad = loadJs(FILES.rootJs).filter(r => !balanced(r.role_cn) || !balanced(r.role_en));
  assert.deepEqual(
    bad.map(r => ({ id: r.id, role_cn: r.role_cn, role_en: r.role_en })),
    [],
    'roster.js 不得含括号不闭合的脏名（会被 sanitizeRosterList 剔除导致页面丢行）'
  );
});

test('roster.json 所有角色名括号闭合', () => {
  const bad = loadJson(FILES.rootJson).filter(r => !balanced(r.role_cn) || !balanced(r.role_en));
  assert.deepEqual(bad.map(r => r.id), [], 'roster.json 不得含脏名');
});

test('两份静态兜底按 id 对齐后角色名完全一致', () => {
  const js = new Map(loadJs(FILES.rootJs).map(r => [Number(r.id), r]));
  const json = loadJson(FILES.rootJson);
  const diff = [];
  json.forEach(r => {
    const hit = js.get(Number(r.id));
    if(!hit){ diff.push({ id: r.id, reason: 'roster.js 缺少该 id' }); return; }
    if(String(hit.role_cn || '') !== String(r.role_cn || '')) diff.push({ id: r.id, js: hit.role_cn, json: r.role_cn });
    if(String(hit.role_en || '') !== String(r.role_en || '')) diff.push({ id: r.id, js: hit.role_en, json: r.role_en });
  });
  assert.deepEqual(diff, [], 'roster.js 与 roster.json 的角色名必须逐条一致');
});

test('id=303 克劳斯·阿德勒 在两份兜底里都是干净名', () => {
  const pick = rows => rows.find(r => Number(r.id) === 303);
  [['roster.js', pick(loadJs(FILES.rootJs))], ['roster.json', pick(loadJson(FILES.rootJson))]].forEach(([label, row]) => {
    assert.ok(row, `${label} 应含 id=303`);
    assert.equal(row.role_cn, '克劳斯·阿德勒', `${label} role_cn 应为干净名`);
    assert.equal(row.role_en, 'Klaus Adler', `${label} role_en 应为干净名`);
  });
});

test('待选角（缺中配或英配）数量为 5，与 DB 一致', () => {
  const pendingOf = rows => rows.filter(r => !r.cn_va || !r.en_va);
  assert.equal(pendingOf(loadJs(FILES.rootJs)).length, 5, 'roster.js 待选角应为 5');
  assert.equal(pendingOf(loadJson(FILES.rootJson)).length, 5, 'roster.json 待选角应为 5');
});

test('deploy 副本与根目录静态兜底完全一致', () => {
  assert.equal(fs.readFileSync(FILES.depJs, 'utf8'), fs.readFileSync(FILES.rootJs, 'utf8'), 'roster.js 副本须一致');
  assert.equal(fs.readFileSync(FILES.depJson, 'utf8'), fs.readFileSync(FILES.rootJson, 'utf8'), 'roster.json 副本须一致');
});
