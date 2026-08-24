'use strict';
// 台词表 v6 配方薄层：只负责文档/Tab命名与兼容导出。
// 模板列、范围、公式的唯一真源：src/script_table_template.js。
const template = require('./src/script_table_template');

function cleanDemandName(value) {
  return String(value || '')
    .replace(/[《》|/\\]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}
function docTitle(demand) {
  const rel = demand.release_plan || demand.release || '';
  const name = cleanDemandName(demand.task_name);
  return `《台词表·${rel}·${name}》`;
}
function tabName(demand) {
  let name = cleanDemandName(demand.task_name);
  if (name.length > 26) name = name.slice(0, 26) + '…';
  return name || String(demand.id);
}
function buildRecipeV6({ demand }) {
  if (!demand || !demand.id || !demand.task_name) {
    throw new Error('buildRecipeV6 requires demand{id,task_name,...}');
  }
  const title = docTitle(demand);
  const tab = tabName(demand);
  return {
    kind: 'full',
    template,
    _summary: {
      demand_id: demand.id,
      task_name: demand.task_name,
      area: demand.area,
      release: demand.release_plan || demand.release,
      doc_title: title,
      tab_name: tab,
      stat_col_count: template.STAT.columns.length,
      line_col_count: template.LINE.columns.length,
    },
  };
}
function makeRowNo(demandId, idxWithinTab) {
  return `${demandId}-${String(idxWithinTab).padStart(3, '0')}`;
}
function deriveVoiceActors(roleCn, rosterOrVoiceRoles) {
  if (!roleCn) return { cn_va: '', en_va: '' };
  const target = String(roleCn).trim();
  const hit = (rosterOrVoiceRoles || []).find((r) => String(r.role_cn || '').trim() === target);
  return { cn_va: (hit && hit.cn_va) || '', en_va: (hit && hit.en_va) || '' };
}

module.exports = {
  buildRecipeV6,
  docTitle,
  tabName,
  cleanDemandName,
  makeRowNo,
  deriveVoiceActors,
  template,
};
