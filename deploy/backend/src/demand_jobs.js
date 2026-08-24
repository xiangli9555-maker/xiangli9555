'use strict';
const fs = require('fs');
const path = require('path');

function ensureParentFile(file, initial='[]') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, initial, { mode: 0o600 });
}

const STATUSES = new Set(['pending','running','done','failed']);

function createDemandJobs(options) {
  const file = options.file || path.join(__dirname, '..', 'demand_jobs.json');
  const legacyFile = options.legacyFile || path.join(__dirname, '..', 'cw_jobs.json');
  ensureParentFile(file);
  const execute = options.execute;
  const log = options.log || console;
  const jobs = new Map();
  let running = false;
  const now = () => new Date().toISOString();
  const newId = () => 'job-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8);
  const keyOf = (type, demandId, version='v1') => `${type}:demand:${String(demandId)}:${version}`;

  function normalize(raw) {
    if (!raw || !raw.id) return null;
    const type = raw.type || 'script_table';
    const demandId = raw.demand_id || (raw.story_ids && raw.story_ids[0]) || (raw._demand && raw._demand.id);
    if (!demandId) return null;
    const version = raw.version || (type === 'script_table' ? 'v6' : 'v1');
    const status = STATUSES.has(raw.status) ? raw.status : 'failed';
    return {
      id: raw.id,
      type,
      demand_id: String(demandId),
      release: raw.release || '',
      idempotency_key: raw.idempotency_key || keyOf(type,demandId,version),
      status: status === 'running' ? 'pending' : status,
      attempt: Number(raw.attempt || 0),
      retry_count: Number(raw.retry_count || 0),
      max_attempts: Number(raw.max_attempts || 3),
      created_at: raw.created_at || now(),
      updated_at: raw.updated_at || now(),
      started_at: raw.started_at || null,
      finished_at: raw.finished_at || null,
      error: raw.error || '',
      progress: raw.progress || '',
      version,
      title: raw.title || raw.doc_title || raw.cw_name || '',
      result: raw.result || {
        doc_url: raw.doc_url || '', doc_file_id: raw.doc_file_id || '', doc_title: raw.doc_title || ''
      },
      payload: raw.payload || { demand_id:String(demandId) }
    };
  }

  function loadArray(p) {
    try { const a=JSON.parse(fs.readFileSync(p,'utf8')); return Array.isArray(a)?a:[]; }
    catch (_) { return []; }
  }
  function load() {
    const source = fs.existsSync(file) ? loadArray(file) : loadArray(legacyFile);
    source.map(normalize).filter(Boolean).forEach(j=>jobs.set(j.id,j));
    save();
  }
  function save() {
    try { fs.writeFileSync(file, JSON.stringify([...jobs.values()],null,2)); }
    catch (e) { log.error('[jobs] save fail:',e.message); }
  }
  function latestByKey(key) {
    return [...jobs.values()].filter(j=>j.idempotency_key===key).sort((a,b)=>b.created_at.localeCompare(a.created_at))[0] || null;
  }
  function publicJob(job) {
    if(!job) return null;
    const { payload, ...safe } = job;
    return safe;
  }
  function enqueue({type,demand,release,version,title,max_attempts=3,force=false}) {
    if(!demand || !demand.id) throw new Error('demand.id required');
    if(!['script_table','voice_estimates'].includes(type)) throw new Error('unsupported job type');
    const ver = version || (type==='script_table'?'v6':'v1');
    const key = keyOf(type,demand.id,ver);
    const existing = latestByKey(key);
    if(existing && !force) {
      const reason = existing.status==='failed' ? 'failed_retry_required' : existing.status;
      return {job:existing,created:false,reason};
    }
    const job = {
      id:newId(), type, demand_id:String(demand.id), release:release||demand.release_plan||'',
      idempotency_key:key, status:'pending', attempt:0, retry_count:0, max_attempts,
      created_at:now(), updated_at:now(), started_at:null, finished_at:null,
      error:'', progress:'queued', version:ver, title:title||demand.task_name||String(demand.id),
      result:{}, payload:{demand_id:String(demand.id)}
    };
    jobs.set(job.id,job); save(); run();
    return {job,created:true,reason:'created'};
  }
  async function run() {
    if(running) return;
    running=true;
    try {
      while(true) {
        const job=[...jobs.values()].filter(j=>j.status==='pending').sort((a,b)=>a.created_at.localeCompare(b.created_at))[0];
        if(!job) break;
        job.status='running'; job.attempt+=1; job.started_at=now(); job.updated_at=now(); job.progress='running'; save();
        try {
          const result=await execute(job);
          if(result && result.partial===true){
            job.status='failed'; job.result=result; job.error=(result.partialReason||'任务部分失败（结果不完整）'); job.progress='partial_failed'; job.finished_at=now(); job.updated_at=now(); save();
          } else {
            job.status='done'; job.result=result||{}; job.error=''; job.progress='done'; job.finished_at=now(); job.updated_at=now(); save();
          }
        } catch(e) {
          job.status='failed'; job.error=e && e.message ? e.message : String(e); job.progress='failed'; job.finished_at=now(); job.updated_at=now(); save();
        }
      }
    } finally { running=false; }
  }
  function retry(id) {
    const job=jobs.get(id);
    if(!job) return {error:'job_not_found',status:404};
    if(job.status!=='failed') return {error:'only_failed_job_can_retry',status:409,job};
    if(job.attempt>=job.max_attempts) return {error:'max_attempts_reached',status:409,job};
    job.status='pending'; job.retry_count+=1; job.error=''; job.progress='retry_queued'; job.started_at=null; job.finished_at=null; job.updated_at=now(); save(); run();
    return {job,status:200};
  }
  function list(filter={}) {
    let a=[...jobs.values()];
    if(filter.type) a=a.filter(j=>j.type===filter.type);
    if(filter.status) a=a.filter(j=>j.status===filter.status);
    if(filter.release) a=a.filter(j=>j.release===filter.release);
    if(filter.demand_id) a=a.filter(j=>String(j.demand_id)===String(filter.demand_id));
    a.sort((x,y)=>y.created_at.localeCompare(x.created_at));
    return a;
  }
  function get(id){ return jobs.get(id)||null; }
  function latest(type,demandId,version){ return latestByKey(keyOf(type,demandId,version||(type==='script_table'?'v6':'v1'))); }

  load();
  setImmediate(run);
  return { enqueue, retry, list, get, latest, run, save, publicJob, keyOf, statuses:[...STATUSES] };
}
module.exports={createDemandJobs};
