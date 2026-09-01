'use strict';

// Vomi 台词表 v6 模板唯一真源。
// 修改列结构、范围、标题、公式时只改本文件；执行器与测试均从这里读取。
const LINES_PER_CHUNK = 20;
const DATA_ROWS = 500;

const STAT = Object.freeze({
  name: '【需求统计】',
  columns: Object.freeze([
    { key: 'category', title: '大类', width: 100 },
    { key: 'role', title: '游戏角色（中）', width: 220 },
    { key: 'estimate', title: '预估句数\n文案填', width: 220 },
    { key: 'actual', title: '实际句数\n系统自动计算·每20字为一句', width: 220 },
    { key: 'separator', title: '', width: 100 },
    { key: 'new_category', title: '大类', width: 100 },
    { key: 'new_role', title: '新增-游戏角色（中）', width: 220 },
    { key: 'new_estimate', title: '预估句数\n文案填', width: 220 },
    { key: 'new_actual', title: '实际句数\n系统自动计算·每20字为一句', width: 220 },
  ]),
  existingLabel: '已有声优',
  newLabel: '新建声优',
  dataStartRow: 3,
  validationRoleColumns: Object.freeze(['B', 'G']),
});

const LINE = Object.freeze({
  columns: Object.freeze([
    { key: 'no', title: 'NO.序号', subtitle: '', width: 70 },
    { key: 'role', title: '游戏角色名', subtitle: '(须与「需求统计」页游戏角色（中）保持一致)', width: 150 },
    { key: 'text_cn', title: '台词-中', subtitle: '', width: 300 },
    { key: 'text_en', title: '台词-英 Lines', subtitle: '', width: 300 },
    { key: 'emotion', title: '情绪', subtitle: '', width: 80 },
    { key: 'trigger', title: '触发条件', subtitle: '', width: 150 },
    { key: 'audio_file', title: 'GP Audio Event/音频文件名', subtitle: '', width: 200 },
    { key: 'remark', title: '备注信息', subtitle: '', width: 200 },
    { key: 'av_sync', title: '音画同步', subtitle: '', width: 110 },
    { key: 'sentence_count', title: '句数统计', subtitle: '系统自动统计｜读取C列·每20字一句', width: 110 },
    { key: 'role_validation', title: '角色校验', subtitle: '不在需求统计页→请在对应页补行或到系统提交声优', width: 300 },
  ]),
  dataStartRow: 3,
  dataRows: DATA_ROWS,
  totalRows: 2 + DATA_ROWS,
});

function lineColumnIndex(key) {
  const index = LINE.columns.findIndex((column) => column.key === key);
  if (index < 0) throw new Error(`Unknown LINE column: ${key}`);
  return index;
}
function columnLetter(zeroBasedIndex) {
  if (!Number.isSafeInteger(zeroBasedIndex) || zeroBasedIndex < 0) {
    throw new Error(`Invalid column index: ${zeroBasedIndex}`);
  }
  let value = zeroBasedIndex + 1;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

const INDEX = Object.freeze({
  avSync: lineColumnIndex('av_sync'),
  sentence: lineColumnIndex('sentence_count'),
  validation: lineColumnIndex('role_validation'),
});

function escapeSheetName(name) {
  return String(name == null ? '' : name).replace(/'/g, "''");
}
function quoteSheetName(name) {
  return `'${escapeSheetName(name)}'`;
}
function lineSentenceFormula(oneBasedRow) {
  return `=ROUNDUP(LEN(C${oneBasedRow})/${LINES_PER_CHUNK},0)`;
}
function roleValidationFormula(oneBasedRow) {
  const end = STAT.dataStartRow + DATA_ROWS - 1;
  return `=IF(AND($B${oneBasedRow}<>"",COUNTIF('${escapeSheetName(STAT.name)}'!$B$${STAT.dataStartRow}:$B$${end},$B${oneBasedRow})=0,COUNTIF('${escapeSheetName(STAT.name)}'!$G$${STAT.dataStartRow}:$G$${end},$B${oneBasedRow})=0),"⚠ 该角色不在「需求统计」页（已有B列/新建G列），请到系统提交声优信息或在对应页补行","")`;
}
function statActualFormula(tabName, roleColumn, oneBasedRow) {
  const tab = quoteSheetName(tabName);
  const lineEnd = LINE.dataStartRow + DATA_ROWS - 1;
  return `=IF(${roleColumn}${oneBasedRow}="","",ROUNDUP(SUMPRODUCT((${tab}!$B$${LINE.dataStartRow}:$B$${lineEnd}=${roleColumn}${oneBasedRow})*LEN(${tab}!$C$${LINE.dataStartRow}:$C$${lineEnd}))/${LINES_PER_CHUNK},0))`;
}

module.exports = {
  LINES_PER_CHUNK,
  DATA_ROWS,
  STAT,
  LINE,
  INDEX,
  lineColumnIndex,
  columnLetter,
  escapeSheetName,
  quoteSheetName,
  lineSentenceFormula,
  roleValidationFormula,
  statActualFormula,
};
