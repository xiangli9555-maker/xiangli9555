'use strict';
// rebuild_snapshot.js — 复刻 dfai-live-server.js 的 mergeStories 逻辑，用磁盘原始数据重建 TAPD_SNAPSHOT
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2]; // tool-results 目录
const OUT_DIR = 'C:/Users/lycheelli/WorkBuddy/音频-Vo管理';
// 2026-07-24 14:49 · 带 Area 字段的完整拉取（原字段过滤丢了 Area 自定义字段，本次不指定 fields 拿全量）
const MA5_FILE = path.join(ROOT, 'mcp-connector-proxy-tapd-woa_proxy_execute_tool-1784875748168-c9a2a5.txt');   // Ma5 page1 (200)
const MA5_FILE2 = path.join(ROOT, 'mcp-connector-proxy-tapd-woa_proxy_execute_tool-1784875755166-e28d58.txt');  // Ma5 page2 (142)
const YANG1_FILE = path.join(ROOT, 'mcp-connector-proxy-tapd-woa_proxy_execute_tool-1784875762560-69d2f7.txt'); // Yang1 page1 (200)
const YANG1_FILE2 = path.join(OUT_DIR, 'yang1_page2.json');                    // Yang1 page2 (9)

const RELEASE_MAP = {
  '1020421949002192265': 'Ma5.0',
  '1020421949002200155': 'Yang1.0',
};
const WORKSPACE_ID = '20421949';
const SFX_BGM = /音效|bgm音乐|【bgm|BGM/i;
const B_OPEN = String.fromCharCode(0x3010);
const B_CLOSE = String.fromCharCode(0x3011);
const RE_ROLE = new RegExp(B_OPEN + '(?:语音|台词|选角|Vo\\.?|VO)[^' + B_CLOSE + ']*' + B_CLOSE, 'g');
const RE_OPEN_G = new RegExp(B_OPEN, 'g');
const RE_CLOSE_G = new RegExp(B_CLOSE, 'g');

function baseName(name) {
  const raw = String(name || '');
  let n = raw;
  let i;
  while ((i = n.indexOf(B_OPEN)) >= 0) {
    const j = n.indexOf(B_CLOSE, i);
    n = j >= 0 ? n.slice(0, i) + n.slice(j + 1) : n.slice(0, i);
  }
  n = n.replace(/\s{2,}/g, ' ').replace(/^[\s\-—–]+|[\s\-—–]+$/g, '').trim();
  if (n) return n;
  let m = raw.replace(RE_ROLE, '')
             .replace(RE_OPEN_G, ' ').replace(RE_CLOSE_G, ' ')
             .replace(/\s{2,}/g, ' ').replace(/\s*-\s*$/, '').trim();
  return m || (raw || '未命名需求');
}

// 权威：优先取 TAPD `Area` 字段（剥【】）；fallback 名字猜测。2026-07-24
function areaOf(name, story) {
  if (story && story.Area) {
    const a = String(story.Area).replace(/【|】/g, '').trim();
    if (a) return a;
  }
  if (name.includes('【兵种】')) return '干员';
  if (name.includes('【系统】')) return '系统';
  if (name.includes('【SOL】') || name.includes('【玩法：SOL】') || /\bSOL\b/i.test(name) || name.includes('/SOL')) return 'SOL';
  if (name.includes('大战场')) return '大战场';
  return 'SOL';
}

function splitRole(name) {
  let m = name.match(/【(语音|台词|选角)[-.·]?(英En|中En|英|中)?】/);
  if (m) return [m[1], m[2] || null];
  let mv = name.match(/【Vo\.语音-(英|中)】/);
  if (mv) return ['语音', mv[1]];
  return [null, null];
}

// 是否为 VO 类子单（含角色拆单标签）。VO 类永不因 SFX_BGM 被误杀。
function isVO(name) {
  const n = String(name || '');
  return /【(语音|台词|选角)/.test(n) || /【Vo\.语音/.test(n);
}

const PROG_FIELD = {
  '台词|中': 'progress_lines_cn', '台词|英': 'progress_lines_en',
  '台词|英En': 'progress_lines_en',
  '语音|中': 'progress_voice_cn', '语音|英': 'progress_voice_en',
};
// PM 定稿 2026-07-24：验收中/合入中 归"进行中"；"已实现" 才算已完成
function progOf(v) {
  const map = {
    '未开始': '未开始', 'new': '未开始', 'status_1': '未开始',
    '规划中': '进行中', 'planning': '进行中',
    '实现中': '进行中', 'in_progress': '进行中',
    '测试中': '进行中', 'testing': '进行中',
    '验收中': '进行中', 'audited': '进行中',
    '合入中': '进行中',
    '已实现': '已完成',
    '已发布': '已完成',
    'closed': '已完成', 'resolved': '已完成', 'product_experience': '已完成',
  };
  return map[v] || '未开始';
}
const VIDEO_KEYWORDS = ['视频', 'cutscene', 'Sequence', '演绎', '入场', '撤离', '动画'];
const PRIORITY = { '台词-中': 0, '语音-中': 1, '台词-英': 2, '语音-英': 3, '选角-中': 4, '选角-英': 5, '台词-英En': 6 };
function clean(v) { return String(v || '').replace(/;+\s*$/, '').trim(); }

function mergeStories(stories) {
  const filtered = stories.filter(s => {
    const rel = RELEASE_MAP[String(s.release_id)];
    if (!rel) return false;
    const status = String(s.status || '');
    if (status === 'suspended' || s.v_status === '挂起') return false;
    const type = String(s.type || s.story_type || '音频');
    if (type !== '音频') return false;
    // 仅对「非 VO 类」纯音效/BGM 子单做 SFX 过滤；含角色拆单标签的 VO 叶永不误杀
    if (!isVO(s.name) && SFX_BGM.test(String(s.name || ''))) return false;
    return true;
  });

  const groups = new Map();
  for (const s of filtered) {
    const pid = String(s.parent_id || s.id);
    if (!groups.has(pid)) groups.set(pid, []);
    groups.get(pid).push(s);
  }

  const rows = [];
  for (const [pid, subsRaw] of groups) {
    const rel = RELEASE_MAP[String(subsRaw[0].release_id)] || '';
    const subs = subsRaw.slice().sort((a, b) => {
      const ka = splitRole(String(a.name || ''));
      const kb = splitRole(String(b.name || ''));
      const ta = ka[0] && ka[1] ? `${ka[0]}-${ka[1]}` : (ka[0] || '');
      const tb = kb[0] && kb[1] ? `${kb[0]}-${kb[1]}` : (kb[0] || '');
      return (PRIORITY[ta] ?? 99) - (PRIORITY[tb] ?? 99);
    });

    const cells = {
      progress_lines_cn: '未开始', progress_lines_en: '未开始',
      progress_voice_cn: '未开始', progress_voice_en: '未开始',
    };
    let cnHandler = '';
    let cnDeveloper = '';
    let voiceCnRaw = ''; // 2026-07-24：语音-中子单原始状态，供前端 tapdStage 区分 规划中/实现中
    const ids = [];
    const tags = [];

    for (const s of subs) {
      const [kind, lang] = splitRole(String(s.name || ''));
      ids.push(String(s.id));
      tags.push(kind ? `${kind}-${lang || '?'}` : String(s.name || '').slice(0, 12));

      if (kind === '台词' && lang === '中') {
        const dev = clean(s.developer);
        const own = clean(s.owner);
        if (!cnHandler) cnHandler = dev || own;
        if (!cnDeveloper) cnDeveloper = dev;
      }
      if (kind === '语音' && lang === '中' && !voiceCnRaw && String(s.status) !== 'suspended') {
        voiceCnRaw = String(s.v_status || s.status || '');
      }

      const pf = PROG_FIELD[`${kind}|${lang}`];
      if (pf && String(s.status) !== 'suspended') {
        const pv = progOf(s.v_status || s.status);
        if (cells[pf] === '未开始') cells[pf] = pv;
        else if (pv === '已完成' && cells[pf] !== '已完成') cells[pf] = pv;
      }
    }

    const rep = subs[0];
    const hasVoiceCN = subs.some(s => {
      const [k, l] = splitRole(String(s.name || ''));
      return k === '语音' && l === '中';
    });
    if (!hasVoiceCN) continue;

    // 围城（siege）内容不在 PM 的 TAPD 视图内（用户 Ma5 视图 25 条均不含围城），对齐过滤
    if (subs.some(s => baseName(String(s.name || '')).includes('围城'))) continue;

    if (!cnHandler) cnHandler = clean(rep.developer) || clean(rep.owner);
    if (!cnDeveloper) cnDeveloper = clean(rep.developer);

    const bn = baseName(String(rep.name || ''));
    const vs = VIDEO_KEYWORDS.some(w => bn.includes(w)) ? '音画同步' : '无需视频';

    rows.push({
      id: String(rep.id),
      release_plan: rel,
      area: areaOf(String(rep.name || ''), rep),
      task_name: bn,
      creator: clean(rep.creator),
      developer: cnDeveloper,
      cn_lines_handler: cnHandler,
      video_sync: vs,
      clarification: '',
      _voice_cn_raw: voiceCnRaw,
      progress_lines_cn: cells.progress_lines_cn,
      progress_lines_en: cells.progress_lines_en,
      progress_voice_cn: cells.progress_voice_cn,
      progress_voice_en: cells.progress_voice_en,
      remark: '',
      tapd_url: `https://tapd.woa.com/tapd_fe/${WORKSPACE_ID}/story/detail/${pid || rep.id}`,
      _sub_count: subs.length,
      _sub_tags: tags.join(','),
    });
  }

  const order = { 'Ma5.0': 0, 'Yang1.0': 1 };
  rows.sort((a, b) =>
    (order[a.release_plan] ?? 9) - (order[b.release_plan] ?? 9) ||
    a.area.localeCompare(b.area) ||
    a.task_name.localeCompare(b.task_name));
  return rows;
}

function load(file) {
  const txt = fs.readFileSync(file, 'utf8');
  const obj = JSON.parse(txt);
  return obj.data || [];
}

const ma5 = load(MA5_FILE).concat(load(MA5_FILE2));
const yang1 = load(YANG1_FILE).concat(load(YANG1_FILE2));
const all = ma5.concat(yang1);

console.error(`Loaded: Ma5=${ma5.length}, Yang1=${yang1.length}, total=${all.length}`);
const rows = mergeStories(all);
const ma5Rows = rows.filter(r => r.release_plan === 'Ma5.0');
const yang1Rows = rows.filter(r => r.release_plan === 'Yang1.0');
console.error(`Snapshot rows: total=${rows.length}, Ma5=${ma5Rows.length}, Yang1=${yang1Rows.length}`);

// 输出 JSON 供校验
fs.writeFileSync(path.join(OUT_DIR, '_rebuilt_snapshot.json'), JSON.stringify(rows, null, 2));
// 输出 JS 字面量供插入 HTML
const jsLiteral = 'const TAPD_SNAPSHOT = ' + JSON.stringify(rows, null, 2) + ';';
fs.writeFileSync(path.join(OUT_DIR, '_rebuilt_snapshot.js'), jsLiteral);
console.error('Wrote _rebuilt_snapshot.json and _rebuilt_snapshot.js');
