#!/usr/bin/env node
'use strict';

const mysql = require('mysql2/promise');
const mcp = require('/app/src/cw_mcp_client.js');
const { aggregateAllDemands } = require('/app/src/cw_doc_executor.js');

const DB_HOST = process.env.DB_HOST || 'vo-mysql';
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_USER = process.env.DB_USER || 'root';
const DB_PASS = process.env.DB_PASS || process.env.DB_PASSWORD || process.env.MYSQL_ROOT_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'vo_manager';

const release = process.argv[2] || 'Yang1.0';
const TEMPLATE_KEY = 'release_summary_master_template_v1';
const CATS = ['指挥官', '干员', 'Boss', 'AI兵', 'NPC', 'AI系统音'];

function txtVal(v) {
  return { items: [{ text: String(v == null ? '' : v), type: 'text' }] };
}

(async () => {
  const pool = mysql.createPool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASS,
    database: DB_NAME,
    charset: 'utf8mb4',
    connectionLimit: 2,
  });

  const [kvRows] = await pool.query('SELECT v FROM kv_store WHERE k=? LIMIT 1', [TEMPLATE_KEY]);
  if (!kvRows.length) throw new Error(`未找到模板登记：${TEMPLATE_KEY}`);
  const tplMeta = JSON.parse(kvRows[0].v || '{}');
  const templateFileId = tplMeta.file_id;
  if (!templateFileId) throw new Error('模板登记缺少 file_id');

  const [demands] = await pool.query(
    "SELECT id, task_name, area, release_plan, creator, cn_lines_handler, script_doc_url, voice_estimates, story_type, status FROM demands WHERE story_type='音频' AND status!='suspended' AND release_plan=?",
    [release]
  );

  const agg = await aggregateAllDemands(demands);

  const cookie = await mcp.openSession();

  const overviewName = tplMeta.tables?.overview || '版本汇总';
  const detailName = tplMeta.tables?.detail || '需求明细';
  const guideName = tplMeta.tables?.guide || '模板说明';

  // 当前 smartsheet endpoint 未开放字段查询工具，按已登记模板结构写入。
  // 若模板字段名变更，请同步更新此处映射（或扩展可用的字段读取工具后再做自动探测）。
  const tableDefs = [
    {
      title: overviewName,
      fields: [
        { field_title: '序号', field_type: 'autoNumber', property_auto_number: { type: 1 } },
        { field_title: '发布计划', field_type: 'text', property_text: {} },
        { field_title: '文档数', field_type: 'number', property_number: { decimal_places: 0 } },
        { field_title: '角色数', field_type: 'number', property_number: { decimal_places: 0 } },
        { field_title: '预估句数', field_type: 'number', property_number: { decimal_places: 0 } },
        ...CATS.map((c) => ({ field_title: c, field_type: 'number', property_number: { decimal_places: 0 } })),
        { field_title: '文案策划句数', field_type: 'text', property_text: {} },
        { field_title: '备注', field_type: 'text', property_text: {} }
      ]
    },
    {
      title: detailName,
      fields: [
        { field_title: '序号', field_type: 'autoNumber', property_auto_number: { type: 1 } },
        { field_title: '发布计划', field_type: 'text', property_text: {} },
        { field_title: 'Story', field_type: 'text', property_text: {} },
        { field_title: 'AREA', field_type: 'text', property_text: {} },
        { field_title: '文案策划', field_type: 'text', property_text: {} },
        { field_title: '创建人', field_type: 'text', property_text: {} },
        { field_title: '角色数', field_type: 'number', property_number: { decimal_places: 0 } },
        { field_title: '预估句数', field_type: 'number', property_number: { decimal_places: 0 } },
        { field_title: '台词表链接', field_type: 'text', property_text: {} },
        { field_title: '备注', field_type: 'text', property_text: {} }
      ]
    },
    {
      title: guideName,
      fields: [
        { field_title: '序号', field_type: 'autoNumber', property_auto_number: { type: 1 } },
        { field_title: '规则项', field_type: 'text', property_text: {} },
        { field_title: '说明', field_type: 'text', property_text: {} }
      ]
    }
  ];

  const created = await mcp.createSmartSheet({ title: `【VO Manager】版本汇总·${release}` });
  const file_id = created.file_id;
  const newCookie = created.cookie || cookie;

  const defaultTables = await mcp.listTables(file_id, newCookie);
  const defaultSid = defaultTables[0] && defaultTables[0].sheet_id;

  const sidMap = {};
  let idx = 1;
  for (const td of tableDefs) {
    sidMap[td.title] = await mcp.addTable(file_id, td.title, idx++, newCookie);
  }
  if (defaultSid) {
    try { await mcp.deleteTable(file_id, defaultSid, newCookie); } catch (_) {}
  }

  for (const td of tableDefs) {
    if (!td.fields.length) continue;
    await mcp.addFields(file_id, sidMap[td.title], td.fields, newCookie);
  }

  const overviewDef = tableDefs.find(t => t.title === overviewName);
  const detailDef = tableDefs.find(t => t.title === detailName);

  if (overviewDef && sidMap[overviewName]) {
    const fieldSet = new Set((overviewDef.fields || []).map(f => f.field_title));
    const records = Object.keys(agg.released || {}).map((rel) => {
      const b = agg.released[rel] || {};
      const writerStr = Object.keys(b.by_writer || {}).map((w) => `${w}:${b.by_writer[w] || 0}`).join('；') || '—';
      const map = {
        '发布计划': { text_value: txtVal(rel) },
        '文档数': { number_value: b.docs || 0 },
        '角色数': { number_value: b.role_count || 0 },
        '预估句数': { number_value: b.est_lines || 0 },
        '文案策划句数': { text_value: txtVal(writerStr) },
      };
      CATS.forEach((c) => { map[c] = { number_value: (b.by_role_type && b.by_role_type[c]) || 0 }; });
      const fv = Object.keys(map).filter(k => fieldSet.has(k)).map((k) => ({ field: k, ...map[k] }));
      return { field_values: fv };
    });
    if (records.length) await mcp.addRecords(file_id, sidMap[overviewName], records, newCookie);
  }

  if (detailDef && sidMap[detailName]) {
    const fieldSet = new Set((detailDef.fields || []).map(f => f.field_title));
    const records = (agg.demands || []).map((d) => {
      const map = {
        '发布计划': { text_value: txtVal(d.release) },
        'Story': { text_value: txtVal(d.task_name) },
        'AREA': { text_value: txtVal(d.area) },
        '文案策划': { text_value: txtVal(d.cn_lines_handler) },
        '创建人': { text_value: txtVal(d.creator) },
        '角色数': { number_value: d.role_count || 0 },
        '预估句数': { number_value: d.est_lines || 0 },
        '台词表链接': { text_value: txtVal(d.script_doc_url || '') },
      };
      const fv = Object.keys(map).filter(k => fieldSet.has(k)).map((k) => ({ field: k, ...map[k] }));
      return { field_values: fv };
    });
    if (records.length) await mcp.addRecords(file_id, sidMap[detailName], records, newCookie);
  }

  await mcp.setPrivilege(file_id, 3, newCookie);

  console.log(JSON.stringify({
    ok: true,
    release,
    template_key: TEMPLATE_KEY,
    template_file_id: templateFileId,
    file_id,
    url: created.url,
    releases: Object.keys(agg.released || {}).length,
    demands: (agg.demands || []).length,
  }));

  await pool.end();
})().catch((e) => {
  console.error('ERR', e && e.message ? e.message : e);
  process.exit(1);
});
