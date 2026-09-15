// 台词库总表「录入覆盖度」：从版本级唯一总表的 1.1声优锁 / 1.2音画同步 两页
// 抽取已录入的 Story 清单，生成 deploy/backend/library_coverage.json 快照；
// 再与 demands 表的需求池比对，得出「已录入 X / 池内 N 条需求」。
//
// 链路与 schedule_refresh.js 完全一致（wecom-cli → CSV → python → 原子写 JSON），
// 唯一差别：这里一次拉两页，python 端按表头名定位列并跨页归并 Story。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const WECOM_CLI = process.env.WECOM_CLI_PATH || '/usr/local/bin/wecom-cli';
const WECOM_HOME = process.env.WECOM_HOME || '/home/node';
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const PULL_SCRIPT = process.env.LIBRARY_COVERAGE_PULL_SCRIPT || '/app/tools/pull_library_coverage.py';
const SNAPSHOT = process.env.LIBRARY_COVERAGE_SNAPSHOT_PATH || path.resolve(__dirname, '..', 'library_coverage.json');
const DOC_ID = process.env.SCHEDULE_DOC_ID || 'e3_ADIABnivAPACNvqm90kNtQyOgdAut_a';
const TIMEOUT_MS = Number(process.env.LIBRARY_REFRESH_TIMEOUT_MS || 60000);

// 覆盖度只看「录入侧」两页：1.1声优锁（声优预估）+ 1.2音画同步（视频同步）
const SHEETS = [
  { sheet_id: process.env.LIBRARY_SHEET_11 || '000001', sheet_name: '1.1声优锁' },
  { sheet_id: process.env.LIBRARY_SHEET_12 || '000002', sheet_name: '1.2音画同步' },
];

let inflight = null;

function run(cmd, args, opts) {
  const options = opts || {};
  const { input, timeout, env, cwd } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env, cwd });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { if (out.length < 8 * 1024 * 1024) out += d; });
    child.stderr.on('data', d => { if (err.length < 64 * 1024) err += d; });
    let timer = null;
    if (timeout) timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} reject(new Error('timeout after ' + timeout + 'ms')); }, timeout);
    const done = fn => { if (timer) clearTimeout(timer); fn(); };
    child.on('error', e => done(() => reject(e)));
    child.on('close', code => done(() => {
      if (code === 0) return resolve(out);
      const detail = err.trim() || out.trim() || ('exit code ' + code);
      const e = new Error(detail.slice(0, 800));
      e.code = code;
      reject(e);
    }));
    try { child.stdin.end(input == null ? '' : input); } catch (_) { /* stdin 已关 */ }
  });
}

function preflight() {
  if (!fs.existsSync(WECOM_CLI)) {
    return { ok: false, error: 'wecom_cli_missing', hint: `未找到 wecom-cli：${WECOM_CLI}` };
  }
  if (!fs.existsSync(PULL_SCRIPT)) {
    return { ok: false, error: 'pull_script_missing', hint: `未找到解析脚本：${PULL_SCRIPT}` };
  }
  return { ok: true };
}

async function fetchSheetCsv(sheetId) {
  const payload = JSON.stringify({ docid: DOC_ID, sheet_id: sheetId, mode: 'csv' });
  const raw = await run(WECOM_CLI, ['sheet', 'ranges', 'get', '--json', payload], {
    env: { ...process.env, HOME: WECOM_HOME, PATH: `${path.dirname(WECOM_CLI)}:${process.env.PATH || '/usr/bin:/bin'}` },
    timeout: TIMEOUT_MS,
  });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const err = new Error('cli_output_not_json: ' + String(raw || '').slice(0, 300));
    err.reason = 'cli_output_not_json';
    throw err;
  }
  const csv = parsed && typeof parsed.content === 'string' ? parsed.content : '';
  return csv;
}

async function refresh() {
  const ready = preflight();
  if (!ready.ok) return ready;

  const sheets = [];
  for (const sh of SHEETS) {
    const csv = await fetchSheetCsv(sh.sheet_id);
    if (!csv.trim()) {
      const err = new Error(`sheet_empty: ${sh.sheet_name}(${sh.sheet_id})`);
      err.reason = 'sheet_empty';
      throw err;
    }
    sheets.push({ sheet_id: sh.sheet_id, sheet_name: sh.sheet_name, csv });
  }

  const stdinPayload = JSON.stringify({
    release: process.env.LIBRARY_RELEASE || 'Yang1.0',
    docid_hint: process.env.LIBRARY_DOCID_HINT || '台词库总表',
    sheets,
  });

  const out = await run(PYTHON_BIN, [PULL_SCRIPT], {
    input: stdinPayload,
    timeout: TIMEOUT_MS,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });

  let data;
  try {
    data = JSON.parse(out);
  } catch (e) {
    const err = new Error('pull_script_invalid_json: ' + String(out || '').slice(0, 300));
    err.reason = 'pull_script_invalid_json';
    throw err;
  }
  if (!data || !Array.isArray(data.stories) || !data.stories.length) {
    const err = new Error('no_stories: 解析结果为空，总表结构可能已变化');
    err.reason = 'no_stories';
    throw err;
  }

  // 先写临时文件再 rename，避免半截 JSON 被前端读到
  const tmp = `${SNAPSHOT}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, SNAPSHOT);

  return {
    ok: true,
    release: data.release || 'Yang1.0',
    story_count: data.story_count || 0,
    role_row_count: data.role_row_count || 0,
    fetched_at: data.fetched_at || new Date().toISOString().slice(0, 19),
    docid_hint: data.docid_hint || '',
  };
}

function refreshShared() {
  if (inflight) return inflight;
  inflight = refresh()
    .then(r => { inflight = null; return r; })
    .catch(e => {
      inflight = null;
      const reason = (e && e.reason) || 'refresh_failed';
      return { ok: false, error: reason, hint: e && e.message ? e.message : String(e) };
    });
  return inflight;
}

// 与前端 fmtStoryTitle 口径一致：去掉成对【…】段，压缩空白，忽略大小写
function normalizeStoryKey(s) {
  let v = String(s == null ? '' : s);
  v = v.replace(/【[^】]*】/g, '');
  v = v.replace(/\s+/g, ' ').trim().toLowerCase();
  return v;
}

function normRelease(s) {
  return String(s || '').trim().replace(/\.0+$/, '').toLowerCase();
}

function readSnapshot(release) {
  let txt;
  try {
    txt = fs.readFileSync(SNAPSHOT, 'utf8');
  } catch (e) {
    return { ok: false, error: 'coverage_snapshot_missing' };
  }
  let data;
  try {
    data = JSON.parse(txt);
  } catch (e) {
    return { ok: false, error: 'coverage_snapshot_invalid_json' };
  }
  if (release && data.release && normRelease(data.release) !== normRelease(release)) {
    return { ok: false, error: 'release_mismatch', want: release, snapshot_release: data.release };
  }
  return { ok: true, data };
}

// 把总表抽出的 Story 与需求池比对，得出覆盖度
function computeCoverage(snapshot, demands) {
  const stories = (snapshot && Array.isArray(snapshot.stories)) ? snapshot.stories : [];
  const pool = Array.isArray(demands) ? demands : [];

  const poolByKey = new Map();
  for (const d of pool) {
    const k = normalizeStoryKey(d.task_name || d.title || d.name);
    if (!k) continue;
    if (!poolByKey.has(k)) poolByKey.set(k, []);
    poolByKey.get(k).push(d);
  }

  const matched = [];
  const unmatched = [];
  const matchedIds = [];
  for (const s of stories) {
    const k = normalizeStoryKey(s.story);
    const hit = k ? poolByKey.get(k) : null;
    if (hit && hit.length) {
      for (const d of hit) {
        if (d && d.id != null && !matchedIds.includes(d.id)) matchedIds.push(d.id);
      }
      matched.push({ story: s.story, areas: s.areas || [], role_rows: s.role_rows || 0, est_lines: s.est_lines || 0, demand_ids: hit.map(d => d.id) });
    } else {
      unmatched.push({ story: s.story, areas: s.areas || [], role_rows: s.role_rows || 0 });
    }
  }

  const total = pool.length;
  const covered = matchedIds.length;
  return {
    total,
    covered,
    coverage: total ? Math.round((covered / total) * 1000) / 1000 : 0,
    missing: Math.max(0, total - covered),
    matched,
    unmatched,
    matched_ids: matchedIds,
  };
}

module.exports = {
  refresh: refreshShared,
  preflight,
  readSnapshot,
  computeCoverage,
  normalizeStoryKey,
  normRelease,
  SNAPSHOT,
  WECOM_CLI,
  PULL_SCRIPT,
  SHEETS,
  DOC_ID,
};
