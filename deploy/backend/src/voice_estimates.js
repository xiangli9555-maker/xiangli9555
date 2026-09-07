'use strict';

const CATEGORIES = ['指挥官','干员','Boss','AI兵','NPC','路人角色','AI系统音'];
const CATEGORY_COLORS = {
  '指挥官':'#727665', '干员':'#CEA06C', 'Boss':'#E9E6DF', 'AI兵':'#D3DFDD',
  'NPC':'#474C40', '路人角色':'#7A8A96', 'AI系统音':'#608980', '未匹配':'#7A8A96'
};
const EDITABLE_STATUSES = new Set(['待澄清','文案ing']);
const DELIVERED_STATUSES = new Set(['已交稿','Vo ing','Done']);
const DETAIL_TABLE_TITLE = '角色需求明细';
const DETAIL_FIELDS = [
  ['唯一键','text'], ['需求ID','text'], ['发布计划','text'], ['Story','text'],
  ['语言','text'], ['大类','text'], ['游戏角色名','text'],
  ['预估句数','number'], ['实际句数','number'], ['角色校验','text'],
  ['原始角色名','text'], ['需求状态','text'], ['更新人','text'], ['更新时间','text']
];

function norm(v){
  return String(v == null ? '' : v).trim().toLowerCase().replace(/[\s·•\-—_（）()、【】\[\]]+/g, '');
}
function normRelease(v){ return String(v || '').trim().replace(/[\s_【】]/g, '').replace(/\.0+$/, ''); }
function effectiveStatus(demand){ return String(demand && demand.manual_status || '待澄清').trim() || '待澄清'; }
function canEditEstimate(status){ return EDITABLE_STATUSES.has(String(status || '').trim()); }
function isDelivered(status){ return DELIVERED_STATUSES.has(String(status || '').trim()); }
function keyOf(row){ return `${row.demand_id}|${String(row.role_name || row.role || '').trim()}|${String(row.language || '').trim().toLowerCase()}`; }

function normalizeEstimateRows(demandId, release, rows){
  const id = Number(demandId);
  if(!Number.isInteger(id) || id <= 0) throw new Error('invalid_demand_id');
  const out = new Map();
  for(const raw of Array.isArray(rows) ? rows : []){
    const role_name = String(raw && (raw.role_name || raw.role) || '').trim();
    if(!role_name) continue;
    const category = String(raw.category || '').trim();
    const language = String(raw.language || '').trim().toLowerCase();
    const estimated_lines = Number(raw.estimated_lines ?? raw.est_lines ?? 0);
    if(!CATEGORIES.includes(category)) throw new Error('invalid_category');
    if(language !== 'cn' && language !== 'en') throw new Error('invalid_language');
    if(!Number.isInteger(estimated_lines) || estimated_lines < 0 || estimated_lines > 999999) throw new Error('invalid_estimated_lines');
    const row = {
      demand_id:id, release_plan:String(release || '').trim(), language, category,
      role_name, estimated_lines,
      actual_lines: Math.max(0, Number(raw.actual_lines) || 0),
      match_status: String(raw.match_status || 'exact'),
      source_role_name: String(raw.source_role_name || '').trim() || null,
      role_id: raw.role_id == null ? null : Number(raw.role_id)
    };
    out.set(keyOf(row), row);
  }
  return [...out.values()];
}

function buildUpsertPlan(existing, incoming){
  const oldMap = new Map((existing || []).map(r => [keyOf(r), r]));
  const newMap = new Map((incoming || []).map(r => [keyOf(r), r]));
  const toAdd = [], toUpdate = [], toDelete = [];
  for(const [key, row] of newMap){
    const old = oldMap.get(key);
    if(old) toUpdate.push(Object.assign({}, row, {record_id:old.record_id || old.id}));
    else toAdd.push(row);
  }
  for(const [key, row] of oldMap){
    if(!newMap.has(key) && (row.record_id || row.id)) toDelete.push(row.record_id || row.id);
  }
  return {toAdd, toUpdate, toDelete};
}

function aggregateActualLineRows(rows, options){
  const opts = Object.assign({ roleIndex:1, textCnIndex:2, textEnIndex:3, sentenceIndex:9, linesPerChunk:20 }, options || {});
  const map = new Map();
  for(const row of Array.isArray(rows) ? rows : []){
    const role = String(row && row[opts.roleIndex] || '').trim();
    if(!role) continue;
    const cn = String(row[opts.textCnIndex] || '').trim();
    const en = String(row[opts.textEnIndex] || '').trim();
    const formulaCount = Math.max(0, Number(String(row[opts.sentenceIndex] || '').replace(/,/g, '')) || 0);
    const fallbackCount = cn ? Math.max(1, Math.ceil(cn.length / opts.linesPerChunk)) : (en ? 1 : 0);
    const count = formulaCount || fallbackCount;
    if(cn){
      const key = `cn|${role}`;
      const item = map.get(key) || { role_name:role, language:'cn', actual_lines:0 };
      item.actual_lines += count; map.set(key, item);
    }
    if(en){
      const key = `en|${role}`;
      const item = map.get(key) || { role_name:role, language:'en', actual_lines:0 };
      item.actual_lines += count; map.set(key, item);
    }
  }
  return [...map.values()];
}

function deviationState(estimated, actual, progress){
  const est = Math.max(0, Number(estimated) || 0);
  const act = Math.max(0, Number(actual) || 0);
  const total = Math.max(0, Number(progress && progress.total) || 0);
  const delivered = Math.max(0, Number(progress && progress.delivered) || 0);
  if(total > 0 && delivered === 0) return {kind:'waiting', label:'待交稿', value:null, percent:null};
  if(est === 0 && act > 0) return {kind:'unestimated', label:'未预估', value:act, percent:null};
  const value = act - est;
  const percent = est > 0 ? value / est : 0;
  if(value < 0) return {kind:'negative', label:String(value), value, percent};
  if(percent > 0.3) return {kind:'over', label:`+${value}`, value, percent};
  return {kind:'normal', label:value > 0 ? `+${value}` : String(value), value, percent};
}

function levenshtein(a,b){
  a=norm(a); b=norm(b);
  const dp=Array.from({length:a.length+1},()=>Array(b.length+1).fill(0));
  for(let i=0;i<=a.length;i++) dp[i][0]=i;
  for(let j=0;j<=b.length;j++) dp[0][j]=j;
  for(let i=1;i<=a.length;i++) for(let j=1;j<=b.length;j++) dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
  return dp[a.length][b.length];
}
function matchRoleName(input, roles){
  const source = String(input || '').trim();
  const n = norm(source);
  const list = Array.isArray(roles) ? roles : [];
  const exact = list.find(r => norm(r.role_cn) === n || norm(r.role_en) === n);
  if(exact) return {status:'exact', role:exact, source};
  let best = null, bestScore = Infinity;
  for(const r of list){
    for(const name of [r.role_cn,r.role_en].filter(Boolean)){
      const nn=norm(name); if(!nn) continue;
      const d=levenshtein(n,nn);
      if(d<bestScore){ bestScore=d; best=r; }
    }
  }
  const limit = n.length <= 4 ? 1 : 2;
  if(best && bestScore <= limit) return {status:'fuzzy', role:best, source};
  return {status:'unmatched', role:null, source};
}

function textValue(value){ return {items:[{type:'text',text:String(value == null ? '' : value)}]}; }
function recordFields(row, demand, actor){
  return [
    {field:'唯一键', text_value:textValue(keyOf(row))},
    {field:'需求ID', text_value:textValue(row.demand_id)},
    {field:'发布计划', text_value:textValue(row.release_plan)},
    {field:'Story', text_value:textValue(demand && demand.task_name || '')},
    {field:'语言', text_value:textValue(row.language)},
    {field:'大类', text_value:textValue(row.category)},
    {field:'游戏角色名', text_value:textValue(row.role_name)},
    {field:'预估句数', number_value:Number(row.estimated_lines)||0},
    {field:'实际句数', number_value:Number(row.actual_lines)||0},
    {field:'角色校验', text_value:textValue(row.match_status || 'exact')},
    {field:'原始角色名', text_value:textValue(row.source_role_name || '')},
    {field:'需求状态', text_value:textValue(effectiveStatus(demand))},
    {field:'更新人', text_value:textValue(actor || 'Vomi')},
    {field:'更新时间', text_value:textValue(new Date().toISOString())},
  ];
}
function valueText(v){
  if(v == null) return '';
  if(typeof v === 'string' || typeof v === 'number') return String(v);
  if(v.text_value){
    const t=v.text_value;
    if(typeof t.text === 'string') return t.text;
    if(Array.isArray(t.items)) return t.items.map(x=>x.text||'').join('');
  }
  if(v.number_value != null) return String(v.number_value);
  if(v.string_value != null) return String(v.string_value);
  if(Array.isArray(v.items)) return v.items.map(x=>x.text||x.value||'').join('');
  return '';
}
function fieldsObject(record){
  const out={};
  const vals=record && (record.field_values || record.values || record.fields);
  if(Array.isArray(vals)) vals.forEach(v=>{ const k=v.field||v.field_title||v.title; if(k) out[k]=valueText(v); });
  else if(vals && typeof vals==='object') Object.keys(vals).forEach(k=>{out[k]=valueText(vals[k]);});
  return out;
}
function docRecordToRow(record){
  const f=fieldsObject(record);
  return {
    record_id:record.record_id||record.id,
    demand_id:f['需求ID'], release_plan:f['发布计划'], language:f['语言'], category:f['大类'],
    role_name:f['游戏角色名'], estimated_lines:Number(f['预估句数'])||0, actual_lines:Number(f['实际句数'])||0,
    match_status:f['角色校验']||'exact', source_role_name:f['原始角色名']||null
  };
}

async function ensureTable(pool){
  await pool.query(`CREATE TABLE IF NOT EXISTS voice_estimate_roles (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    demand_id BIGINT NOT NULL,
    release_plan VARCHAR(64) NOT NULL,
    language ENUM('cn','en') NOT NULL,
    category VARCHAR(32) NOT NULL,
    role_name VARCHAR(255) NOT NULL,
    role_id BIGINT NULL,
    estimated_lines INT NOT NULL DEFAULT 0,
    actual_lines INT NOT NULL DEFAULT 0,
    match_status ENUM('exact','fuzzy','unmatched') NOT NULL DEFAULT 'exact',
    source_role_name VARCHAR(255) NULL,
    doc_file_id VARCHAR(128) NULL,
    doc_table_id VARCHAR(128) NULL,
    doc_record_id VARCHAR(128) NULL,
    revision BIGINT NOT NULL DEFAULT 1,
    updated_by VARCHAR(128) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_voice_estimate_demand_role_lang (demand_id, role_name, language),
    KEY idx_voice_estimate_release_lang_role (release_plan, language, role_name),
    KEY idx_voice_estimate_demand (demand_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

async function libraryDocForRelease(pool, release){
  const [rows]=await pool.query('SELECT v FROM kv_store WHERE k=? LIMIT 1',['release_script_libraries_v1']);
  if(!rows.length || !rows[0].v) return null;
  let map={}; try{map=JSON.parse(rows[0].v)||{};}catch(_){return null;}
  const direct=map[release];
  const key=direct ? release : Object.keys(map).find(k=>normRelease(k)===normRelease(release));
  const rec=key ? map[key] : null;
  if(!rec) return null;
  const url=typeof rec==='string'?rec:rec.url;
  const file_id=typeof rec==='object'&&rec.file_id ? rec.file_id : String(url||'').match(/\/(?:sheet|smartsheet)\/([^?/#]+)/i)?.[1];
  return file_id ? {file_id,url:url||'',release:key||release} : null;
}

async function ensureRoleDetailTable(mcp, file_id){
  const cookie=await mcp.openSession();
  const tables=await mcp.listTables(file_id,cookie);
  let table=tables.find(t=>t.title===DETAIL_TABLE_TITLE);
  let created=false;
  if(!table){
    const sheet_id=await mcp.addTable(file_id,DETAIL_TABLE_TITLE,tables.length,cookie);
    table={sheet_id,title:DETAIL_TABLE_TITLE}; created=true;
  }
  if(created){
    const fields=[{field_title:'序号',field_type:'autoNumber',property_auto_number:{type:1}}]
      .concat(DETAIL_FIELDS.map(([field_title,field_type])=>field_type==='number'
        ? {field_title,field_type:'number',property_number:{decimal_places:0}}
        : {field_title,field_type:'text',property_text:{}}));
    await mcp.addFields(file_id,table.sheet_id,fields,cookie);
  }else if(typeof mcp.listFields==='function'){
    const fields=await mcp.listFields(file_id,table.sheet_id,cookie);
    const names=new Set((fields||[]).map(f=>f.field_title||f.title||f.name));
    const missing=DETAIL_FIELDS.filter(([title])=>!names.has(title)).map(([field_title,field_type])=>field_type==='number'
      ? {field_title,field_type:'number',property_number:{decimal_places:0}}
      : {field_title,field_type:'text',property_text:{}});
    if(missing.length) await mcp.addFields(file_id,table.sheet_id,missing,cookie);
  }
  return {file_id,sheet_id:table.sheet_id,cookie};
}

function extractRecords(payload){
  if(Array.isArray(payload)) return payload;
  if(!payload||typeof payload!=='object') return [];
  for(const k of ['records','list','data','items']){
    if(Array.isArray(payload[k])) return payload[k];
    if(payload[k]&&typeof payload[k]==='object'){
      const nested=extractRecords(payload[k]); if(nested.length) return nested;
    }
  }
  return [];
}
async function listAllRecords(mcp,file_id,sheet_id,cookie){
  const out=[]; let offset=0;
  for(let page=0;page<100;page++){
    const payload=await mcp.listRecords(file_id,sheet_id,{offset,limit:100},cookie);
    const part=extractRecords(payload); out.push(...part);
    if(part.length<100) break;
    offset+=part.length;
  }
  return out;
}

async function upsertRoleDetailRecords(mcp, target, demand, rows, actor){
  const all=await listAllRecords(mcp,target.file_id,target.sheet_id,target.cookie);
  const existing=all.map(docRecordToRow).filter(r=>String(r.demand_id)===String(demand.id));
  const plan=buildUpsertPlan(existing,rows);
  if(plan.toUpdate.length) await mcp.updateRecords(target.file_id,target.sheet_id,plan.toUpdate.map(r=>({record_id:r.record_id,field_values:recordFields(r,demand,actor)})),target.cookie);
  if(plan.toAdd.length) await mcp.addRecords(target.file_id,target.sheet_id,plan.toAdd.map(r=>({field_values:recordFields(r,demand,actor)})),target.cookie);
  if(plan.toDelete.length) await mcp.deleteRecords(target.file_id,target.sheet_id,plan.toDelete,target.cookie);
  return plan;
}

async function mirrorRows(pool,demand,rows,target,actor){
  const conn=await pool.getConnection();
  try{
    await conn.beginTransaction();
    const keep=rows.map(r=>`${r.role_name}\u0000${r.language}`);
    if(keep.length){
      const clauses=rows.map(()=>'(role_name=? AND language=?)').join(' OR ');
      const vals=[]; rows.forEach(r=>vals.push(r.role_name,r.language));
      await conn.query(`DELETE FROM voice_estimate_roles WHERE demand_id=? AND NOT (${clauses})`,[demand.id,...vals]);
    }else await conn.query('DELETE FROM voice_estimate_roles WHERE demand_id=?',[demand.id]);
    for(const r of rows){
      await conn.query(`INSERT INTO voice_estimate_roles
        (demand_id,release_plan,language,category,role_name,role_id,estimated_lines,actual_lines,match_status,source_role_name,doc_file_id,doc_table_id,updated_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE release_plan=VALUES(release_plan),category=VALUES(category),role_id=VALUES(role_id),estimated_lines=VALUES(estimated_lines),actual_lines=VALUES(actual_lines),match_status=VALUES(match_status),source_role_name=VALUES(source_role_name),doc_file_id=VALUES(doc_file_id),doc_table_id=VALUES(doc_table_id),updated_by=VALUES(updated_by),revision=revision+1`,
        [r.demand_id,r.release_plan,r.language,r.category,r.role_name,r.role_id,r.estimated_lines,r.actual_lines,r.match_status,r.source_role_name,target.file_id,target.sheet_id,actor]);
    }
    const legacy=rows.map(r=>({role:r.role_name,category:r.category,language:r.language,est_lines:r.estimated_lines,actual_lines:r.actual_lines,match_status:r.match_status}));
    await conn.query('UPDATE demands SET voice_estimates=? WHERE id=?',[JSON.stringify(legacy),demand.id]);
    await conn.commit();
  }catch(e){ await conn.rollback(); throw e; } finally { conn.release(); }
}

async function saveDemandEstimates({pool,mcp,demand,rows,actor}){
  await ensureTable(pool);
  const status=effectiveStatus(demand);
  if(!canEditEstimate(status)){ const e=new Error('estimate_locked'); e.statusCode=409; throw e; }
  const normalized=normalizeEstimateRows(demand.id,demand.release_plan,rows);
  const [roles]=await pool.query('SELECT id,module,role_cn,role_en FROM voice_roles WHERE is_deleted=0 OR is_deleted IS NULL');
  const byName=new Map(); roles.forEach(r=>{if(r.role_cn)byName.set(norm(r.role_cn),r);if(r.role_en)byName.set(norm(r.role_en),r);});
  normalized.forEach(r=>{const hit=byName.get(norm(r.role_name));if(!hit){const e=new Error('role_not_in_roster:'+r.role_name);e.statusCode=400;throw e;}r.role_id=hit.id;r.role_name=hit.role_cn;r.category=hit.module||r.category;r.match_status='exact';});
  const doc=await libraryDocForRelease(pool,demand.release_plan);
  if(!doc){const e=new Error('release_library_not_registered');e.statusCode=409;throw e;}
  const target=await ensureRoleDetailTable(mcp,doc.file_id);
  const plan=await upsertRoleDetailRecords(mcp,target,demand,normalized,actor);
  await mirrorRows(pool,demand,normalized,target,actor);
  return {rows:normalized,document:{file_id:target.file_id,sheet_id:target.sheet_id,url:doc.url},changes:{added:plan.toAdd.length,updated:plan.toUpdate.length,deleted:plan.toDelete.length}};
}

async function listEstimates(pool,filters){
  await ensureTable(pool);
  const where=['1=1'], vals=[];
  if(filters&&filters.release){where.push('release_plan=?');vals.push(filters.release);}
  if(filters&&filters.demand_id){where.push('demand_id=?');vals.push(Number(filters.demand_id));}
  const [rows]=await pool.query(`SELECT * FROM voice_estimate_roles WHERE ${where.join(' AND ')} ORDER BY category,role_name,language,demand_id`,vals);
  return rows;
}

async function syncActualLines({pool,mcp,readActualLinesForDemand,release,demandId,actor}){
  await ensureTable(pool);
  const where=['script_doc_url IS NOT NULL','script_doc_url<>\'\'']; const vals=[];
  if(release){where.push('release_plan=?');vals.push(release);}
  if(demandId){where.push('id=?');vals.push(Number(demandId));}
  const [demands]=await pool.query(`SELECT * FROM demands WHERE ${where.join(' AND ')} ORDER BY id`,vals);
  const [roles]=await pool.query('SELECT id,module,role_cn,role_en FROM voice_roles WHERE is_deleted=0 OR is_deleted IS NULL');
  const results=[];
  for(const demand of demands){
    try{
      const actual=await readActualLinesForDemand(demand);
      const [stored]=await pool.query('SELECT * FROM voice_estimate_roles WHERE demand_id=?',[demand.id]);
      const merged=new Map(stored.map(r=>[keyOf(r),Object.assign({},r,{actual_lines:0})]));
      for(const a of actual.rows||[]){
        const hit=matchRoleName(a.role_name,roles);
        const standard=hit.role ? hit.role.role_cn : a.role_name;
        const category=hit.role ? hit.role.module : '未匹配';
        const key=`${demand.id}|${standard}|${a.language}`;
        const row=merged.get(key)||{
          demand_id:Number(demand.id),release_plan:demand.release_plan,language:a.language,
          category,role_name:standard,role_id:hit.role?hit.role.id:null,estimated_lines:0
        };
        row.actual_lines=Number(a.actual_lines)||0;
        row.match_status=hit.status;
        row.source_role_name=hit.status==='exact'?null:a.role_name;
        row.category=category; row.role_id=hit.role?hit.role.id:null;
        merged.set(key,row);
      }
      const rows=[...merged.values()];
      const doc=await libraryDocForRelease(pool,demand.release_plan);
      if(!doc) throw new Error('release_library_not_registered');
      const target=await ensureRoleDetailTable(mcp,doc.file_id);
      await upsertRoleDetailRecords(mcp,target,demand,rows,actor||'Vomi');
      await mirrorRows(pool,demand,rows,target,actor||'Vomi');
      results.push({demand_id:demand.id,ok:true,rows:rows.length});
    }catch(e){results.push({demand_id:demand.id,ok:false,error:e.message});}
  }
  return {ok:results.every(r=>r.ok),processed:results.length,results};
}

function aggregateRoleCards(rows,demands){
  const demandMap=new Map((demands||[]).map(d=>[String(d.id),d]));
  const map=new Map();
  for(const r of rows||[]){
    const key=`${r.language}|${r.role_name}`;
    const d=demandMap.get(String(r.demand_id))||{};
    if(!map.has(key)) map.set(key,{role:r.role_name,language:r.language,category:r.category,estimated:0,actual:0,demands:[],delivered:0,total:0,unmatched:0});
    const x=map.get(key); x.estimated+=Number(r.estimated_lines)||0; x.total++;
    if(isDelivered(effectiveStatus(d))){x.actual+=Number(r.actual_lines)||0;x.delivered++;}
    if(r.match_status==='unmatched') x.unmatched++;
    x.demands.push({id:r.demand_id,story:d.task_name||'',status:effectiveStatus(d),estimated:Number(r.estimated_lines)||0,actual:Number(r.actual_lines)||0});
  }
  return [...map.values()].map(x=>Object.assign(x,{deviation:deviationState(x.estimated,x.actual,{delivered:x.delivered,total:x.total})}));
}

module.exports={
  CATEGORIES,CATEGORY_COLORS,DETAIL_TABLE_TITLE,DETAIL_FIELDS,canEditEstimate,isDelivered,effectiveStatus,
  normalizeEstimateRows,buildUpsertPlan,aggregateActualLineRows,deviationState,matchRoleName,aggregateRoleCards,
  ensureTable,libraryDocForRelease,ensureRoleDetailTable,upsertRoleDetailRecords,saveDemandEstimates,listEstimates,syncActualLines,
  textValue,recordFields,docRecordToRow,norm,normRelease
};
