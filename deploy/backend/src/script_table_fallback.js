'use strict';
// 台词表生成 · WAF/限流自动降级（2026-09-04）
//
// 背景：每份台词表生成需 ~80+ 次腾讯 MCP 调用，受腾讯 WAF 突发限流影响，
// 偶发整张表在第 N 步被网关拦截而任务标记 failed。文案策划没耐心手工 retry，
// 故引入自动降级：完整模式（lite=false）撞到 WAF/限流错误时，
// 静默改用 lite 模式重跑一次；lite 模式自身已是最简，不再二次降级。
//
// 实现：
// - runScriptTableWithFallback(dem, jobLite, cwExecutor) → 第一次按 jobLite 调用
//   generateForDemand；抛错时若 /网关限流|WAF|限流|captcha|重试耗尽/ 命中且原
//   jobLite=false，则自动以 lite=true 重跑；其它错误原样上抛。
// - 返回 { result, downgraded }，downgraded=true 表示发生过降级，便于事后复盘。
//
// 注意：第一次完整模式中途失败可能已创建腾讯文档（孤儿），不自动清理。
// 后续可加独立 cleanup_orphan_docs 工具清，本次不实现。

const WAF_RE = /网关限流|WAF|限流|captcha|重试耗尽/i;

async function runScriptTableWithFallback(dem, jobLite, cwExecutor) {
  const firstLite = !!jobLite;
  try {
    const result = await cwExecutor.generateForDemand(dem, { lite: firstLite });
    return { result, downgraded: false };
  } catch (e) {
    const errMsg = (e && e.message) || String(e);
    const isWaf = WAF_RE.test(errMsg);
    // 仅完整模式撞 WAF 才降级；lite 已最简，不再降级；其它错误原样抛
    if (isWaf && !firstLite) {
      // 日志分级明确：原错在 job.result 里仍然能取到，warn 而非 error
      console.warn('[script_table] 完整模式撞 WAF/限流，自动降级到 lite 模式, demand=' + dem.id + ', err=' + errMsg.slice(0, 200));
      const result = await cwExecutor.generateForDemand(dem, { lite: true });
      return { result, downgraded: true };
    }
    throw e;
  }
}

module.exports = { runScriptTableWithFallback, WAF_RE };
