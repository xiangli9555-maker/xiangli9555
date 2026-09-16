const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../../..');
const FILE = 'preview-需求汇总-精修版.html';
const SOURCE = fs.readFileSync(path.join(ROOT, FILE), 'utf8');
const DEMAND = { id: 'd1', task_name: '测试需求', manual_status: '待澄清', release_plan: 'Yang1.0' };
const OLD_ROWS = [
  { demand_id: 'd1', role_name: '旧干员', category: '干员', estimated_lines: 12, actual_lines: 7 },
  { demand_id: 'd1', role_name: '旧首领', category: 'Boss', estimated_lines: 4, actual_lines: 2 },
];
const FAILURE_MESSAGE = '声优预估读取失败，暂不可编辑，请重试';
// 版本节点桩：dev.end 足够远 → 声优锁未到（可编辑）；dev.end 已过期 → 声优锁 18:00 已过（只读）。
const PLAN_OPEN = [{ label: 'Yang1.0', phases: { dev: { end: '2028/12/31' } } }];
const PLAN_CLOSED = [{ label: 'Yang1.0', phases: { dev: { end: '2020/1/10' } } }];

function block(start, end) {
  const from = SOURCE.indexOf(start);
  const to = SOURCE.indexOf(end, from);
  assert.ok(from >= 0 && to > from, '应从页面提取真实函数，不复制业务实现');
  return SOURCE.slice(from, to);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => '' }, json: async () => structuredClone(body) };
}
function element() {
  const classes = new Set();
  return {
    value: '', hidden: false, disabled: false, textContent: '', innerHTML: '', dataset: {},
    offsetWidth: 400, offsetHeight: 300,
    classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x), toggle: (x, on) => on ? classes.add(x) : classes.delete(x) },
    style: { setProperty() {} }, setAttribute() {}, removeAttribute() {}, focus() {},
    getBoundingClientRect: () => ({ left: 20, top: 20, bottom: 40 }),
  };
}
function harness() {
  const elements = new Map(), messages = [], puts = [], estimates = [], demands = [];
  const getElement = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const sandbox = {
    console: { info() {}, warn() {} },
    window: { innerWidth: 1200, innerHeight: 900, addEventListener() {} },
    document: { addEventListener() {}, getElementById: getElement, querySelector: getElement, querySelectorAll: () => [] },
    requestAnimationFrame: fn => { fn(); return 1; }, cancelAnimationFrame() {}, setTimeout() {},
    esc: value => String(value), tapdStage: () => '待澄清',
    flashErr: message => messages.push(message), flashOk: message => messages.push(message),
    applyOfflineDrafts: rows => rows, releaseInScope: () => true, flushOfflineDrafts: async () => {},
    setSyncStatus() {}, loadRecordingMax: async () => {}, normalizeCopywriters() {}, updateKPI() {}, renderRows() {},
    pollCwJobs() {}, pushAssignments() {}, TAPD_SNAPSHOT: [DEMAND], TAPD_SNAPSHOT_AT: '',
    fetch: async (url, options = {}) => {
      if (options.method === 'PUT') {
        puts.push(JSON.parse(options.body));
        if (sandbox.putResponse) return sandbox.putResponse;
        return response({ ok: true, rows: puts.at(-1).rows.map(row => ({ ...row, demand_id: 'd1' })), changes: { added: 0, updated: 1, deleted: 0 } });
      }
      if (url === '/api/demands') return demands.length ? demands.shift() : response([DEMAND]);
      if (url === '/api/voice-estimates') {
        const result = estimates.shift();
        if (result instanceof Error) throw result;
        assert.ok(result, '每次读取预估均应有明确测试响应');
        return result;
      }
      if (url === '/api/talents' && sandbox.rosterResponse) return sandbox.rosterResponse;
      throw new Error('测试禁止任何未声明的请求：' + url);
    },
  };
  const context = vm.createContext(sandbox);
  const run = code => vm.runInContext(code, context);
  run(block('let allDemands = [];', "const RELEASE_SCOPE_START =") + '\n' +
      // 2026-09-16：声优预估门禁改为「声优锁当天 18:00」，需把版本节点引擎与门禁函数一并载入沙箱。
      block('// 双 DDL 与版本节点页共用同一份节假日及调休数据。', 'async function loadReleasePlans()') + '\n' +
      block('// ★ 声优预估编辑门禁（PM 定稿 2026-09-16）', 'function renderDualDdl') + '\n' +
      block("const VE_CATEGORIES=", "document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.getElementById('veCategoryPopover')") + '\n' +
      block('async function loadDemands(){', '// 「从 TAPD 刷新」'));
  // 默认给一个「声优锁尚未到」的版本节点（远期 dev.end），使预估处于可编辑窗口。
  run(`RELEASE_PLANS=${JSON.stringify(PLAN_OPEN)};`);
  run(`allDemands=${JSON.stringify([DEMAND])}; VE_ROSTER=${JSON.stringify([
    { id: 1, module: '干员', role_cn: '旧干员' }, { id: 2, module: 'Boss', role_cn: '旧首领' }, { id: 3, module: '干员', role_cn: '新干员' },
  ])}; rebuildVeRosterIndex();`);
  context.anchor = element();
  return {
    run, sandbox, elements, messages, puts, estimates, demands,
    load: result => { estimates.push(result); return run('loadDemands()'); },
    open: () => run("openVeCategory('d1','干员',anchor)"),
    save: () => run('saveVeCategory()'),
    cells: () => run('veCells(allDemands[0])'),
    rows: () => JSON.parse(run('JSON.stringify(allVoiceEstimates)')),
  };
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

for (const [label, invalid] of [
  ['网络拒绝', () => new Error('网络失败')],
  ['HTTP 500', () => response({ ok: true, rows: [] }, 500)],
  ['业务失败', () => response({ ok: false, rows: [] })],
  ['缺少 ok', () => response({ rows: [] })],
  ['ok 非布尔真', () => response({ ok: 'true', rows: [] })],
  ['rows 非数组', () => response({ ok: true, rows: {} })],
  ['rows 缺失', () => response({ ok: true })],
  ['空 body', () => response(null)],
  ['畸形 JSON', () => ({ ok: true, json: async () => { throw new SyntaxError('无效 JSON'); } })],
]) {
  test(`${label}不能伪装空预估或允许提交`, async () => {
    const h = harness();
    await h.load(invalid());
    assert.equal(h.run('veCanEdit(allDemands[0])'), false, '失败后的需求不能编辑');
    assert.match(h.cells(), /读取失败/, '初次失败必须显示不可用，而非空白或零');
    assert.ok(h.messages.includes(FAILURE_MESSAGE), '失败必须显式提示可重试');
    await h.open();
    await h.save();
    assert.equal(h.puts.length, 0, '读取失败不能向全量替换接口发送空草稿');
  });
}

test('尚未加载不能打开可编辑草稿', async () => {
  const h = harness();
  assert.equal(h.run('veCanEdit(allDemands[0])'), false);
  assert.match(h.cells(), /未加载/);
  await h.open(); await h.save();
  assert.equal(h.puts.length, 0);
});

test('合法成功空数组仍可新增预估', async () => {
  const h = harness();
  await h.load(response({ ok: true, rows: [] }));
  assert.equal(h.run('veCanEdit(allDemands[0])'), true);
  await h.open();
  h.run("veChangeLines({dataset:{role:'新干员',roleId:'3'},value:'9',closest:()=>null})");
  await h.save();
  assert.equal(h.puts.length, 1);
  assert.equal(h.puts[0].rows[0].estimated_lines, 9);
});

test('成功读取后编辑一类保留其它类完整预估和实际句数', async () => {
  const h = harness();
  await h.load(response({ ok: true, rows: OLD_ROWS }));
  await h.open();
  h.run("veChangeLines({dataset:{role:'旧干员',roleId:'1'},value:'13',closest:()=>null})");
  await h.save();
  assert.equal(h.puts.length, 1);
  assert.deepEqual(h.puts[0].rows.map(r => [r.role_name, r.estimated_lines, r.actual_lines]), [['旧干员', 13, 7], ['旧首领', 4, 2]]);
});

// 2026-09-16：门禁由 manual_status 五态改为「声优锁当天 18:00」，以下三条覆盖新口径。
test('声优锁当天 18:00 后：预估只读且不再写入', async () => {
  const h = harness();
  await h.load(response({ ok: true, rows: OLD_ROWS }));
  h.run(`RELEASE_PLANS=${JSON.stringify(PLAN_CLOSED)};`);
  assert.equal(h.run('veCanEdit(allDemands[0])'), false, '声优锁 18:00 后必须只读');
  assert.match(h.run('veReadonlyReason(allDemands[0])'), /声优锁[\s\S]*18:00 后已截止/, '只读必须给出截止时间原因');
  await h.open(); await h.save();
  assert.equal(h.run('VE_CATEGORY.readonly'), true);
  assert.equal(h.puts.length, 0, '截止后不得向全量替换接口写入');
});

test('声优锁当天 18:00 前：预估可编辑（与 manual_status 无关）', async () => {
  const h = harness();
  await h.load(response({ ok: true, rows: OLD_ROWS }));
  h.run(`RELEASE_PLANS=${JSON.stringify(PLAN_OPEN)};`);
  h.run("allDemands[0].manual_status='Done'");
  assert.equal(h.run('veCanEdit(allDemands[0])'), true, '新门禁只看声优锁截止时间，不再看 manual_status');
  await h.open();
  h.run("veChangeLines({dataset:{role:'新干员',roleId:'3'},value:'9',closest:()=>null})");
  await h.save();
  assert.equal(h.puts.length, 1);
});

test('无版本节点的版本：预估保守只读', async () => {
  const h = harness();
  await h.load(response({ ok: true, rows: OLD_ROWS }));
  h.run('RELEASE_PLANS=[];');
  assert.equal(h.run('veCanEdit(allDemands[0])'), false);
  assert.match(h.run('veReadonlyReason(allDemands[0])'), /无版本节点/);
  await h.open(); await h.save();
  assert.equal(h.puts.length, 0);
});

test('刷新开始立即禁止旧弹框保存，读取失败保留明确标记的旧数据', async () => {
  const h = harness();
  await h.load(response({ ok: true, rows: OLD_ROWS }));
  await h.open();
  const pending = deferred();
  h.demands.push(pending.promise);
  const loading = h.load(new Error('刷新失败'));
  await h.save();
  assert.equal(h.puts.length, 0, '需求 GET 尚未返回时旧弹框已不可保存');
  assert.equal(h.run('VE_CATEGORY.readonly'), true, '已经打开的编辑控件必须立即只读');
  assert.match(h.cells(), /读取中|加载中/);
  pending.resolve(response([DEMAND]));
  await loading;
  assert.deepEqual(h.rows(), OLD_ROWS, '失败不能清空上次成功索引');
  assert.match(h.cells(), /旧数据/);
  assert.match(h.cells(), /读取失败/);
  assert.match(h.cells(), /旧干员/);
  await h.save();
  assert.equal(h.puts.length, 0);
});

test('刷新成功也不能复用刷新前的草稿代次', async () => {
  const h = harness();
  await h.load(response({ ok: true, rows: OLD_ROWS }));
  await h.open();
  await h.load(response({ ok: true, rows: [...OLD_ROWS, { demand_id: 'd1', role_name: '新干员', category: '干员', estimated_lines: 6 }] }));
  h.run('VE_CATEGORY.readonly=false');
  await h.save();
  assert.equal(h.puts.length, 0, '即使绕过只读字段也必须检查草稿代次');
  await h.open(); await h.save();
  assert.equal(h.puts[0].rows.length, 3, '重新打开后草稿必须基于最新完整基线');
});

test('两次预估响应乱序：过期成功不能覆盖最新成功', async () => {
  const h = harness(), older = deferred();
  const first = h.load(older.promise);
  await settle();
  await h.load(response({ ok: true, rows: OLD_ROWS }));
  older.resolve(response({ ok: true, rows: [] }));
  await first;
  assert.deepEqual(h.rows(), OLD_ROWS);
  assert.equal(h.run('veCanEdit(allDemands[0])'), true);
});

test('两次预估响应乱序：过期失败不能覆盖最新成功', async () => {
  const h = harness(), older = deferred();
  const first = h.load(older.promise);
  await settle();
  await h.load(response({ ok: true, rows: OLD_ROWS }));
  older.reject(new Error('过期请求失败'));
  await first;
  assert.deepEqual(h.rows(), OLD_ROWS);
  assert.equal(h.run('veCanEdit(allDemands[0])'), true);
  assert.equal(h.messages.includes(FAILURE_MESSAGE), false);
});

test('两次预估响应乱序：过期成功不能解除最新失败锁', async () => {
  const h = harness(), older = deferred();
  const first = h.load(older.promise);
  await settle();
  await h.load(new Error('最新读取失败'));
  older.resolve(response({ ok: true, rows: OLD_ROWS }));
  await first;
  assert.equal(h.run('veCanEdit(allDemands[0])'), false);
  assert.match(h.cells(), /读取失败/);
});

test('声优库异步打开期间刷新不能生成可提交的旧草稿', async () => {
  const h = harness();
  await h.load(response({ ok: true, rows: OLD_ROWS }));
  const roster = deferred();
  h.sandbox.rosterResponse = roster.promise;
  h.run('VE_ROSTER=[]');
  const opening = h.open();
  await h.load(new Error('刷新失败'));
  roster.resolve(response([{ id: 1, role_cn: '旧干员', module: '干员' }]));
  await opening; await h.save();
  assert.equal(h.puts.length, 0);
});

test('提交后发起刷新时，迟到的保存响应不能覆盖更新代次数据', async () => {
  const h = harness();
  await h.load(response({ ok: true, rows: OLD_ROWS }));
  await h.open();
  const saving = deferred();
  h.sandbox.putResponse = saving.promise;
  const save = h.save();
  const newerRows = [{ ...OLD_ROWS[0], estimated_lines: 88 }, OLD_ROWS[1]];
  await h.load(response({ ok: true, rows: newerRows }));
  saving.resolve(response({ ok: true, rows: OLD_ROWS, changes: { added: 0, updated: 1, deleted: 0 } }));
  await save;
  assert.deepEqual(h.rows(), newerRows, '保存完成不能写回其它代次的内存基线');
});

test('根页面与部署副本逐字节一致', () => {
  assert.deepEqual(fs.readFileSync(path.join(ROOT, FILE)), fs.readFileSync(path.join(ROOT, 'deploy/frontend', FILE)));
});
