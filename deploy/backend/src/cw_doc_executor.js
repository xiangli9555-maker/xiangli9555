'use strict';
// cw_doc_executor.js — CVM 端「台词表」建表执行器（v6：每需求 1 份普通在线表格，含 2~3 个固定子表）
// 不依赖 AI 会话 / 企业版 AccessToken：直连腾讯文档个人版 MCP（cw_mcp_client）。
//
// 文档结构（每需求 1 份）：
//   ├─ Tab1【需求统计】   ← 9 列 v2：已有声优 A-D(大类|游戏角色中|预估句数|实际句数) | E间隔 | 新建声优 F-I(大类|新增游戏角色中|预估句数|实际句数)
//   │                      第一行合并标签(已有声优/新建声优)，第二行表头，冻结至第二行；FGHI 品牌黄标记新建分区
//   │                      预估句数 留空（文案手动填）；实际句数(D/I) 写 SUMPRODUCT+LEN 公式：按 Tab2 游戏角色名匹配，累加台词-中字符数，每 20 字一句
//   └─ Tab2<需求名>       ← 台词表 v2（11 列，两行表头：主标题绿底 + 8pt 小字说明，冻结至第 2 行）
//                          B=游戏角色名(小字须与需求统计页一致)，C=台词-中，G=音频文件名
//                          I=音画同步下拉，J=句数统计，K=角色校验（检查Tab1 B/G，覆盖500行）
//
// 流程：
//   1) manage.create_file  → 建普通在线表格（file_type:'sheet'，自带 1 个默认子表）
//   2) sheet.get_sheet_info → 取默认子表（作为 Tab1）
//   3) 写 Tab1【需求统计】表头+数据 → 改名列 → 样式/冻结/列宽
//   4) sheet.add_sheet     → 新增 Tab2（台词表）
//   5) 写 Tab2 v2 两行表头 → 样式/冻结/列宽/下拉/数字与日期格式
//   6) 写 Tab1 实际句数 COUNTIF 公式（必须在 Tab2 建好之后）
//   7) manage.set_privilege → 权限设「所有人可编辑」(policy=3)

const fs = require('fs');
const path = require('path');
const mcp = require('./cw_mcp_client');
const recipe = require('../cw_doc_recipe_v6');
const pool = require('./db');
const tableTemplate = require('./script_table_template');

// 声优库真源：优先读后端 voice_roles 表（实时，含声优库页「保存到系统」回写的编辑），
// 失败或为空时回退到 roster.json 静态文件。
// 字段映射：DB 用 module / cn_loc / en_loc，roster 形状用 category / cn_location / en_location。
async function loadRoster() {
  try {
    const [rows] = await pool.query(
      `SELECT id,
              module          AS category,
              role_cn,
              role_en,
              gender,
              cn_va,
              cn_loc         AS cn_location,
              cn_studio,
              en_va,
              en_loc         AS en_location,
              en_studio
       FROM voice_roles
       WHERE (is_deleted = 0 OR is_deleted IS NULL)
       ORDER BY id`
    );
    if (Array.isArray(rows) && rows.length) return rows;
  } catch (e) {
    console.warn('[cw] loadRoster 读 DB 失败，回退 roster.json:', e.message);
  }
  const p = path.join(__dirname, '..', 'roster.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return raw.roster || raw;
}

// 台词表模板结构统一从 script_table_template.js 读取，禁止在执行器重复定义列结构。
const LINE_COL_WIDTHS = tableTemplate.LINE.columns.map((c) => c.width);
const AV_CHOICE_COL = tableTemplate.INDEX.avSync;
const LINE_V2_MAIN = tableTemplate.LINE.columns.map((c) => c.title);
const LINE_V2_SUB = tableTemplate.LINE.columns.map((c) => c.subtitle || '');
const LINE_V2_COL_WIDTHS = LINE_COL_WIDTHS;
const COL_ROLE = tableTemplate.lineColumnIndex('role');
const COL_TEXT_CN = tableTemplate.lineColumnIndex('text_cn');
const COL_TEXT_EN = tableTemplate.lineColumnIndex('text_en');
const COL_EMOTION = tableTemplate.lineColumnIndex('emotion');
const COL_TRIGGER = tableTemplate.lineColumnIndex('trigger');
const COL_AUDIO_FILE = tableTemplate.lineColumnIndex('audio_file');
const COL_REMARK = tableTemplate.lineColumnIndex('remark');
const COL_SENTENCE = tableTemplate.INDEX.sentence;
const COL_VALID = tableTemplate.INDEX.validation;
const VALID_COL_LETTER = tableTemplate.columnLetter(COL_VALID);
const SUB_FONT_SIZE = 8;
const VALID_ROWS = tableTemplate.DATA_ROWS;
const SENTENCE_FORMULA = tableTemplate.lineSentenceFormula;
const VALID_FORMULA = tableTemplate.roleValidationFormula;
const VALID_HINT_PREFIX = '⚠';
const STAT_V2_COL_WIDTHS = tableTemplate.STAT.columns.map((c) => c.width);
const COL_A = 0, COL_B = 1, COL_C = 2, COL_D = 3, COL_E = 4, COL_F = 5, COL_G = 6, COL_H = 7, COL_I = 8;
const STAT_V2_HEADERS = tableTemplate.STAT.columns.map((c) => c.title);
const STAT_V2_LABEL_EXISTING = tableTemplate.STAT.existingLabel;
const STAT_V2_LABEL_NEW = tableTemplate.STAT.newLabel;
const STAT_HEADER_ROW_HEIGHT = 36;
const STAT_LABEL_ROW_HEIGHT = 32;
const BRAND_YELLOW = 'FFF4CF67';
const BRAND_YELLOW_SOFT = 'FFFDF3D6';
const BRAND_GREEN = 'FF0FF796';
const SEP_FILL = 'FFF2F4F6';
const LINES_PER_CHUNK = tableTemplate.LINES_PER_CHUNK;

// 第二页「角色校验」列（K / index 10）逻辑见下方 generateForDemand 的 5b 段；
// 公式 VALID_FORMULA + 条件格式（contains_text '⚠' → 红底红字），常量已并入上方 v2 块。

// 取本需求的角色行（大类 + 游戏角色（中）），按声优库顺序归组。
// 角色来源优先级：
//   1) demand.voice_estimates 非空 → 以它为准（已精确配过角色的需求，保持原逻辑不破坏）；
//   2) voice_estimates 为空 → 回退到「整个声优库全部未删除角色」（含待选角），全量灌入 Tab1。
//      这样只要录入系统的角色都会出现在台词表【需求统计】，不会因为没配 voice_estimates 而漏掉。
function buildStatRows(demand, roster) {
  const rosterIndex = new Map();
  roster.forEach((r, i) => { if (r.role_cn) rosterIndex.set(r.role_cn, i); });
  // Tab1 固定拉取声优库全部未删除角色；voice_estimates 不再决定角色范围。
  const rows = roster.filter((r) => r && r.role_cn).map((r) => [r.category || '', r.role_cn]);
  // 去重（同一角色名只保留一行），声优库内角色按原序归组，库外角色排末尾
  const seen = new Set();
  const dedup = rows.filter((row) => {
    const key = row[1];
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  dedup.sort((a, b) => {
    const ia = rosterIndex.has(a[1]) ? rosterIndex.get(a[1]) : 1e9;
    const ib = rosterIndex.has(b[1]) ? rosterIndex.get(b[1]) : 1e9;
    return ia - ib;
  });
  return dedup;
}

// 解析台词表「可编辑成员」：文案策划(cn_lines_handler) + PM(owner)。
// 返回企业微信 userid 列表。英文名/工号(疑似 userid)直接采用；中文名等按 DOC_EDITOR_USERID_MAP 映射；
// 仍未命中则丢弃（交由 OA 侧按名称解析或人工补映射）。映射表格式：{"张三":"zhangsan","李四":"lisi"}
function resolveDocEditors(demand) {
  const raw = [];
  if (demand && demand.cn_lines_handler) {
    const v = String(demand.cn_lines_handler).trim();
    if (v && !raw.includes(v)) raw.push(v);
  }
  if (demand && demand.owner) {
    const v = String(demand.owner).trim();
    if (v && !raw.includes(v)) raw.push(v);
  }
  let map = {};
  try { if (process.env.DOC_EDITOR_USERID_MAP) map = JSON.parse(process.env.DOC_EDITOR_USERID_MAP); } catch (e) { /* ignore */ }
  const out = [];
  for (const v of raw) {
    if (!v) continue;
    if (map[v]) { if (!out.includes(map[v])) out.push(map[v]); continue; }
    if (/^[A-Za-z0-9_-]+$/.test(v)) { if (!out.includes(v)) out.push(v); continue; } // 疑似 userid/英文名，直接采用
    if (map['*name'] === 'keep') { if (!out.includes(v)) out.push(v); } // 显式要求保留原名
  }
  return out;
}

// 写一个子表：表头(row0) + 数据行，并加表头样式/冻结首行/设列宽
async function writeSheet(file_id, sheet_id, headers, dataRows, widths, cookie) {
  const values = [];
  headers.forEach((h, c) => values.push({ row: 0, col: c, value_type: 'STRING', string_value: String(h) }));
  (dataRows || []).forEach((row, r) => {
    row.forEach((val, c) => {
      if (val === '' || val == null) return;
      const isNum = typeof val === 'number' && isFinite(val);
      values.push({
        row: r + 1, col: c,
        value_type: isNum ? 'NUMBER' : 'STRING',
        ...(isNum ? { number_value: val } : { string_value: String(val) }),
      });
    });
  });
  if (values.length) await mcp.setRangeValue(file_id, sheet_id, values, cookie);

  // 表头样式：加粗 + 绿底 + 居中 + 自动换行
  await mcp.setCellStyle(file_id, sheet_id, {
    start_row: 0, start_col: 0,
    end_row: 0, end_col: headers.length - 1,
    bold: true,
    font_color: 'FF0F171C',
    bg_color: 'FF0FF796',
    horizontal_align: 'center',
    vertical_align: 'center',
    wrap_text: true,
  }, cookie);

  // 冻结首行
  await mcp.setFreeze(file_id, sheet_id, 1, 0, cookie);

  // 表头行高（容纳两行文字：主标题 + 说明小字）
  if (STAT_HEADER_ROW_HEIGHT) {
    try {
      await mcp.setDimensionSize(file_id, sheet_id, [{ dimension_type: 'row', index: 0, size: STAT_HEADER_ROW_HEIGHT }], cookie);
    } catch (e) { console.warn('[cw] 设置表头行高失败(忽略):', e.message); }
  }

  // 列宽
  const dimensions = (widths || []).slice(0, headers.length).map((size, index) => ({
    dimension_type: 'col', index, size,
  }));
  if (dimensions.length) await mcp.setDimensionSize(file_id, sheet_id, dimensions, cookie);
}

// 写 Tab1【需求统计】v2（9 列结构）：已有声优 A-D | 间隔 E | 新建声优 F-I。
// 第 1 行合并标签(已有声优/新建声优)，第 2 行表头，冻结至第 2 行；FGHI 品牌黄标记新建分区。
// 实际句数(D/I) 写 SUMPRODUCT+LEN 公式：按 Tab2「游戏角色名」(B 列) 匹配，累加「台词-中」(C 列) 字符数，每 20 字一句。
// 必须在 Tab2 建好之后调用（公式引用 Tab2）。
async function writeStatSheetV2(file_id, sheet_id, demand, roster, tab, cookie) {
  const pairs = buildStatRows(demand, roster); // [[大类, 游戏角色（中）], ...]
  const n = pairs.length;

  // —— 第 1 行标签（合并 A-D / F-I，best-effort）——
  await mcp.setCellValue(file_id, sheet_id, 0, COL_A, 'STRING', STAT_V2_LABEL_EXISTING, cookie);
  await mcp.setCellValue(file_id, sheet_id, 0, COL_F, 'STRING', STAT_V2_LABEL_NEW, cookie);
  // 注：sheet.merge_cells 未在腾讯文档 MCP 注册（调用必然报 -32601），
  //   保留只会白烧一个请求并推高 WAF 触发概率；标签靠单元格溢出显示已足够。


  // —— 第 2 行表头 ——
  const headVals = [];
  STAT_V2_HEADERS.forEach((h, c) => {
    if (h === '') return;
    headVals.push({ row: 1, col: c, value_type: 'STRING', string_value: String(h) });
  });
  if (headVals.length) await mcp.setRangeValue(file_id, sheet_id, headVals, cookie);

  // —— 数据行：A/B=已有角色（来自声优库），C/E/F/G/H 留空（文案/新建手动填）——
  const dataVals = [];
  for (let i = 0; i < n; i++) {
    const r = i + 2; // 0-based 数据行（row0 标签, row1 表头）
    const cn = pairs[i][1] || '';
    const cat = pairs[i][0] || '';
    dataVals.push({ row: r, col: COL_A, value_type: 'STRING', string_value: String(cat) });
    dataVals.push({ row: r, col: COL_B, value_type: 'STRING', string_value: String(cn) });
  }
  if (dataVals.length) await mcp.setRangeValue(file_id, sheet_id, dataVals, cookie);

  // —— D / I 实际句数公式（批量，sheet-mcp 端点支持 FORMULA）——
  const dVals = [], iVals = [];
  for (let i = 0; i < n; i++) {
    const r = i + 2;
    const dFormula = tableTemplate.statActualFormula(tab, 'B', r + 1);
    const iFormula = tableTemplate.statActualFormula(tab, 'G', r + 1);
    dVals.push({ row: r, col: COL_D, value_type: 'FORMULA', formula: dFormula });
    iVals.push({ row: r, col: COL_I, value_type: 'FORMULA', formula: iFormula });
  }
  // D / I 两列合并为单次批量写入（同一子表，sheet-mcp 端点 values 支持混合列），减少请求量规避 WAF
  const diVals = dVals.concat(iVals);
  if (diVals.length) await mcp.setRangeValueSmcp(file_id, sheet_id, diVals);

  // —— 样式 ——
  // 标签行：已有=绿，新建=品牌黄
  await mcp.setCellStyle(file_id, sheet_id, { start_row: 0, start_col: COL_A, end_row: 0, end_col: COL_D, bold: true, font_color: 'FF0F171C', bg_color: BRAND_GREEN, horizontal_align: 'center', vertical_align: 'center' }, cookie);
  await mcp.setCellStyle(file_id, sheet_id, { start_row: 0, start_col: COL_F, end_row: 0, end_col: COL_I, bold: true, font_color: 'FF1B2526', bg_color: BRAND_YELLOW, horizontal_align: 'center', vertical_align: 'center' }, cookie);
  // 表头行：A-D 绿，F-I 品牌黄
  await mcp.setCellStyle(file_id, sheet_id, { start_row: 1, start_col: COL_A, end_row: 1, end_col: COL_D, bold: true, font_color: 'FF0F171C', bg_color: BRAND_GREEN, horizontal_align: 'center', vertical_align: 'center', wrap_text: true }, cookie);
  await mcp.setCellStyle(file_id, sheet_id, { start_row: 1, start_col: COL_F, end_row: 1, end_col: COL_I, bold: true, font_color: 'FF1B2526', bg_color: BRAND_YELLOW, horizontal_align: 'center', vertical_align: 'center', wrap_text: true }, cookie);
  // 间隔列 E 浅灰
  await mcp.setCellStyle(file_id, sheet_id, { start_row: 0, start_col: COL_E, end_row: Math.max(n + 1, 20), end_col: COL_E, bg_color: SEP_FILL }, cookie);
  // 新建分区数据区浅黄（F-I，row2 起）
  if (n > 0) await mcp.setCellStyle(file_id, sheet_id, { start_row: 2, start_col: COL_F, end_row: 1 + n, end_col: COL_I, bg_color: BRAND_YELLOW_SOFT }, cookie);
  // 数据区垂直居中
  if (n > 0) await mcp.setCellStyle(file_id, sheet_id, { start_row: 2, start_col: COL_A, end_row: 1 + n, end_col: COL_I, vertical_align: 'center' }, cookie);

  // —— 行高 + 列宽（合并为单次 setDimensionSize，3 请求 → 1，降低 WAF 触发概率）——
  const dimensions = [
    { dimension_type: 'row', index: 0, size: STAT_LABEL_ROW_HEIGHT },
    { dimension_type: 'row', index: 1, size: STAT_HEADER_ROW_HEIGHT },
  ].concat(STAT_V2_COL_WIDTHS.map((size, index) => ({ dimension_type: 'col', index, size })));
  try { await mcp.setDimensionSize(file_id, sheet_id, dimensions, cookie); } catch (e) {}

  // —— 冻结至第 2 行（标签行 + 表头行）——
  await mcp.setFreeze(file_id, sheet_id, 2, 0, cookie);
}

// 写 Tab2 台词表 v2（11 列）：两行表头（第 0 行主标题绿底 / 第 1 行 8pt 小字说明），冻结至第 2 行；
// 列宽按 LINE_V2_COL_WIDTHS。J(句数统计)/K(角色校验) 的公式与条件格式在 generateForDemand 5b 写入。
// 数据行从 0-based row=2（第 3 行）起，前两行为表头。
async function writeLineSheetV2(file_id, sheet_id, cookie) {
  const n = LINE_V2_MAIN.length; // 11
  // —— 两行表头（主标题 + 小字说明）——
  const headVals = [];
  for (let c = 0; c < n; c++) {
    if (LINE_V2_MAIN[c]) headVals.push({ row: 0, col: c, value_type: 'STRING', string_value: String(LINE_V2_MAIN[c]) });
    headVals.push({ row: 1, col: c, value_type: 'STRING', string_value: String(LINE_V2_SUB[c] || '') });
  }
  if (headVals.length) await mcp.setRangeValue(file_id, sheet_id, headVals, cookie);

  // —— 主标题行样式（绿底/加粗/居中/换行）——
  await mcp.setCellStyle(file_id, sheet_id, {
    start_row: 0, start_col: 0, end_row: 0, end_col: n - 1,
    bold: true, font_color: 'FF0F171C', bg_color: 'FF0FF796',
    horizontal_align: 'center', vertical_align: 'center', wrap_text: true,
  }, cookie);

  // —— 小字说明行样式（8pt / 浅底 / 居中 / 换行）；font_size 不支持单元格内分行号，故独立成行 ——
  try {
    await mcp.setCellStyle(file_id, sheet_id, {
      start_row: 1, start_col: 0, end_row: 1, end_col: n - 1,
      font_size: SUB_FONT_SIZE, font_color: 'FF656668', bg_color: 'FFEDF1F0',
      horizontal_align: 'center', vertical_align: 'center', wrap_text: true,
    }, cookie);
  } catch (e) {
    console.warn('[cw] Tab2 小字行 8pt 样式失败(回退默认字号):', e.message);
    try {
      await mcp.setCellStyle(file_id, sheet_id, {
        start_row: 1, start_col: 0, end_row: 1, end_col: n - 1,
        font_color: 'FF656668', bg_color: 'FFEDF1F0',
        horizontal_align: 'center', vertical_align: 'center', wrap_text: true,
      }, cookie);
    } catch (e2) { /* ignore */ }
  }

  // —— 冻结至第 2 行（两行表头均固定）——
  await mcp.setFreeze(file_id, sheet_id, 2, 0, cookie);

  // —— 两行表头行高 + 列宽（合并为单次 setDimensionSize，3 请求 → 1，降低 WAF 触发概率）——
  const dimensions = [
    { dimension_type: 'row', index: 0, size: 32 },
    { dimension_type: 'row', index: 1, size: 30 },
  ].concat(LINE_V2_COL_WIDTHS.map((size, index) => ({ dimension_type: 'col', index, size })));
  try { await mcp.setDimensionSize(file_id, sheet_id, dimensions, cookie); } catch (e) {}
}

// —— Lite 版写入：仅写核心数据，跳过全部样式/冻结/列宽/公式装饰，把单次生成 MCP 调用压到 ~10 次，规避腾讯 WAF 突发限流 ——
async function writeStatSheetV2Lite(file_id, sheet_id, demand, roster, tab, cookie) {
  const pairs = buildStatRows(demand, roster); // [[大类, 游戏角色（中）], ...]
  const n = pairs.length;
  const headVals = [];
  STAT_V2_HEADERS.forEach((h, c) => { if (h !== '') headVals.push({ row: 1, col: c, value_type: 'STRING', string_value: String(h) }); });
  if (headVals.length) await mcp.setRangeValue(file_id, sheet_id, headVals, cookie);
  const dataVals = [];
  for (let i = 0; i < n; i++) {
    const r = i + 2;
    dataVals.push({ row: r, col: COL_A, value_type: 'STRING', string_value: String(pairs[i][0] || '') });
    dataVals.push({ row: r, col: COL_B, value_type: 'STRING', string_value: String(pairs[i][1] || '') });
  }
  if (dataVals.length) await mcp.setRangeValue(file_id, sheet_id, dataVals, cookie);
  // D/I 实际句数公式（单包批量，1 次请求；平台不支持 FORMULA 则静默跳过，不影响聚合读取）
  try {
    const dVals = [], iVals = [];
    for (let i = 0; i < n; i++) {
      const r = i + 2;
      dVals.push({ row: r, col: COL_D, value_type: 'FORMULA', formula: tableTemplate.statActualFormula(tab, 'B', r + 1) });
      iVals.push({ row: r, col: COL_I, value_type: 'FORMULA', formula: tableTemplate.statActualFormula(tab, 'G', r + 1) });
    }
    const diVals = dVals.concat(iVals);
    if (diVals.length) await mcp.setRangeValueSmcp(file_id, sheet_id, diVals);
  } catch (e) { console.warn('[cw] lite D/I 公式跳过:', e.message); }
}

async function writeLineSheetV2Lite(file_id, sheet_id, cookie) {
  const n = LINE_V2_MAIN.length;
  const headVals = [];
  for (let c = 0; c < n; c++) {
    if (LINE_V2_MAIN[c]) headVals.push({ row: 0, col: c, value_type: 'STRING', string_value: String(LINE_V2_MAIN[c]) });
    headVals.push({ row: 1, col: c, value_type: 'STRING', string_value: String(LINE_V2_SUB[c] || '') });
  }
  if (headVals.length) await mcp.setRangeValue(file_id, sheet_id, headVals, cookie);

  // 扩行：新表默认约 200 行，公式需覆盖到 VALID_ROWS，先扩行（1 次 smcp 调用，失败不阻断）
  try {
    const need = tableTemplate.LINE.totalRows;
    const curRows = 200;
    if (curRows < need) {
      await mcp.smcpCall('insert_dimension', { file_id, sheet_id, dimension_type: 'row', index: curRows, count: need - curRows });
    }
  } catch (e) { console.warn('[cw] lite 扩行跳过:', e.message); }

  // 计算 / 统计公式（lite 模式下仍必须保留，否则台词表无统计能力）：
  //   A 序号 =ROW()-2；J 句数统计 =ROUNDUP(台词-中长度/20)；K 角色校验 = 角色不在统计页则 ⚠
  // 三列合并为单次 setRangeValueSmcp（sheet-mcp 端点，公式必需），规避 WAF 突发限流；
  // 条件格式红字为纯视觉、非计算，lite 跳过，待 WAF 解除后补。
  try {
    const aNumVals = [], sentVals = [], validVals = [];
    for (let ri = 2; ri < 2 + VALID_ROWS; ri++) {
      const one = ri + 1; // 1-based 数据行号（数据行从第 3 行起）
      aNumVals.push({ row: ri, col: 0, value_type: 'FORMULA', formula: '=ROW()-2' });
      sentVals.push({ row: ri, col: COL_SENTENCE, value_type: 'FORMULA', formula: SENTENCE_FORMULA(one) });
      validVals.push({ row: ri, col: COL_VALID, value_type: 'FORMULA', formula: VALID_FORMULA(one) });
    }
    if (aNumVals.length) await mcp.setRangeValueSmcp(file_id, sheet_id, aNumVals.concat(sentVals, validVals));
    console.log('[cw] lite Tab2 A/J/K 公式已写入（' + VALID_ROWS + ' 行）');
  } catch (e) { console.warn('[cw] lite Tab2 公式跳过:', e.message); }
}

// 为单个需求建一份台词表普通在线表格（含【需求统计】+ 台词表），返回 { file_id, url, tab }
async function generateForDemand(demand, opts = {}) {
  if (!demand || !demand.task_name) throw new Error('demand.task_name 缺失');
  const LITE = !!opts.lite;
  const roster = await loadRoster();
  const rec = recipe.buildRecipeV6({ WS: path.join(__dirname, '..'), demand, roster });
  const title = rec._summary.doc_title.slice(0, 36);
  // 台词表(第二页) v2 表头来自模板唯一真源（11 列）
  const headers = LINE_V2_MAIN;
  const tab = rec._summary.tab_name;

  // 需求统计(第一页) 数据在 writeStatSheetV2 中按 v2 9 列结构构建

  // 1) 建普通在线表格
  const created = await mcp.createSheet({ title });
  const file_id = created.file_id;
  const cookie = created.cookie;

  const warnings = [];   // 仅 cosmetic 问题；核心内容缺失则直接抛出 → 任务标记 failed 可重试
  let coreWritten = false; // 核心内容（Tab1+Tab2）已写入后置 true；lite/异常时避免把已写好的表误删回滚
  try {

  // 2) 取默认子表 → 作为 Tab1【需求统计】（核心，失败即整任务失败）
  const sheets = await mcp.getSheetInfo(file_id, cookie);
    const def = sheets[0];
    if (!def || !def.sheet_id) throw new Error('未获取到子表 ID');
    const statSheetId = def.sheet_id;

    // 3) Tab1 仅建好子表并改名；内容在 Tab2 建好后再写（公式需引用 Tab2）
    if (def.title !== '【需求统计】') {
      try { await mcp.renameSheet(file_id, statSheetId, '【需求统计】', cookie); }
      catch (e) { warnings.push('重命名【需求统计】子表: ' + e.message); }
    }

    // 4) 新增 Tab2（台词表）放在第二页
    const added = await mcp.addSheet(file_id, tab, 1, cookie);
    let lineSheetId = added.sheet_id;
    if (!lineSheetId) {
      const after = await mcp.getSheetInfo(file_id, cookie);
      const hit = after.find((s) => s.title === tab) || after[1];
      lineSheetId = hit && hit.sheet_id;
    }
    if (!lineSheetId) throw new Error('新增台词表子表失败');

    // 5) 写 Tab2 v2（两行表头：主标题绿底 + 8pt 小字说明，冻结至第 2 行）
    await (LITE ? writeLineSheetV2Lite(file_id, lineSheetId, cookie) : writeLineSheetV2(file_id, lineSheetId, cookie));

    // 5x) 写 Tab1【需求统计】v2（9 列结构 + 冻结至第 2 行 + D/I 实际句数公式，需引用本 Tab2）
    await (LITE ? writeStatSheetV2Lite(file_id, statSheetId, demand, roster, tab, cookie) : writeStatSheetV2(file_id, statSheetId, demand, roster, tab, cookie));
    coreWritten = true;

    // 普通表默认约 200 行；公式与角色校验覆盖到 VALID_ROWS（当前 500 行），先统一扩行。（lite 模式跳过，数据已写入不受扩行影响）
    if (!LITE) {
    try {
      const need = tableTemplate.LINE.totalRows;
      const sinfo = await mcp.smcpCall('get_sheet_info', { file_id });
      const srow = (sinfo.sheets || sinfo).find((s) => s.sheet_id === lineSheetId);
      const curRows = srow && srow.row_count ? srow.row_count : 200;
      if (curRows < need) {
        await mcp.smcpCall('insert_dimension', { file_id, sheet_id: lineSheetId, dimension_type: 'row', index: curRows, count: need - curRows });
      }
    } catch (e) { warnings.push('扩展行数: ' + e.message); }
    }

    // 5a) 文案填写辅助规则：音画同步单选 + 句数统计(数字格式)（lite 模式跳过）
    if (!LITE) {
    try {
      await mcp.smcpCall('set_data_validation', {
        file_id, sheet_id: lineSheetId, type: 'LIST',
        col_indexes: [{ start: AV_CHOICE_COL, end: AV_CHOICE_COL }], ignore_rows: 2,
        select_options: [
          { id: 'av-sync', text: '音画同步', text_color: '#6A5200', bg_color: '#F4CF67' },
          { id: 'no-video', text: '无需视频', text_color: '#4F5554', bg_color: '#D9DEDC' }
        ]
      });
      await mcp.smcpCall('set_cell_style', {
        file_id, sheet_id: lineSheetId,
        start_row: 2, end_row: 1 + VALID_ROWS,
        start_col: COL_SENTENCE, end_col: COL_SENTENCE,
        number_format_pattern: '0', horizontal_align: 'center'
      });
      await mcp.smcpCall('set_cell_style', {
        file_id, sheet_id: lineSheetId,
        start_row: 2, end_row: 1 + VALID_ROWS,
        start_col: 0, end_col: 0,
        number_format_pattern: '0', horizontal_align: 'center'
      });
      console.log('[cw] Tab2 新增填写规则：音画同步下拉 + 句数统计(数字)');
    } catch (e) {
      warnings.push('Tab2 填写规则: ' + e.message);
    }
    }

    // 5b) 句数统计(J/index9) + 角色校验(K/index10)公式 + 条件格式（500行）
    //   句数统计：读取 C 列(台词-中)，每 20 字一句 ROUNDUP
    //   角色校验：B 列角色名不在「需求统计」页 B列(已有)/G列(新建) 时，该格显示 ⚠ 提示并整格标红
    //   注：条件格式仅能整格着色，无法整行标红（平台 CF 仅支持 CF_CELL_IS 值规则）
    if (!LITE) {
    try {
      const sentVals = [];
      const validVals = [];
      const aNumVals = [];
      for (let ri = 2; ri < 2 + VALID_ROWS; ri++) {
        const one = ri + 1; // 1-based 行号（数据行从第 3 行起）
        sentVals.push({ row: ri, col: COL_SENTENCE, value_type: 'FORMULA', formula: SENTENCE_FORMULA(one) });
        validVals.push({ row: ri, col: COL_VALID, value_type: 'FORMULA', formula: VALID_FORMULA(one) });
        // A 列自动序号：两行表头下，数据行序号 = 行号-2（=ROW()-2），增删行自动顺延
        aNumVals.push({ row: ri, col: 0, value_type: 'FORMULA', formula: '=ROW()-2' });
      }
      // 批量写公式（sheet-mcp 端点，openapi 的 set_range_value 不支持 FORMULA）
      // A/J/K 三列合并为单次写入（3 请求 → 1）以规避腾讯 WAF 突发限流；
      // 若单包过大被平台拒绝（非 WAF 错误），降级为按列分 3 次写。
      try {
        await mcp.setRangeValueSmcp(file_id, lineSheetId, aNumVals.concat(sentVals, validVals));
      } catch (e) {
        if (/WAF|限流|captcha/i.test(e.message || '')) throw e;
        console.warn('[cw] Tab2 公式合并写入失败，降级为分列写入:', e.message);
        await mcp.setRangeValueSmcp(file_id, lineSheetId, aNumVals);
        await mcp.setRangeValueSmcp(file_id, lineSheetId, sentVals);
        await mcp.setRangeValueSmcp(file_id, lineSheetId, validVals);
      }
      // 条件格式：角色校验列出现 ⚠ 前缀 → 红底红字加粗（仅该格；整行标红受平台限制无法实现）
      await mcp.addConditionalFormat(file_id, lineSheetId, [`${VALID_COL_LETTER}3:${VALID_COL_LETTER}${2 + VALID_ROWS}`], {
        type: 'CF_CELL_IS',
        cell_is: { operator: 'contains_text', formulas: [VALID_HINT_PREFIX] },
        style: { bg_color: '#FFC7CE', font_color: '#9C0006', bold: true },
      });
      console.log('[cw] Tab2 句数统计 + 角色校验 公式已写入（' + VALID_ROWS + ' 行）');
    } catch (e) {
      warnings.push('句数统计/角色校验公式: ' + e.message);
    }
    }

    // 实际句数(D/I 列) 公式已在 writeStatSheetV2 中随 Tab1 一同写入（需引用本 Tab2）。

  // （核心写表阶段不再整体吞错：Tab2 / 统计表 / 角色校验等关键步骤失败会向上抛出，使任务标记 failed 可重试）

  // 8) 权限：优先企业版(OA)成员授权（仅文案策划+PM 可编辑）；
  //    未配置 OA 或授权失败则回退「所有人可编辑」，避免破坏现有协作（待 OA token 注入后自动切换）
  if (LITE) {
    // lite 模式：跳过 OA 编辑器查找（省 ~2 次调用），直接设所有人可编辑，保证表可访问即可
    try { await mcp.setPrivilege(file_id, 3, cookie); } catch (e) { /* 权限失败不阻断生成 */ }
  } else {
  try {
    const editors = resolveDocEditors(demand);
    const er = editors.length ? await mcp.setEnterpriseDocEditors(file_id, editors) : { ok: false, reason: 'no-members' };
    if (er && er.ok) {
      await mcp.setPrivilege(file_id, 2, cookie); // 基线：所有人只读 + 指定成员可编辑
      console.log('[cw] 企业版成员授权成功，可编辑成员: ' + editors.join(','));
    } else {
      await mcp.setPrivilege(file_id, 3, cookie); // 回退：所有人可编辑（维持现状）
      if ((er && er.reason) === 'no-members') {
        // 未配置 OA 编辑器 → 预期降级（全员可编辑），不计为失败（避免严格模式下正常生成被误判 failed）
        console.log('[cw] 未配置 OA 编辑器，回退所有人可编辑（预期降级，不计为失败）');
      } else {
        warnings.push('成员授权未生效(' + ((er && er.reason) || 'unknown') + ')，维持所有人可编辑');
      }
    }
  } catch (e) {
    warnings.push('权限设置: ' + e.message);
  }
  }

  // 严格模式：任何 cosmetic 警告都视为生成不完整 → 任务标记 failed 可重试（不再静默成功）。lite 模式跳过（装饰步骤本就未执行，无 warnings）
  if (!LITE && warnings.length) {
    throw new Error('DOC_GENERATED_WITH_WARNINGS: ' + warnings.join(' | '));
  }
  return { file_id, url: created.url, headers_count: headers.length, tab, warnings: [] };
  } catch (e) {
    // 失败回滚：仅当核心内容尚未写入成功时才删除孤儿文档，避免把 95% 建好的表也整份删掉（WAF 场景重试会反复烧请求）
    if (file_id && !coreWritten) {
      try { await mcp.deleteFile(file_id, cookie); } catch (_) { /* 回滚删除失败不影响主错误传播 */ }
    }
    throw e;
  }
}

// 从台词表文档 URL 抽取 file_id（URL 形如 https://docs.qq.com/sheet/<file_id>）
function extractFileId(docUrl) {
  if (!docUrl) return '';
  try {
    const u = new URL(docUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  } catch (e) { /* fallthrough */ }
  const m = String(docUrl).match(/([A-Za-z0-9_-]{8,})$/);
  return m ? m[1] : '';
}

// 批量聚合：遍历所有需求的台词表，读每份【需求统计】子表，按发布计划汇总台词量。
// 用于「台词管理页 · 按发布计划看台词量」看板。返回 { released: { <release>: {...} }, demands: [...], aggregatedAt }
// 注意：包含 release 内【全部】需求（无论是否已生成台词表）；无台词表的需求句数/角色数记 0，便于"汇总整个 release 所有需求"。
async function aggregateAllDemands(demands) {
  const list = Array.isArray(demands) ? demands : [];
  const released = {};
  const demandStats = [];
  let scanned = 0;
  for (const dem of list) {
    if (!dem) continue;
    const file_id = dem.script_doc_url ? fileIdFromUrl(dem.script_doc_url) : '';
    if (!file_id) {
      // 无台词表：仍计入需求明细，句数/角色数记 0
      const release = (dem.release_plan || '未标记').trim();
      const b = released[release] || (released[release] = {
        release, docs: 0, roles: new Set(), est_lines: 0, act_lines: 0,
        by_role_type: {}, by_writer: {}
      });
      b.docs += 1; // 需求本身算 1 份文档占位（即便台词表未生成）
      demandStats.push({
        id: dem.id, release, task_name: dem.task_name || '',
        area: dem.area || '', creator: dem.creator || '', cn_lines_handler: dem.cn_lines_handler || '',
        doc_count: 0, role_count: 0, est_lines: 0, act_lines: 0,
        script_doc_url: dem.script_doc_url || ''
      });
      continue;
    }
    const release = (dem.release_plan || '未标记').trim();
    let estimates = [];
    try {
      const r = await readVoiceEstimatesForDemand(dem);
      estimates = (r && r.estimates) || [];
    } catch (e) {
      console.warn('[cw] 聚合反读失败 需求' + dem.id + ':', e.message);
    }
    scanned++;
    const roles = new Set();
    let estLines = 0, actLines = 0;
    estimates.forEach(function(x) {
      if (x && x.role) roles.add(x.role);
      var ev = Number(x && x.est_lines); if (isFinite(ev)) estLines += ev;
      var av = Number(x && x.act_lines); if (isFinite(av)) actLines += av;
    });
    const b = released[release] || (released[release] = {
      release, docs: 0, roles: new Set(), est_lines: 0, act_lines: 0,
      by_role_type: {}, by_writer: {}
    });
    b.docs += 1;
    roles.forEach(function(r) { b.roles.add(r); });
    b.est_lines += estLines;
    b.act_lines += actLines;
    // 按角色类型（category）汇总句数
    estimates.forEach(function(x) {
      if (!x) return;
      var cat = (x.category || '未分类').trim() || '未分类';
      var ev = Number(x.est_lines); if (!isFinite(ev)) ev = 0;
      b.by_role_type[cat] = (b.by_role_type[cat] || 0) + ev;
    });
    // 按文案策划汇总句数
    var writer = (dem.cn_lines_handler || '').trim() || '未分配';
    b.by_writer[writer] = (b.by_writer[writer] || 0) + estLines;
    demandStats.push({
      id: dem.id, release, task_name: dem.task_name || '',
      area: dem.area || '', creator: dem.creator || '', cn_lines_handler: dem.cn_lines_handler || '',
      doc_count: 1, role_count: roles.size, est_lines: estLines, act_lines: actLines,
    });
  }
  // Set → 数字
  Object.keys(released).forEach(function(k) {
    var b = released[k];
    b.role_count = b.roles.size; delete b.roles;
  });
  return {
    released,
    demands: demandStats,
    scanned,
    aggregatedAt: new Date().toISOString()
  };
}

// 生成「台词量汇总看板」智能表格：聚合所有需求的台词量，写入一张全新的腾讯文档智能表格。
// 含两个子表：
//   版本汇总：每版本一行（文档数/角色数/预估句数/各角色大类句数/文案策划句数）
//   需求明细：每需求一行（发布计划/Story/AREA/文案策划/创建人/角色数/预估句数/台词表链接）
// 权限默认全员只读（看板供查阅，编辑留给 per-demand 台词表）。
// 当 oldFileId 传入时，先删除旧文档再建新（避免重复生成堆积孤儿文档）。
// release 参数用于标题与单 release 范围（传入时只汇总该 release 的需求）。
async function generateSummaryBoard(demands, release, oldFileId) {
  const agg = await aggregateAllDemands(demands);
  if (oldFileId) {
    try { await mcp.deleteFile(oldFileId); console.log('[cw] 已删除旧汇总文档 file_id=' + oldFileId); }
    catch (e) { console.warn('[cw] 删除旧汇总文档失败(忽略):', e.message); }
  }
  const title = '【VO Manager】台词量汇总' + (release ? '·' + release : '看板');
  const created = await mcp.createSmartSheet({ title });
  const fid = created.file_id;
  const cookie = created.cookie;

  // 默认自带一个空表，先记下，再新增两个命名子表后删掉默认表
  const tables = await mcp.listTables(fid, cookie);
  const defSid = tables[0] && tables[0].sheet_id;
  const relSid = await mcp.addTable(fid, '版本汇总', 1, cookie);
  const detSid = await mcp.addTable(fid, '需求明细', 2, cookie);
  try { if (defSid) await mcp.deleteTable(fid, defSid, cookie); }
  catch (e) { console.warn('[cw] 删除默认子表失败(忽略):', e.message); }

  const CATS = ['指挥官', '干员', 'Boss', 'AI兵', 'NPC', 'AI系统音'];
  const numField = () => ({ field_type: 'number', property_number: { decimal_places: 0 } });
  const txtField = (t) => ({ field_title: t, field_type: 'text', property_text: {} });
  const txtVal = (v) => ({ items: [{ text: String(v == null ? '' : v), type: 'text' }] });

  // —— 子表 1：版本汇总 ——
  const relFields = [
    { field_title: '序号', field_type: 'autoNumber', property_auto_number: { type: 1 } },
    txtField('发布计划'),
    Object.assign({ field_title: '文档数' }, numField()),
    Object.assign({ field_title: '角色数' }, numField()),
    Object.assign({ field_title: '预估句数' }, numField()),
    Object.assign({ field_title: '指挥官' }, numField()),
    Object.assign({ field_title: '干员' }, numField()),
    Object.assign({ field_title: 'Boss' }, numField()),
    Object.assign({ field_title: 'AI兵' }, numField()),
    Object.assign({ field_title: 'NPC' }, numField()),
    Object.assign({ field_title: 'AI系统音' }, numField()),
    txtField('文案策划句数'),
  ];
  await mcp.addFields(fid, relSid, relFields, cookie);

  const relRecords = Object.keys(agg.released).map((rel) => {
    const b = agg.released[rel];
    const fv = [
      { field: '发布计划', text_value: txtVal(rel) },
      { field: '文档数', number_value: b.docs || 0 },
      { field: '角色数', number_value: b.role_count || 0 },
      { field: '预估句数', number_value: b.est_lines || 0 },
    ];
    CATS.forEach((c) => fv.push({ field: c, number_value: (b.by_role_type && b.by_role_type[c]) || 0 }));
    const writerStr = Object.keys(b.by_writer || {}).map((w) => w + ':' + (b.by_writer[w] || 0)).join('；') || '—';
    fv.push({ field: '文案策划句数', text_value: txtVal(writerStr) });
    return { field_values: fv };
  });
  if (relRecords.length) await mcp.addRecords(fid, relSid, relRecords, cookie);

  // —— 子表 2：需求明细 ——
  const detFields = [
    { field_title: '序号', field_type: 'autoNumber', property_auto_number: { type: 1 } },
    txtField('发布计划'),
    txtField('Story'),
    txtField('AREA'),
    txtField('文案策划'),
    txtField('创建人'),
    Object.assign({ field_title: '角色数' }, numField()),
    Object.assign({ field_title: '预估句数' }, numField()),
    txtField('台词表链接'),
  ];
  await mcp.addFields(fid, detSid, detFields, cookie);

  const detRecords = (agg.demands || []).map((d) => {
    const fv = [
      { field: '发布计划', text_value: txtVal(d.release) },
      { field: 'Story', text_value: txtVal(d.task_name) },
      { field: 'AREA', text_value: txtVal(d.area) },
      { field: '文案策划', text_value: txtVal(d.cn_lines_handler) },
      { field: '创建人', text_value: txtVal(d.creator) },
      { field: '角色数', number_value: d.role_count || 0 },
      { field: '预估句数', number_value: d.est_lines || 0 },
    ];
    if (d.script_doc_url) fv.push({ field: '台词表链接', text_value: txtVal(d.script_doc_url) });
    return { field_values: fv };
  });
  if (detRecords.length) await mcp.addRecords(fid, detSid, detRecords, cookie);

  // 权限：全员只读
  await mcp.setPrivilege(fid, 2, cookie);
  console.log('[cw] 台词量汇总看板已生成 file_id=' + fid + ' url=' + created.url +
    ' releases=' + Object.keys(agg.released).length + ' demands=' + (agg.demands || []).length);
  return {
    file_id: fid, url: created.url,
    releases: Object.keys(agg.released).length,
    demands: (agg.demands || []).length,
    scanned: agg.scanned,
  };
}

function fileIdFromUrl(url) {
  const m = String(url || '').match(/\/(?:sheet|smartsheet)\/([^?/#]+)/i);
  return m ? m[1] : '';
}
function parseCsv(text) {
  const rows=[]; let row=[],cell='',quoted=false;
  const s=String(text||'');
  for(let i=0;i<s.length;i++){
    const ch=s[i];
    if(quoted){
      if(ch==='"' && s[i+1]==='"'){ cell+='"'; i++; }
      else if(ch==='"') quoted=false;
      else cell+=ch;
    }else if(ch==='"') quoted=true;
    else if(ch===','){ row.push(cell); cell=''; }
    else if(ch==='\n'){ row.push(cell.replace(/\r$/,'')); rows.push(row); row=[]; cell=''; }
    else cell+=ch;
  }
  if(cell||row.length){ row.push(cell.replace(/\r$/,'')); rows.push(row); }
  return rows;
}
async function readVoiceEstimatesForDemand(demand) {
  const file_id = demand.doc_file_id || demand._doc_file_id || fileIdFromUrl(demand.script_doc_url);
  if(!file_id) throw new Error('需求尚无可读取的台词表 file_id');
  const info = await mcp.smcpCall('get_sheet_info', { file_id });
  const sheets = info.sheets || info.sheet_list || info || [];
  const stat = sheets.find((s) => s.title === '【需求统计】' || s.name === '【需求统计】') || sheets[0];
  if(!stat || !stat.sheet_id) throw new Error('台词表缺少【需求统计】子表');
  const raw = await mcp.smcpCall('get_cell_data', {
    file_id, sheet_id: stat.sheet_id,
    start_row: 0, end_row: 999, start_col: 0, end_col: 8,
    return_csv: true, include_formula: false, return_formula: false
  });
  const csv = raw.csv_data || raw.csv || raw.data || raw._raw || '';
  const rows = parseCsv(typeof csv === 'string' ? csv : '');
  if(!rows.length) throw new Error('【需求统计】未返回可解析数据');
  const estimates=[];
  // Tab1 v2 9 列：已有声优 A-D(大类|游戏角色|预估句数|实际句数) | E 间隔 | 新建声优 F-H(大类|新增角色|预估句数) —— 只到 H，不读 I(实际句数)
  for(const r of rows.slice(2)){
    const cat=String(r[0]||'').trim(), role=String(r[1]||'').trim();
    if(role){
      estimates.push({
        category: cat, role,
        est_lines: Number(String(r[2]||'').replace(/,/g,''))||0,
        is_new: false
      });
    }
    const ncat=String(r[5]||'').trim(), nrole=String(r[6]||'').trim();
    if(nrole){
      estimates.push({
        category: ncat, role: nrole,
        est_lines: Number(String(r[7]||'').replace(/,/g,''))||0,
        is_new: true
      });
    }
  }
  return { file_id, sheet_id:stat.sheet_id, estimates };
}

// 演示用：往指定需求的 Tab2 台词表批量写入 [DEMO] 台词行。
// lines: [{ role_cn, cn_text, en_text, situation?, trigger?, audio_file?, remark? }]
// 从第 3 行（0-based row=2）起写；列位统一由 script_table_template.js 推导。
// 不清空原有行——只是"追加/覆盖"从第3行起 lines.length 行。用于下午演示 demo，事后配套 cleanup 清除。
async function appendDemoLinesForDemand(demand, lines) {
  if (!demand || !demand.script_doc_url) return { ok: false, reason: 'no-doc' };
  if (!Array.isArray(lines) || !lines.length) return { ok: false, reason: 'empty-lines' };
  const file_id = extractFileId(demand.script_doc_url);
  if (!file_id) return { ok: false, reason: 'no-file-id' };
  const cookie = await mcp.openSession();
  // 定位 Tab2（台词表）：一般是第 2 个子表；用 sheet_name 精确匹配'【需求统计】'排除后取下一个
  const sinfo = await mcp.smcpCall('get_sheet_info', { file_id });
  const sheets = (sinfo && sinfo.sheets) || [];
  const tab2 = sheets.find((s) => s.sheet_name && !s.sheet_name.includes('需求统计') && !s.sheet_name.includes('音画同步')) || sheets[1];
  const sheet_id = tab2 && tab2.sheet_id;
  if (!sheet_id) return { ok: false, reason: 'no-tab2' };

  // 构造 setRangeValue 的 payload
  const values = [];
  lines.forEach((ln, i) => {
    const row = i + 2; // 第 3 行起（0-based row=2；前两行为两行表头）
    const put = (col, val) => {
      if (val == null || val === '') return;
      values.push({ row, col, value_type: 'STRING', string_value: String(val) });
    };
    put(COL_ROLE, ln.role_cn);
    put(COL_TEXT_CN, ln.cn_text);
    put(COL_TEXT_EN, ln.en_text);
    put(COL_EMOTION, ln.situation || '');
    put(COL_TRIGGER, ln.trigger || '');
    put(COL_AUDIO_FILE, ln.audio_file || '');
    put(COL_REMARK, ln.remark || '');
  });
  if (!values.length) return { ok: false, reason: 'no-values' };
  await mcp.setRangeValue(file_id, sheet_id, values, cookie);
  console.log('[cw][demo] Tab2 追加台词 demand=' + (demand.id || '?') + ' rows=' + lines.length + ' file_id=' + file_id);
  return { ok: true, file_id, sheet_id, rows: lines.length };
}

module.exports = { generateForDemand, appendDemoLinesForDemand, aggregateAllDemands, generateSummaryBoard, readVoiceEstimatesForDemand, fileIdFromUrl, parseCsv, loadRoster, buildStatRows, COL_WIDTHS: LINE_COL_WIDTHS };
