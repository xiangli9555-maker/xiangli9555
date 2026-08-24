// 台词表 · 上传解析 / 汇总 / 按声优导出
// 过渡方案（无平台 API）：文案导出填写好的 v3 台账 xlsx -> 后端解析 -> upsert 进 script_lines
// 声优姓名按「角色」从 voice_roles 映射派生，避免依赖 xlsx 内的 VLOOKUP 公式（上传解析读不到计算值）
const ExcelJS = require('exceljs');
const pool = require('./db');
const { assertZipSafe } = require('./zip_guard');

// v3 母版台账列序：A序号 B模块 C角色 D中配声优(公式) E英配声优(公式) F台词-中 G台词-英 H情绪 I触发 J audio K备注
const COL = { NO: 1, MODULE: 2, ROLE: 3, TEXT_CN: 6, TEXT_EN: 7, EMOTION: 8, TRIGGER: 9, AUDIO: 10, REMARK: 11 };

async function getRoleMap() {
  const [rows] = await pool.query('SELECT role_cn, cn_va, en_va FROM voice_roles');
  const m = new Map();
  rows.forEach((r) => { if (r.role_cn) m.set(String(r.role_cn).trim(), { cn: r.cn_va || '', en: r.en_va || '' }); });
  return m;
}

async function resolveVaId(name) {
  if (!name) return null;
  const [rows] = await pool.query('SELECT id FROM voice_actors WHERE name=? LIMIT 1', [name]);
  return rows.length ? rows[0].id : null;
}

// 解析 xlsx buffer -> 台词行数组（仅含中文台词的行）
async function parseLinesheet(buffer, demandId) {
  assertZipSafe(buffer, {
    maxEntries: 2_000,
    maxEntryUncompressed: 25 * 1024 * 1024,
    maxTotalUncompressed: 100 * 1024 * 1024,
    maxCompressionRatio: 100,
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer, { ignoreNodes: ['dataValidations', 'extLst'] });
  const ws = wb.getWorksheet('台词表') || wb.worksheets[0];
  if (!ws) throw Object.assign(new Error('xlsx_without_worksheet'), { status: 400 });
  if (ws.rowCount > 100_000 || ws.columnCount > 100) {
    throw Object.assign(new Error('xlsx_limits_exceeded'), { status: 413 });
  }
  const roleMap = await getRoleMap();

  let area = '';
  try {
    const [d] = await pool.query('SELECT area FROM demands WHERE id=?', [demandId]);
    if (d.length) area = d[0].area || '';
  } catch (e) { /* 忽略，area 留空 */ }

  const lines = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber < 2) return; // 跳过表头
    const textCn = (row.getCell(COL.TEXT_CN).value || '').toString().trim();
    if (!textCn) return; // 只处理有中文台词的行
    const roleCn = (row.getCell(COL.ROLE).value || '').toString().trim();
    const va = roleMap.get(roleCn) || { cn: '', en: '' };
    lines.push({
      no: String(row.getCell(COL.NO).value || (rowNumber - 1)).trim(),
      module: (row.getCell(COL.MODULE).value || '').toString().trim(),
      role_cn: roleCn,
      text_cn: textCn,
      text_en: (row.getCell(COL.TEXT_EN).value || '').toString().trim(),
      emotion: (row.getCell(COL.EMOTION).value || '').toString().trim(),
      trigger_condition: (row.getCell(COL.TRIGGER).value || '').toString().trim(),
      gp_audio_event: (row.getCell(COL.AUDIO).value || '').toString().trim(),
      remark: (row.getCell(COL.REMARK).value || '').toString().trim(),
      va_cn: va.cn,
      va_en: va.en,
      area,
    });
  });
  return lines;
}

// 幂等 upsert：按 (demand_id, no) 判重，重复上传只更新不新增
async function upsertLines(demandId, planner, lines) {
  let inserted = 0, updated = 0;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const ln of lines) {
      const [exist] = await conn.query(
        'SELECT id FROM script_lines WHERE demand_id=? AND no=?', [demandId, ln.no]
      );
      const vaId = await resolveVaId(ln.va_cn);
      if (exist.length) {
        await conn.query(
          `UPDATE script_lines SET area=?, voice_actor_id=?, role_cn=?, va_cn=?, va_en=?,
             text_cn=?, text_en=?, trigger_condition=?, emotion=?, gp_audio_event=?, remark=?
           WHERE id=?`,
          [ln.area, vaId, ln.role_cn, ln.va_cn, ln.va_en, ln.text_cn, ln.text_en,
           ln.trigger_condition, ln.emotion, ln.gp_audio_event, ln.remark, exist[0].id]
        );
        updated++;
      } else {
        await conn.query(
          `INSERT INTO script_lines
             (demand_id, area, no, voice_actor_id, role_cn, va_cn, va_en, text_cn, text_en,
              trigger_condition, emotion, gp_audio_event, remark)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [demandId, ln.area, ln.no, vaId, ln.role_cn, ln.va_cn, ln.va_en,
           ln.text_cn, ln.text_en, ln.trigger_condition, ln.emotion, ln.gp_audio_event, ln.remark]
        );
        inserted++;
      }
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return { inserted, updated, total: lines.length };
}

// 汇总查询：按需求 / 声优过滤
async function getLines({ demandId = null, vaName = '' } = {}) {
  const where = ['1=1'];
  const params = [];
  if (demandId) { where.push('sl.demand_id=?'); params.push(demandId); }
  if (vaName) { where.push('(sl.va_cn=? OR sl.va_en=?)'); params.push(vaName, vaName); }
  const [rows] = await pool.query(
    `SELECT sl.*, d.task_name, d.area AS demand_area
       FROM script_lines sl
       LEFT JOIN demands d ON d.id = sl.demand_id
      WHERE ${where.join(' AND ')}
      ORDER BY sl.demand_id, CAST(sl.no AS UNSIGNED)`,
    params
  );
  return rows;
}

// 按声优导出单页 xlsx（直接发录音棚）
async function exportByVoiceActor(vaName) {
  const rows = await getLines({ vaName });
  if (!rows.length) return null;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('台词-' + vaName);
  ws.columns = [
    { header: '需求ID', key: 'did', width: 8 },
    { header: '需求名', key: 'task', width: 24 },
    { header: '模块', key: 'area', width: 12 },
    { header: '游戏角色', key: 'role', width: 18 },
    { header: '台词-中', key: 'cn', width: 44 },
    { header: '台词-英', key: 'en', width: 44 },
    { header: '情绪', key: 'emo', width: 10 },
    { header: '触发', key: 'trig', width: 24 },
    { header: 'GP Audio', key: 'gp', width: 22 },
    { header: '备注', key: 'remark', width: 22 },
  ];
  rows.forEach((r) => ws.addRow({
    did: r.demand_id,
    task: r.task_name || '',
    area: r.area || r.demand_area || '',
    role: r.role_cn || '',
    cn: r.text_cn || '',
    en: r.text_en || '',
    emo: r.emotion || '',
    trig: r.trigger_condition || '',
    gp: r.gp_audio_event || '',
    remark: r.remark || '',
  }));
  ws.freezePanes = 'A2';
  const hdr = ws.getRow(1);
  hdr.eachCell((c) => {
    c.font = { bold: true, color: { argb: '0FF796' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '16302B' } };
    c.alignment = { vertical: 'center' };
  });
  const buffer = await wb.xlsx.writeBuffer();
  return { buffer, filename: `台词_${vaName}.xlsx` };
}

module.exports = { parseLinesheet, upsertLines, getLines, exportByVoiceActor };
