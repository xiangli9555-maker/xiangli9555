// calendar.js — 统一日期引擎（官方节假日 + 调休补班 + 工作日计算）
// 作为前后端唯一真源；页面改为消费本模块经 /api/calendar 提供的数据。
//
// ⚠️ 数据准确性：HOLIDAYS 为国务院放假区间（2026-2028 内置，离线可用）。
//    BRIDGE_DAYS（调休补班日 = 周末变工作日）须按当年《国务院办公厅关于节假日安排的通知》核对，
//    下方仅给骨架示例，部署前请补全/校正。

// 法定节假日（放假区间，含起止）
const HOLIDAYS = [
  // 2026
  { label: '元旦',   start: '2026-01-01', end: '2026-01-03' },
  { label: '春节',   start: '2026-01-29', end: '2026-02-04' },
  { label: '清明节', start: '2026-04-04', end: '2026-04-06' },
  { label: '劳动节', start: '2026-05-01', end: '2026-05-05' },
  { label: '端午节', start: '2026-05-29', end: '2026-05-31' },
  { label: '中秋节', start: '2026-09-25', end: '2026-09-27' },
  { label: '国庆节', start: '2026-10-01', end: '2026-10-07' },
  // 2027
  { label: '元旦',   start: '2027-01-01', end: '2027-01-03' },
  { label: '春节',   start: '2027-02-05', end: '2027-02-13' },
  { label: '清明节', start: '2027-04-05', end: '2027-04-07' },
  { label: '劳动节', start: '2027-05-01', end: '2027-05-05' },
  { label: '端午节', start: '2027-05-28', end: '2027-05-30' },
  { label: '中秋节', start: '2027-09-20', end: '2027-09-22' },
  { label: '国庆节', start: '2027-10-01', end: '2027-10-07' },
  // 2028
  { label: '元旦',   start: '2028-01-01', end: '2028-01-03' },
  { label: '春节',   start: '2028-01-25', end: '2028-02-01' },
  { label: '清明节', start: '2028-04-04', end: '2028-04-06' },
  { label: '劳动节', start: '2028-05-01', end: '2028-05-05' },
  { label: '端午节', start: '2028-06-19', end: '2028-06-21' },
  { label: '中秋节', start: '2028-09-14', end: '2028-09-16' },
  { label: '国庆节', start: '2028-10-01', end: '2028-10-07' },
];

// 调休补班日（周末上班）。⚠️ 须按官方通知逐年核对，以下为占位示例。
const BRIDGE_DAYS = [
  // 2026 示例（请以国务院通知为准）：
  '2026-02-14',
  '2026-09-27',            // 中秋/国庆衔接补班（示例）
  '2026-10-10', '2026-10-11',
  // 2027 / 2028 待补全
];

function toKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function parseKey(k) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function isHoliday(date) {
  const k = toKey(date);
  return HOLIDAYS.some(h => k >= h.start && k <= h.end);
}
function isBridge(date) {
  return BRIDGE_DAYS.includes(toKey(date));
}
// 工作日 = 非周末(或补班日) 且 非法定节假日
function isWorkday(date) {
  const dow = date.getDay();
  const weekend = dow === 0 || dow === 6;
  if (weekend && !isBridge(date)) return false;
  if (isHoliday(date)) return false;
  return true;
}
// 累加 n 个工作日（n=0 返回当日；n>0 返回第 n 个工作日）
function addWorkDays(startDate, n) {
  let cur = new Date(startDate.getTime());
  if (n <= 0) return cur;
  let rem = n;
  while (rem > 0) {
    cur = new Date(cur.getTime() + 86400000);
    if (isWorkday(cur)) rem--;
  }
  return cur;
}
// 整周(周一~周日)被法定节假日覆盖 >2 天 => 节假日周（跳过不计工作周）
function weekIsHoliday(monday) {
  const m = new Date(monday.getTime());
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); // 归一到周一
  let hit = 0;
  for (let i = 0; i < 7; i++) {
    const day = new Date(m.getTime() + i * 86400000);
    if (isHoliday(day)) hit++;
  }
  return hit > 2;
}

// 对外：某年日历数据（供 /api/calendar）
function getCalendar(year) {
  const y = Number(year) || new Date().getFullYear();
  const holidays = HOLIDAYS.filter(h => h.start.startsWith(String(y)));
  const bridges = BRIDGE_DAYS.filter(b => b.startsWith(String(y)));
  return { year: y, holidays, bridges };
}

module.exports = {
  HOLIDAYS, BRIDGE_DAYS,
  toKey, parseKey,
  isHoliday, isBridge, isWorkday,
  addWorkDays, weekIsHoliday,
  getCalendar,
};
