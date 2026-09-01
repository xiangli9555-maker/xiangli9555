(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  if(root) root.VOMI_HOLIDAY_CALENDAR = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  // 中国法定放假区间：2026 为国务院办公厅正式安排；2027–2028 为版本规划离线兜底。
  // 海外仅以 12/25 作为圣诞周锚点，命中后整周不计入有效周。
  const HOLIDAYS = [
    {region:'CN',year:2026,short:'元旦',label:'元旦',start:'2026-01-01',end:'2026-01-03'},
    {region:'CN',year:2026,short:'春节',label:'春节',start:'2026-02-15',end:'2026-02-23'},
    {region:'CN',year:2026,short:'清明',label:'清明节',start:'2026-04-04',end:'2026-04-06'},
    {region:'CN',year:2026,short:'劳动',label:'劳动节',start:'2026-05-01',end:'2026-05-05'},
    {region:'CN',year:2026,short:'端午',label:'端午节',start:'2026-06-19',end:'2026-06-21'},
    {region:'CN',year:2026,short:'中秋',label:'中秋节',start:'2026-09-25',end:'2026-09-27'},
    {region:'CN',year:2026,short:'国庆',label:'国庆节',start:'2026-10-01',end:'2026-10-07'},
    {region:'CN',year:2027,short:'元旦',label:'元旦',start:'2027-01-01',end:'2027-01-03'},
    {region:'CN',year:2027,short:'春节',label:'春节',start:'2027-02-05',end:'2027-02-13'},
    {region:'CN',year:2027,short:'清明',label:'清明节',start:'2027-04-05',end:'2027-04-07'},
    {region:'CN',year:2027,short:'劳动',label:'劳动节',start:'2027-05-01',end:'2027-05-05'},
    {region:'CN',year:2027,short:'端午',label:'端午节',start:'2027-05-28',end:'2027-05-30'},
    {region:'CN',year:2027,short:'中秋',label:'中秋节',start:'2027-09-20',end:'2027-09-22'},
    {region:'CN',year:2027,short:'国庆',label:'国庆节',start:'2027-10-01',end:'2027-10-07'},
    {region:'CN',year:2028,short:'元旦',label:'元旦',start:'2028-01-01',end:'2028-01-03'},
    {region:'CN',year:2028,short:'春节',label:'春节',start:'2028-01-25',end:'2028-02-01'},
    {region:'CN',year:2028,short:'清明',label:'清明节',start:'2028-04-04',end:'2028-04-06'},
    {region:'CN',year:2028,short:'劳动',label:'劳动节',start:'2028-05-01',end:'2028-05-05'},
    {region:'CN',year:2028,short:'端午',label:'端午节',start:'2028-06-19',end:'2028-06-21'},
    {region:'CN',year:2028,short:'中秋',label:'中秋节',start:'2028-09-14',end:'2028-09-16'},
    {region:'CN',year:2028,short:'国庆',label:'国庆节',start:'2028-10-01',end:'2028-10-07'},
    ...[2025,2026,2027,2028,2029].map(year=>({region:'XMAS',year,short:'圣诞',label:'圣诞节',start:`${year}-12-25`,end:`${year}-12-25`}))
  ];

  // 国务院办公厅公布的 2026 年调休上班日；未来年份未正式公布前不猜测。
  const BRIDGE_DAYS = [
    '2026-01-04','2026-02-14','2026-02-28',
    '2026-05-09','2026-09-20','2026-10-10'
  ];

  function cloneHolidays(){ return HOLIDAYS.map(item=>Object.assign({}, item)); }
  function cloneBridgeDays(){ return BRIDGE_DAYS.slice(); }
  function toKey(date){
    const d = date instanceof Date ? date : new Date(date);
    if(!Number.isFinite(d.getTime())) return '';
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  function isHoliday(date, holidays){
    const key = toKey(date);
    return (holidays || HOLIDAYS).some(item=>key >= item.start.replace(/\//g,'-') && key <= item.end.replace(/\//g,'-'));
  }
  function isBridge(date, bridges){ return (bridges || BRIDGE_DAYS).includes(toKey(date)); }
  function isWorkday(date, holidays, bridges){
    const d = date instanceof Date ? date : new Date(date);
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    if(weekend && !isBridge(d, bridges)) return false;
    return !isHoliday(d, holidays);
  }
  function mondayOf(date){
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() - ((d.getDay()+6)%7));
    return d;
  }
  function weekIsHoliday(date, holidays){
    const mon = mondayOf(date);
    const sun = new Date(mon); sun.setDate(sun.getDate()+6);
    const start = toKey(mon), end = toKey(sun);
    return (holidays || HOLIDAYS).some(item=>item.start.replace(/\//g,'-') <= end && item.end.replace(/\//g,'-') >= start);
  }

  return {
    HOLIDAYS,
    BRIDGE_DAYS,
    holidays: cloneHolidays,
    bridgeDays: cloneBridgeDays,
    toKey,
    isHoliday,
    isBridge,
    isWorkday,
    weekIsHoliday
  };
});
