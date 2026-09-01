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
let reconcileMissingTapdDemands;
try {
  ({ reconcileMissingTapdDemands } = require('../src/tapd_snapshot_sync'));
} catch (_) {}

test('TAPD 快照对账会停用同版本中已不存在的需求且保留历史数据', async () => {
  assert.equal(typeof reconcileMissingTapdDemands, 'function', '缺少 TAPD 快照缺失项对账实现');
  const calls = [];
  const conn = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return [{ affectedRows: 1 }];
    },
  };
  const result = await reconcileMissingTapdDemands(conn, [
    { id: '1020421949136927679', release_plan: 'Yang1.0' },
    { id: '1020421949137235450', release_plan: 'Yang1.0' },
  ], new Date('2026-09-01T06:30:00.000Z'));

  assert.deepEqual(result, { deactivated: 1, releases: ['Yang1.0'] });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /^UPDATE demands SET status='suspended', last_synced_at=\?/);
  assert.match(calls[0].sql, /sync_source='tapd_snapshot'/);
  assert.match(calls[0].sql, /story_type='音频'/);
  assert.match(calls[0].sql, /release_plan=\?/);
  assert.match(calls[0].sql, /external_id NOT IN \(\?,\?\)/);
  assert.doesNotMatch(calls[0].sql, /DELETE FROM demands/);
  assert.deepEqual(calls[0].params.slice(1), [
    'Yang1.0',
    '1020421949136927679',
    '1020421949137235450',
  ]);
});

test('TAPD 快照为空时拒绝执行对账，避免误停整个版本', async () => {
  assert.equal(typeof reconcileMissingTapdDemands, 'function', '缺少 TAPD 快照缺失项对账实现');
  await assert.rejects(
    reconcileMissingTapdDemands({ query: async () => [{ affectedRows: 0 }] }, []),
    /tapd_snapshot_empty/,
  );
});

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
const eyebrowPageSpecs = [
  ['需求汇总', 'preview-需求汇总-精修版.html', 'MISSION OPERATIONS'],
  ['需求汇总部署镜像', 'deploy/frontend/preview-需求汇总-精修版.html', 'MISSION OPERATIONS'],
  ['版本节点', 'preview-版本节点-精修版.html', 'RELEASE CALENDAR'],
  ['版本节点部署镜像', 'deploy/frontend/preview-版本节点-精修版.html', 'RELEASE CALENDAR'],
  ['录制档期', 'preview-录制档期-精修版.html', 'RECORDING SCHEDULE'],
  ['录制档期部署镜像', 'deploy/frontend/preview-录制档期-精修版.html', 'RECORDING SCHEDULE'],
  ['声优库', 'preview-声优库-精修版.html', 'TALENT OPERATIONS'],
  ['声优库部署镜像', 'deploy/frontend/preview-声优库-精修版.html', 'TALENT OPERATIONS'],
];
const canonicalEyebrowRule = '.eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:11px;color:var(--c-primary);letter-spacing:.6px;font-weight:500;text-transform:none;font-family:"Microsoft YaHei UI","Microsoft YaHei","PingFang SC",sans-serif}';

for (const [name, relativePath, label] of eyebrowPageSpecs) {
  test(`${name} 顶部英文提示统一为全大写与同一字体规格`, () => {
    const page = readProjectFile(relativePath);
    assert.equal(page.includes(canonicalEyebrowRule), true, 'eyebrow 字体规格未统一');
    assert.match(page, new RegExp(`<div class="eyebrow"><span class="sig"></span>${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:<|\\s)`));
  });
}

for (const [index, page] of demandPages.entries()) {
  test(`需求汇总页 ${index + 1} 在快照导入后反馈自动停用数量`, () => {
    assert.equal(/const deactivated = Number\(j\.deactivated \?\? 0\)/.test(page), true, '未读取后端对账停用数量');
    assert.equal(/自动移除 \$\{deactivated\} 条/.test(page), true, '成功提示未反馈自动移除数量');
  });

  test(`需求汇总页 ${index + 1} 使用真实数据时间并展示快照时间`, () => {
    assert.equal(/id="snapshotTimeNote"/.test(page), true, '缺少可见快照时间节点');
    assert.equal(/window\.TAPD_SNAPSHOT_AT/.test(page), true, '未读取静态快照时间元数据');
    assert.equal(/【快照时间：/.test(page), true, '缺少快照时间文案');
    assert.equal(/const now = new Date\(\);[\s\S]{0,180}updatedTime/.test(page), false, '仍使用页面加载时间冒充数据时间');
  });

  test(`需求汇总页 ${index + 1} 空数据行只跨越真实 16 列，让 Story 吸收剩余宽度`, () => {
    assert.equal(/<td colspan="16"[^>]*>[\s\S]{0,160}当前筛选下无数据/.test(page), true, '空数据行未使用真实 16 列');
    assert.equal(/colspan="17"/.test(page), false, '多余的第 17 列会在表头右侧制造空隙');
  });
}

test('快照生成器和现有前端快照都携带生成时间元数据', () => {
  assert.equal(/window\.TAPD_SNAPSHOT_AT/.test(readProjectFile('scripts/build_snapshot.py')), true);
  assert.equal(/window\.TAPD_SNAPSHOT_AT/.test(readProjectFile('assets/tapd-snapshot.js')), true);
  assert.equal(/window\.TAPD_SNAPSHOT_AT/.test(readProjectFile('deploy/frontend/assets/tapd-snapshot.js')), true);
});

test('最新 Yang1 快照已移除 TAPD 不存在的旧需求并保留合并后的需求', () => {
  [
    readProjectFile('assets/tapd-snapshot.js'),
    readProjectFile('deploy/frontend/assets/tapd-snapshot.js'),
  ].forEach((snapshot) => {
    assert.equal(/1020421949137075775/.test(snapshot), false, '已从 TAPD 删除的旧需求仍残留在快照');
    assert.equal(/1020421949136927679/.test(snapshot), true, '合并后的 TAPD 需求缺失');
    assert.equal(/新春红包活动-\(恭喜发财\+新年快乐）/.test(snapshot), true, '合并后的需求标题未更新');
  });
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

test('共享版本日历支持从 Yang1 起步并保留后续版本', () => {
  delete require.cache[require.resolve(releaseCalendarAsset)];
  const calendar = require(releaseCalendarAsset);
  const plans = JSON.parse(readProjectFile('data/release-plans.json'));
  calendar.setPlans(plans);

  assert.equal(calendar.isAtOrAfter(plans, 'Ma5.0', 'Yang1.0'), false);
  assert.equal(calendar.isAtOrAfter(plans, 'Yang1.0', 'Yang1.0'), true);
  assert.equal(calendar.isAtOrAfter(plans, 'Yang2.0', 'Yang1.0'), true);
  assert.equal(calendar.clampFrom(plans, 'Ma5.0', 'Yang1.0'), 'Yang1.0');
  assert.equal(calendar.clampFrom(plans, 'Yang2.0', 'Yang1.0'), 'Yang2.0');
  assert.equal(calendar.isAtOrAfterCached('Ma4.0', 'Yang1.0'), false);
  assert.equal(calendar.isAtOrAfterCached('Yang3.0', 'Yang1.0'), true);
});

test('需求汇总、录制档期与外壳均从 Yang1 发布计划开始取数', () => {
  const shellPages = [
    readProjectFile('vo-manager-refined.html'),
    readProjectFile('deploy/frontend/vo-manager-refined.html'),
  ];
  [...demandPages, ...schedulePages, ...shellPages].forEach((page, index) => {
    assert.equal(/RELEASE_SCOPE_START\s*=\s*['"]Yang1\.0['"]/.test(page), true, `页面 ${index + 1} 未声明 Yang1 起始版本`);
  });
  demandPages.forEach((page) => {
    assert.equal(/allDemands\s*=\s*applyOfflineDrafts\([\s\S]{0,160}\.filter\(releaseInScope\)/.test(page), true, '需求汇总未过滤 Yang1 之前的数据');
    assert.equal(/currentReleasePlan\(\)[\s\S]{0,220}clampFromCached/.test(page), true, '需求汇总当前版本未钳制到 Yang1 起步');
  });
  schedulePages.forEach((page) => {
    assert.equal(/function schedReleaseMatch\(plan\)\{[\s\S]{0,180}!releaseInScope\(plan\)/.test(page), true, '录制档期筛选仍允许 Yang1 之前的数据');
    assert.equal(/ACTOR_STATE\.demands\s*=\s*arr\.filter\(releaseInScope\)/.test(page), true, '录制档期声优汇总未过滤 Yang1 之前的需求');
    assert.equal(/PUBLISHED_ROWS\s*=\s*arr\.filter\(releaseInScope\)/.test(page), true, '录制档期已发布排期未过滤 Yang1 之前的数据');
  });
  shellPages.forEach((page) => {
    assert.equal(/function pickCurrentRelease\(\)[\s\S]{0,220}clampFromCached/.test(page), true, '外壳当前版本未从 Yang1 起步');
    assert.equal(/rows\s*=\s*rows\.filter\(releaseInScopeShell\)/.test(page), true, '外壳计数仍包含 Yang1 之前的数据');
  });
});

test('共享版本日历按权威有效周规则生成 VO 四个关键节点', () => {
  delete require.cache[require.resolve(releaseCalendarAsset)];
  const calendar = require(releaseCalendarAsset);
  const holidays = require(path.join(projectRoot, 'assets/holiday-calendar.js'));
  const plans = JSON.parse(readProjectFile('data/release-plans.json'));
  const yang1 = calendar.listOf(plans).find((plan) => calendar.releaseName(plan.label) === 'Yang1.0');
  const nodes = calendar.vomiMilestones(yang1, holidays);

  assert.deepEqual(nodes.map((node) => [node.key, node.date]), [
    ['demand-lock', '2026-09-14'],
    ['talent-lock', '2026-10-29'],
    ['script-lock', '2026-11-12'],
    ['vo-delivery', '2026-12-11'],
  ]);
});

test('外壳通知铃铛启用身份感知悬浮信息卡并只读取真实业务接口', () => {
  const shellPages = [
    readProjectFile('vo-manager-refined.html'),
    readProjectFile('deploy/frontend/vo-manager-refined.html'),
  ];
  shellPages.forEach((page, index) => {
    assert.equal(/id="notifyBell"(?![^>]*is-disabled)[^>]*aria-haspopup="dialog"/.test(page), true, `外壳 ${index + 1} 的铃铛仍未启用`);
    assert.equal(/id="notificationPopover"[^>]*role="dialog"/.test(page), true, `外壳 ${index + 1} 缺少通知悬浮卡`);
    assert.equal(/function getNotificationRole\(/.test(page), true, `外壳 ${index + 1} 未按身份分类通知`);
    assert.equal(/function buildNotificationModel\(/.test(page), true, `外壳 ${index + 1} 缺少通知内容模型`);
    assert.equal(/Promise\.allSettled\([\s\S]{0,500}\/api\/demands[\s\S]{0,500}\/api\/schedules[\s\S]{0,500}\/api\/voice-roles/.test(page), true, `外壳 ${index + 1} 未从真实业务接口汇总风险`);
    assert.equal(/vomiMilestones\(/.test(page), true, `外壳 ${index + 1} 未展示权威 VO 节点`);
    assert.equal(/Escape[\s\S]{0,180}closeNotification/.test(page), true, `外壳 ${index + 1} 缺少 ESC 关闭交互`);
    assert.equal(/notification-popover/.test(page), true, `外壳 ${index + 1} 缺少统一浅绿色悬浮信息卡样式`);
  });
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

test('1470×956 外壳为子页面释放宽度且锁住根级水平溢出', () => {
  [readProjectFile('vo-manager-refined.html'), readProjectFile('deploy/frontend/vo-manager-refined.html')].forEach((page, index) => {
    assert.equal(page.includes('1470 compact: no horizontal scroll'), true, `外壳 ${index + 1} 缺少 1470 紧凑模式标记`);
    assert.match(page, /@media \(max-width: 1500px\)[\s\S]{0,1200}\.sidebar\{width:176px/);
    assert.match(page, /@media \(max-width: 1500px\)[\s\S]{0,1200}\.brand-search\{[^}]*max-width:280px/);
    assert.match(page, /@media \(max-width: 1500px\)[\s\S]{0,1400}\.layout,\.main-view,\.viewport,\.iframe-wrap\{min-width:0;overflow-x:hidden\}/);
  });
});

test('1470×956 需求汇总保留 16 列并禁止宽表横向滚动', () => {
  demandPages.forEach((page, index) => {
    assert.equal(page.includes('1470 compact: no horizontal scroll'), true, `需求汇总 ${index + 1} 缺少紧凑模式标记`);
    assert.match(page, /\.table-wrap\{overflow-y:auto;overflow-x:hidden/);
    assert.match(page, /table\.demand-table\{width:100%;min-width:0!important;table-layout:fixed/);
    assert.match(page, /\.th-ve-group\{min-width:0!important/);
    assert.match(page, /table\.demand-table col:nth-child\(1\)\{width:5\.2%!important\}/, '窄屏必须覆盖 colgroup 的内联像素宽度');
    assert.match(page, /table\.demand-table col:nth-child\(n\+9\):nth-child\(-n\+14\)\{width:4%!important\}/, '六个声优预估 col 必须按百分比收缩');
    assert.doesNotMatch(page, /table\.demand-table\{font-size:(?:11\.5|10\.5)px;min-width:(?:1050|900)px\}/);
    assert.equal((page.match(/<th\b/g) || []).length >= 16, true, '需求汇总必须继续保留全部表头');
  });
});

test('1470×956 版本节点三类时间表只纵向滚动并取消固定最小宽度', () => {
  [
    readProjectFile('preview-版本节点-精修版.html'),
    readProjectFile('deploy/frontend/preview-版本节点-精修版.html'),
  ].forEach((page, index) => {
    assert.equal(page.includes('1470 compact: no horizontal scroll'), true, `版本节点 ${index + 1} 缺少紧凑模式标记`);
    assert.match(page, /\.yc-scroll\{[^}]*overflow-y:auto;overflow-x:hidden/);
    assert.match(page, /\.yc-table,\.wk-table,\.day-table\{min-width:0!important;width:100%;table-layout:fixed\}/);
    assert.match(page, /\.yc-table col:nth-child\(n\+3\):not\(:last-child\)\{width:auto!important\}/, '窄屏必须覆盖年历脚本注入的固定周列宽');
    assert.match(page, /\.right-panel\{width:176px/);
  });
});

test('1470×956 录制档期压缩辅助栏与卡片轨道且根级无横向溢出', () => {
  schedulePages.forEach((page, index) => {
    assert.equal(page.includes('1470 compact: no horizontal scroll'), true, `录制档期 ${index + 1} 缺少紧凑模式标记`);
    assert.match(page, /\.mid-panel\{width:220px/);
    assert.match(page, /\.demand-cards\{grid-template-columns:repeat\(auto-fill,minmax\(280px,1fr\)\)/);
    assert.match(page, /\.acard-group\{grid-template-columns:repeat\(auto-fill,minmax\(260px,1fr\)\)/);
    assert.match(page, /html,body\{overflow-x:hidden\}/);
  });
});

test('1470×956 声优库保留 10 列并覆盖内联最小宽度', () => {
  [
    readProjectFile('preview-声优库-精修版.html'),
    readProjectFile('deploy/frontend/preview-声优库-精修版.html'),
  ].forEach((page, index) => {
    assert.equal(page.includes('1470 compact: no horizontal scroll'), true, `声优库 ${index + 1} 缺少紧凑模式标记`);
    assert.match(page, /\.table-wrap\{overflow-y:auto;overflow-x:hidden/);
    assert.match(page, /#rosterTable\{width:100%;table-layout:fixed;min-width:0\}/);
    assert.match(page, /#rosterTable th\{min-width:0!important;width:auto!important/);
    assert.equal((page.match(/<th style=/g) || []).length, 10, '声优库必须继续保留全部 10 列');
  });
});

test('1470×956 AI 助手保留三栏并让对话区吸收剩余宽度', () => {
  [
    readProjectFile('preview-AI助手-精修版.html'),
    readProjectFile('deploy/frontend/preview-AI助手-精修版.html'),
  ].forEach((page, index) => {
    assert.equal(page.includes('1470 compact: no horizontal scroll'), true, `AI 助手 ${index + 1} 缺少紧凑模式标记`);
    assert.match(page, /\.mid\{grid-template-columns:170px minmax\(0,1fr\) 240px/);
    assert.match(page, /\.cmd-col,\.chat-col,\.data-col\{min-width:0\}/);
    assert.match(page, /html,body\{overflow-x:hidden\}/);
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
