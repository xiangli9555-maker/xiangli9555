// src/linesheet.js
// 台词表 · 企业微信智能表格 业务逻辑
// 模型：每文案策划 = 1 份智能表格文档；每个需求 = 1 个子表(tab)
// 字段 = 表头（天然锁定，仅 PM/工具建）；记录 = 文案填的台词行
// 声优列由工具按「角色」自动从声优库映射填回

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const pool = require('./db');
const wecom = require('./wecom');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'planner_docs.json');

// ---------- 选项常量 ----------
const MODULES = ['AI兵', 'Boss', '指挥官', '干员', 'NPC', '路人角色', 'AI系统音'];
const EMOTIONS = ['平静', '紧张', '兴奋', '愤怒', '悲伤', '恐惧', '嘲讽', '惊讶', '疲惫', '命令', '低语', '怒吼', '喜悦', '痛苦'];

// 11 列字段定义（顺序即表头顺序）。声优两列由工具自动填，文案不手填。
function buildFields(roles) {
  const opt = (arr) => (arr || []).map((t) => ({ text: String(t) }));
  return [
    { field_title: '序号', field_type: 'FIELD_TYPE_TEXT' },
    { field_title: '模块', field_type: 'FIELD_TYPE_SINGLE_SELECT', options: opt(MODULES) },
    { field_title: '角色', field_type: 'FIELD_TYPE_SINGLE_SELECT', options: opt(roles) },
    { field_title: '中配声优', field_type: 'FIELD_TYPE_TEXT' },
    { field_title: '英配声优', field_type: 'FIELD_TYPE_TEXT' },
    { field_title: '台词-中', field_type: 'FIELD_TYPE_TEXT' },
    { field_title: '台词-英', field_type: 'FIELD_TYPE_TEXT' },
    { field_title: '情绪', field_type: 'FIELD_TYPE_SINGLE_SELECT', options: opt(EMOTIONS) },
    { field_title: '触发', field_type: 'FIELD_TYPE_TEXT' },
    { field_title: 'audio名', field_type: 'FIELD_TYPE_TEXT' },
    { field_title: '备注', field_type: 'FIELD_TYPE_TEXT' },
  ];
}

// ---------- 文档映射存储（planner -> docid/url/sheets）----------
function loadStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); }
  catch { return {}; }
}
function saveStore(s) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(s, null, 2));
}

// planner 显示名 -> 企业微信账号ID（用于建文档归属 + 分享）
function plannerUserid(name) {
  try {
    const map = JSON.parse(process.env.WECOM_PLANNER_MAP || '{}');
    return map[name] || null;
  } catch { return null; }
}

// ---------- 数据查询 ----------
async function getPlannerDemands(planner) {
  const [rows] = await pool.query(
    `SELECT * FROM demands WHERE cn_lines_handler=? AND story_type='音频' AND status!='suspended' ORDER BY id`,
    [planner]
  );
  return rows;
}
async function getRoleMap() {
  const [rows] = await pool.query('SELECT role_cn, cn_va, en_va FROM voice_roles');
  const m = new Map();
  rows.forEach((r) => { if (r.role_cn) m.set(r.role_cn, r); });
  return m;
}
async function getActorNameToId() {
  const [rows] = await pool.query('SELECT id, name FROM voice_actors');
  const m = new Map();
  rows.forEach((r) => { if (r.name) m.set(r.name, r.id); });
  return m;
}

const demandKey = (d) => `D${d.id}`;

// ---------- 1) 生成/刷新某策划的汇总文档（空脚手架，供文案填）----------
async function generateRollup(planner) {
  const store = loadStore();
  const demands = await getPlannerDemands(planner);
  if (!demands.length) return { ok: true, warning: '该策划名下暂无音频需求', docid: null, url: null, sheets: 0 };

  const roleMap = await getRoleMap();
  const roles = [...roleMap.keys()];
  const fields = buildFields(roles);

  let entry = store[planner];
  if (!entry) {
    const uid = plannerUserid(planner);
    const { docid, url } = await wecom.createSmartsheet(`【Vo Manager】${planner} 台词汇总`, uid ? [uid] : []);
    entry = { docid, url, sheets: {} };
    if (uid) { try { await wecom.shareDoc(docid, [uid], 'edit'); } catch (e) { /* 联调时校正权限接口 */ } }
    store[planner] = entry;
    saveStore(store);
  }

  let created = 0;
  for (const d of demands) {
    const key = demandKey(d);
    let sheetId = entry.sheets[d.id];
    if (!sheetId) {
      sheetId = await wecom.addSheet(entry.docid, key);
      entry.sheets[d.id] = sheetId;
      created++;
      saveStore(store);
    }
    // 幂等建字段：已含「台词-中」视为已初始化
    const existing = await wecom.getFields(entry.docid, sheetId);
    if (existing.some((f) => f.field_title === '台词-中')) continue;

    if (existing.length <= 1) {
      // 重命名默认字段为「序号」，再补其余 10 列
      const def = existing[0];
      await wecom.updateFields(entry.docid, sheetId, [
        { field_id: def.field_id, field_title: '序号', field_type: def.field_type },
      ]);
      await wecom.addFields(entry.docid, sheetId, fields.slice(1));
    } else {
      await wecom.addFields(entry.docid, sheetId, fields);
    }
  }
  return { ok: true, docid: entry.docid, url: entry.url, sheets: Object.keys(entry.sheets).length, created };
}

// ---------- 2) 同步：读回各子表台词 -> upsert 进 script_lines + 回写声优 ----------
async function syncRollup(planner) {
  const store = loadStore();
  const entry = store[planner];
  if (!entry) return { ok: false, error: '请先生成该策划的汇总文档' };
  const demands = await getPlannerDemands(planner);
  const roleMap = await getRoleMap();
  const actorMap = await getActorNameToId();

  let lines = 0;
  for (const d of demands) {
    const sheetId = entry.sheets[d.id];
    if (!sheetId) continue;
    const rec = await wecom.getRecords(entry.docid, sheetId, { limit: 1000 });
    const records = rec.records || [];
    for (const row of records) {
      const v = row.values || {};
      const no = wecom.cellText(v['序号']) || '0';
      const role = wecom.cellText(v['角色']);
      const cnText = wecom.cellText(v['台词-中']);
      const enText = wecom.cellText(v['台词-英']);
      if (!cnText && !enText) continue; // 空行跳过

      const rm = role ? roleMap.get(role) : null;
      const cnVa = rm ? rm.cn_va || '' : '';
      const enVa = rm ? rm.en_va || '' : '';
      const vaId = cnVa ? (actorMap.get(cnVa) || null) : null;

      // upsert script_lines（按 demand_id + no，保留 recorded_* 历史）
      const [exist] = await pool.query(
        'SELECT id FROM script_lines WHERE demand_id=? AND no=?', [d.id, no]
      );
      if (exist.length) {
        await pool.query(
          `UPDATE script_lines SET area=?, voice_actor_id=?, text_cn=?, text_en=?,
             emotion=?, trigger_condition=?, gp_audio_event=?, remark=?
           WHERE id=?`,
          [d.area, vaId, cnText, enText, wecom.cellText(v['情绪']),
           wecom.cellText(v['触发']), wecom.cellText(v['audio名']), wecom.cellText(v['备注']), exist[0].id]
        );
      } else {
        await pool.query(
          `INSERT INTO script_lines
             (demand_id, area, no, voice_actor_id, text_cn, text_en, emotion, trigger_condition, gp_audio_event, remark)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [d.id, d.area, no, vaId, cnText, enText, wecom.cellText(v['情绪']),
           wecom.cellText(v['触发']), wecom.cellText(v['audio名']), wecom.cellText(v['备注'])]
        );
      }
      lines++;

      // 回写声优到智能表格（工具自动填，文案无需手填）
      if (row.record_id && (cnVa || enVa)) {
        try {
          await wecom.updateRecords(entry.docid, sheetId, [{
            record_id: row.record_id,
            values: {
              '中配声优': [{ type: 'text', text: cnVa }],
              '英配声优': [{ type: 'text', text: enVa }],
            },
          }]);
        } catch (e) { /* 声优列回写失败不阻断主流程 */ }
      }
    }
  }
  return { ok: true, planner, lines_synced: lines };
}

// ---------- 3) 按声优导出 xlsx（单页发录音棚）----------
async function exportByVoiceActor(vaName) {
  const [va] = await pool.query('SELECT id, name FROM voice_actors WHERE name=?', [vaName]);
  const vaId = va.length ? va[0].id : null;
  if (!vaId) return null;

  const [rows] = await pool.query(
    `SELECT sl.*, d.task_name, d.release_plan
       FROM script_lines sl
       LEFT JOIN demands d ON d.id = sl.demand_id
      WHERE sl.voice_actor_id = ?
      ORDER BY sl.demand_id, CAST(sl.no AS UNSIGNED)`,
    [vaId]
  );

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('台词');
  ws.columns = [
    { header: '需求ID', key: 'did', width: 8 },
    { header: '需求名', key: 'task', width: 24 },
    { header: '模块', key: 'area', width: 12 },
    { header: '台词-中', key: 'cn', width: 40 },
    { header: '台词-英', key: 'en', width: 40 },
    { header: '情绪', key: 'emo', width: 10 },
    { header: '触发', key: 'trig', width: 20 },
    { header: 'audio名', key: 'audio', width: 20 },
    { header: '备注', key: 'remark', width: 20 },
  ];
  rows.forEach((r) => {
    ws.addRow({
      did: r.demand_id, task: r.task_name, area: r.area,
      cn: r.text_cn, en: r.text_en, emo: r.emotion, trig: r.trigger_condition,
      audio: r.gp_audio_event, remark: r.remark,
    });
  });

  const buf = await wb.xlsx.writeBuffer();
  return { buffer: buf, filename: `台词_${vaName}.xlsx` };
}

module.exports = { generateRollup, syncRollup, exportByVoiceActor, getPlannerDemands };
