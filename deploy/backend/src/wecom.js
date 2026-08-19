// src/wecom.js
// 企业微信 · 智能表格（smartsheet）API 客户端
// 文档：https://developer.work.weixin.qq.com/document/path/97392
// 鉴权：corpid + corpsecret 服务端换 access_token（无需 OAuth 回调）
// 前缀：/cgi-bin/wedoc/  (智能表格推荐入口，替代已废弃的 /smartdoc)

const WECOM_API = 'https://qyapi.weixin.qq.com/cgi-bin';

let _token = null;
let _tokenExpire = 0;

// 获取并缓存 access_token（有效期 7200s，提前 60s 刷新）
async function getToken() {
  const now = Date.now();
  if (_token && now < _tokenExpire - 60000) return _token;

  const corpid = process.env.WECOM_CORPID;
  const secret = process.env.WECOM_CORPSECRET;
  if (!corpid || !secret) {
    throw new Error('缺少环境变量 WECOM_CORPID / WECOM_CORPSECRET，无法调用企业微信');
  }
  const url = `${WECOM_API}/gettoken?corpid=${encodeURIComponent(corpid)}&corpsecret=${encodeURIComponent(secret)}`;
  const r = await fetch(url);
  const j = await r.json();
  if (j.errcode !== 0) {
    throw new Error(`WeCom gettoken 失败: ${j.errcode} ${j.errmsg}`);
  }
  _token = j.access_token;
  _tokenExpire = now + (j.expires_in || 7200) * 1000;
  return _token;
}

// 通用 POST 到 wedoc 系列接口（自动带 token，统一 errcode 校验）
async function post(path, body) {
  const token = await getToken();
  const url = `${WECOM_API}/wedoc/${path}?access_token=${token}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.errcode !== 0) {
    const e = new Error(`WeCom ${path} 失败: ${j.errcode} ${j.errmsg}`);
    e.errcode = j.errcode;
    throw e;
  }
  return j;
}

// 新建智能表格文档（doc_type=10）。返回 { docid, url }
// admin_users: 企业微信账号ID数组，建文档时指定归属，否则文档“找不到”
async function createSmartsheet(docName, adminUsers = []) {
  const j = await post('create_doc', { doc_type: 10, doc_name: docName, admin_users: adminUsers });
  return { docid: j.docid, url: j.url };
}

// 列出子表（工作表）。返回 [{sheet_id, title, ...}]
async function getSheets(docid) {
  const j = await post('smartsheet/get_sheet', { docid });
  return j.sheets || [];
}

// 新增子表（tab）。返回 sheet_id
async function addSheet(docid, title) {
  const j = await post('smartsheet/add_sheet', { docid, properties: { title } });
  return j.sheet_id || (j.sheet && j.sheet.sheet_id);
}

// 查询子表字段。返回 [{field_id, field_title, field_type, ...}]
async function getFields(docid, sheetId) {
  const j = await post('smartsheet/get_fields', { docid, sheet_id: sheetId });
  return j.fields || [];
}

// 重命名字段（只能改名，不能改类型）。用于把默认字段改名为我们的第一个字段
async function updateFields(docid, sheetId, fields) {
  return post('smartsheet/update_fields', { docid, sheet_id: sheetId, fields });
}

// 新增字段。fields: [{field_title, field_type, options?}]
async function addFields(docid, sheetId, fields) {
  return post('smartsheet/add_fields', { docid, sheet_id: sheetId, fields });
}

// 新增记录。records: [{values: {字段标题: [{type:'text', text:'...'}]}}]
// key_type=FIELD_TITLE 表示用字段标题做 key（字段标题唯一）
async function addRecords(docid, sheetId, records) {
  return post('smartsheet/add_records', {
    docid, sheet_id: sheetId,
    key_type: 'CELL_VALUE_KEY_TYPE_FIELD_TITLE',
    records,
  });
}

// 更新记录（用于回写声优等自动列）。records: [{record_id, values:{...}}]
async function updateRecords(docid, sheetId, records) {
  return post('smartsheet/update_records', {
    docid, sheet_id: sheetId,
    key_type: 'CELL_VALUE_KEY_TYPE_FIELD_TITLE',
    records,
  });
}

// 查询记录（支持分页 cursor/limit）。返回 {records, ...}
async function getRecords(docid, sheetId, opts = {}) {
  const body = { docid, sheet_id: sheetId };
  if (opts.limit) body.limit = opts.limit;
  if (opts.cursor) body.cursor = opts.cursor;
  return post('smartsheet/get_records', body);
}

// 分享文档给成员（可编辑）。
// 注：企业微信文档权限接口的精确路径需在联调时按官方文档确认；
// 这里以 modify_doc_member 为占位实现，联调若报路径错误再校正。
async function shareDoc(docid, userids, perm = 'edit') {
  return post('modify_doc_member', {
    docid,
    perm,
    members: (userids || []).map((u) => ({ userid: u, auth: perm === 'edit' ? 2 : 1 })),
  });
}

// 从单元格值数组里取文本：[{type,text}] -> text
function cellText(v) {
  if (Array.isArray(v) && v.length && v[0] && v[0].text != null) return String(v[0].text);
  if (v == null) return '';
  return String(v);
}

module.exports = {
  getToken, post,
  createSmartsheet, getSheets, addSheet, getFields,
  updateFields, addFields, addRecords, updateRecords, getRecords,
  shareDoc, cellText,
};
