// 日期引擎单元测试（纯逻辑，无需数据库）
const test = require('node:test');
const assert = require('node:assert');
const cal = require('../src/calendar');

function D(s){ const [y,m,d]=s.split('-').map(Number); return new Date(y,m-1,d); }

test('isHoliday 命中放假区间', () => {
  assert.ok(cal.isHoliday(D('2026-01-01')));   // 元旦
  assert.ok(cal.isHoliday(D('2026-02-01')));   // 春节区间内
  assert.ok(!cal.isHoliday(D('2026-01-10')));  // 普通日
});

test('isBridge 识别调休补班日', () => {
  assert.ok(cal.isBridge(D('2026-02-14')));
  assert.ok(!cal.isBridge(D('2026-02-16')));  // 不在种子中
});

test('isWorkday：周末补班算工作日、节假日不算', () => {
  // 2026-02-14 是周六且为补班日 -> 工作日
  assert.ok(cal.isWorkday(D('2026-02-14')));
  // 2026-01-01 元旦(周四)放假 -> 非工作日
  assert.ok(!cal.isWorkday(D('2026-01-01')));
  // 普通周一 -> 工作日
  assert.ok(cal.isWorkday(D('2026-01-05')));
  // 普通周六 -> 非工作日
  assert.ok(!cal.isWorkday(D('2026-01-10')));
});

test('addWorkDays 跨节假日正确累加', () => {
  // 2026-01-05(周一) 起向后 +3 个工作日：1/6(二),1/7(三),1/8(四) -> 1/8
  const r = cal.addWorkDays(D('2026-01-05'), 3);
  assert.strictEqual(cal.toKey(r), '2026-01-08');
  // 从周六 2026-01-03 起 +1 个工作日，应跳过周末落到 1/05(周一)
  const r2 = cal.addWorkDays(D('2026-01-03'), 1);
  assert.strictEqual(cal.toKey(r2), '2026-01-05');
});

test('getCalendar 按年返回节假日与补班', () => {
  const c2026 = cal.getCalendar(2026);
  assert.strictEqual(c2026.year, 2026);
  assert.ok(c2026.holidays.length >= 7);
  assert.ok(c2026.bridges.includes('2026-02-14'));
  const c2030 = cal.getCalendar(2030);
  assert.strictEqual(c2030.holidays.length, 0); // 未内置
});

test('weekIsHoliday 节假日覆盖>2天判定', () => {
  // 中秋 2026-09-25~09-27 落在某周一~周日周内，覆盖3天 -> true
  const mon = D('2026-09-21'); // 该周周一
  assert.ok(cal.weekIsHoliday(mon));
});
