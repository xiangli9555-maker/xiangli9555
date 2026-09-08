'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const demandHtml = fs.readFileSync(path.join(ROOT, 'preview-需求汇总-精修版.html'), 'utf8');
const rosterHtml = fs.readFileSync(path.join(ROOT, 'preview-声优库-精修版.html'), 'utf8');
const schedHtml = fs.readFileSync(path.join(ROOT, 'preview-录制档期-精修版.html'), 'utf8');
const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
const executorSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'cw_doc_executor.js'), 'utf8');
const templateSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'script_table_template.js'), 'utf8');
const mod = require('../src/voice_estimates');
const mcpClient = require('../src/cw_mcp_client');

function extractNamedFunction(source, name){
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `缺少函数 ${name}`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for(let i=brace;i<source.length;i++){
    if(source[i]==='{') depth++;
    else if(source[i]==='}' && --depth===0) return source.slice(start,i+1);
  }
  throw new Error(`函数 ${name} 花括号不闭合`);
}

test('声优预估固定使用 7 大类并包含路人角色冷灰色', () => {
  assert.deepEqual(mod.CATEGORIES, ['指挥官','干员','Boss','AI兵','NPC','路人角色','AI系统音']);
  assert.equal(mod.CATEGORY_COLORS['路人角色'], '#7A8A96');
});

test('仅待澄清与文案ing允许编辑预估', () => {
  assert.equal(mod.canEditEstimate('待澄清'), true);
  assert.equal(mod.canEditEstimate('文案ing'), true);
  assert.equal(mod.canEditEstimate('已交稿'), false);
  assert.equal(mod.canEditEstimate('Vo ing'), false);
  assert.equal(mod.canEditEstimate('Done'), false);
});

test('标准化角色明细按需求角色语言唯一键去重并保留最后值', () => {
  const rows = mod.normalizeEstimateRows(42, 'Yang1.0', [
    { role_name:'牧羊人', category:'干员', language:'cn', estimated_lines:12 },
    { role_name:'牧羊人', category:'干员', language:'cn', estimated_lines:18 },
    { role_name:'路人甲', category:'路人角色', language:'en', estimated_lines:0 },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(x => x.role_name === '牧羊人').estimated_lines, 18);
  assert.equal(rows.find(x => x.role_name === '路人甲').category, '路人角色');
  assert.throws(() => mod.normalizeEstimateRows(42, 'Yang1.0', [{role_name:'A',category:'未知',language:'cn',estimated_lines:1}]), /invalid_category/);
  assert.throws(() => mod.normalizeEstimateRows(42, 'Yang1.0', [{role_name:'A',category:'NPC',language:'jp',estimated_lines:1}]), /invalid_language/);
  assert.throws(() => mod.normalizeEstimateRows(42, 'Yang1.0', [{role_name:'A',category:'NPC',language:'cn',estimated_lines:-1}]), /invalid_estimated_lines/);
});

test('文档 upsert 计划区分新增、更新与删除', () => {
  const existing = [
    { record_id:'r1', demand_id:'42', role_name:'牧羊人', language:'cn', estimated_lines:10 },
    { record_id:'r2', demand_id:'42', role_name:'蜂医', language:'cn', estimated_lines:20 },
  ];
  const incoming = [
    { demand_id:42, role_name:'牧羊人', language:'cn', estimated_lines:16 },
    { demand_id:42, role_name:'露娜', language:'cn', estimated_lines:8 },
  ];
  const plan = mod.buildUpsertPlan(existing, incoming);
  assert.deepEqual(plan.toUpdate.map(x=>x.record_id), ['r1']);
  assert.deepEqual(plan.toAdd.map(x=>x.role_name), ['露娜']);
  assert.deepEqual(plan.toDelete, ['r2']);
});

test('文档 upsert 计划跳过完全未变化的角色，避免重复远程写入', () => {
  const existing = [
    { record_id:'r1', demand_id:'42', release_plan:'Yang1.0', role_name:'牧羊人', language:'cn', category:'干员', estimated_lines:16, actual_lines:3, match_status:'exact', source_role_name:null },
  ];
  const incoming = [
    { demand_id:42, release_plan:'Yang1.0', role_name:'牧羊人', language:'cn', category:'干员', estimated_lines:16, actual_lines:3, match_status:'exact', source_role_name:null },
  ];
  const plan = mod.buildUpsertPlan(existing, incoming);
  assert.equal(plan.toUpdate.length, 0);
  assert.equal(plan.unchanged, 1);
});

test('同一文档连续保存复用角色明细定位与记录快照，只发送变更行', async () => {
  const calls = {open:0,tables:0,fields:0,list:0,update:0,add:0,del:0};
  let docRows = [{record_id:'r1',field_values:{
    '唯一键':'42|牧羊人|cn','需求ID':'42','发布计划':'Yang1.0','Story':'测试需求','语言':'cn','大类':'干员','游戏角色名':'牧羊人','预估句数':10,'实际句数':0,'角色校验':'exact','原始角色名':'','需求状态':'文案ing','更新人':'tester','更新时间':'2026-09-07T00:00:00.000Z'
  }}];
  const conn = {async beginTransaction(){},async query(){return [[],[]];},async commit(){},async rollback(){},release(){}};
  const pool = {
    async query(sql){
      if(/CREATE TABLE/.test(sql)) return [[],[]];
      if(/FROM voice_roles/.test(sql)) return [[{id:1,module:'干员',role_cn:'牧羊人',role_en:'Shepherd'}],[]];
      if(/FROM kv_store/.test(sql)) return [[{v:JSON.stringify({'Yang1.0':{file_id:'doc1',url:'https://docs.qq.com/smartsheet/doc1'}})}],[]];
      if(/FROM voice_estimate_roles/.test(sql)&&/doc_table_id/.test(sql)) return [[{doc_table_id:'sheet1'}],[]];
      throw new Error('unexpected query: '+sql);
    },
    async getConnection(){return conn;}
  };
  const mcp = {
    async openSession(){calls.open++;return 'cookie';},
    async listTables(){calls.tables++;return [{sheet_id:'sheet1',title:'角色需求明细'}];},
    async listFields(){calls.fields++;return mod.DETAIL_FIELDS.map(([field_title])=>({field_title}));},
    async listRecords(){calls.list++;return {records:docRows};},
    async updateRecords(_f,_s,records){calls.update++;docRows=docRows.map(old=>{const hit=records.find(r=>r.record_id===old.record_id);return hit?{record_id:old.record_id,field_values:hit.field_values}:old;});return {ok:true};},
    async addRecords(){calls.add++;return {records:[]};},
    async deleteRecords(){calls.del++;return {ok:true};}
  };
  const demand={id:42,release_plan:'Yang1.0',manual_status:'文案ing',task_name:'测试需求'};
  const first=await mod.saveDemandEstimates({pool,mcp,demand,rows:[{role_name:'牧羊人',category:'干员',language:'cn',estimated_lines:11}],actor:'tester'});
  const second=await mod.saveDemandEstimates({pool,mcp,demand,rows:[{role_name:'牧羊人',category:'干员',language:'cn',estimated_lines:12}],actor:'tester'});
  assert.equal(first.timing.cache_hit,false);
  assert.equal(second.timing.cache_hit,true);
  assert.deepEqual(calls,{open:1,tables:0,fields:0,list:1,update:2,add:0,del:0});
});

test('MySQL 镜像使用单次批量 upsert，角色多时不逐行等待', async () => {
  const sqls=[];
  const conn={
    async beginTransaction(){},
    async query(sql,params){sqls.push({sql,params});return [[],[]];},
    async commit(){},
    async rollback(){},
    release(){}
  };
  const pool={async getConnection(){return conn;}};
  const rows=['牧羊人','蜂医','红狼'].map((role_name,i)=>({demand_id:42,release_plan:'Yang1.0',language:'cn',category:'干员',role_name,role_id:i+1,estimated_lines:10+i,actual_lines:0,match_status:'exact',source_role_name:null}));
  await mod.mirrorRows(pool,{id:42},rows,{file_id:'doc1',sheet_id:'sheet1'},'tester');
  const inserts=sqls.filter(x=>/INSERT INTO voice_estimate_roles/.test(x.sql));
  assert.equal(inserts.length,1);
  assert.equal((inserts[0].sql.match(/\(\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?\)/g)||[]).length,3);
});

test('偏差状态覆盖待交稿、未预估、超30%、负数和正常范围', () => {
  assert.deepEqual(mod.deviationState(100, 0, {delivered:0,total:2}), {kind:'waiting', label:'待交稿', value:null, percent:null});
  assert.deepEqual(mod.deviationState(0, 8, {delivered:1,total:1}), {kind:'unestimated', label:'未预估', value:8, percent:null});
  assert.equal(mod.deviationState(100, 131, {delivered:1,total:1}).kind, 'over');
  assert.equal(mod.deviationState(100, 130, {delivered:1,total:1}).kind, 'normal');
  assert.equal(mod.deviationState(100, 80, {delivered:1,total:1}).kind, 'negative');
});

test('角色名校验先标准归一，再有限模糊匹配，匹配不上归未匹配', () => {
  const roles = [{id:1,role_cn:'牧羊人',module:'干员'}, {id:2,role_cn:'蜂医',module:'干员'}];
  assert.equal(mod.matchRoleName('牧羊人', roles).status, 'exact');
  assert.equal(mod.matchRoleName('牧 羊 人', roles).role.role_cn, '牧羊人');
  assert.equal(mod.matchRoleName('牧羊', roles).status, 'fuzzy');
  assert.equal(mod.matchRoleName('完全不存在', roles).status, 'unmatched');
});

test('实际句数优先读取台词表句数统计列，缺失时按每20字兜底', () => {
  const row = (role, cn, en, sentence) => {
    const cells = Array(11).fill('');
    cells[1] = role; cells[2] = cn; cells[3] = en; cells[9] = sentence;
    return cells;
  };
  const out = mod.aggregateActualLineRows([
    row('牧羊人', '中文台词', 'English line', '3'),
    row('牧羊人', '这是一条超过二十个汉字的中文台词用于验证兜底折算逻辑', '', ''),
    row('蜂医', '', 'English only', ''),
  ]);
  const byKey = new Map(out.map(x => [`${x.language}|${x.role_name}`, x.actual_lines]));
  assert.equal(byKey.get('cn|牧羊人'), 5);
  assert.equal(byKey.get('en|牧羊人'), 3);
  assert.equal(byKey.get('en|蜂医'), 1);
});

test('台词表角色名校验使用黄色标记并给出统一规范提示', () => {
  assert.match(templateSrc, /角色名不规范，请检查/);
  assert.match(executorSrc, /style:\s*\{\s*bg_color:\s*'#FFD24C',\s*font_color:\s*'#0F171C'/);
});

test('后端提供角色明细 API、状态权限与腾讯文档真源同步入口', () => {
  assert.match(indexSrc, /\/api\/voice-estimates/);
  assert.match(indexSrc, /saveDemandEstimates/);
  assert.match(indexSrc, /syncActualLines/);
  assert.match(executorSrc, /角色需求明细/);
  assert.match(executorSrc, /upsertRoleDetailRecords/);
});

test('版本汇总表为七类全部建字段，路人角色不会写入不存在的列', () => {
  assert.match(executorSrc, /field_title:\s*'路人角色'/);
});

test('需求进入已交稿时自动触发该需求实际句数回填', () => {
  assert.match(indexSrc, /req\.body\.manual_status\s*===\s*'已交稿'/);
  assert.match(indexSrc, /syncActualLines\(\{[\s\S]{0,400}demandId:\s*req\.params\.id/);
});

test('MCP 列表响应只提取数组，兼容 data.fields 嵌套结构', () => {
  const fields = [{field_title:'角色名'}];
  assert.deepEqual(mcpClient.digArray({data:{fields}}, 'fields', 'data', 'list'), fields);
  assert.deepEqual(mcpClient.digArray({data:{records:[{record_id:'r1'}]}}, 'records', 'data', 'list'), [{record_id:'r1'}]);
  assert.deepEqual(mcpClient.digArray({data:{offset:0}}, 'fields', 'data', 'list'), []);
});

test('腾讯文档写入失败时不得提前提交 MySQL 镜像', async () => {
  let mirrored = false;
  const pool = {
    async query(sql){
      if (/CREATE TABLE/.test(sql)) return [[], []];
      if (/FROM voice_roles/.test(sql)) return [[{id:1,module:'干员',role_cn:'牧羊人',role_en:'Shepherd'}], []];
      if (/FROM kv_store/.test(sql)) return [[{v:JSON.stringify({'Yang1.0':{file_id:'doc1',url:'https://docs.qq.com/smartsheet/doc1'}})}], []];
      throw new Error('unexpected query: '+sql);
    },
    async getConnection(){ mirrored = true; throw new Error('mirror must not run'); }
  };
  const mcp = {
    async openSession(){ return 'cookie'; },
    async listTables(){ return [{sheet_id:'sheet1',title:'角色需求明细'}]; },
    async listFields(){ return mod.DETAIL_FIELDS.map(([field_title])=>({field_title})); },
    async listRecords(){ throw new Error('doc_write_failed'); }
  };
  await assert.rejects(() => mod.saveDemandEstimates({
    pool, mcp,
    demand:{id:42,release_plan:'Yang1.0',manual_status:'文案ing',task_name:'测试需求'},
    rows:[{role_name:'牧羊人',category:'干员',language:'cn',estimated_lines:12}],
    actor:'tester'
  }), /doc_write_failed/);
  assert.equal(mirrored, false);
});

test('版本汇总同角色跨需求按合计显示，单需求历史中英记录仍只取较大值', () => {
  const source = ['veList','veRecord','veResolved','veUnified'].map(name=>extractNamedFunction(demandHtml,name)).join('\n');
  const VE_CATEGORIES=['指挥官','干员','Boss','AI兵','NPC','AI系统音'];
  const VE_ESTIMATE_INDEX=new Map([
    ['d1',[{demand_id:'d1',category:'AI系统音',role_name:'CC（赛季）',language:'cn',estimated_lines:50}]],
    ['d2',[{demand_id:'d2',category:'AI系统音',role_name:'CC（赛季）',language:'cn',estimated_lines:20}]],
    ['d3',[
      {demand_id:'d3',category:'AI系统音',role_name:'CC（赛季）',language:'cn',estimated_lines:50},
      {demand_id:'d3',category:'AI系统音',role_name:'CC（赛季）',language:'en',estimated_lines:20},
    ]],
  ]);
  const VE_UNIFIED_CACHE=new Map();
  const {veUnified}=new Function('VE_CATEGORIES','VE_ESTIMATE_INDEX','VE_UNIFIED_CACHE',`${source};return {veUnified};`)(VE_CATEGORIES,VE_ESTIMATE_INDEX,VE_UNIFIED_CACHE);
  assert.equal(veUnified({_releaseSummary:true,_releaseRows:[{id:'d1'},{id:'d2'}]})[0].est_lines,70);
  assert.equal(veUnified({id:'d3'})[0].est_lines,50);
});

test('需求汇总声优预估大类与声优库一致且取消路人角色与编辑列', () => {
  const demandCats = demandHtml.match(/const VE_CATEGORIES=\[([^\]]+)\]/)?.[1].match(/'[^']+'/g)?.map(x=>x.slice(1,-1));
  const rosterCats = rosterHtml.match(/const order = \[([^\]]+)\]/)?.[1].match(/'[^']+'/g)?.map(x=>x.slice(1,-1));
  assert.deepEqual(demandCats, rosterCats);
  assert.deepEqual(demandCats, ['指挥官','干员','Boss','AI兵','NPC','AI系统音']);
  assert.doesNotMatch(demandHtml, /class="th-ve-edit|class="col-ve-edit|class="ve-edit-btn/);
  assert.doesNotMatch(demandHtml, /data-sort="veCat:路人角色"/);
});

test('点击大类单元格打开该类角色句数框且不区分中英', () => {
  assert.match(demandHtml, /openVeCategory\('\$\{d\.id\}',\s*'\$\{cat\}',\s*this\)/);
  assert.match(demandHtml, /id="veCategoryPopover"/);
  assert.match(demandHtml, /id="veCategoryScroll"/);
  assert.match(demandHtml, /\.ve-category-scroll\{[^}]*overflow-y:auto/);
  assert.match(demandHtml, /data-role="\$\{esc\(r\.role_cn\)\}"[^>]*type="number"/);
  assert.match(demandHtml, /language:'cn'/);
  assert.doesNotMatch(demandHtml, /class="ve-lang-tabs|data-ve-lang=|setVeEditorLang/);
  assert.doesNotMatch(demandHtml, />中配<|>英配</);
  assert.match(demandHtml, /待澄清.*文案ing/);
  assert.match(demandHtml, /data\.actual_sync\.ok\s*===\s*false/);
});

test('声优预估填写使用索引缓存、搜索帧合并与连续录入快捷键', () => {
  assert.match(demandHtml, /const VE_ESTIMATE_INDEX=new Map\(\),VE_UNIFIED_CACHE=new Map\(\)/);
  assert.match(demandHtml, /function rebuildVeEstimateIndex\(/);
  assert.match(demandHtml, /function queueVeCategorySearch\(/);
  assert.match(demandHtml, /requestAnimationFrame\(\(\)=>\{VE_SEARCH_RAF=0;renderVeCategoryRoles\(\);\}\)/);
  assert.match(demandHtml, /function veLineKeydown\(event,input\)/);
  assert.match(demandHtml, /event\.key==='Enter'/);
  assert.match(demandHtml, /onfocus="this\.select\(\)"/);
  assert.match(demandHtml, /onkeydown="veLineKeydown\(event,this\)"/);
  assert.match(demandHtml, /VE_CATEGORY\.saving/);
});

test('声优预估滚动条与操作按钮使用战术风格且不显示系统箭头', () => {
  assert.match(demandHtml, /\.ve-category-scroll::-webkit-scrollbar\{width:8px\}/);
  assert.match(demandHtml, /\.ve-category-scroll::-webkit-scrollbar-button\{display:none;width:0;height:0\}/);
  assert.match(demandHtml, /\.ve-stack::-webkit-scrollbar-button\{display:none;width:0;height:0\}/);
  assert.match(demandHtml, /scrollbar-color:var\(--c-hairline\) transparent/);
  assert.match(demandHtml, /\.ve-category-actions \.btn\{[^}]*clip-path:polygon/);
  assert.match(demandHtml, /\.ve-category-actions \.btn:not\(\.btn-primary\)\{background:transparent;color:var\(--c-text-mute\);border:1px solid var\(--c-border\)\}/);
  assert.match(demandHtml, /\.ve-category-actions \.btn-primary\{background:var\(--c-brand-yellow,#FFD24C\);color:#0A1015/);
});

test('录制档期声优视图回退为六板标签云但继续使用真实预估接口', () => {
  assert.match(schedHtml, /function renderActorRoleTable\(\)\{\s*return\s*renderActorSixBoard\('role'\);?\s*\}/);
  assert.match(schedHtml, /中文声优/);
  assert.match(schedHtml, /英文声优/);
  assert.match(schedHtml, /待预约/);
  assert.match(schedHtml, /部分已约/);
  assert.match(schedHtml, /已约完/);
  assert.match(schedHtml, /cardB-tag/);
  assert.doesNotMatch(schedHtml, /role-estimate-card/);
  assert.match(schedHtml, /\/api\/voice-estimates/);
});
