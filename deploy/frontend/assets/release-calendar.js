(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  if(root) root.VOMI_RELEASE_CALENDAR = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  let cachedPlans = [];
  let loading = null;

  function listOf(payload){
    if(Array.isArray(payload)) return payload;
    return payload && Array.isArray(payload.data) ? payload.data : [];
  }

  function releaseName(value){
    return String(value == null ? '' : value)
      .trim()
      .replace(/[【】]/g, '')
      .replace(/_/g, '')
      .replace(/\s+/g, '');
  }

  function dateKey(value){
    const d = value instanceof Date ? value : new Date(value == null ? Date.now() : value);
    if(!Number.isFinite(d.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(d).reduce((out, part)=>{
      if(part.type !== 'literal') out[part.type] = part.value;
      return out;
    }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function orderedPlans(payload){
    return listOf(payload)
      .filter(plan=>plan && plan.phases && plan.phases.dev && plan.phases.dev.end && plan.phases.test && plan.phases.test.start)
      .filter(plan=>Number(plan.phases.is_main == null ? 1 : plan.phases.is_main) !== 0)
      .slice()
      .sort((a,b)=>String(a.phases.dev.start||'').localeCompare(String(b.phases.dev.start||'')));
  }

  function releaseWindows(payload){
    const plans = orderedPlans(payload);
    return plans.map((plan, index)=>({
      name: releaseName(plan.label || plan.name || plan.release_plan),
      start: index > 0
        ? String(plans[index - 1].phases.test.start || '')
        : String((plan.phases.range && plan.phases.range.start) || plan.startdate || plan.phases.dev.start || ''),
      end: String(plan.phases.dev.end || ''),
      source: plan
    })).filter(item=>item.name && item.start && item.end);
  }

  function currentRelease(payload, at){
    const day = dateKey(at);
    if(!day) return '';
    const hit = releaseWindows(payload).find(item=>item.start <= day && day <= item.end);
    return hit ? hit.name : '';
  }

  function releaseIndex(payload, value){
    const key = releaseName(value).toLowerCase();
    if(!key) return -1;
    return orderedPlans(payload).findIndex(plan=>releaseName(plan.label || plan.name || plan.release_plan).toLowerCase() === key);
  }

  function isAtOrAfter(payload, value, floor){
    const valueIndex = releaseIndex(payload, value);
    const floorIndex = releaseIndex(payload, floor);
    return valueIndex >= 0 && floorIndex >= 0 && valueIndex >= floorIndex;
  }

  function clampFrom(payload, value, floor){
    return isAtOrAfter(payload, value, floor) ? releaseName(value) : releaseName(floor);
  }

  async function fetchJson(url){
    const response = await fetch(url, {cache:'no-store'});
    if(!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function load(){
    if(cachedPlans.length) return cachedPlans;
    if(loading) return loading;
    loading = (async()=>{
      let payload = null;
      try{ payload = await fetchJson('/api/release-plans'); }
      catch(_){ payload = await fetchJson('data/release-plans.json'); }
      cachedPlans = orderedPlans(payload);
      return cachedPlans;
    })().finally(()=>{ loading = null; });
    return loading;
  }

  function setPlans(payload){
    cachedPlans = orderedPlans(payload);
    return cachedPlans;
  }

  function parseDay(value){
    const parts = String(value || '').replace(/\//g, '-').split('-').map(Number);
    if(parts.length !== 3 || parts.some(part=>!Number.isFinite(part))) return null;
    return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0);
  }

  function mondayOf(date){
    const out = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0);
    out.setDate(out.getDate() - ((out.getDay() + 6) % 7));
    return out;
  }

  function addDays(date, count){
    const out = new Date(date);
    out.setDate(out.getDate() + count);
    return out;
  }

  function keyOf(date, holidayCalendar){
    if(holidayCalendar && typeof holidayCalendar.toKey === 'function') return holidayCalendar.toKey(date);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function weekIsHoliday(date, holidayCalendar){
    return !!(holidayCalendar && typeof holidayCalendar.weekIsHoliday === 'function' && holidayCalendar.weekIsHoliday(date));
  }

  function nthValidWeekBackwardInclusive(fromDate, count, holidayCalendar){
    let cursor = mondayOf(fromDate);
    let remaining = Math.max(1, count);
    while(true){
      if(!weekIsHoliday(cursor, holidayCalendar)){
        remaining -= 1;
        if(remaining === 0) return cursor;
      }
      cursor = addDays(cursor, -7);
    }
  }

  function shiftValidWeeksAfter(fromDate, count, holidayCalendar){
    let cursor = mondayOf(fromDate);
    let remaining = Math.max(0, count);
    while(remaining > 0){
      cursor = addDays(cursor, 7);
      if(weekIsHoliday(cursor, holidayCalendar)) continue;
      remaining -= 1;
    }
    return cursor;
  }

  function deliveryFriday(devEnd, holidayCalendar){
    let week = addDays(mondayOf(devEnd), -7);
    while(weekIsHoliday(week, holidayCalendar)) week = addDays(week, -7);
    return addDays(week, 4);
  }

  function vomiMilestones(plan, holidayCalendar){
    const devEnd = parseDay(plan && plan.phases && plan.phases.dev && plan.phases.dev.end);
    if(!devEnd) return [];
    const demandLock = nthValidWeekBackwardInclusive(devEnd, 11, holidayCalendar);
    const talentLock = addDays(shiftValidWeeksAfter(demandLock, 3, holidayCalendar), 3);
    const scriptLock = addDays(shiftValidWeeksAfter(talentLock, 2, holidayCalendar), 3);
    const delivery = deliveryFriday(devEnd, holidayCalendar);
    return [
      { key:'demand-lock', label:'Vo需求锁', date:keyOf(demandLock, holidayCalendar), roles:['pm','writer'] },
      { key:'talent-lock', label:'声优锁', date:keyOf(talentLock, holidayCalendar), time:'11:30', roles:['pm','writer','audio'] },
      { key:'script-lock', label:'台词锁', date:keyOf(scriptLock, holidayCalendar), time:'11:30', roles:['pm','writer','audio'] },
      { key:'vo-delivery', label:'VO资源交付', date:keyOf(delivery, holidayCalendar), roles:['pm','audio'] }
    ];
  }

  function currentCached(at){
    return currentRelease(cachedPlans, at);
  }

  function isAtOrAfterCached(value, floor){
    return isAtOrAfter(cachedPlans, value, floor);
  }

  function clampFromCached(value, floor){
    return clampFrom(cachedPlans, value, floor);
  }

  return {
    listOf,
    releaseName,
    releaseWindows,
    currentRelease,
    currentCached,
    releaseIndex,
    isAtOrAfter,
    isAtOrAfterCached,
    clampFrom,
    clampFromCached,
    vomiMilestones,
    load,
    setPlans
  };
});
