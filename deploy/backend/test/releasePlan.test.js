'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  slugify,
  deriveStatus,
  aggregateLocal,
  normalizeDfaiReleasePlans,
  normalizeDfaiEntries,
  getReleasePlans,
} = require('../src/releasePlan');

test('slugify 去除括号与空格', () => {
  assert.equal(slugify('Ma_4.0'), 'ma-4-0');
  assert.equal(slugify('【Yang_1.0】'), 'yang-1-0');
  assert.equal(slugify('  Hou 1.0 '), 'hou-1-0');
});

test('deriveStatus 按需求状态推导版本状态', () => {
  assert.equal(deriveStatus({ 'Vo ING': 3, '文案ING': 1 }), 'Vo ING');
  assert.equal(deriveStatus({ '文案ING': 2 }), '文案ING');
  assert.equal(deriveStatus({ '待澄清': 5 }), '待澄清');
  assert.equal(deriveStatus({ '已完成': 4, 'Vo ING': 1 }), '已完成');
  assert.equal(deriveStatus({}), '');
});

test('aggregateLocal 由本地行产出统一契约，含档期节点日期', () => {
  const releaseRows = [{ release_plan: 'Ma_4.0' }, { release_plan: 'Yang_1.0' }];
  const demandStats = {
    'Ma_4.0': { total: 4, byStatus: { 'Vo ING': 3, '文案ING': 1 } },
    'Yang_1.0': { total: 2, byStatus: { '待澄清': 2 } },
  };
  const scheduleRanges = {
    'Ma_4.0': { min: '2026-08-19', max: '2026-08-26' },
  };
  const out = aggregateLocal(releaseRows, demandStats, scheduleRanges);
  assert.equal(out.success, true);
  assert.equal(out.source, 'local');
  assert.equal(out.data.length, 2);
  const ma = out.data.find((v) => v.label === 'Ma_4.0');
  assert.equal(ma.id, 'ma-4-0');
  assert.equal(ma.status, 'Vo ING');
  assert.equal(ma.total_demands, 4);
  assert.ok(ma.phases.release, '应含有档期窗口作为发布期节点');
  assert.equal(ma.phases.release.start, '2026-08-19');
  const yang = out.data.find((v) => v.label === 'Yang_1.0');
  assert.equal(yang.phases.release, undefined, '无档期的不应伪造节点');
});

test('normalizeDfaiReleasePlans 归一化多种形状', () => {
  const raw = {
    data: [
      { label: 'Ma_4.0', id: 'ma4', status: '发布中', phases: { dev: { start: '2026-06-01', end: '2026-07-01' }, test: { start: '2026-07-02', end: '2026-07-20' } } },
    ],
  };
  const out = normalizeDfaiReleasePlans(raw);
  assert.equal(out.success, true);
  assert.equal(out.data[0].label, 'Ma_4.0');
  assert.equal(out.data[0].phases.dev.start, '2026-06-01');
  assert.equal(out.data[0].phases.test.end, '2026-07-20');
});

test('normalizeDfaiReleasePlans 空/异常输入安全降级', () => {
  assert.equal(normalizeDfaiReleasePlans(null).success, false);
  assert.equal(normalizeDfaiReleasePlans({}).data.length, 0);
  assert.equal(normalizeDfaiReleasePlans('not-object').data.length, 0);
});

test('normalizeDfaiEntries 归一化节点条目', () => {
  const raw = { data: [{ release_id: 'ma4', title: '★对外正式包确认', start_time: '2026-08-26 10:00:00' }] };
  const out = normalizeDfaiEntries(raw);
  assert.equal(out.data.length, 1);
  assert.equal(out.data[0].release_id, 'ma4');
  assert.match(out.data[0].title, /对外正式包确认/);
});

test('getReleasePlans 无 DFAI_TOKEN 时走本地真源（mock pool）', async () => {
  delete process.env.DFAI_TOKEN;
  const pool = {
    query: async (sql) => {
      if (sql.includes('DISTINCT release_plan')) {
        return [[{ release_plan: 'Ma_4.0' }, { release_plan: 'Yang_1.0' }]];
      }
      if (sql.includes('COUNT(*)')) {
        return [[
          { release_plan: 'Ma_4.0', status: 'Vo ING', c: 3 },
          { release_plan: 'Ma_4.0', status: '文案ING', c: 1 },
          { release_plan: 'Yang_1.0', status: '待澄清', c: 2 },
        ]];
      }
      if (sql.includes('MIN(record_date)')) {
        return [[{ release_plan: 'Ma_4.0', min: '2026-08-19', max: '2026-08-26' }]];
      }
      return [[]];
    },
  };
  const out = await getReleasePlans(pool);
  assert.equal(out.source, 'local');
  assert.equal(out.data.length, 2);
  assert.equal(out.data[0].status, 'Vo ING');
  assert.ok(out.data[0].phases.release);
});
