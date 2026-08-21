const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const pool = require('./db');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// 音频文件上传 · 存 /data/audio
const AUDIO_DIR = process.env.AUDIO_DIR || '/data/audio';
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
const upload = multer({ dest: AUDIO_DIR });

// 健康检查
app.get('/api/health', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT NOW() AS t');
    res.json({ ok: true, db_time: rows[0].t, service: 'vo-manager-backend' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- 通用 KV 云备份（带revision的乐观并发控制） ----------
const KV_READY = (async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS kv_store (
      k VARCHAR(128) PRIMARY KEY,
      v LONGTEXT,
      revision BIGINT NOT NULL DEFAULT 1,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    try { await pool.query(`ALTER TABLE kv_store ADD COLUMN revision BIGINT NOT NULL DEFAULT 1`); }
    catch (e) { if (!/Duplicate column|1060/.test(e.message)) throw e; }
  } catch (e) { console.error('[kv] init fail:', e.message); }
})();

// 需求表扩展列（幂等）：人工状态独立于TAPD status
const DEMANDS_READY = (async () => {
  for (const sql of [
    `ALTER TABLE demands ADD COLUMN voice_estimates JSON`,
    `ALTER TABLE demands ADD COLUMN parent_external_id VARCHAR(32)`,
    `ALTER TABLE demands ADD COLUMN manual_status VARCHAR(32) NULL`,
    `ALTER TABLE demands ADD COLUMN manual_status_updated_at DATETIME NULL`
  ]) {
    try { await pool.query(sql); }
    catch (e) { if (!/Duplicate column|1060/.test(e.message)) console.error('[demands] alter fail:', e.message); }
  }
  // 一次性兼容迁移：旧KV中的普通需求人工状态回填MySQL；虚拟release汇总行继续留在KV。
  try {
    await KV_READY;
    const [rows] = await pool.query('SELECT v FROM kv_store WHERE k=?', ['vo_clarify_v1']);
    if (rows[0] && rows[0].v) {
      const legacy = JSON.parse(rows[0].v) || {};
      const map = {'未澄清':'待澄清','有变更':'待澄清','已澄清':'文案ING'};
      const valid = new Set(['待澄清','文案ING','Vo ING','已完成']);
      for (const [id, rec] of Object.entries(legacy)) {
        if (!/^\d+$/.test(id) || !rec || !rec.status) continue;
        const status = map[rec.status] || rec.status;
        if (!valid.has(status)) continue;
        await pool.query(
          'UPDATE demands SET manual_status=?, manual_status_updated_at=COALESCE(manual_status_updated_at,NOW()) WHERE id=? AND (manual_status IS NULL OR manual_status="")',
          [status, id]
        );
      }
    }
  } catch (e) { console.warn('[demands] migrate manual status skipped:', e.message); }
})();
app.get('/api/kv/:key', async (req, res) => {
  try {
    await KV_READY;
    const [rows] = await pool.query('SELECT v, revision, updated_at FROM kv_store WHERE k=?', [req.params.key]);
    if (!rows.length) return res.json({ ok:true, exists:false, value:null, revision:0, updated_at:null });
    res.json({ ok:true, exists:true, value:rows[0].v, revision:Number(rows[0].revision||1), updated_at:rows[0].updated_at });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});
app.put('/api/kv/:key', async (req, res) => {
  try {
    await KV_READY;
    const key = req.params.key;
    const v = typeof req.body.value === 'string' ? req.body.value : JSON.stringify(req.body.value ?? null);
    const base = Number(req.body.base_revision);
    if (!Number.isInteger(base) || base < 0) return res.status(428).json({ ok:false, error:'revision_required' });
    if (base === 0) {
      try {
        await pool.query('INSERT INTO kv_store (k,v,revision) VALUES (?,?,1)', [key,v]);
        return res.json({ ok:true, revision:1 });
      } catch (e) {
        if (!/Duplicate entry|1062/.test(e.message)) throw e;
      }
    } else {
      const [result] = await pool.query('UPDATE kv_store SET v=?, revision=revision+1 WHERE k=? AND revision=?', [v,key,base]);
      if (result.affectedRows === 1) return res.json({ ok:true, revision:base+1 });
    }
    const [current] = await pool.query('SELECT v,revision,updated_at FROM kv_store WHERE k=?', [key]);
    return res.status(409).json({
      ok:false,
      error:'revision_conflict',
      current_revision:current[0] ? Number(current[0].revision) : 0,
      current_value:current[0] ? current[0].v : null,
      updated_at:current[0] ? current[0].updated_at : null
    });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ---------- 声优 ----------
app.get('/api/actors', async (req, res) => {
  const { role_type } = req.query;
  const params = [];
  let sql = 'SELECT * FROM voice_actors';
  if (role_type) { sql += ' WHERE role_type=?'; params.push(role_type); }
  sql += ' ORDER BY id';
  const [rows] = await pool.query(sql, params);
  res.json(rows);
});
app.post('/api/actors', async (req, res) => {
  const { name, role_type, languages, schedule, available, portfolio_url } = req.body;
  if (!name || !portfolio_url) return res.status(400).json({ error: '姓名与选角资料链接必填' });
  const [r] = await pool.query(
    'INSERT INTO voice_actors (name, role_type, languages, schedule, available, portfolio_url) VALUES (?,?,?,?,?,?)',
    [name, role_type || '干员', languages || '中文', schedule || '—', available ? 1 : 0, portfolio_url]
  );
  res.json({ id: r.insertId });
});
app.patch('/api/actors/:id', async (req, res) => {
  const fields = ['name', 'role_type', 'languages', 'schedule', 'available', 'portfolio_url'];
  const sets = [], vals = [];
  fields.forEach(f => { if (f in req.body) { sets.push(`${f}=?`); vals.push(req.body[f]); } });
  if (!sets.length) return res.json({ ok: true });
  vals.push(req.params.id);
  await pool.query(`UPDATE voice_actors SET ${sets.join(',')} WHERE id=?`, vals);
  res.json({ ok: true });
});
app.delete('/api/actors/:id', async (req, res) => {
  await pool.query('DELETE FROM voice_actors WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// ---------- 声优库·角色映射（10 列 Excel 版） ----------
const VOICE_ROLE_FIELDS = ['module','role_cn','gender','role_en','cn_va','cn_loc','cn_studio','en_va','en_loc','en_studio','sort_order','remark','casting_note','rec_time_cn','rec_time_en','is_deleted'];
app.get('/api/voice-roles', async (req, res) => {
  const { module } = req.query;
  const params = [];
  let sql = 'SELECT * FROM voice_roles WHERE (is_deleted=0 OR is_deleted IS NULL)';
  if (module) { sql += ' AND module=?'; params.push(module); }
  sql += ' ORDER BY module, sort_order, id';
  const [rows] = await pool.query(sql, params);
  res.json(rows);
});
app.post('/api/voice-roles', async (req, res) => {
  const body = req.body || {};
  if (!body.module || !body.role_cn) return res.status(400).json({ error: 'module 与 role_cn 必填' });
  const cols = VOICE_ROLE_FIELDS.filter(f => f in body);
  const vals = cols.map(f => body[f]);
  const placeholders = cols.map(() => '?').join(',');
  const [r] = await pool.query(
    `INSERT INTO voice_roles (${cols.join(',')}) VALUES (${placeholders})`, vals
  );
  res.json({ id: r.insertId });
});
app.patch('/api/voice-roles/:id', async (req, res) => {
  const sets = [], vals = [];
  VOICE_ROLE_FIELDS.forEach(f => { if (f in req.body) { sets.push(`${f}=?`); vals.push(req.body[f]); } });
  if (!sets.length) return res.json({ ok: true });
  vals.push(req.params.id);
  await pool.query(`UPDATE voice_roles SET ${sets.join(',')} WHERE id=?`, vals);
  res.json({ ok: true });
});
app.delete('/api/voice-roles/:id', async (req, res) => {
  await pool.query('DELETE FROM voice_roles WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});
// 批量导入（用于 Excel 一键导入）
app.post('/api/voice-roles/bulk', async (req, res) => {
  const rows = req.body && req.body.rows;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows 数组必填' });
  const clear = !!(req.body && req.body.clearFirst);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (clear) await conn.query('DELETE FROM voice_roles');
    let inserted = 0;
    for (const r of rows) {
      if (!r.module || !r.role_cn) continue;
      const cols = VOICE_ROLE_FIELDS.filter(f => f in r);
      const vals = cols.map(f => r[f]);
      const placeholders = cols.map(() => '?').join(',');
      await conn.query(`INSERT INTO voice_roles (${cols.join(',')}) VALUES (${placeholders})`, vals);
      inserted++;
    }
    await conn.commit();
    res.json({ ok: true, inserted, cleared: clear });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// ---------- 需求 ----------
app.get('/api/demands', async (req, res) => {
  const { release_plan, area, status } = req.query;
  const where = ["story_type='音频'", "status!='suspended'"];
  const params = [];
  if (release_plan) { where.push('release_plan=?'); params.push(release_plan); }
  if (area) { where.push('area=?'); params.push(area); }
  if (status) { where.push('status=?'); params.push(status); }
  const [rows] = await pool.query(
    `SELECT * FROM demands WHERE ${where.join(' AND ')} ORDER BY id DESC`, params
  );
  res.json(rows);
});
app.post('/api/demands', async (req, res) => {
  const { release_plan, area, task_name, description, creator, developer, handler, status } = req.body;
  const [r] = await pool.query(
    `INSERT INTO demands (release_plan, version, area, task_name, description, creator, developer, handler, status)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [release_plan, release_plan, area, task_name, description, creator, developer, handler, status || 'new']
  );
  res.json({ id: r.insertId });
});
// 人工字段唯一写入口。TAPD 权威字段（release/area/story/creator/status等）禁止经PATCH修改，
// 只能由快照导入更新，避免人工编辑与TAPD刷新互相覆盖。
const MANUAL_DEMAND_FIELDS = [
  'manual_status', 'clarification', 'video_sync', 'cn_lines_handler',
  'progress_lines_cn', 'progress_lines_en', 'progress_voice_cn', 'progress_voice_en',
  'remark', 'script_doc_url', 'voice_estimates'
];
app.patch('/api/demands/:id', async (req, res) => {
  const fields = MANUAL_DEMAND_FIELDS;
  const sets = [], vals = [];
  const rejected = Object.keys(req.body || {}).filter((f) => !MANUAL_DEMAND_FIELDS.includes(f));
  if (rejected.length) return res.status(400).json({ ok:false, error:'TAPD权威字段不可人工修改', rejected });
  if ('manual_status' in (req.body||{})) {
    const valid = ['待澄清','文案ING','Vo ING','已完成',null,''];
    if (!valid.includes(req.body.manual_status)) return res.status(400).json({ok:false,error:'invalid_manual_status'});
  }
  await DEMANDS_READY;

  fields.forEach(f => {
    if (f in req.body) {
      let v = req.body[f];
      if (f === 'manual_status') {
        const valid = ['待澄清','文案ING','Vo ING','已完成'];
        if (v !== null && v !== '' && !valid.includes(v)) return;
        v = v || null;
      }
      // JSON 列：对象/数组需显式序列化，否则 mysql2 会写成 '[object Object]'
      if (f === 'voice_estimates' && v != null && typeof v !== 'string') v = JSON.stringify(v);
      sets.push(`${f}=?`);
      vals.push(v);
      if (f === 'manual_status') sets.push('manual_status_updated_at=NOW()');
    }
  });
  if (!sets.length) return res.json({ ok:true, updated:[] });
  vals.push(req.params.id);
  await pool.query(`UPDATE demands SET ${sets.join(',')} WHERE id=?`, vals);

  res.json({ ok: true });
});

// ---------- TAPD 快照导入：只更新TAPD权威字段，绝不覆盖人工字段 ----------
const TAPD_DEMAND_FIELDS = [
  'parent_external_id', 'release_plan', 'version', 'area', 'task_name',
  'description', 'creator', 'developer', 'handler', 'status',
  'story_type', 'sync_source', 'last_synced_at'
];
app.post('/api/refresh', async (req, res) => {
  try {
    await DEMANDS_READY;
    const fs = require('fs');
    const path = require('path');
    // 快照文件路径（容器内 nginx 挂载或构建时 COPY）
    const snapPaths = [
      '/usr/share/nginx/html/assets/tapd-snapshot.js',   // 生产：nginx 挂载
      '/app/tapd-snapshot.js',                              // 备用：手动 docker cp
      '../frontend/assets/tapd-snapshot.js'                  // 开发
    ];
    let content = null, snapshotPath = null, snapshotMtime = null;
    for (const p of snapPaths) {
      try {
        content = fs.readFileSync(p, 'utf-8');
        snapshotPath = p;
        snapshotMtime = fs.statSync(p).mtime.toISOString();
        break;
      } catch(_) {}
    }
    if (!content) return res.status(404).json({ ok:false, source:'tapd_snapshot', error:'tapd-snapshot.js not found', rows:0 });

    const start = content.indexOf('[');
    const end = content.lastIndexOf(']') + 1;
    const data = JSON.parse(content.slice(start, end));

    let inserted = 0, updated = 0;
    for (const item of data) {
      if (!item.id) continue;
      const extId = BigInt(item.id);
      const [existing] = await pool.query('SELECT id FROM demands WHERE external_id=?', [extId]);

      // 仅TAPD权威字段可来自快照。人工字段禁止出现在此对象中。
      const tapdFields = {
        parent_external_id: item.parent_id ? String(item.parent_id) : null,
        release_plan: item.release_plan||'Unspecified',
        version: item.release_plan||'Unspecified',
        area: item.area||'',
        task_name: item.task_name||'',
        description: (item.description||'').slice(0,500),
        creator: item.creator||'',
        developer: item.developer||'',
        handler: item.handler||'',
        status: item.status||'new',
        story_type: '音频',
        sync_source: 'tapd_snapshot',
        last_synced_at: new Date()
      };

      if (existing.length > 0) {
        const sets=[], vals=[];
        for (const key of TAPD_DEMAND_FIELDS) { sets.push(`${key}=?`); vals.push(tapdFields[key]); }
        vals.push(extId);
        await pool.query(`UPDATE demands SET ${sets.join(',')} WHERE external_id=?`, vals);
        updated++;
      } else {
        // 新需求初始化人工字段；之后快照导入永不再更新这些列。
        const newDemand = {
          external_id: extId,
          ...tapdFields,
          clarification: '',
          video_sync: '无需视频',
          cn_lines_handler: '',
          progress_lines_cn: '未开始',
          progress_lines_en: '未开始',
          progress_voice_cn: '未开始',
          progress_voice_en: '未开始',
          remark: '',
          script_doc_url: null,
          voice_estimates: null
        };
        const cols=Object.keys(newDemand), ph=cols.map(()=>'?').join(',');
        await pool.query(`INSERT INTO demands (${cols.join(',')}) VALUES (${ph})`, Object.values(newDemand));
        inserted++;
      }
    }

    res.json({
      ok:true,
      source:'tapd_snapshot',
      snapshot_file:path.basename(snapshotPath),
      snapshot_updated_at:snapshotMtime,
      updated_fields:TAPD_DEMAND_FIELDS,
      preserved_fields:MANUAL_DEMAND_FIELDS,
      rows:data.length,
      inserted,
      updated
    });
  } catch(e) {
    res.status(500).json({ ok:false, source:'tapd_snapshot', error: e.message, rows:0 });
  }
});

// ---------- 台词 ----------
app.get('/api/scripts', async (req, res) => {
  const { area, demand_id } = req.query;
  const where = ['1=1'];
  const params = [];
  if (area) { where.push('sl.area=?'); params.push(area); }
  if (demand_id) { where.push('sl.demand_id=?'); params.push(demand_id); }
  const [rows] = await pool.query(
    `SELECT sl.*, va.name AS voice_actor_name
     FROM script_lines sl
     LEFT JOIN voice_actors va ON va.id = sl.voice_actor_id
     WHERE ${where.join(' AND ')} ORDER BY sl.id`, params
  );
  res.json(rows);
});
app.post('/api/scripts', async (req, res) => {
  const b = req.body;
  const [r] = await pool.query(
    `INSERT INTO script_lines
       (demand_id, area, no, voice_actor_id, text_cn, text_en, recorded_text_cn, recorded_text_en,
        trigger_condition, emotion, gp_audio_event, remark)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [b.demand_id, b.area, b.no, b.voice_actor_id, b.text_cn, b.text_en,
     b.recorded_text_cn, b.recorded_text_en, b.trigger_condition, b.emotion, b.gp_audio_event, b.remark]
  );
  res.json({ id: r.insertId });
});
app.patch('/api/scripts/:id', async (req, res) => {
  const fields = ['voice_actor_id', 'text_cn', 'text_en', 'recorded_text_cn', 'recorded_text_en',
                  'trigger_condition', 'emotion', 'gp_audio_event', 'remark'];
  const sets = [], vals = [];
  fields.forEach(f => { if (f in req.body) { sets.push(`${f}=?`); vals.push(req.body[f]); } });
  if (!sets.length) return res.json({ ok: true });
  // 留痕
  const [old] = await pool.query('SELECT * FROM script_lines WHERE id=?', [req.params.id]);
  if (old.length) {
    const changedBy = req.headers['x-user'] || 'anonymous';
    for (const f of Object.keys(req.body)) {
      if (fields.includes(f) && String(old[0][f] ?? '') !== String(req.body[f] ?? '')) {
        await pool.query(
          'INSERT INTO script_line_history (script_line_id, field_name, old_value, new_value, changed_by) VALUES (?,?,?,?,?)',
          [req.params.id, f, String(old[0][f] ?? ''), String(req.body[f] ?? ''), changedBy]
        );
      }
    }
  }
  vals.push(req.params.id);
  await pool.query(`UPDATE script_lines SET ${sets.join(',')} WHERE id=?`, vals);
  res.json({ ok: true });
});
app.delete('/api/scripts/:id', async (req, res) => {
  await pool.query('DELETE FROM script_lines WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// ---------- 档期：recording_schedules 为唯一正式数据源 ----------
const SCHEDULES_READY = (async () => {
  for (const sql of [
    `ALTER TABLE recording_schedules MODIFY voice_actor_id INT NULL`,
    `ALTER TABLE recording_schedules ADD COLUMN release_plan VARCHAR(64) NULL`,
    `ALTER TABLE recording_schedules ADD COLUMN studio VARCHAR(128) NULL`,
    `ALTER TABLE recording_schedules ADD COLUMN time_slot VARCHAR(64) NULL`,
    `ALTER TABLE recording_schedules ADD COLUMN line_count INT NOT NULL DEFAULT 0`,
    `ALTER TABLE recording_schedules ADD COLUMN client_draft_id VARCHAR(64) NULL`,
    `ALTER TABLE recording_schedules ADD COLUMN published_at DATETIME NULL`,
    `ALTER TABLE recording_schedules ADD UNIQUE KEY uk_client_draft_id (client_draft_id)`
  ]) {
    try { await pool.query(sql); }
    catch(e){ if(!/Duplicate column|Duplicate key name|1060|1061/.test(e.message)) console.error('[schedules] alter fail:',e.message); }
  }
})();
app.get('/api/schedules', async (req, res) => {
  await SCHEDULES_READY;
  const { year, month, voice_actor_id, demand_id, release_plan, language } = req.query;
  const where = ['1=1'];
  const params = [];
  if (year && month) {
    where.push('YEAR(record_date)=? AND MONTH(record_date)=?');
    params.push(year, month);
  }
  if (voice_actor_id) { where.push('voice_actor_id=?'); params.push(voice_actor_id); }
  if (demand_id) { where.push('demand_id=?'); params.push(demand_id); }
  if (release_plan) { where.push('release_plan=?'); params.push(release_plan); }
  if (language) { where.push('language=?'); params.push(language); }
  const [rows] = await pool.query(
    `SELECT rs.*, va.name AS voice_actor_name
     FROM recording_schedules rs
     LEFT JOIN voice_actors va ON va.id = rs.voice_actor_id
     WHERE ${where.join(' AND ')} ORDER BY record_date, rs.id`, params
  );
  res.json(rows);
});
function normalizeScheduleDraft(b){
  const lang=(b.language||b.vaType||'').toLowerCase();
  return {
    voice_actor_id:b.voice_actor_id||null,
    record_date:b.record_date||b.date||'',
    language:lang==='en'||/英/.test(lang)?'en':'cn',
    gp_audio_event:b.gp_audio_event||'',
    duration_hours:Number(b.duration_hours||b.estHours||0)||2,
    status:b.status==='done'?'done':(b.status==='canceled'?'canceled':'pending'),
    demand_id:Number(b.demand_id||b.demandId)||null,
    release_plan:b.release_plan||b.plan||'',
    studio:b.studio||'',
    time_slot:b.time_slot||b.slot||'',
    line_count:Number(b.line_count||b.lines||0)||0,
    client_draft_id:String(b.client_draft_id||b.id||'').trim()||null
  };
}
async function publishScheduleDraft(b){
  const x=normalizeScheduleDraft(b);
  if(!x.demand_id) throw Object.assign(new Error('关联需求必填'),{status:400});
  if(!/^\d{4}-\d{2}-\d{2}$/.test(x.record_date)) throw Object.assign(new Error('录制日期必填'),{status:400});
  const [demands]=await pool.query('SELECT id,release_plan FROM demands WHERE id=?',[x.demand_id]);
  if(!demands[0]) throw Object.assign(new Error('关联需求不存在'),{status:400});
  if(!x.release_plan) x.release_plan=demands[0].release_plan||'';
  const cols=['voice_actor_id','record_date','language','gp_audio_event','duration_hours','status','demand_id','release_plan','studio','time_slot','line_count','client_draft_id','published_at'];
  const vals=[x.voice_actor_id,x.record_date,x.language,x.gp_audio_event,x.duration_hours,x.status,x.demand_id,x.release_plan,x.studio,x.time_slot,x.line_count,x.client_draft_id,new Date()];
  if(x.client_draft_id){
    const [before]=await pool.query('SELECT id FROM recording_schedules WHERE client_draft_id=?',[x.client_draft_id]);
    await pool.query(`INSERT INTO recording_schedules (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')}) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,vals);
    const [hit]=await pool.query('SELECT * FROM recording_schedules WHERE client_draft_id=?',[x.client_draft_id]);
    return {row:hit[0],created:before.length===0};
  }
  const [r]=await pool.query(`INSERT INTO recording_schedules (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`,vals);
  const [hit]=await pool.query('SELECT * FROM recording_schedules WHERE id=?',[r.insertId]);
  return {row:hit[0],created:true};
}
app.post('/api/schedules', async (req,res) => {
  try{ await SCHEDULES_READY; const out=await publishScheduleDraft(req.body||{}); res.json({ok:true,...out}); }
  catch(e){ res.status(e.status||500).json({ok:false,error:e.message}); }
});
app.post('/api/schedules/publish', async (req,res) => {
  try{
    await SCHEDULES_READY;
    const drafts=Array.isArray(req.body&&req.body.drafts)?req.body.drafts:[];
    if(!drafts.length) return res.status(400).json({ok:false,error:'没有可发布的草稿'});
    const published=[],failed=[];
    for(const draft of drafts){
      try{ const out=await publishScheduleDraft(draft); published.push({client_draft_id:draft.id||draft.client_draft_id,id:out.row.id,created:out.created}); }
      catch(e){ failed.push({client_draft_id:draft.id||draft.client_draft_id,error:e.message}); }
    }
    res.status(failed.length?207:200).json({ok:failed.length===0,published,failed,total:drafts.length});
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});
app.patch('/api/schedules/:id', async (req,res) => {
  try{
    await SCHEDULES_READY;
    const allowed=['record_date','language','gp_audio_event','duration_hours','status','demand_id','release_plan','studio','time_slot','line_count','voice_actor_id'];
    const sets=[],vals=[]; allowed.forEach(k=>{if(k in req.body){sets.push(`${k}=?`);vals.push(req.body[k]);}});
    if(!sets.length) return res.json({ok:true}); vals.push(req.params.id);
    await pool.query(`UPDATE recording_schedules SET ${sets.join(',')} WHERE id=?`,vals); res.json({ok:true});
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});
app.delete('/api/schedules/:id', async (req,res) => {
  try{ await SCHEDULES_READY; await pool.query('DELETE FROM recording_schedules WHERE id=?',[req.params.id]); res.json({ok:true}); }
  catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

// ---------- 音频资产 ----------
app.get('/api/assets', async (req, res) => {
  const { voice_actor_id, version, gp_audio_event, q } = req.query;
  const where = ['1=1'];
  const params = [];
  if (voice_actor_id) { where.push('a.voice_actor_id=?'); params.push(voice_actor_id); }
  if (version) { where.push('a.version=?'); params.push(version); }
  if (gp_audio_event) { where.push('a.gp_audio_event=?'); params.push(gp_audio_event); }
  if (q) { where.push('a.file_name LIKE ?'); params.push(`%${q}%`); }
  const [rows] = await pool.query(
    `SELECT a.*, va.name AS voice_actor_name
     FROM audio_assets a
     LEFT JOIN voice_actors va ON va.id = a.voice_actor_id
     WHERE ${where.join(' AND ')} ORDER BY a.id DESC`, params
  );
  res.json(rows);
});
app.post('/api/assets/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未上传文件' });
  const { script_line_id, voice_actor_id, version, gp_audio_event, language } = req.body;
  const stat = fs.statSync(req.file.path);
  const [r] = await pool.query(
    `INSERT INTO audio_assets
       (script_line_id, voice_actor_id, version, gp_audio_event, language, file_name, file_url, size_bytes, uploaded_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [script_line_id || null, voice_actor_id || null, version, gp_audio_event, language,
     req.file.originalname, req.file.filename, stat.size, req.headers['x-user'] || 'anonymous']
  );
  res.json({ id: r.insertId, file_url: `/audio/${req.file.filename}` });
});
app.get('/audio/:filename', (req, res) => {
  const p = path.join(AUDIO_DIR, req.params.filename);
  if (!fs.existsSync(p)) return res.status(404).send('not found');
  res.sendFile(p);
});

// ---------- TAPD 同步（占位，未来接 DFAI）----------
app.post('/api/tapd/sync', async (req, res) => {
  // TODO: 接入 https://dfai.woa.com/aiapi/get_story
  // 需要环境变量 DFAI_TOKEN
  res.json({
    ok: true,
    message: 'DFAI 同步接口占位。请在 .env 里配置 DFAI_TOKEN 后启用真实同步。',
    synced_count: 0
  });
});

// ---------- 台词表 · 上传解析 / 汇总 / 按声优导出 ----------
// 过渡方案（无平台 API）：文案导出 v3 台账 xlsx -> 后端解析 -> upsert 进 script_lines
const lineOps = require('./upload');
const lineUpload = multer({ storage: multer.memoryStorage() });

// 上传填写好的 v3 台账 xlsx -> 解析 -> 幂等 upsert 进 script_lines
app.post('/api/lines/upload', lineUpload.single('file'), async (req, res) => {
  const demandId = parseInt(req.body.demand_id, 10);
  const planner = req.body.planner || (req.headers['x-user'] || 'anonymous');
  if (!req.file) return res.status(400).json({ error: '未上传文件' });
  if (!demandId) return res.status(400).json({ error: 'demand_id 必填（请先在面板选择归属需求）' });
  try {
    const parsed = await lineOps.parseLinesheet(req.file.buffer, demandId);
    const r = await lineOps.upsertLines(demandId, planner, parsed);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 汇总查询：按需求 / 声优过滤（供台词管理页与声优下拉聚合）
app.get('/api/lines', async (req, res) => {
  try {
    const rows = await lineOps.getLines({
      demandId: req.query.demand_id ? parseInt(req.query.demand_id, 10) : null,
      vaName: req.query.va_name || '',
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 按声优导出单页 xlsx（直接发录音棚）。支持 GET(下载方便) 与 POST
async function handleExportVa(req, res) {
  const vaName = (req.method === 'GET' ? req.query.va_name : (req.body && req.body.va_name)) || '';
  if (!vaName) return res.status(400).json({ error: 'va_name 必填' });
  try {
    const r = await lineOps.exportByVoiceActor(vaName);
    if (!r) return res.status(404).json({ error: '未找到该声优或无可导出台词' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(r.filename)}"`);
    res.send(Buffer.from(r.buffer));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
app.get('/api/lines/export', handleExportVa);
app.post('/api/lines/export', handleExportVa);

// ---------- 声优库 · 选角资料 Word 导出件解析（多人可用，无需登录态/OCR） ----------
// 前端上传企业微信文档「导出为 Word」的 .docx → 纯 Node 解析（zip+XML）→ 章节字段 → 填充新建声优表单
const vadoc = require('./vadoc');
const vaDocUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
app.post('/api/va-doc/parse-file', vaDocUpload.single('file'), async (req, res) => {
  if (!req.file || !req.file.buffer) return res.status(400).json({ error: '未上传文件' });
  try {
    const r = vadoc.parseVaDocxAuto(req.file.buffer, req.file.originalname || '');
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// 台词表 v6 生成（CVM 直连腾讯文档个人版 MCP，点击即真建表，无需 AI 会话）
// 前端按钮 → POST /api/cw-doc/sync-v6 → 入队 → 后台顺序建表 → 链接回填 demands
// ============================================================
const cwExecutor = require('./cw_doc_executor');
const cwRecipe = require('../cw_doc_recipe_v6');

if (false) { // legacy cw jobs implementation retained only for migration reference
const CW_JOBS_FILE = path.join(__dirname, '..', 'cw_jobs.json');
const jobs = new Map();
let cwWorkerRunning = false;
const nowISO = () => new Date().toISOString();
function cwNewId() { return 'cw-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }

function cwLoad() {
  try {
    const arr = JSON.parse(fs.readFileSync(CW_JOBS_FILE, 'utf8'));
    if (Array.isArray(arr)) arr.forEach((j) => jobs.set(j.id, j));
  } catch (e) { /* 空 */ }
}
function cwSave() {
  const arr = [...jobs.values()];
  try { fs.writeFileSync(CW_JOBS_FILE, JSON.stringify(arr, null, 2)); } catch (e) { console.error('[cw] save fail', e.message); }
}
cwLoad();

// 后台顺序执行 pending/running 任务（同一进程内，顺序避免限流）
async function cwRun() {
  if (cwWorkerRunning) return;
  cwWorkerRunning = true;
  try {
    const queue = [...jobs.values()].filter((j) => j.status === 'pending' || j.status === 'running');
    for (const job of queue) {
      if (job.status === 'done') continue;
      job.status = 'running';
      job.updated_at = nowISO();
      cwSave();
      try {
        const dem = job._demand;
        if (!dem) throw new Error('job 缺少 _demand');
        const r = await cwExecutor.generateForDemand(dem);
        job.status = 'done';
        job.doc_url = r.url;
        job.doc_file_id = r.file_id;
        job.doc_title = r.tab;
        job.updated_at = nowISO();
        // 链接回填 demands 表（幂等：仅当为空）
        try {
          await pool.query(
            'UPDATE demands SET script_doc_url=? WHERE id=? AND (script_doc_url IS NULL OR script_doc_url="")',
            [r.url, dem.id]
          );
        } catch (e) { console.warn('[cw] 回填 script_doc_url 失败(忽略):', e.message); }
        cwSave();
      } catch (e) {
        job.status = 'failed';
        job.error = e.message;
        job.updated_at = nowISO();
        cwSave();
      }
    }
  } finally {
    cwWorkerRunning = false;
  }
}

// 是否已生成（done 且有链接，或 demands 表已有 script_doc_url）
function cwAlreadyDone(dem, doneIds) {
  if (doneIds.has(String(dem.id))) return true;
  if (dem.script_doc_url && String(dem.script_doc_url).trim()) return true;
  return false;
}

// 为单个需求建一条 pending job
async function cwMakeJob(dem) {
  const roster = await cwExecutor.loadRoster();
  const rec = cwRecipe.buildRecipeV6({ WS: path.join(__dirname, '..'), demand: dem, roster });
  const job = {
    id: cwNewId(),
    cw_id: 'demand-' + dem.id,
    cw_name: dem.task_name || String(dem.id),
    release: dem.release_plan || dem.release || '',
    story_ids: [String(dem.id)],
    status: 'pending',
    created_at: nowISO(),
    updated_at: nowISO(),
    doc_url: '',
    doc_title: rec._summary.doc_title,
    doc_file_id: '',
    error: '',
    progress: '',
    version: 'v6',
    _demand: dem,
  };
  jobs.set(job.id, job);
  cwSave();
  return job;
}

// POST /api/cw-doc/submit-v6  → 单需求建表
app.post('/api/cw-doc/submit-v6', async (req, res) => {
  try {
    let dem = req.body && req.body.demand;
    if (!dem && req.body && req.body.demand_id) {
      const [rows] = await pool.query('SELECT * FROM demands WHERE id=?', [req.body.demand_id]);
      dem = rows[0];
    }
    if (!dem || !dem.id || !dem.task_name) return res.status(400).json({ error: 'demand{id,task_name} 或 demand_id 必填' });
    const job = await cwMakeJob(dem);
    cwRun();
    res.json({ ok: true, job_id: job.id, job });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/cw-doc/sync-v6  → 某 release 内所有未生成的需求逐个入队
app.post('/api/cw-doc/sync-v6', async (req, res) => {
  try {
    const release = (req.body && req.body.release) || 'Yang1.0';
    const [rows] = await pool.query(
      "SELECT * FROM demands WHERE release_plan=? AND story_type='音频' AND status!='suspended' ORDER BY id",
      [release]
    );
    const doneIds = new Set();
    [...jobs.values()].forEach((j) => {
      if (j.status === 'done' && j.doc_url) (j.story_ids || []).forEach((s) => doneIds.add(String(s)));
    });
    const created = [], skipped = [];
    for (const dem of rows) {
      if (cwAlreadyDone(dem, doneIds)) { skipped.push({ demand_id: dem.id, reason: 'done' }); continue; }
      const job = await cwMakeJob(dem);
      created.push({ demand_id: dem.id, task_name: dem.task_name, job_id: job.id, doc_title: job.doc_title });
    }
    cwRun();
    res.json({ ok: true, release, created, skipped, total: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/cw-doc/jobs  → 列表（支持 cw_id / release / status 过滤）；前端轮询用
app.get('/api/cw-doc/jobs', (req, res) => {
  let list = [...jobs.values()];
  const cw = req.query.cw_id, rel = req.query.release, st = req.query.status;
  if (cw) list = list.filter((j) => j.cw_id === cw);
  if (rel) list = list.filter((j) => j.release === rel);
  if (st) list = list.filter((j) => j.status === st);
  list.sort((a, b) => b.created_at.localeCompare(a.created_at));
  res.json({ jobs: list, count: list.length });
});

// PATCH /api/cw-doc/jobs/:id  → 状态回写（内部 worker 直接改内存，此端点供外部/兜底）
app.patch('/api/cw-doc/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  ['status', 'doc_url', 'doc_title', 'doc_file_id', 'error', 'progress'].forEach((k) => {
    if (k in req.body) job[k] = req.body[k];
  });
  job.updated_at = nowISO();
  cwSave();
  res.json({ ok: true, job });
});
} // end legacy cw jobs implementation

// ============================================================
// 统一需求Jobs：script_table + voice_estimates
// 状态固定 pending/running/done/failed；幂等键 = type:demand:id:version
// ============================================================
const { createDemandJobs } = require('./demand_jobs');
const unifiedCwExecutor = require('./cw_doc_executor');
const demandJobs = createDemandJobs({
  file: path.join(__dirname, '..', 'demand_jobs.json'),
  legacyFile: path.join(__dirname, '..', 'cw_jobs.json'),
  execute: async (job) => {
    const [rows] = await pool.query('SELECT * FROM demands WHERE id=?', [job.demand_id]);
    const dem = rows[0];
    if (!dem) throw new Error('需求不存在或已删除');
    if (job.type === 'script_table') {
      const r = await unifiedCwExecutor.generateForDemand(dem);
      await pool.query(
        'UPDATE demands SET script_doc_url=? WHERE id=? AND (script_doc_url IS NULL OR script_doc_url="")',
        [r.url, dem.id]
      );
      return { doc_url:r.url, doc_file_id:r.file_id, doc_title:r.tab, has_av_sync:!!r.has_av_sync };
    }
    if (job.type === 'voice_estimates') {
      const tableJob = demandJobs.latest('script_table', dem.id, 'v6');
      if (tableJob && tableJob.result && tableJob.result.doc_file_id) dem._doc_file_id = tableJob.result.doc_file_id;
      const r = await unifiedCwExecutor.readVoiceEstimatesForDemand(dem);
      await pool.query('UPDATE demands SET voice_estimates=? WHERE id=?', [JSON.stringify(r.estimates), dem.id]);
      return { count:r.estimates.length, file_id:r.file_id, sheet_id:r.sheet_id };
    }
    throw new Error('未知任务类型: '+job.type);
  }
});
function publicJobResult(x){ return {...x, job:demandJobs.publicJob(x.job)}; }

// 统一单需求入队入口。type=script_table|voice_estimates
app.post('/api/cw-doc/jobs', async (req,res) => {
  try{
    const type=req.body&&req.body.type, demandId=req.body&&req.body.demand_id;
    if(!type||!demandId) return res.status(400).json({ok:false,error:'type and demand_id required'});
    const [rows]=await pool.query('SELECT * FROM demands WHERE id=?',[demandId]); const dem=rows[0];
    if(!dem) return res.status(404).json({ok:false,error:'demand_not_found'});
    const version=(req.body&&req.body.version)||(type==='script_table'?'v6':'v1');
    const out=demandJobs.enqueue({type,demand:dem,release:dem.release_plan,version,title:dem.task_name,force:!!req.body.force});
    res.json({ok:true,...publicJobResult(out)});
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

app.post('/api/cw-doc/submit-v6', async (req,res) => {
  try{
    let dem=req.body&&req.body.demand;
    if(!dem&&req.body&&req.body.demand_id){ const [rows]=await pool.query('SELECT * FROM demands WHERE id=?',[req.body.demand_id]); dem=rows[0]; }
    if(!dem||!dem.id) return res.status(400).json({ok:false,error:'demand_id必填'});
    const out=demandJobs.enqueue({type:'script_table',demand:dem,release:dem.release_plan,version:'v6',title:dem.task_name,force:!!req.body.force});
    res.json({ok:true,...publicJobResult(out)});
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

// 原地刷新某需求已有台词表文档的 Tab1【需求统计】（拉最新声优库，不新建文档）
app.post('/api/cw-doc/refresh-stat', async (req, res) => {
  try {
    const demandId = req.body && req.body.demand_id;
    if (!demandId) return res.status(400).json({ ok:false, error: 'demand_id 必填' });
    const [rows] = await pool.query('SELECT * FROM demands WHERE id=?', [demandId]);
    const dem = rows[0];
    if (!dem) return res.status(404).json({ ok:false, error: 'demand 不存在' });
    if (!dem.script_doc_url || !String(dem.script_doc_url).trim()) {
      return res.status(409).json({ ok:false, error: '该需求尚未生成台词表，请先生成' });
    }
    const r = await cwExecutor.refreshStatForDemand(dem);
    if (!r.ok) {
      if (r.reason === 'tab1-frozen-after-generation') {
        return res.status(409).json({ ok:false, error: 'Tab1 为生成时快照，已禁止刷新以免破坏源数据（台词表生成后不再回写统计页）' });
      }
      return res.status(409).json({ ok:false, error: '刷新失败：' + (r.reason || 'unknown') });
    }
    res.json({ ok: true, demand_id: String(demandId), rows: r.rows, file_id: r.file_id });
  } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
});

// 演示专用：往指定需求 Tab2 台词表批量追加 [DEMO] 台词行。
// 请求体：{ demand_id, lines: [{ role_cn, cn_text, en_text, situation?, trigger?, remark? }] }
// 事后清理：从 Tab2 第 2 行起清 lines.length 行；配套 cleanup 脚本处理。
app.post('/api/cw-doc/append-demo-lines', async (req, res) => {
  try {
    const demandId = req.body && req.body.demand_id;
    const lines = (req.body && req.body.lines) || [];
    if (!demandId) return res.status(400).json({ ok:false, error: 'demand_id 必填' });
    if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ ok:false, error: 'lines 不能为空' });
    const [rows] = await pool.query('SELECT * FROM demands WHERE id=?', [demandId]);
    const dem = rows[0];
    if (!dem) return res.status(404).json({ ok:false, error: 'demand 不存在' });
    if (!dem.script_doc_url) return res.status(409).json({ ok:false, error: '该需求尚未生成台词表' });
    const r = await cwExecutor.appendDemoLinesForDemand(dem, lines);
    if (!r.ok) return res.status(409).json({ ok:false, error: '写入失败：' + (r.reason || 'unknown') });
    res.json({ ok: true, demand_id: String(demandId), rows: r.rows, file_id: r.file_id, sheet_id: r.sheet_id });
  } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
});

// ---------- 台词管理页 · 按发布计划看台词量（聚合看板） ----------
const RELEASE_STATS_FILE = path.join(__dirname, '..', 'release_stats.json');
// 读缓存（无则 null）
function loadReleaseStats() {
  try { if (fs.existsSync(RELEASE_STATS_FILE)) return JSON.parse(fs.readFileSync(RELEASE_STATS_FILE, 'utf8')); }
  catch (e) { console.error('[stats] 读缓存失败', e.message); }
  return null;
}
// 批量反读所有需求台词表 → 按发布计划聚合 → 落缓存
app.post('/api/cw-doc/aggregate', async (req, res) => {
  try {
    const force = !!(req.body && req.body.force);
    // 取全部需求（含 script_doc_url），逐份反读【需求统计】聚合
    const [rows] = await pool.query('SELECT id, task_name, area, release_plan, creator, cn_lines_handler, script_doc_url FROM demands ORDER BY id');
    const agg = await cwExecutor.aggregateAllDemands(rows);
    fs.writeFileSync(RELEASE_STATS_FILE, JSON.stringify(agg, null, 2));
    console.log('[stats] 聚合完成 scanned=' + agg.scanned + ' releases=' + Object.keys(agg.released).join(','));
    res.json({ ok: true, scanned: agg.scanned, released: agg.released, aggregatedAt: agg.aggregatedAt });
  } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
});
// 看板读取：有缓存返回缓存；force 或无缓存则现聚合
app.get('/api/release-stats', async (req, res) => {
  try {
    const force = req.query.force === '1';
    let data = !force ? loadReleaseStats() : null;
    if (!data) {
      const [rows] = await pool.query('SELECT id, task_name, area, release_plan, creator, cn_lines_handler, script_doc_url FROM demands ORDER BY id');
      data = await cwExecutor.aggregateAllDemands(rows);
      fs.writeFileSync(RELEASE_STATS_FILE, JSON.stringify(data, null, 2));
    }
    res.json({ ok: true, ...data });
  } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
});

// ---------- 手动生成「台词量汇总看板」腾讯文档智能表格（看板供查阅，编辑留给 per-demand 台词表） ----------
// 请求体可选 { release } 限定单版本；缺省聚合全部音频需求。手动触发，符合"手动"口径。
app.post('/api/cw-doc/summary-board', async (req, res) => {
  try {
    const release = req.body && req.body.release;
    let sql = "SELECT id, task_name, area, release_plan, creator, cn_lines_handler, script_doc_url FROM demands WHERE story_type='音频' AND status!='suspended'";
    const params = [];
    if (release) { sql += ' AND release_plan=?'; params.push(release); }
    sql += ' ORDER BY release_plan, id';
    const [rows] = await pool.query(sql, params);
    if (!rows.length) return res.status(404).json({ ok:false, error:'无满足条件的音频需求' });
    const r = await unifiedCwExecutor.generateSummaryBoard(rows);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
});

// 一键批量生成（sync-v6）已于 2026-08-21 按用户要求取消：改为手动「单个需求生成」入口，
// 不再提供 release 级批量建表，避免误触产生大量孤儿文档。前端对应按钮需隐藏。
app.post('/api/cw-doc/sync-v6', async (req, res) => {
  res.status(410).json({ ok:false, error:'一键批量生成已取消（按用户 2026-08-21 要求）。请改用单个需求的「生成台词表」入口。' });
});
app.post('/api/cw-doc/sync-voice-estimates', async (req,res) => {
  try{
    const release=(req.body&&req.body.release)||'Yang1.0';
    const demandId=req.body&&req.body.demand_id;
    const params=[]; let sql="SELECT * FROM demands WHERE story_type='音频' AND status!='suspended'";
    if(demandId){ sql+=' AND id=?'; params.push(demandId); } else { sql+=' AND release_plan=?'; params.push(release); }
    sql+=' ORDER BY id';
    const [rows]=await pool.query(sql,params); const created=[],skipped=[];
    for(const dem of rows){
      if(!dem.script_doc_url && !demandJobs.latest('script_table',dem.id,'v6')){ skipped.push({demand_id:dem.id,reason:'no_script_table'}); continue; }
      const out=demandJobs.enqueue({type:'voice_estimates',demand:dem,release:dem.release_plan,version:'v1',title:dem.task_name,force:!!(req.body&&req.body.force)});
      (out.created?created:skipped).push({demand_id:dem.id,job_id:out.job.id,reason:out.reason,idempotency_key:out.job.idempotency_key});
    }
    res.json({ok:true,release,created,skipped,total:rows.length});
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});
app.get('/api/cw-doc/jobs',(req,res)=>{
  const list=demandJobs.list(req.query).map(demandJobs.publicJob);
  const counts={pending:0,running:0,done:0,failed:0}; list.forEach(j=>{if(j.status in counts)counts[j.status]++;});
  res.json({jobs:list,count:list.length,counts,statuses:demandJobs.statuses});
});
app.post('/api/cw-doc/jobs/:id/retry',(req,res)=>{
  const out=demandJobs.retry(req.params.id);
  if(out.error) return res.status(out.status||400).json({ok:false,error:out.error,job:demandJobs.publicJob(out.job)});
  res.json({ok:true,job:demandJobs.publicJob(out.job)});
});
// 旧PATCH不再允许任意改状态，避免绕过状态机；仅保留清晰错误。
app.patch('/api/cw-doc/jobs/:id',(req,res)=>res.status(405).json({ok:false,error:'use_retry_endpoint_or_worker'}));

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Vo Manager API] listening on 0.0.0.0:${PORT}`);
});
