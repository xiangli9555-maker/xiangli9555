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

  // 验证周口径（2026-09-16 PM）：dev.end 与 test.start 之间的验证周视同开发周，
  // 有效开发结束日 = test.start 前一天（空档 2~29 天才扩展，防脏数据）。
  function effectiveDevEnd(phases){
    const raw = parseDay(phases && phases.dev && phases.dev.end);
    if(!raw) return null;
    const testStart = parseDay(phases && phases.test && phases.test.start);
    if(testStart){
      const gapDays = Math.round((testStart - raw)/86400000);
      if(gapDays > 1 && gapDays <= 29) return new Date(testStart.getTime() - 86400000);
    }
    return raw;
  }

  // ── Vo需求锁手动锚定（PM 拍板 · 跳过公式）────────────────────────────
  // 2026-09-11 PM 手动锚定 Yang1 Vo需求锁 = 2026-09-14：公式（dev.end 向前第 11 个有效周周一）
  // 算出的日期与 PM 口径不一致，故显式声明。后续版本继续走公式。
  // 历史：这张表原先只在「版本节点页」内联存在，「录制档期页」另有一份副本，
  // 「需求汇总页」和本文件完全没有 override 分支 → 2026-09-17 抽成公共口径，四处统一从这里取。
  const VO_NEED_LOCK_OVERRIDE = Object.freeze({ yang1: '2026-09-14' });

  // 版本 key 强归一化：大小写 /【】/ 空格 / 下划线 / 末尾 .0 全部抹平
  // 例：'【Yang_1.0】' / 'Yang_1.0' / 'Yang1' / 'yang1' → 'yang1'
  function normReleaseKey(value){
    return String(value == null ? '' : value)
      .trim().toLowerCase()
      .replace(/[【】\s_]/g, '')
      .replace(/\.0$/, '');
  }

  // 入参：版本名字符串，或 release plan / version 对象（依次试 id/release/name/label/release_plan）
  function voNeedLockOverrideFor(target){
    if(target == null || target === '') return '';
    if(typeof target === 'string') return VO_NEED_LOCK_OVERRIDE[normReleaseKey(target)] || '';
    const candidates = [target.id, target.release, target.name, target.label, target.release_plan];
    for(const c of candidates){
      const hit = VO_NEED_LOCK_OVERRIDE[normReleaseKey(c)];
      if(hit) return hit;
    }
    return '';
  }

  // Vo需求锁当天（周一）：有 override 就用 override，否则走公式。
  // 日期串统一转成 'YYYY/MM/DD' 再解析，避免 new Date('YYYY-MM-DD') 按 UTC 午夜解析导致东八区差一天。
  function voNeedLockDay(planOrName, devEnd, holidayCalendar){
    const overrideIso = voNeedLockOverrideFor(planOrName);
    if(overrideIso){
      const raw = parseDay(String(overrideIso).replace(/-/g, '/'));
      if(raw) return mondayOf(raw);
    }
    return nthValidWeekBackwardInclusive(devEnd, 11, holidayCalendar);
  }

  function vomiMilestones(plan, holidayCalendar){
    const devEnd = effectiveDevEnd(plan && plan.phases);
    if(!devEnd) return [];
    const demandLock = voNeedLockDay(plan, devEnd, holidayCalendar);
    // 2026-09-16 PM 拍板：声优锁 / 台词锁都是**周三**（+2，+3 是周四，旧口径）。
    // 声优锁当天 18:00 是「声优预估编辑截止」，锁点本身仍是 11:30。
    const talentLock = addDays(shiftValidWeeksAfter(demandLock, 3, holidayCalendar), 2);
    const scriptLock = addDays(shiftValidWeeksAfter(talentLock, 2, holidayCalendar), 2);
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
    VO_NEED_LOCK_OVERRIDE,
    normReleaseKey,
    voNeedLockOverrideFor,
    voNeedLockDay,
    load,
    setPlans
  };
});
