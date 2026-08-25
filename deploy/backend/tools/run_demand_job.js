#!/usr/bin/env node
/**
 * 台词表生成 Job 端到端验证脚本（容器内运行）
 *
 * 用途：提交一个 script_table Job 并轮询到终态，打印完整 Job 记录。
 *   docker exec vo-backend node /app/tools/run_demand_job.js <demand_id> [max_poll] [lite]
 *   第 4 个参数传 "lite" 即以 lite 模式提交（仅写核心数据，规避腾讯 WAF 突发限流）。
 *
 * 为什么需要它：
 *   - 容器内无 curl；且 ssh -> docker exec -> node -e 的多层引号嵌套极易炸裂。
 *   - 固化成文件后可反复调用，避免每次重写内联脚本。
 */
const http = require('http');

const DEMAND_ID = String(process.argv[2] || '103');
const MAX_POLL = Number(process.argv[3] || 80);
const LITE = process.argv[4] === 'lite';
const PORT = Number(process.env.PORT || 3001);

function request(opts, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve(buf));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  const payload = JSON.stringify({ type: 'script_table', demand_id: DEMAND_ID, force: true, lite: LITE });
  const posted = await request(
    { host: '127.0.0.1', port: PORT, path: '/api/cw-doc/jobs', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
    payload
  );

  let jobId = '';
  try { jobId = ((JSON.parse(posted) || {}).job || {}).id || ''; } catch (e) { /* noop */ }
  if (!jobId) {
    console.log('SUBMIT_FAILED', posted.slice(0, 400));
    process.exit(1);
  }
  console.log('NEW_JOB', jobId, 'demand', DEMAND_ID);

  for (let i = 0; i < MAX_POLL; i++) {
    const out = await request({ host: '127.0.0.1', port: PORT, path: '/api/cw-doc/jobs?demand_id=' + encodeURIComponent(DEMAND_ID) });
    let job = null;
    try { job = ((JSON.parse(out) || {}).jobs || []).find((x) => x.id === jobId) || null; } catch (e) { /* noop */ }
    const status = job ? job.status : '?';
    if (i % 4 === 0) console.log('poll', i, status);
    if (status === 'done' || status === 'failed') {
      console.log('=== TERMINAL:', status, '===');
      const elapsed = job.started_at && job.finished_at
        ? Math.round((new Date(job.finished_at) - new Date(job.started_at)) / 1000) + 's'
        : 'n/a';
      console.log('elapsed', elapsed);
      if (job.error) console.log('ERROR', String(job.error).slice(0, 500));
      console.log('RESULT', JSON.stringify(job.result || {}).slice(0, 600));
      process.exit(status === 'done' ? 0 : 2);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log('POLL_TIMEOUT');
  process.exit(3);
})().catch((e) => { console.log('SCRIPT_ERR', e.message); process.exit(1); });
