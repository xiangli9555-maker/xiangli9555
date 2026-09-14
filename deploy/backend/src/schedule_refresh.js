// 实时从企微「Vomi台词库」在线表格的「3.录制档期」页拉取档期快照。
// 链路：wecom-cli（容器内二进制 + 挂载的机器人凭证）→ CSV → pull_schedule_from_sheet.py → schedule_from_sheet.json
//
// 与本地手工 SOP 的唯一差别：这里在容器里跑，凭证由 docker-compose 只读挂载，
// 生成结果与本地 `python pull_schedule_from_sheet.py` 完全一致。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const WECOM_CLI = process.env.WECOM_CLI_PATH || '/usr/local/bin/wecom-cli';
const WECOM_HOME = process.env.WECOM_HOME || '/home/node';
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const PULL_SCRIPT = process.env.SCHEDULE_PULL_SCRIPT || '/app/tools/pull_schedule_from_sheet.py';
const SNAPSHOT = process.env.SCHEDULE_SNAPSHOT_PATH || path.resolve(__dirname, '..', 'schedule_from_sheet.json');
const DOC_ID = process.env.SCHEDULE_DOC_ID || 'e3_ADIABnivAPACNvqm90kNtQyOgdAut_a';
const SHEET_ID = process.env.SCHEDULE_SHEET_ID || 'rqt0n2';
const TIMEOUT_MS = Number(process.env.SCHEDULE_REFRESH_TIMEOUT_MS || 60000);

let inflight = null; // 并发保护：同一时刻只允许一个刷新任务

// 注意：异步 execFile 不支持 options.input（stdin 管道不会关闭 → python 永远等输入而挂死），
// 因此这里用 spawn 显式写 stdin 并 end()。
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

async function refresh() {
  const ready = preflight();
  if (!ready.ok) return ready;

  const payload = JSON.stringify({ docid: DOC_ID, sheet_id: SHEET_ID, mode: 'csv' });
  const raw = await run(WECOM_CLI, ['sheet', 'ranges', 'get', '--json', payload], {
    env: { ...process.env, HOME: WECOM_HOME, PATH: `${path.dirname(WECOM_CLI)}:${process.env.PATH || '/usr/bin:/bin'}` },
    timeout: TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'utf8',
  });

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: 'cli_output_not_json', hint: String(raw || '').slice(0, 300) };
  }
  const csv = parsed && typeof parsed.content === 'string' ? parsed.content : '';
  if (!csv.trim()) {
    return { ok: false, error: 'sheet_empty', hint: '表格返回空内容，请检查 docid / sheet_id 与机器人权限' };
  }

  const out = await run(PYTHON_BIN, [PULL_SCRIPT], {
    input: csv,
    timeout: TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });

  let data;
  try {
    data = JSON.parse(out);
  } catch (e) {
    return { ok: false, error: 'pull_script_invalid_json', hint: String(out || '').slice(0, 300) };
  }
  if (!data || !Array.isArray(data.records) || !data.records.length) {
    return { ok: false, error: 'no_records', hint: '解析结果为空，表格结构可能已变化' };
  }

  // 先写临时文件再 rename，避免半截 JSON 被前端读到
  const tmp = `${SNAPSHOT}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, SNAPSHOT);

  return {
    ok: true,
    release: data.release || 'Yang1',
    count: data.records.length,
    fetched_at: data.fetched_at || new Date().toISOString().slice(0, 19),
    docid_hint: data.docid_hint || '',
    sheet_name: data.sheet_name || '',
  };
}

// 并发保护：刷新期间再次请求直接复用同一个 promise
function refreshShared() {
  if (inflight) return inflight;
  inflight = refresh()
    .then(r => { inflight = null; return r; })
    .catch(e => { inflight = null; return { ok: false, error: 'refresh_failed', hint: e && e.message ? e.message : String(e) }; });
  return inflight;
}

module.exports = { refresh: refreshShared, preflight, SNAPSHOT, WECOM_CLI, PULL_SCRIPT };
