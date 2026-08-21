// 发布计划聚合 —— 版本节点实时数据源
// 设计：
//  · 主源：本地 DB（demands.release_plan + recording_schedules 节点日期），始终可用、实时。
//  · 增强：若配置了 DFAI_TOKEN，则叠加 dfai.woa.com 官方发布计划（5min 内存缓存），覆盖更完整的阶段周数。
//  · 两者统一为前端契约 { success:true, data:[{ label, id, status, phases }] }。
// 纯函数（aggregateLocal / normalizeDfai* / deriveStatus）便于单测；池查询集中在 getReleasePlans / getCalendarEntries。

const DFAI_BASE = process.env.DFAI_BASE || 'https://dfai.woa.com';
const DFAI_TTL_MS = Number(process.env.DFAI_CACHE_TTL_MS || 5 * 60 * 1000);
let _dfaiCache = { at: 0, data: null };

function slugify(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/[【】\[\]()（）]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// 由需求状态分布推导版本整体状态（本地聚合用）
function deriveStatus(byStatus) {
  const s = byStatus || {};
  const done = s['已完成'] || 0;
  const vo = s['Vo ING'] || 0;
  const cn = s['文案ING'] || 0;
  const clarify = s['待澄清'] || 0;
  if (done > 0 && done >= vo + cn + clarify) return '已完成';
  if (vo > 0) return 'Vo ING';
  if (cn > 0) return '文案ING';
  if (clarify > 0) return '待澄清';
  return '';
}

// 本地真实聚合：输入为已查出的行（纯函数）
function aggregateLocal(releaseRows, demandStats, scheduleRanges) {
  const data = [];
  for (const r of releaseRows || []) {
    const rp = r && r.release_plan;
    if (!rp) continue;
    const stats = demandStats[rp] || { total: 0, byStatus: {} };
    const range = scheduleRanges[rp];
    const phases = {};
    // 录制档期窗口作为「发布期」节点（真实节点日期）
    if (range && range.min && range.max) {
      phases.release = { start: range.min, end: range.max };
    }
    data.push({
      label: rp,
      id: slugify(rp),
      status: deriveStatus(stats.byStatus),
      total_demands: stats.total || 0,
      phases,
      source: 'local',
    });
  }
  return { success: true, data, source: 'local' };
}

// 归一化 DFAI 发布计划响应为统一契约（防御式，未知字段安全忽略）
function normalizeDfaiReleasePlans(raw) {
  if (!raw) return { success: false, data: [] };
  const list = Array.isArray(raw) ? raw : (raw.data || raw.release_plans || raw.items || []);
  if (!Array.isArray(list)) return { success: false, data: [] };
  const data = list
    .map((p) => {
      if (!p) return null;
      const label = p.label || p.name || p.title || p.release_plan || '';
      const phasesIn = p.phases || p.phase || {};
      const phases = {};
      for (const k of ['w0', 'dev', 'test', 'release']) {
        const seg = phasesIn[k];
        if (seg && seg.start && seg.end) {
          phases[k] = { start: String(seg.start).slice(0, 10), end: String(seg.end).slice(0, 10) };
        }
      }
      return {
        label,
        id: p.id || slugify(label),
        status: p.status || '',
        total_demands: p.total_demands || 0,
        phases,
        source: 'dfai',
      };
    })
    .filter(Boolean);
  return { success: true, data, source: 'dfai' };
}

// 归一化 DFAI 日历条目（对外正式包确认等节点）
function normalizeDfaiEntries(raw) {
  if (!raw) return { data: [] };
  const list = Array.isArray(raw) ? raw : (raw.data || raw.entries || raw.rows || []);
  if (!Array.isArray(list)) return { data: [] };
  const data = list
    .map((e) => ({
      release_id: e.release_id || e.releaseId || e.release_plan || '',
      title: e.title || e.name || '',
      start_time: e.start_time || e.startTime || e.start || null,
      end_time: e.end_time || e.endTime || e.end || null,
      status: e.status || '',
    }))
    .filter((e) => e.release_id);
  return { data, source: 'dfai' };
}

async function fetchDfai(url, token, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      cache: 'no-cache',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`dfai ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// 对外主函数：优先 dfai（有 token 且可达），否则本地真源
async function getReleasePlans(pool) {
  const token = process.env.DFAI_TOKEN;
  if (token) {
    try {
      const fresh = _dfaiCache.data && Date.now() - _dfaiCache.at < DFAI_TTL_MS;
      const raw = fresh ? _dfaiCache.data : await fetchDfai(`${DFAI_BASE}/aiapi/calendar/release-plans`, token);
      if (!fresh) _dfaiCache = { at: Date.now(), data: raw };
      const norm = normalizeDfaiReleasePlans(raw);
      if (norm.success && norm.data.length) return norm;
    } catch (e) {
      console.warn('[release-plans] dfai 拉取失败，回退本地真源：', e.message);
    }
  }

  // ★ 2026-08-21 两步走·第一步：无 DFAI token 时优先读静态快照（DFAI 官方数据固化，phases 完整含 dev/test/w0/周数、ISO 日期）
  //   后续再重写完整节点计算规则替换此段。快照路径通过 compose volume 挂到 /app/data/release-plans.json。
  try {
    const fs = require('fs');
    const candidates = [
      process.env.RELEASE_SNAPSHOT_PATH,
      '/app/data/release-plans.json',
      '/app/frontend/data/release-plans.json',
      '/root/deploy/frontend/data/release-plans.json',
    ].filter(Boolean);
    let snapRaw = null;
    for (const c of candidates) {
      try { snapRaw = fs.readFileSync(c, 'utf-8'); if (snapRaw) break; } catch (_) {}
    }
    if (snapRaw) {
      const snap = JSON.parse(snapRaw);
      if (snap && snap.success && Array.isArray(snap.data) && snap.data.length) {
        const [stats0] = await pool.query(
          `SELECT release_plan, status, COUNT(*) c FROM demands
             WHERE story_type='音频' AND status<>'suspended'
               AND release_plan IS NOT NULL AND release_plan<>''
             GROUP BY release_plan, status`
        );
        const normKey = (x) => String(x || '').replace(/[【】_\s]/g, '').toLowerCase();
        const demandStats0 = {};
        for (const st of stats0) {
          const k = normKey(st.release_plan);
          demandStats0[k] = demandStats0[k] || { total: 0, byStatus: {} };
          demandStats0[k].total += st.c;
          demandStats0[k].byStatus[st.status] = (demandStats0[k].byStatus[st.status] || 0) + st.c;
        }
        const enriched = snap.data.map((p) => {
          const ds = demandStats0[normKey(p.label)] || { total: 0, byStatus: {} };
          return {
            label: p.label,
            id: p.id || slugify(p.label),
            status: deriveStatus(ds.byStatus) || p.status || '',
            total_demands: ds.total || p.total_demands || 0,
            phases: p.phases || {},
            source: 'snapshot',
          };
        });
        return { success: true, data: enriched, source: 'snapshot' };
      }
    }
  } catch (e) {
    console.warn('[release-plans] 静态快照读取失败，回退纯本地聚合：', e.message);
  }

  const [rel] = await pool.query(
    `SELECT DISTINCT release_plan FROM demands
     WHERE story_type='音频' AND status<>'suspended'
       AND release_plan IS NOT NULL AND release_plan<>''
     ORDER BY release_plan`
  );
  const [stats] = await pool.query(
    `SELECT release_plan, status, COUNT(*) c FROM demands
     WHERE story_type='音频' AND status<>'suspended'
       AND release_plan IS NOT NULL AND release_plan<>''
     GROUP BY release_plan, status`
  );
  const [ranges] = await pool.query(
    `SELECT release_plan, MIN(record_date) min, MAX(record_date) max FROM recording_schedules
     WHERE release_plan IS NOT NULL AND release_plan<>''
     GROUP BY release_plan`
  );
  const demandStats = {};
  for (const s of stats) {
    demandStats[s.release_plan] = demandStats[s.release_plan] || { total: 0, byStatus: {} };
    demandStats[s.release_plan].total += s.c;
    demandStats[s.release_plan].byStatus[s.status] = (demandStats[s.release_plan].byStatus[s.status] || 0) + s.c;
  }
  const scheduleRanges = {};
  for (const r of ranges) scheduleRanges[r.release_plan] = { min: String(r.min), max: String(r.max) };
  return aggregateLocal(rel, demandStats, scheduleRanges);
}

// 对外：某 release 的日历节点（对外正式包确认等）
async function getCalendarEntries(pool, releaseId) {
  const token = process.env.DFAI_TOKEN;
  if (token && releaseId) {
    try {
      const raw = await fetchDfai(
        `${DFAI_BASE}/aiapi/calendar/entries?releaseId=${encodeURIComponent(releaseId)}`,
        token
      );
      const norm = normalizeDfaiEntries(raw);
      if (norm.data.length) return norm;
    } catch (e) {
      console.warn('[calendar-entries] dfai 拉取失败，回退本地档期：', e.message);
    }
  }
  if (!releaseId) return { data: [], source: 'local' };
  const [rows] = await pool.query(
    `SELECT rs.release_plan, rs.record_date, rs.language, rs.status, va.name AS voice_actor_name
     FROM recording_schedules rs
     LEFT JOIN voice_actors va ON va.id = rs.voice_actor_id
     WHERE rs.release_plan = ?
     ORDER BY rs.record_date`,
    [releaseId]
  );
  const data = rows
    .filter((r) => r.record_date)
    .map((r) => ({
      release_id: r.release_plan,
      title: `录制 ${r.language === 'en' ? 'EN' : 'CN'} · ${r.voice_actor_name || ''}`.trim(),
      start_time: String(r.record_date).slice(0, 10) + 'T00:00:00',
      end_time: String(r.record_date).slice(0, 10) + 'T23:59:59',
      status: r.status || '',
    }));
  return { data, source: 'local' };
}

module.exports = {
  slugify,
  deriveStatus,
  aggregateLocal,
  normalizeDfaiReleasePlans,
  normalizeDfaiEntries,
  getReleasePlans,
  getCalendarEntries,
};
