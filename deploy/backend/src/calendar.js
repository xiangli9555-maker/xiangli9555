// calendar.js — 统一日期引擎（法定节假日 + 调休补班 + 工作日计算）
// 前后端共同读取 deploy/frontend/assets/holiday-calendar.js，避免多份日期表独立漂移。
const holidayCalendar = require('../../frontend/assets/holiday-calendar.js');
const HOLIDAYS = holidayCalendar.HOLIDAYS;
const BRIDGE_DAYS = holidayCalendar.BRIDGE_DAYS;

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
// 任一法定放假日或 12/25 命中周一~周日，该周整周不计入有效周。
function weekIsHoliday(monday) {
  return holidayCalendar.weekIsHoliday(monday, HOLIDAYS);
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
