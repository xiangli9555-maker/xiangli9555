// 守卫：台词载体从「每个需求一张台词表」切换为「版本级 1 份台词库总表」后，
// 需求汇总页 KPI 必须显示「总表录入覆盖度」= 总表 1.1+1.2 里出现过的需求数 / 需求池。
// ① 后端注册 GET /api/library-coverage + POST /api/library-coverage/refresh
// ② 刷新链路与 schedule_refresh 同构：spawn + stdin.end + .tmp → renameSync（禁 execFile）
// ③ 解析脚本按表头名定位列（总表列结构会演进），数据从第 3 行起
// ④ 前端 KPI 卡改名为「台词库总表」，不再用 script_doc_url 计数
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..');
const ROOT = path.resolve(__dirname, '../../..');
const indexSrc = fs.readFileSync(path.join(BACKEND, 'src', 'index.js'), 'utf8');
const covSrc = fs.readFileSync(path.join(BACKEND, 'src', 'library_coverage.js'), 'utf8');
const pySrc = fs.readFileSync(path.join(BACKEND, 'tools', 'pull_library_coverage.py'), 'utf8');
const demandsHtml = fs.readFileSync(path.join(ROOT, 'preview-需求汇总-精修版.html'), 'utf8');

test('后端注册覆盖度端点', () => {
  assert.ok(indexSrc.includes("app.get('/api/library-coverage'"), '缺少 GET /api/library-coverage');
  assert.ok(indexSrc.includes("app.post('/api/library-coverage/refresh'"), '缺少 POST /api/library-coverage/refresh');
  assert.ok(indexSrc.includes('libraryCoverage.refresh()'), 'refresh 端点未调用刷新模块');
  assert.ok(indexSrc.includes('libraryCoverage.computeCoverage('), 'GET 端点未做覆盖度比对');
});

test('覆盖度刷新链路与档期刷新同构（禁 execFile，必须原子写）', () => {
  assert.ok(covSrc.includes("'sheet', 'ranges', 'get', '--json'"), '未调用 wecom-cli sheet ranges get');
  assert.ok(covSrc.includes("mode: 'csv'"), '未要求 csv 模式');
  assert.ok(covSrc.includes('parsed.content'), '未取 CLI 返回体的 content 字段');
  assert.ok(covSrc.includes('.tmp`'), '未使用临时文件');
  assert.ok(covSrc.includes('fs.renameSync(tmp, SNAPSHOT)'), '未原子 rename 覆写快照');
  assert.ok(/spawn\(/.test(covSrc), '应使用 spawn 显式写 stdin');
  assert.ok(covSrc.includes('child.stdin.end('), '写完必须 end() stdin');
  // 2026-09-14 踩坑：异步 execFile 的 options.input 无效 → python 等 stdin 挂死
  assert.ok(!/execFile\s*\(/.test(covSrc), '禁用 execFile：其 input 选项无效会导致子进程挂死');
});

test('覆盖度只统计录入侧两页：1.1声优锁 + 1.2音画同步', () => {
  assert.ok(covSrc.includes('1.1声优锁'), '未声明 1.1声优锁 页');
  assert.ok(covSrc.includes('1.2音画同步'), '未声明 1.2音画同步 页');
  const sheetsBlock = covSrc.slice(covSrc.indexOf('const SHEETS'), covSrc.indexOf('let inflight'));
  assert.strictEqual((sheetsBlock.match(/sheet_id:/g) || []).length, 2, 'SHEETS 应恰好两页');
});

test('解析脚本按表头名定位列，数据从第 3 行起', () => {
  assert.ok(pySrc.includes('def find_col('), '解析脚本应按表头名定位列，不能写死下标');
  assert.ok(pySrc.includes('rows[2:]'), '前 2 行是表头 + 填写人说明，数据应从第 3 行起');
  assert.ok(pySrc.includes("'Story'"), '未定位 Story 列');
  assert.ok(!/print\(/.test(pySrc.split('if __name__')[1] || ''), 'stdout 只能有 JSON，禁止 print');
});

test('Story 归并键与前端 fmtStoryTitle 同口径：去【…】+ 压空白 + 忽略大小写', () => {
  const modPath = path.join(BACKEND, 'src', 'library_coverage.js');
  delete require.cache[require.resolve(modPath)];
  const mod = require(modPath);
  assert.strictEqual(mod.normalizeStoryKey('【系统】Test 02- For  Vo Manager 围城定律'), 'test 02- for vo manager 围城定律');
  assert.strictEqual(mod.normalizeStoryKey('  Test 02  '), mod.normalizeStoryKey('test 02'));
  assert.strictEqual(mod.normRelease('Yang1.0'), mod.normRelease('yang1'));
  delete require.cache[require.resolve(modPath)];
});

test('覆盖度计算：跨页同一 Story 只算一条需求', () => {
  const modPath = path.join(BACKEND, 'src', 'library_coverage.js');
  delete require.cache[require.resolve(modPath)];
  const mod = require(modPath);
  const snapshot = {
    stories: [
      { story: 'Test 02- For Vo Manager 围城定律', areas: ['SOL'], role_rows: 28, est_lines: 794 },
      { story: 'test 04- For Vo Manager 赛季任务', areas: ['系统'], role_rows: 6, est_lines: 130 },
      { story: '表格里有但需求池没有的', areas: [], role_rows: 1, est_lines: 1 },
    ],
  };
  const demands = [
    { id: 133, task_name: 'Test 02- For Vo Manager 围城定律' },
    { id: 132, task_name: '【系统】test 04- For Vo Manager 赛季任务' },
    { id: 120, task_name: '别的需求' },
  ];
  const r = mod.computeCoverage(snapshot, demands);
  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.covered, 2, '跨页同一 Story 只应计一条需求');
  assert.strictEqual(r.missing, 1);
  assert.strictEqual(r.coverage, 0.667);
  assert.deepStrictEqual(r.matched_ids, [133, 132]);
  assert.strictEqual(r.unmatched.length, 1);
  assert.strictEqual(r.unmatched[0].story, '表格里有但需求池没有的');
  delete require.cache[require.resolve(modPath)];
});

test('镜像带上解析脚本与初始快照；远端同步清单含新快照', () => {
  const dockerfile = fs.readFileSync(path.join(BACKEND, 'Dockerfile'), 'utf8');
  assert.ok(/COPY\s+--chown=node:node tools \.\/tools/.test(dockerfile), 'tools/ 未 COPY 进镜像');
  assert.ok(/COPY\s+--chown=node:node library_coverage\.json/.test(dockerfile), 'library_coverage.json 未 COPY 进镜像');

  const remote = fs.readFileSync(path.join(ROOT, 'release', 'remote-deploy.sh'), 'utf8');
  assert.ok(/schedule_from_sheet\.json library_coverage\.json/.test(remote), 'remote-deploy 同步清单未含 library_coverage.json');

  const compose = fs.readFileSync(path.join(BACKEND, '..', 'docker-compose.yml'), 'utf8');
  assert.ok(/LIBRARY_COVERAGE_PULL_SCRIPT:\s*\/app\/tools\/pull_library_coverage\.py/.test(compose), 'compose 未声明解析脚本路径');
});

test('需求汇总页 KPI 卡改名并改走覆盖度接口', () => {
  assert.ok(demandsHtml.includes('LINES · 台词库总表'), 'KPI 卡标题未改为台词库总表');
  assert.ok(demandsHtml.includes('/api/library-coverage?release='), 'KPI 未读取覆盖度接口');
  assert.ok(demandsHtml.includes('版本级唯一总表'), '副标未点明版本级唯一总表');
  // 退役旧口径：KPI 不得再按 script_doc_url 计数
  const kpiFn = demandsHtml.slice(demandsHtml.indexOf('function updateKPI(){'), demandsHtml.indexOf('function updateKPI(){') + 4000);
  assert.ok(!/script_doc_url/.test(kpiFn), 'updateKPI 仍在按 script_doc_url 统计台词表');
});
