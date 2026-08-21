'use strict';
// cw_mcp_client.js — 直连腾讯文档个人版 MCP（JSON-RPC over HTTPS）
// 让 CVM 上的 vo-backend 不依赖任何 AI 会话、不依赖企业版 AccessToken，
// 直接用 MCP token 调 manage.create_file / smartsheet.* 建「台词表」智能表格。
//
// 用法：
//   const mcp = require('./cw_mcp_client');
//   const fid = await mcp.createSmartSheet({ title });
//   const sid = await mcp.addTable(fid, 'tab名');
//   await mcp.addFields(fid, sid, fieldsArray);
//
// 环境变量：
//   TENCENT_DOCS_MCP_URL   默认 https://docs.qq.com/openapi/mcp
//   TENCENT_DOCS_MCP_TOKEN 必填（来自 ~/.workbuddy/mcp.json 的 tencent-docs.headers.Authorization）

const https = require('https');
const fs = require('fs');

const MCP_URL = process.env.TENCENT_DOCS_MCP_URL || 'https://docs.qq.com/openapi/mcp';
// token 来源：env 优先；否则读文件（便于 CVM 部署时 docker cp 注入，免改 compose）
const TOKEN_FILE = process.env.TENCENT_DOCS_MCP_TOKEN_FILE || '/app/tencent_docs_token';
function readTokenFile() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) { return ''; }
}
const TOKEN = () => (process.env.TENCENT_DOCS_MCP_TOKEN || readTokenFile() || '').trim();

function rawRequest(body, cookie) {
  return new Promise((resolve, reject) => {
    if (!TOKEN()) return reject(new Error('TENCENT_DOCS_MCP_TOKEN 未配置'));
    let url;
    try { url = new URL(MCP_URL); } catch (e) { return reject(e); }
    const payload = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': TOKEN(),
      'Content-Length': Buffer.byteLength(payload),
    };
    if (cookie) headers['Cookie'] = cookie;
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        // 可能返回 set-cookie（维持会话）
        const setCookie = res.headers['set-cookie'];
        let cookieStr = cookie || '';
        if (Array.isArray(setCookie) && setCookie.length) {
          cookieStr = setCookie.map((c) => c.split(';')[0]).join('; ');
        }
        // 响应可能是 SSE（text/event-stream，包在 data: 里）或纯 JSON
        let text = buf;
        const m = buf.match(/data:\s*(\{[\s\S]*\})/);
        if (m) text = m[1];
        try {
          resolve({ json: JSON.parse(text), cookie: cookieStr });
        } catch (e) {
          reject(new Error('MCP 响应解析失败: ' + buf.slice(0, 400)));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// 开启一个 MCP 会话：initialize 并取回 cookie
async function openSession() {
  const r = await rawRequest({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'vo-backend', version: '1.0' } },
  });
  return r.cookie;
}

// 调用一个 MCP 工具，返回 { content:[{type,text}], ... } 中的结构化对象（尽可能 JSON.parse）
async function callTool(name, args, cookie) {
  const r = await rawRequest({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name, arguments: args || {} },
  }, cookie);
  const body = r.json;
  if (body.error) throw new Error(`MCP ${name} error: ${JSON.stringify(body.error)}`);
  const result = (body.result && body.result.content) || [];
  // 合并所有 text 片段，尝试解析为 JSON
  const texts = result.filter((c) => c.type === 'text').map((c) => c.text || '');
  const raw = texts.join('');
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { parsed = { _raw: raw }; }
  return { cookie: r.cookie, parsed, raw, structured: result };
}

// 从工具返回里抽取某个字段（兼容多种嵌套结构）
function dig(obj, ...keys) {
  for (const k of keys) {
    const v = digOne(obj, k);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}
function digOne(obj, key) {
  if (obj == null) return undefined;
  if (typeof obj === 'object') {
    if (key in obj) return obj[key];
    for (const k of Object.keys(obj)) {
      const v = digOne(obj[k], key);
      if (v !== undefined && v !== null && v !== '') return v;
    }
  }
  if (Array.isArray(obj)) {
    for (const it of obj) {
      const v = digOne(it, key);
      if (v !== undefined && v !== null && v !== '') return v;
    }
  }
  return undefined;
}

// —— 高层封装 ——

// 建智能表格，返回 { file_id, url, title }
async function createSmartSheet({ title, parent_id }) {
  const cookie = await openSession();
  const r = await callTool('manage.create_file', { title, file_type: 'smartsheet', ...(parent_id ? { parent_id } : {}) }, cookie);
  const p = r.parsed && (r.parsed.data || r.parsed);
  const file_id = dig(p, 'file_id', 'fileId', 'id', 'fid');
  const url = dig(p, 'url');
  if (!file_id) throw new Error('create_file 未返回 file_id: ' + r.raw.slice(0, 300));
  return { file_id, url, title, cookie };
}

// 列出智能表格的所有工作表，返回 [{sheet_id, title, index}]
async function listTables(file_id, cookie) {
  const r = await callTool('smartsheet.list_tables', { file_id }, cookie);
  const p = r.parsed || {};
  let tables = dig(p, 'tables', 'sheets', 'data', 'list');
  if (!Array.isArray(tables)) tables = [];
  return tables.map((t) => ({
    sheet_id: dig(t, 'sheet_id', 'sheetId', 'id'),
    title: dig(t, 'title', 'name'),
    index: dig(t, 'index'),
  }));
}

// 新增一个工作表（tab），返回 sheet_id
async function addTable(file_id, title, index, cookie) {
  const r = await callTool('smartsheet.add_table', {
    file_id,
    properties: { title, index: index == null ? 1 : index },
  }, cookie);
  const sid = dig(r.parsed, 'sheet_id', 'sheetId', 'id', 'table_id', 'tableId');
  if (!sid) throw new Error('add_table 未返回 sheet_id: ' + r.raw.slice(0, 300));
  return sid;
}

// 给工作表加字段（列），fields 为 cw_doc_recipe_v6 的 step3 字段数组
async function addFields(file_id, sheet_id, fields, cookie) {
  const r = await callTool('smartsheet.add_fields', { file_id, sheet_id, fields }, cookie);
  return r.parsed;
}

// 批量写记录（行）。records: [{ values: { '<字段标题>': <值>, ... } }, ...]
async function addRecords(file_id, sheet_id, records, cookie) {
  const r = await callTool('smartsheet.add_records', { file_id, sheet_id, records }, cookie);
  return r.parsed;
}

// 删除一个工作表（用于清掉建表后默认多余的空 sheet）
async function deleteTable(file_id, sheet_id, cookie) {
  const r = await callTool('smartsheet.delete_table', { file_id, sheet_id }, cookie);
  return r.parsed;
}

// 设置文档权限：policy=2 所有人可读，policy=3 所有人可编辑
async function setPrivilege(file_id, policy, cookie) {
  const r = await callTool('manage.set_privilege', { file_id, policy }, cookie);
  return r.parsed;
}

// 删除整文件（移入回收站，与腾讯文档手动删除等价）。file_id 即探针表/NhpDAOMErlOy 之类。
// 腾讯文档 MCP 未暴露「清空回收站」工具，彻底删除需在 UI 回收站手动操作。
async function deleteFile(file_id, cookie) {
  const r = await callTool('manage.delete_file', { file_id }, cookie);
  return r.parsed;
}

// ============ 企业版(OA) 腾讯文档 MCP：成员级授权 ============
// 端点 saas.docs.qq.com/api/v6/open/agent/mcp；需在 env 注入 TENCENT_DOCS_OA_MCP_URL / TENCENT_DOCS_OA_MCP_TOKEN
// （个人版 set_privilege 仅支持 policy 2/3 全员权限，无法限定到具体人；企业版才支持成员级可编辑）
const OA_MCP_URL = process.env.TENCENT_DOCS_OA_MCP_URL || 'https://saas.docs.qq.com/api/v6/open/agent/mcp';
const OA_TOKEN_FILE = process.env.TENCENT_DOCS_OA_MCP_TOKEN_FILE || '/app/tencent_docs_oa_token';
function readOaTokenFile() { try { return fs.readFileSync(OA_TOKEN_FILE, 'utf8').trim(); } catch (e) { return ''; } }
const OA_TOKEN = () => (process.env.TENCENT_DOCS_OA_MCP_TOKEN || readOaTokenFile() || '').trim();

function oaRawRequest(body, cookie) {
  return new Promise((resolve, reject) => {
    if (!OA_TOKEN()) return reject(new Error('TENCENT_DOCS_OA_MCP_TOKEN 未配置'));
    let url; try { url = new URL(OA_MCP_URL); } catch (e) { return reject(e); }
    const payload = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': OA_TOKEN(),
      'Content-Length': Buffer.byteLength(payload),
    };
    if (cookie) headers['Cookie'] = cookie;
    const req = https.request({ hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, method: 'POST', headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        const setCookie = res.headers['set-cookie'];
        let cookieStr = cookie || '';
        if (Array.isArray(setCookie) && setCookie.length) cookieStr = setCookie.map((c) => c.split(';')[0]).join('; ');
        let text = buf; const m = buf.match(/data:\s*(\{[\s\S]*\})/); if (m) text = m[1];
        try { resolve({ json: JSON.parse(text), cookie: cookieStr }); } catch (e) { reject(new Error('OA MCP 响应解析失败: ' + buf.slice(0, 400))); }
      });
    });
    req.on('error', reject); req.write(payload); req.end();
  });
}
async function oaOpenSession() {
  const r = await oaRawRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'vo-backend', version: '1.0' } } });
  return r.cookie;
}
async function oaCallTool(name, args, cookie) {
  const r = await oaRawRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args || {} } }, cookie);
  const body = r.json;
  if (body.error) throw new Error(`OA MCP ${name} error: ${JSON.stringify(body.error)}`);
  const result = (body.result && body.result.content) || [];
  const texts = result.filter((c) => c.type === 'text').map((c) => c.text || '');
  const raw = texts.join('');
  let parsed = null; try { parsed = JSON.parse(raw); } catch (e) { parsed = { _raw: raw }; }
  return { cookie: r.cookie, parsed, raw, structured: result };
}

// 把文档授权给指定企业微信成员可编辑。userids 为企业微信 userid 列表。
// 注：OA set_privilege 成员参数形态需在拿到 OA token 后 tools/list 实测确认；此处先按 policy=1 + members 尝试并记录原始响应。
async function setEnterpriseDocEditors(file_id, userids) {
  if (!OA_TOKEN()) { console.warn('[cw] 未配置 OA token，跳过企业版成员授权'); return { ok: false, reason: 'no-oa-token' }; }
  if (!Array.isArray(userids) || !userids.length) { console.warn('[cw] setEnterpriseDocEditors 无有效成员，跳过'); return { ok: false, reason: 'no-members' }; }
  try {
    const cookie = await oaOpenSession();
    const r = await oaCallTool('manage.set_privilege', { file_id, policy: 1, members: userids.map((u) => ({ userid: String(u) })) }, cookie);
    console.log('[cw] OA set_privilege 响应:', JSON.stringify(r.parsed).slice(0, 500));
    return { ok: true, raw: r.parsed };
  } catch (e) {
    console.warn('[cw] OA 成员授权失败(需按 tools/list 校正参数):', e.message);
    return { ok: false, reason: 'oa-call-failed', error: e.message };
  }
}

// ============ 普通在线表格（sheet，非智能表格）============
// 建普通在线表格（file_type:'sheet'），返回 { file_id, url, title }
async function createSheet({ title, parent_id }) {
  const cookie = await openSession();
  const r = await callTool('manage.create_file', { title, file_type: 'sheet', ...(parent_id ? { parent_id } : {}) }, cookie);
  const p = r.parsed && (r.parsed.data || r.parsed);
  const file_id = dig(p, 'file_id', 'fileId', 'id', 'fid');
  const url = dig(p, 'url');
  if (!file_id) throw new Error('create_file(sheet) 未返回 file_id: ' + r.raw.slice(0, 300));
  return { file_id, url, title, cookie };
}

// 取子表信息，返回 [{sheet_id, title, index}]
async function getSheetInfo(file_id, cookie) {
  const r = await callTool('sheet.get_sheet_info', { file_id }, cookie);
  const p = r.parsed || {};
  let sheets = dig(p, 'sheets', 'sub_sheets', 'data', 'list', 'sheet_list', 'sheet_list_info');
  if (!Array.isArray(sheets)) sheets = [];
  return sheets.map((s) => ({
    sheet_id: dig(s, 'sheet_id', 'sheetId', 'id'),
    title: dig(s, 'title', 'name'),
    index: dig(s, 'index'),
  }));
}

// 批量写单元格值（values: [{row,col,value_type,string_value|number_value|...}]）
async function setRangeValue(file_id, sheet_id, values, cookie) {
  const r = await callTool('sheet.set_range_value', { file_id, sheet_id, values }, cookie);
  return r.parsed;
}

// 单格写值，支持 value_type:'FORMULA'（formula 字段传公式原文，普通表可求值）。
// 注意：unified 网关的 sheet.set_range_value 不支持 FORMULA，公式必须用本函数（sheet.set_cell_value）。
async function setCellValue(file_id, sheet_id, row, col, value_type, value, cookie) {
  const arg = { file_id, sheet_id, row, col, value_type };
  if (value_type === 'FORMULA') arg.formula = String(value);
  else if (value_type === 'NUMBER') arg.number_value = Number(value);
  else arg.string_value = String(value);
  const r = await callTool('sheet.set_cell_value', arg, cookie);
  return r.parsed;
}

// 设置单元格样式（style 含 start_row/start_col/end_row/end_col + 样式字段）
async function setCellStyle(file_id, sheet_id, style, cookie) {
  const r = await callTool('sheet.set_cell_style', Object.assign({ file_id, sheet_id }, style), cookie);
  return r.parsed;
}

// 冻结行列（row_count/col_count 传 0 取消冻结）
async function setFreeze(file_id, sheet_id, row_count, col_count, cookie) {
  const r = await callTool('sheet.set_freeze', {
    file_id, sheet_id, row_count: row_count || 0, col_count: col_count || 0,
  }, cookie);
  return r.parsed;
}

// 设置行列尺寸（dimensions: [{dimension_type:'row'|'col', index, size}]）
async function setDimensionSize(file_id, sheet_id, dimensions, cookie) {
  const r = await callTool('sheet.set_dimension_size', { file_id, sheet_id, dimensions }, cookie);
  return r.parsed;
}

// 重命名子表（name ≤31 字）
async function renameSheet(file_id, sheet_id, name, cookie) {
  const r = await callTool('sheet.rename_sheet', { file_id, sheet_id, name }, cookie);
  return r.parsed;
}

// 新增一个子表（tab），返回 { sheet_id, title }
async function addSheet(file_id, name, index, cookie) {
  const args = { file_id, name };
  if (index != null) args.index = index;
  const r = await callTool('sheet.add_sheet', args, cookie);
  let sid = dig(r.parsed, 'sheet_id', 'sheetId', 'id');
  if (!sid) {
    // 兜底：重新拉取子表列表，按名字匹配
    try {
      const sheets = await getSheetInfo(file_id, cookie);
      const hit = sheets.find((s) => s.title === name);
      if (hit) sid = hit.sheet_id;
    } catch (e) { /* ignore */ }
  }
  return { sheet_id: sid, title: name };
}

// 合并单元格（best-effort：部分 MCP 端点可能不支持或参数结构不同，调用方需 try/catch 兜底）
async function mergeCells(file_id, sheet_id, ranges, cookie) {
  const r = await callTool('sheet.merge_cells', { file_id, sheet_id, ranges }, cookie);
  return r.parsed;
}

// 上传图片到腾讯文档云（返回 image_id，有效期 1 天）
async function uploadImage(image_base64, file_name, cookie) {
  const r = await callTool('upload_image', { image_base64, file_name }, cookie);
  const imgId = dig(r.parsed, 'image_id', 'imageId', 'id');
  return imgId;
}

// 在表格单元格插入图片（base64 或 image_id 二选一）
async function insertImage(file_id, sheet_id, row_index, col_index, opts, cookie) {
  const args = { file_id, sheet_id, row_index, col_index };
  if (opts && opts.image_id) args.image_id = opts.image_id;
  if (opts && opts.content) args.content = opts.content;
  const r = await callTool('sheet.insert_image', args, cookie);
  return r.parsed;
}

// ============ sheet-mcp 精细编辑端点（条件格式 / 批量公式）============
// 说明：条件格式(add_conditional_format)与「批量写公式的 set_range_value」仅在
//   https://docs.qq.com/api/v6/sheet/mcp 暴露；该端点工具名【不带 sheet. 前缀】，
//   且参数结构与 openapi/mcp 不同（如 set_range_value 用 values[row,col,...] 而非 range）。
//   统一 token 相同，同一 file_id 跨端点通用。
const SHEET_MCP_URL = process.env.TENCENT_DOCS_SHEET_MCP_URL || 'https://docs.qq.com/api/v6/sheet/mcp';
function smcpRaw(body) {
  return new Promise((resolve, reject) => {
    if (!TOKEN()) return reject(new Error('TENCENT_DOCS_MCP_TOKEN 未配置'));
    let url;
    try { url = new URL(SHEET_MCP_URL); } catch (e) { return reject(e); }
    const payload = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': TOKEN(),
      'Content-Length': Buffer.byteLength(payload),
    };
    const req = https.request({ hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, method: 'POST', headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        const m = buf.match(/data:\s*(\{[\s\S]*\})/);
        const text = m ? m[1] : buf;
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('sheet-mcp 响应解析失败: ' + buf.slice(0, 400))); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
async function smcpCall(name, args) {
  await smcpRaw({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'vo-backend', version: '1.0' } } });
  const r = await smcpRaw({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args || {} } });
  const body = r;
  if (body.error) throw new Error(`sheet-mcp ${name} error: ${JSON.stringify(body.error)}`);
  const result = (body.result && body.result.content) || [];
  const texts = result.filter((c) => c.type === 'text').map((c) => c.text || '');
  const raw = texts.join('');
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { parsed = { _raw: raw }; }
  return parsed;
}

// 批量写单元格（支持 value_type:'FORMULA'）。values: [{row,col,value_type,string_value|number_value|formula}]
// 注意：openapi/mcp 的 set_range_value 会丢弃 FORMULA，公式必须走本函数（sheet-mcp 端点）。
async function setRangeValueSmcp(file_id, sheet_id, values) {
  return smcpCall('set_range_value', { file_id, sheet_id, values });
}
// 添加条件格式规则（rule 形如 {type:'CF_CELL_IS', cell_is:{operator,formulas}, style:{bg_color:'#RRGGBB',font_color:'#RRGGBB',bold}}）
async function addConditionalFormat(file_id, sheet_id, ranges, rule) {
  return smcpCall('add_conditional_format', { file_id, sheet_id, ranges, rule });
}
// 清空某子表全部条件格式（重建前清旧规则用）
async function removeAllConditionalFormat(file_id, sheet_id) {
  return smcpCall('remove_conditional_format', { file_id, sheet_id, is_remove_all: true });
}

module.exports = {
  rawRequest, openSession, callTool, dig,
  createSmartSheet, listTables, addTable, addFields, addRecords, deleteTable, setPrivilege, deleteFile,
  createSheet, getSheetInfo, setRangeValue, setCellValue, setCellStyle, setFreeze, setDimensionSize, renameSheet, addSheet, mergeCells,
  uploadImage, insertImage,
  SHEET_MCP_URL, smcpCall, setRangeValueSmcp, addConditionalFormat, removeAllConditionalFormat,
  setEnterpriseDocEditors,
};
