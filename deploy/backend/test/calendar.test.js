// 日期引擎单元测试（纯逻辑，无需数据库）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const cal = require('../src/calendar');

function D(s){ const [y,m,d]=s.split('-').map(Number); return new Date(y,m-1,d); }

test('isHoliday 命中全量放假区间与圣诞日', () => {
  assert.ok(cal.isHoliday(D('2026-01-01')));   // 元旦
  assert.ok(cal.isHoliday(D('2026-02-16')));   // 春节区间内
  assert.ok(!cal.isHoliday(D('2026-01-30')));  // 旧错误春节日期不得残留
  assert.ok(cal.isHoliday(D('2026-12-25')));   // 海外圣诞周锚点
  assert.ok(!cal.isHoliday(D('2026-01-10')));  // 普通日
});

test('isBridge 识别国务院公布的 2026 调休补班日', () => {
  for(const day of ['2026-01-04','2026-02-14','2026-02-28','2026-05-09','2026-09-20','2026-10-10']){
    assert.ok(cal.isBridge(D(day)), `${day} 应为补班日`);
  }
  assert.ok(!cal.isBridge(D('2026-09-27')), '中秋假期日不能同时作为补班日');
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
  // 从周六 2026-01-03 起 +1 个工作日，应命中国务院调休补班日 1/04(周日)
  const r2 = cal.addWorkDays(D('2026-01-03'), 1);
  assert.strictEqual(cal.toKey(r2), '2026-01-04');
});

test('getCalendar 按年返回节假日与补班', () => {
  const c2026 = cal.getCalendar(2026);
  assert.strictEqual(c2026.year, 2026);
  assert.ok(c2026.holidays.length >= 8);
  assert.ok(c2026.bridges.includes('2026-02-14'));
  const c2030 = cal.getCalendar(2030);
  assert.strictEqual(c2030.holidays.length, 0); // 未内置
});

test('weekIsHoliday 任一法定放假日或圣诞日命中即整周无效', () => {
  assert.ok(cal.weekIsHoliday(D('2026-09-21'))); // 中秋周
  assert.ok(cal.weekIsHoliday(D('2026-12-21'))); // 仅 12/25 命中也必须整周无效
});

test('前后端统一使用同一份全量节假日模块', () => {
  const projectRoot = path.resolve(__dirname, '../../..');
  const rootAsset = path.join(projectRoot, 'assets/holiday-calendar.js');
  const deployAsset = path.join(projectRoot, 'deploy/frontend/assets/holiday-calendar.js');
  assert.ok(fs.existsSync(rootAsset), '缺少根目录全量节假日模块');
  assert.ok(fs.existsSync(deployAsset), '缺少发布镜像节假日模块');
  assert.strictEqual(fs.readFileSync(rootAsset, 'utf8'), fs.readFileSync(deployAsset, 'utf8'));
  assert.deepStrictEqual(cal.HOLIDAYS, require(rootAsset).HOLIDAYS);
  assert.deepStrictEqual(cal.BRIDGE_DAYS, require(rootAsset).BRIDGE_DAYS);

  for(const relative of [
    'preview-版本节点-精修版.html',
    'preview-需求汇总-精修版.html',
    'preview-录制档期-精修版.html',
    'deploy/frontend/preview-版本节点-精修版.html',
    'deploy/frontend/preview-需求汇总-精修版.html',
    'deploy/frontend/preview-录制档期-精修版.html',
  ]){
    const page = fs.readFileSync(path.join(projectRoot, relative), 'utf8');
    assert.match(page, /assets\/holiday-calendar\.js/, `${relative} 未加载统一节假日模块`);
    assert.match(page, /window\.VOMI_HOLIDAY_CALENDAR/, `${relative} 未消费统一节假日模块`);
  }

  for(const relative of [
    'preview-版本节点-精修版.html',
    'deploy/frontend/preview-版本节点-精修版.html',
  ]){
    const page = fs.readFileSync(path.join(projectRoot, relative), 'utf8');
    assert.doesNotMatch(page, /let HOLIDAYS\s*=\s*\[/, `${relative} 仍保留重复 HOLIDAYS 数组`);
  }

  for(const relative of [
    'preview-需求汇总-精修版.html',
    'deploy/frontend/preview-需求汇总-精修版.html',
  ]){
    const page = fs.readFileSync(path.join(projectRoot, relative), 'utf8');
    assert.doesNotMatch(page, /let DDL_HOLIDAYS\s*=\s*\[/, `${relative} 仍保留重复 DDL_HOLIDAYS 数组`);
  }

  for(const relative of [
    'preview-录制档期-精修版.html',
    'deploy/frontend/preview-录制档期-精修版.html',
  ]){
    const page = fs.readFileSync(path.join(projectRoot, relative), 'utf8');
    assert.doesNotMatch(page, /var HOLIDAY_RANGES_WD\s*=\s*\[/, `${relative} 仍保留重复 HOLIDAY_RANGES_WD 数组`);
    assert.doesNotMatch(page, /var HOLIDAYS\s*=\s*\[/, `${relative} 仍保留重复 HOLIDAYS 数组`);
  }
});
