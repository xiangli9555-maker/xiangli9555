'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

const projectRoot = path.resolve(__dirname, '../../..');
const readProjectFile = (relativePath) => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
const demandPages = [
  'preview-需求汇总-精修版.html',
  'deploy/frontend/preview-需求汇总-精修版.html',
].map(readProjectFile);
const schedulePages = [
  'preview-录制档期-精修版.html',
  'deploy/frontend/preview-录制档期-精修版.html',
].map(readProjectFile);

for (const [index, page] of demandPages.entries()) {
  test(`需求汇总页 ${index + 1} 使用真实数据时间并展示快照时间`, () => {
    assert.equal(/id="snapshotTimeNote"/.test(page), true, '缺少可见快照时间节点');
    assert.equal(/window\.TAPD_SNAPSHOT_AT/.test(page), true, '未读取静态快照时间元数据');
    assert.equal(/【快照时间：/.test(page), true, '缺少快照时间文案');
    assert.equal(/const now = new Date\(\);[\s\S]{0,180}updatedTime/.test(page), false, '仍使用页面加载时间冒充数据时间');
  });
}

test('快照生成器和现有前端快照都携带生成时间元数据', () => {
  assert.equal(/window\.TAPD_SNAPSHOT_AT/.test(readProjectFile('scripts/build_snapshot.py')), true);
  assert.equal(/window\.TAPD_SNAPSHOT_AT/.test(readProjectFile('assets/tapd-snapshot.js')), true);
  assert.equal(/window\.TAPD_SNAPSHOT_AT/.test(readProjectFile('deploy/frontend/assets/tapd-snapshot.js')), true);
});

test('MySQL 需求接口返回真实数据来源与更新时间响应头', () => {
  const backend = readProjectFile('deploy/backend/src/index.js');
  assert.equal(/X-Data-Source/.test(backend), true);
  assert.equal(/X-Data-At/.test(backend), true);
  assert.equal(/last_synced_at/.test(backend), true);
});

for (const [index, page] of schedulePages.entries()) {
  test(`录制档期页 ${index + 1} 不以静态或自动 mock 冒充线上真数据`, () => {
    assert.equal(/<div class="mp-pr-val">(?:2 \/ 4|4 \/ 8)<\/div>/.test(page), false, '初始预约进度仍有固定样例');
    assert.equal(/<div class="mp-up-role">(?:红狼|钟婉)<\/div>/.test(page), false, '初始即将录制仍有固定样例');
    assert.equal(/if\(window\.FORCE_SCHED_MOCK && !byReleaseDraft\.length\)/.test(page), true, 'release 过滤后 mock 未受预览开关保护');
    assert.equal(/if\(!byReleaseDraft\.length\)\{/.test(page), false, '仍存在无条件 mock fallback');
    assert.equal(/if\(!arr \|\| !arr\.length\) arr = buildMockDemands\(\)/.test(page), false, '需求 API 空数据仍无条件注入 mock');
    assert.equal(/PUBLISHED_ROWS = buildMockSchedules\(\)/.test(page), false, '档期 API 失败仍无条件注入 mock');
    assert.equal(/window\.location\.protocol === 'file:'/.test(page), true, '未限制 mock 到 file://');
  });
}

const releaseCalendarAsset = path.join(projectRoot, 'assets/release-calendar.js');

test('当前版本按上一版本转测开始到本版本开发结束判定，并跳过 Ma5 转测段', () => {
  assert.equal(fs.existsSync(releaseCalendarAsset), true, '缺少共享版本日历判定模块');
  delete require.cache[require.resolve(releaseCalendarAsset)];
  const calendar = require(releaseCalendarAsset);
  const plans = JSON.parse(readProjectFile('data/release-plans.json'));

  assert.equal(calendar.currentRelease(plans, '2026-08-03T12:00:00+08:00'), 'Ma5.0');
  assert.equal(calendar.currentRelease(plans, '2026-09-01T12:00:00+08:00'), 'Ma5.0');
  assert.equal(calendar.currentRelease(plans, '2026-09-28T00:00:00+08:00'), 'Yang1.0');
  assert.equal(calendar.currentRelease(plans, '2026-12-20T23:59:59+08:00'), 'Yang1.0');
  assert.equal(calendar.currentRelease(plans, '2026-12-21T00:00:00+08:00'), 'Yang2.0');
});

test('需求、档期和外壳统一加载共享版本日历，禁止按需求数或草稿数猜当前版本', () => {
  const pages = [
    ...demandPages,
    ...schedulePages,
    readProjectFile('vo-manager-refined.html'),
    readProjectFile('deploy/frontend/vo-manager-refined.html'),
  ];
  pages.forEach((page, index) => {
    assert.equal(/assets\/release-calendar\.js/.test(page), true, `页面 ${index + 1} 未加载共享版本日历`);
  });
  demandPages.forEach((page) => {
    assert.equal(/function currentReleasePlan\(\)\{[\s\S]{0,500}counts/.test(page), false, '需求汇总仍按需求数量猜当前版本');
  });
  schedulePages.forEach((page) => {
    assert.equal(/function detectCurrentReleaseFrom(?:Demands|Rows)\([^)]*\)\{[\s\S]{0,500}counts/.test(page), false, '录制档期仍按列表数量猜当前版本');
  });
  [readProjectFile('vo-manager-refined.html'), readProjectFile('deploy/frontend/vo-manager-refined.html')].forEach((page) => {
    assert.equal(/function pickCurrentRelease\(map\)\{[\s\S]{0,500}bestCount/.test(page), false, '外壳仍按需求数量猜当前版本');
  });
});

test('虚拟版本汇总行创建者固定为 Vomi', () => {
  demandPages.forEach((page) => {
    assert.equal(/creator:'Vomi'/.test(page), true, '汇总行 creator 不是 Vomi');
    assert.equal(/title="汇总负责人">Vomi<\/td>/.test(page), true, '汇总负责人显示不是 Vomi');
    assert.equal(/creator:'lycheelli'|title="汇总负责人">lycheelli<\/td>/.test(page), false, '仍残留个人名作为汇总创建者');
  });
});

test('外壳收起态为 Logo、折叠按钮和后续品牌信息预留安全间距', () => {
  [readProjectFile('vo-manager-refined.html'), readProjectFile('deploy/frontend/vo-manager-refined.html')].forEach((page, index) => {
    assert.equal(
      /body\.sidebar-collapsed \.brand-toggle\{[^}]*left:calc\(var\(--sb-col-w\) \+ 34px\)/.test(page),
      true,
      `外壳 ${index + 1} 的折叠按钮未右移到安全间距`,
    );
    assert.equal(
      /body\.sidebar-collapsed \.brand-logo\{[^}]*margin-right:calc\(var\(--sb-col-w\) \+ 16px\)/.test(page),
      true,
      `外壳 ${index + 1} 未给后续品牌信息预留防叠加空间`,
    );
    assert.equal(
      /--collapsed-line-x:calc\(var\(--sb-col-w\) \+ 24px\)/.test(page),
      true,
      `外壳 ${index + 1} 的竖线未定位到折叠按钮左侧`,
    );
    assert.equal(
      /body\.sidebar-collapsed \.brand-divider\{[^}]*left:var\(--collapsed-line-x\)/.test(page),
      true,
      `外壳 ${index + 1} 的顶栏分隔线未跟随统一定位`,
    );
    assert.equal(
      /--collapsed-content-offset-x:6px/.test(page),
      true,
      `外壳 ${index + 1} 未定义收起态 Logo 对齐偏移`,
    );
    assert.equal(
      /body\.sidebar-collapsed \.sidebar\{[^}]*width:var\(--collapsed-line-x\)[^}]*border-right-color:var\(--c-hairline\)[^}]*background-color:var\(--c-sidebar\)/.test(page),
      true,
      `外壳 ${index + 1} 的收起态侧栏未延展至统一分隔线`,
    );
    assert.equal(
      /body\.sidebar-collapsed \.sidebar \.nav-item\{[^}]*margin:2px auto[^}]*transform:translateX\(var\(--collapsed-content-offset-x\)\)/.test(page),
      true,
      `外壳 ${index + 1} 的收起态导航项未向 Logo 中轴对齐`,
    );
    assert.equal(
      /body\.sidebar-collapsed \.sidebar \.sec-label::before\{[^}]*transform:translateX\(var\(--collapsed-content-offset-x\)\)/.test(page),
      true,
      `外壳 ${index + 1} 的收起态分组线未与导航项同轴`,
    );
  });
});
