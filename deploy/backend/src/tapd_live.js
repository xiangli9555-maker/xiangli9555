'use strict';
// ============================================================================
// DFAI get_story 实时拉取 TAPD 音频需求（子单粒度）
// ----------------------------------------------------------------------------
// 目的：生产「从 TAPD 刷新」按钮不再只重放静态快照，而是在配置了 DFAI_API_TOKEN
//       时实时调 https://dfai.woa.com/aiapi/get_story 拉最新需求，条数对齐
//       TAPD 界面筛选口径（标题含「语音-中」+ 需求类型音频 + 非挂起）。
// 回退：pullLiveDemands 抛错 / 0 行时，调用方（index.js /api/refresh）应回退
//       静态快照，保持「永远有数据」。
// 字段：产出 item 与 scripts/build_snapshot.py 生成的快照 item 严格同构，
//       仅补充 status 真实值（快照原本漏填，导致 demands.status 恒 'new'）。
// ============================================================================

const https = require('https');

const DFAI_BASE = process.env.DFAI_BASE || 'https://dfai.woa.com';
const DFAI_API_TOKEN = process.env.DFAI_API_TOKEN || '';
const WORKSPACE_ID = '20421949';

// 发布计划 → release_plan（与 dfai-live-server.js 同源；新增版本在此追加）
// 2026-09-04：当前版本仅 Yang1.0；Ma5.0 已移除（历史版本不参与实时拉取）。
//   等 Yang1.0 收尾后，将 Yang1.0 归档、并把当前版本切到 Yang2.0（届时在此替换）。
const RELEASE_MAP = {
  '1020421949002200155': 'Yang1.0',
};

// 【】 用码点构造（U+3010 / U+3011），规避源码字面量编码差异
const B_OPEN = String.fromCharCode(0x3010);
const B_CLOSE = String.fromCharCode(0x3011);

// 剥所有【...】段，折叠空白 —— 与 build_snapshot.py clean_title 同口径
function cleanTitle(name) {
  let n = String(name || '');
  for (;;) {
    const i = n.indexOf(B_OPEN);
    if (i < 0) break;
    const j = n.indexOf(B_CLOSE, i);
    n = j >= 0 ? n.slice(0, i) + n.slice(j + 1) : n.slice(0, i);
  }
  return n.replace(/\s+/g, ' ').trim();
}

// 父需求名兜底清洗：在 cleanTitle 基础上再剥首尾分隔符（- — – 及空白）。
// 父名剥【】后常残留「- 音频制作」这类悬空前缀，去掉后更接近正文（与前端 cleanTaskName 同口径）。
function cleanParentName(name) {
  return cleanTitle(name).replace(/^[\s\-—–]+|[\s\-—–]+$/g, '').trim();
}

// area 取【】内文字；无【】则原样返回 —— 与 build_snapshot.py clean_area 同口径
function cleanArea(area) {
  const a = String(area || '').trim();
  if (!a) return '';
  const m = a.match(new RegExp(B_OPEN + '(.*?)' + B_CLOSE));
  return m ? m[1].trim() : a;
}

// 去尾部分号 + trim（TAPD 的 owner/developer 常带尾随 ';'）
function clean(v) {
  return String(v || '').replace(/;+\s*$/, '').trim();
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { Authorization: `Bearer ${DFAI_API_TOKEN}`, Accept: 'application/json' },
      timeout: 15000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`DFAI ${res.statusCode}: ${buf.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error('DFAI 返回非 JSON: ' + buf.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('DFAI 请求超时')); });
  });
}

// 单个 release 的实时拉取（needParents=1 附带父需求，供 task_name 剥空时回退父需求名）
async function fetchStories(releaseId) {
  const u = new URL(`${DFAI_BASE}/aiapi/get_story`);
  u.searchParams.set('releaseId', releaseId);
  u.searchParams.set('type', '音频');
  u.searchParams.set('fields', 'id,name,status,release_id,owner,developer,creator,parent_id,type,area');
  u.searchParams.set('limit', '1000');
  u.searchParams.set('needParents', '1');
  const json = await httpsGetJson(u.toString());
  return Array.isArray(json.data) ? json.data : [];
}

// 过滤 + 映射：get_story 子单数组 → 快照 item 同构数组（纯函数，便于单测）
function toSnapshotItems(stories) {
  // needParents=1 附带进来的父需求（type=父需求、release_id 可能为空/0）也在此数组中；
  // 先建 id → 原始名 映射，供 task_name 剥空/「-」时回退父需求名。父需求本身不产出独立行（type 过滤排除）。
  const parentNameById = new Map();
  for (const s of stories) {
    parentNameById.set(String(s.id), String(s.name || ''));
  }

  const items = [];
  for (const s of stories) {
    const name = String(s.name || '');
    const type = String(s.type || s.story_type || '音频');
    const status = String(s.status || '');
    // 对齐用户 TAPD 界面口径：需求类型音频 + 标题含「语音-中」+ 所有未结束状态（排除挂起）
    if (type !== '音频') continue;
    if (!name.includes('语音-中')) continue;
    if (status === 'suspended' || s.v_status === '挂起') continue;

    const sid = String(s.id);
    const pid = String(s.parent_id || '').trim();
    const rel = RELEASE_MAP[String(s.release_id)] || '';
    if (!rel) continue; // 不在关注版本内（如 Yang2 尚未纳入）则跳过

    // task_name：剥【】后可能为空或「-」（Cutscene 子单标题全是【】标签）；此时回退显示父需求名
    let taskName = cleanTitle(name);
    if (!taskName || taskName === '-') {
      const pname = parentNameById.get(pid);
      if (pname && String(pname).trim()) {
        taskName = cleanParentName(pname) || String(pname).trim();
      } else {
        taskName = '-';
      }
    }

    const parentUrl = pid
      ? `https://tapd.woa.com/tapd_fe/${WORKSPACE_ID}/story/detail/${pid}`
      : `https://tapd.woa.com/tapd_fe/${WORKSPACE_ID}/story/detail/${sid}`;

    items.push({
      id: sid,
      parent_id: pid,
      parent_url: parentUrl,
      release_plan: rel,
      area: cleanArea(s.Area || s.area || s.custom_field_47),
      task_name: taskName,
      description: '',
      creator: clean(s.creator),
      developer: '',   // 与快照一致：暂不落真实开发人员，避免空→有值的展示变化
      handler: '',     // 与快照一致：暂不落真实处理人
      cn_lines_handler: '',
      video_sync: '无需视频',
      clarification: '',
      remark: '',
      tapd_url: s.detail_link || parentUrl,
      status: status || 'new', // 补充真实 TAPD 状态（快照原本缺此字段，恒 'new'）
    });
  }

  const order = { 'Yang1.0': 0 };
  items.sort((a, b) =>
    (order[a.release_plan] ?? 9) - (order[b.release_plan] ?? 9) ||
    a.area.localeCompare(b.area) ||
    a.task_name.localeCompare(b.task_name));
  return items;
}

// 拉全部关注版本并汇总
async function pullLiveDemands() {
  const all = [];
  for (const rid of Object.keys(RELEASE_MAP)) {
    all.push(...(await fetchStories(rid)));
  }
  return toSnapshotItems(all);
}

function isLiveReady() {
  return !!DFAI_API_TOKEN;
}

module.exports = { pullLiveDemands, toSnapshotItems, isLiveReady, RELEASE_MAP };
