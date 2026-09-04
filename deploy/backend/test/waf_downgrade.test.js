'use strict';
// 守卫测试：台词表生成 WAF/限流自动降级（2026-09-04）
//
// 背景：完整模式生成台词表需 ~80+ 次腾讯 MCP 调用，受腾讯 WAF 突发限流影响
// 会在中间某一步被网关拦截 → 任务失败。文案策划自己点会没耐心手工 retry，
// 故引入 runScriptTableWithFallback：完整模式撞 WAF 自动降级到 lite 模式重跑。
//
// 本测试锁住边界：
// 1) 完整模式 + WAF 错 → 降级生效（opts.lite=true、调用=2 次、downgraded=true）
// 2) 完整模式 + 业务错（非 WAF）→ 不降级，原样抛
// 3) lite 模式 + WAF 错 → 不再二次降级，原样抛（lite 已最简）
// 4) 完整模式成功 → 不降级，调用=1 次
// 5) 守卫：index.js script_table 分支已接入降级 wrapper

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runScriptTableWithFallback, WAF_RE } = require('../src/script_table_fallback');

// ---------- WAF 正则自身覆盖：与 cw_mcp_client.js 三种错误信息匹配 ----------

test('WAF_RE 命中 sheet-mcp 网关限流（实际触发源）', () => {
  assert.ok(WAF_RE.test('sheet-mcp 网关限流/WAF拦截(重试耗尽): ...'));
  assert.ok(WAF_RE.test('MCP 网关限流/WAF拦截(重试耗尽): ...'));
});

test('WAF_RE 命中 captcha / 限流 / 网关限流 / WAF 四类关键字', () => {
  ['captcha 拦截', '请求被限流', '网关限流', 'WAF blocked', '重试耗尽'].forEach(s => {
    assert.ok(WAF_RE.test(s), '应命中: ' + s);
  });
});

test('WAF_RE 不命中普通业务错误', () => {
  ['需求 task_name 缺失', '未获取到子表 ID', '权限不足'].forEach(s => {
    assert.ok(!WAF_RE.test(s), '不应命中: ' + s);
  });
});

// ---------- 降级行为 ----------

function makeDemand(id) {
  return { id: String(id), task_name: 'test-' + id };
}

// 统一构造 stub executor + 跑一次跑，记录每次调用参数
async function runOnce(jobLite, executor) {
  return await runScriptTableWithFallback(makeDemand('999'), jobLite, executor);
}

test('完整模式 + WAF 错 → 自动降级到 lite', async () => {
  const calls = [];
  const stub = {
    generateForDemand: async (dem, opts) => {
      calls.push({ id: dem.id, lite: !!opts.lite });
      if (!opts.lite) {
        const e = new Error('sheet-mcp 网关限流/WAF拦截(重试耗尽): <...>');
        throw e;
      }
      return { url: 'https://docs.qq.com/sheet/DOC-lite', file_id: 'F1', tab: '台词表', warnings: [] };
    }
  };
  const { result, downgraded } = await runOnce(false, stub);
  assert.strictEqual(calls.length, 2, '应调用 2 次（完整失败 + lite 重跑）');
  assert.strictEqual(calls[0].lite, false, '第一次 lite=false');
  assert.strictEqual(calls[1].lite, true, '第二次 lite=true');
  assert.strictEqual(downgraded, true, 'downgraded 标记为 true');
  assert.strictEqual(result.url, 'https://docs.qq.com/sheet/DOC-lite');
});

test('完整模式 + 业务错（非 WAF）→ 不降级，原样抛', async () => {
  const calls = [];
  const stub = {
    generateForDemand: async (dem, opts) => {
      calls.push({ lite: !!opts.lite });
      const e = new Error('需求 task_name 缺失');
      throw e;
    }
  };
  await assert.rejects(
    () => runOnce(false, stub),
    /task_name 缺失/
  );
  assert.strictEqual(calls.length, 1, '只调用 1 次，不降级');
  assert.strictEqual(calls[0].lite, false);
});

test('lite 模式 + WAF 错 → 不再二次降级，原样抛', async () => {
  const calls = [];
  const stub = {
    generateForDemand: async (dem, opts) => {
      calls.push({ lite: !!opts.lite });
      const e = new Error('MCP 网关限流/WAF拦截(重试耗尽)');
      throw e;
    }
  };
  await assert.rejects(
    () => runOnce(true, stub),
    /网关限流/
  );
  assert.strictEqual(calls.length, 1, 'lite 已是最简，不再二次降级');
  assert.strictEqual(calls[0].lite, true);
});

test('完整模式成功 → 不降级，调用 1 次，downgraded=false', async () => {
  const calls = [];
  const stub = {
    generateForDemand: async (dem, opts) => {
      calls.push({ lite: !!opts.lite });
      return { url: 'https://docs.qq.com/sheet/DOC-full', file_id: 'F2', tab: '台词表', warnings: [] };
    }
  };
  const { result, downgraded } = await runOnce(false, stub);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(downgraded, false);
  assert.strictEqual(result.url, 'https://docs.qq.com/sheet/DOC-full');
});

// ---------- 守卫：index.js 已接入降级 wrapper ----------

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

test('守卫：index.js 已引入 runScriptTableWithFallback', () => {
  assert.ok(
    /require\(['"]\.\/script_table_fallback['"]\)/.test(SRC),
    'index.js 应 require ./script_table_fallback'
  );
  assert.ok(
    /\{[^}]*\brunScriptTableWithFallback\b[^}]*\}/.test(SRC) ||
      /runScriptTableWithFallback\s*[,}]/.test(SRC) ||
      /const\s*\{\s*runScriptTableWithFallback/.test(SRC),
    'index.js 应解构出 runScriptTableWithFallback'
  );
});

test('守卫：script_table 分支已用降级 wrapper 替代直接 generateForDemand', () => {
  // 在 script_table 分支（紧跟 job.type === 'script_table' 之后的那段）里
  // 必须出现 runScriptTableWithFallback，且不能再有直接的 cwExecutor.generateForDemand 调用
  const idx = SRC.indexOf("job.type === 'script_table'");
  assert.ok(idx !== -1, '应存在 script_table 分支');
  const branchEnd = SRC.indexOf("job.type === 'voice_estimates'", idx);
  const branch = SRC.slice(idx, branchEnd === -1 ? idx + 600 : branchEnd);
  assert.ok(
    /runScriptTableWithFallback\s*\(/.test(branch),
    'script_table 分支应调用 runScriptTableWithFallback'
  );
  assert.ok(
    !/cwExecutor\.generateForDemand\s*\(/.test(branch),
    'script_table 分支不应再直接调 cwExecutor.generateForDemand'
  );
});

test('守卫：返回值带 downgraded 字段', () => {
  // 脚本表分支返回的对象里应含 downgraded
  const idx = SRC.indexOf("job.type === 'script_table'");
  const branchEnd = SRC.indexOf("job.type === 'voice_estimates'", idx);
  const branch = SRC.slice(idx, branchEnd === -1 ? idx + 600 : branchEnd);
  assert.ok(
    /downgraded/.test(branch),
    'script_table 返回值应包含 downgraded 字段（即使文仍带 warnings）'
  );
});
