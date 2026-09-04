'use strict';
// tapd_live.js 纯函数测试：toSnapshotItems 的过滤 + 映射 + 排序
// 验收基准：TAPD MCP 实时实测 release_id=Yang1.0 + name LIKE<语音-中> 返回 42 条（3 挂起 → 39 有效）。
// 本测试用代表性边界用例验证「排除挂起/非音频/无语音-中/非关注版本 + 映射剥【】 + 排序」的正确性。

const { test } = require('node:test');
const assert = require('node:assert');
const { toSnapshotItems } = require('../src/tapd_live');

const YANG1 = '1020421949002200155';
const MA5 = '1020421949002192265';

test('toSnapshotItems 过滤与映射：排除挂起/非音频/无语音-中/非关注版本，正确映射字段并排序', () => {
  const stories = [
    // 正常 Yang1 SOL → 保留
    { id: '1020421949137916023', parent_id: '1020421949134949464', name: '【手游|PC】【音频】【AI】【语音-中】围城.哈夫克电棍近战兵的台词语音', type: '音频', status: 'new', release_id: YANG1, owner: 'lycheelli;', creator: 'morrinzhang', Area: '【SOL】' },
    // suspended → 排除
    { id: '1020421949137163177', parent_id: '1020421949137161401', name: '【音频】【语音-中】重生老太补录', type: '音频', status: 'suspended', release_id: YANG1, Area: '【商业化】' },
    // v_status=挂起 → 排除
    { id: '1020421949135485851', parent_id: '1020421949135485847', name: '【音频】【玩法】围城外城撤离视频 - 【Vo.语音-中】', type: '音频', status: 'new', v_status: '挂起', release_id: YANG1, Area: '【SOL】' },
    // 「Vo.语音-中」含语音-中子串 → 保留
    { id: '1020421949137284427', parent_id: '1020421949137284414', name: '【音频】【SOL】赛季任务演绎【Vo.语音-中】', type: '音频', status: 'new', release_id: YANG1, owner: 'diyayang;', creator: 'luxxchen', Area: '【系统】' },
    // type 非音频 → 排除
    { id: '1020421949137999999', parent_id: '1020421949137999998', name: '【音效】【语音-中】某音效', type: '音效', status: 'new', release_id: YANG1, Area: '【系统】' },
    // 无「语音-中」→ 排除
    { id: '1020421949137999998', parent_id: '1020421949137999997', name: '【音频】【系统】某BGM音乐', type: '音频', status: 'new', release_id: YANG1, Area: '【系统】' },
    // release 不在 RELEASE_MAP → 排除
    { id: '1020421949137999997', parent_id: '1020421949137999996', name: '【音频】【语音-中】Yang2某需求', type: '音频', status: 'new', release_id: '9999999999999999999', Area: '【干员】' },
    // Ma5 正常 → 保留（排序应排最前）
    { id: '1020421949137999996', parent_id: '1020421949137999995', name: '【音频】【干员】【语音-中】Ma5干员语音', type: '音频', status: 'new', release_id: MA5, owner: 'x', creator: 'x', Area: '【干员】' },
  ];

  const items = toSnapshotItems(stories);

  assert.equal(items.length, 3, '应只保留 3 条有效需求');

  // 排序：Ma5(order 0) 最前，Yang1(order 1) 在后；Yang1 内 area 按 localeCompare
  assert.equal(items[0].id, '1020421949137999996', 'Ma5 应排最前');
  assert.equal(items[0].release_plan, 'Ma5.0');
  assert.equal(items[0].area, '干员', 'area 应取【】内文字');
  assert.equal(items[0].task_name, 'Ma5干员语音', 'task_name 应剥【】');

  const sol = items.find((i) => i.id === '1020421949137916023');
  assert.ok(sol, 'Yang1 SOL 需求应保留');
  assert.equal(sol.release_plan, 'Yang1.0');
  assert.equal(sol.area, 'SOL');
  assert.equal(sol.task_name, '围城.哈夫克电棍近战兵的台词语音');
  assert.equal(sol.parent_id, '1020421949134949464', 'parent_id 应保留');
  assert.equal(sol.creator, 'morrinzhang', 'creator 应去除尾部分号');
  assert.equal(sol.status, 'new', 'status 应保留真实值');
  assert.equal(sol.handler, '', 'handler 应与快照一致留空');
  assert.equal(sol.developer, '', 'developer 应与快照一致留空');

  // 「Vo.语音-中」应因含「语音-中」子串被保留
  const vo = items.find((i) => i.id === '1020421949137284427');
  assert.ok(vo, 'Vo.语音-中 需求应保留（含语音-中子串）');
  assert.equal(vo.area, '系统');
});

test('toSnapshotItems 空数组与全挂起均不产出', () => {
  assert.equal(toSnapshotItems([]).length, 0);
  const allSuspended = [
    { id: '1020421949137163177', parent_id: '1', name: '【语音-中】挂起A', type: '音频', status: 'suspended', release_id: YANG1, Area: '【SOL】' },
    { id: '1020421949135485851', parent_id: '2', name: '【语音-中】挂起B', type: '音频', status: 'new', v_status: '挂起', release_id: YANG1, Area: '【SOL】' },
  ];
  assert.equal(toSnapshotItems(allSuspended).length, 0, '全挂起应产出 0 条');
});

test('cleanTitle 剥【】后与 build_snapshot.py clean_title 同口径（折叠空白）', () => {
  const items = toSnapshotItems([
    { id: '1020421949137999995', parent_id: '1', name: '【手游|PC】【音频】【系统】【语音-中】   蜂医小屋   专属交互物   ', type: '音频', status: 'new', release_id: YANG1, Area: '【系统】' },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].task_name, '蜂医小屋 专属交互物', '多空白应折叠为单空格并去首尾');
});
