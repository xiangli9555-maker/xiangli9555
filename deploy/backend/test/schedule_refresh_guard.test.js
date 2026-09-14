// 守卫：录制档期页「从 Vo 版本汇总表同步」必须走实时刷新链路。
// ① 后端注册 POST /api/schedule-from-sheet/refresh + status 自诊断
// ② CLI/解析脚本缺失时给出可读错误，不得 500 静默
// ③ 前端按钮先 POST 刷新再读快照
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..');
const indexSrc = fs.readFileSync(path.join(BACKEND, 'src', 'index.js'), 'utf8');
const schedSrc = fs.readFileSync(path.join(BACKEND, 'src', 'schedule_refresh.js'), 'utf8');
const schedHtml = fs.readFileSync(path.resolve(__dirname, '../../../preview-录制档期-精修版.html'), 'utf8');

test('后端注册实时刷新端点与自诊断端点', () => {
  assert.ok(indexSrc.includes("app.post('/api/schedule-from-sheet/refresh'"), '缺少 POST /api/schedule-from-sheet/refresh');
  assert.ok(indexSrc.includes("app.get('/api/schedule-from-sheet/refresh/status'"), '缺少 GET .../refresh/status');
  assert.ok(indexSrc.includes('scheduleRefresh.refresh()'), 'refresh 端点未调用刷新模块');
});

test('刷新模块：wecom-cli → CSV → python 解析 → 原子覆写快照', () => {
  assert.ok(schedSrc.includes("'sheet', 'ranges', 'get', '--json'"), '未调用 wecom-cli sheet ranges get');
  assert.ok(schedSrc.includes('mode: \'csv\''), '未要求 csv 模式');
  assert.ok(schedSrc.includes('parsed.content'), '未取 CLI 返回体的 content 字段');
  assert.ok(schedSrc.includes('.tmp`'), '未使用临时文件');
  assert.ok(schedSrc.includes('fs.renameSync(tmp, SNAPSHOT)'), '未原子 rename 覆写快照');
  // 2026-09-14 踩坑：异步 execFile 不支持 options.input，stdin 不关 → python 挂死
  assert.ok(!/execFile\s*\(/.test(schedSrc), '禁用 execFile：其 input 选项无效会导致子进程挂死');
  assert.ok(schedSrc.includes('spawn('), '应使用 spawn 显式写 stdin');
  assert.ok(schedSrc.includes('child.stdin.end('), '写完必须 end() stdin');
});

test('CLI 缺失时返回可诊断错误而非崩溃', () => {
  const modPath = path.join(BACKEND, 'src', 'schedule_refresh.js');
  delete require.cache[require.resolve(modPath)];
  process.env.WECOM_CLI_PATH = '/definitely/not/here/wecom-cli';
  process.env.SCHEDULE_PULL_SCRIPT = '/definitely/not/here/pull.py';
  const mod = require(modPath);
  const p = mod.preflight();
  delete require.cache[require.resolve(modPath)];
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.error, 'wecom_cli_missing');
  assert.ok(/wecom-cli/.test(p.hint || ''), '提示里应点名 wecom-cli');
});

test('镜像与挂载：必须 glibc 基础镜像 + python3/证书 + CLI 与凭证只读挂载', () => {
  const dockerfile = fs.readFileSync(path.join(BACKEND, 'Dockerfile'), 'utf8');
  assert.ok(!/FROM\s+node:\S*alpine/i.test(dockerfile), 'alpine(musl) 跑不了 wecom-cli 原生二进制，必须 glibc 基础镜像');
  assert.ok(/FROM\s+node:\S*slim/i.test(dockerfile), '应使用 Debian slim 基础镜像');
  assert.ok(/python3/.test(dockerfile), 'Dockerfile 需安装 python3');
  assert.ok(/ca-certificates/.test(dockerfile), 'Dockerfile 需安装 ca-certificates（wecom-cli 走 HTTPS）');
  assert.ok(/home\/node\/.config\/wecom\/cache/.test(dockerfile), '需预建可写的 wecom cache 目录');

  const compose = fs.readFileSync(path.join(BACKEND, '..', 'docker-compose.yml'), 'utf8');
  assert.ok(/wecom-cli:\/usr\/local\/bin\/wecom-cli:ro/.test(compose), 'compose 未只读挂载 wecom-cli');
  assert.ok(/credentials\.enc:\/home\/node\/.config\/wecom\/credentials\.enc:ro/.test(compose), 'compose 未挂载凭证');
  assert.ok(/\.encryption_key:\/home\/node\/.config\/wecom\/.encryption_key:ro/.test(compose), 'compose 未挂载加密密钥');
  assert.ok(/WECOM_HOME:\s*\/home\/node/.test(compose), 'compose 未设置 WECOM_HOME');
});

test('前端同步按钮先 POST 刷新，再读快照', () => {
  const fn = schedHtml.slice(schedHtml.indexOf('window.syncFromVersionSummary=function'));
  const body = fn.slice(0, fn.indexOf('\n  };'));
  assert.ok(body.includes("method:'POST'"), '同步未发起 POST 刷新');
  assert.ok(body.includes('/api/schedule-from-sheet/refresh'), '刷新端点路径不对');
  const iPost = body.indexOf('/api/schedule-from-sheet/refresh');
  const iGet = body.indexOf("'/api/schedule-from-sheet?release='");
  assert.ok(iPost >= 0 && iGet > iPost, '必须先 POST 刷新再 GET 快照');
  assert.ok(body.includes('回退上次快照'), '刷新失败未提示回退');
  assert.ok(body.includes("__VOMI_GUEST__"), '预览模式未跳过写请求');
});
