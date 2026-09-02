'use strict';
// 角色名（role_cn / role_en）括号闭合校验。
//
// 背景（2026-09-02）：docx 解析器的旧切分正则把
//   `克劳斯·阿德勒 (Klaus Adler) 代号“钟表匠”`
// 切成 role_cn=`克劳斯·阿德勒 (Klaus` + role_en=`Klaus Adler)` 并落库。
// 后果：前端 loadRoster 按 role_cn 合并「静态 roster.json + DB」时，脏值与干净值
// trim 后键不一致 —— 脏行匹配不上 DB 被原样保留，DB 的干净版又被当成新角色 append，
// 同一角色在表里渲染出两条。
//
// 本模块在后端三个写入口（POST upsert / PATCH / bulk）统一拦截，
// 让任何渠道（前端 inline edit、草稿回写、批量导入、脚本直连）的半截括号名都进不了库。
//
// 注意：只拦「不平衡」，不拦「含括号」。
// Luna (Lara)、Twins (Haddawi、Tokamak)、SOL-GTI指挥官 等合法名必须放行。

// 半角 + 全角括号
const OPEN_RE = /[(（]/g;
const CLOSE_RE = /[)）]/g;

/**
 * 校验角色名括号是否闭合。
 * @param {unknown} name 待校验值（非字符串/空值直接放行，交给必填校验处理）
 * @param {string} [field='role_cn'] 字段名，用于错误信息定位
 * @returns {null | {ok:false,error:string,field:string,open:number,close:number,value:string}}
 *   闭合（或无需校验）返回 null；不平衡返回可直接作为 400 响应体的对象。
 */
function assertRoleNameBalanced(name, field = 'role_cn') {
  if (typeof name !== 'string' || !name) return null;
  const open = (name.match(OPEN_RE) || []).length;
  const close = (name.match(CLOSE_RE) || []).length;
  if (open === close) return null;
  return {
    ok: false,
    error: `${field}_unbalanced_brackets`,
    field,
    open,
    close,
    value: name
  };
}

module.exports = { assertRoleNameBalanced };
