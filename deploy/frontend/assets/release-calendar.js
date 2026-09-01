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

  function currentCached(at){
    return currentRelease(cachedPlans, at);
  }

  return {
    listOf,
    releaseName,
    releaseWindows,
    currentRelease,
    currentCached,
    load,
    setPlans
  };
});
