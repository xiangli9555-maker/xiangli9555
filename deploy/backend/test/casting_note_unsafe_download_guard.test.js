// 「下载角色信息」委托顶层触发守卫（2026-09-03）
//
// 用户报告：声优库页面（被嵌在 vo-manager-refined 的 iframe 里）双击「角色信息」列
// 触发下载 Word (.doc) 时，Chrome 124+ 弹出「已阻止不安全的下载」。
// 根因：iframe 内的 Blob + a[download].click()，user activation 跨 iframe 边界丢失，
// Chrome 视为「非用户授权的下载」→ 拦截。
//
// 修法：iframe 内检测到有顶层 window.parent 时，把 html + filename 用 postMessage 递给
// vo-manager-refined 顶层 shell；顶层在自己的上下文里构 Blob + click（user activation 完整）。
// 若声优库被顶层直开（无 window.parent），降级为原 Blob + a.click() 路径。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const SHELL = path.join(ROOT, 'vo-manager-refined.html');
const SUB = path.join(ROOT, 'preview-声优库-精修版.html');
const DEPLOY_SHELL = path.join(ROOT, 'deploy', 'frontend', 'vo-manager-refined.html');
const DEPLOY_SUB = path.join(ROOT, 'deploy', 'frontend', 'preview-声优库-精修版.html');

const SHELL_SRC = fs.readFileSync(SHELL, 'utf8');
const SUB_SRC = fs.readFileSync(SUB, 'utf8');

// 用 [%XX] 提取「type === '__vomi_casting_note_download' 之后到下一个分支 / 函数结尾」之间的代码段，
// 避免与文件其他位置混淆。
function sliceBranch(src, openTag, closeDepth) {
  const i = src.indexOf(openTag);
  if (i < 0) return '';
  // 找到对应的右大括号：按深度计数
  let depth = 0;
  let j = i;
  // 从 openTag 之后开始跟踪
  const start = src.indexOf('{', i);
  if (start < 0) return '';
  for (let k = start; k < src.length; k++) {
    const c = src[k];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, k + 1);
    }
  }
  return '';
}

test('顶层 shell message listener 中含「type=__vomi_casting_note_download」分支', () => {
  // type 字面量识别
  assert.match(SHELL_SRC, /type\s*===\s*['"]__vomi_casting_note_download['"]/, '应包含 type 字面量识别');
  // BOM 在 <script> 源码里是字面 6 字符 '\ufeff'（运行时才被解析为 BOM codepoint）
  // — 用 indexOf 字面匹配，避开 regex literal 的反斜杠/unicode 转义歧义
  const bomPrefix = "new Blob(['" + String.fromCharCode(0x5c) + "ufeff'";
  assert.ok(SHELL_SRC.indexOf(bomPrefix) >= 0, '应构造 BOM 字面转义 + body 的 Blob');
  assert.match(SHELL_SRC, /URL\.createObjectURL\(blob\)/, '应 createObjectURL');
  assert.match(SHELL_SRC, /a\.download\s*=\s*fn/, 'a.download 应设置为文件名');
  assert.match(SHELL_SRC, /a\.click\(\)/, '必须 a.click() 触发下载');
  assert.match(SHELL_SRC, /URL\.revokeObjectURL\(url\)/, '必须 revokeObjectURL 释放 url');
});

test('顶层 shell 下载分支做同源校验', () => {
  // 实际写法是 e.origin !== location.origin（4 字符严格不等）
  assert.match(SHELL_SRC, /e\.origin\s*!==\s*location\.origin/, '同源严格不等校验');
});

test('声优库子页在 iframe 内优先把下载委托给顶层', () => {
  // 必须含完整字面量：postMessage({type:'__vomi_casting_note_download', filename, html}, target)
  const re = /window\.parent\.postMessage\(\{\s*type:\s*['"]__vomi_casting_note_download['"]\s*,\s*filename\s*,\s*html\s*\}/;
  assert.match(SUB_SRC, re, 'iframe 内应 postMessage(type, filename, html) 三件套');
});

test('声优库子页判定 iframe 环境后降级', () => {
  // 顶层直开（window.parent === window）时，降级为原 Blob + a.click() 路径
  assert.match(SUB_SRC, /window\.parent\s*[!=]==\s*window/, '应判定 window.parent !== window');
});

test('顶层 shell 与声优库子页均优先 showSaveFilePicker 直写盘，失败/不支持降级 Blob（2026-09-04 方案 D）', () => {
  // 顶层 shell：检测 API + 直写盘 + 用户取消/失败降级
  assert.match(SHELL_SRC, /typeof window\.showSaveFilePicker === 'function'/, 'shell 未检测 showSaveFilePicker');
  assert.match(SHELL_SRC, /showSaveFilePicker\(\{\s*suggestedName:\s*fn/, 'shell 未传 suggestedName');
  assert.match(SHELL_SRC, /handle\.createWritable\(\)/, 'shell 未 createWritable');
  assert.match(SHELL_SRC, /err\.name === 'AbortError'/, 'shell 未处理用户取消（AbortError）');
  assert.match(SHELL_SRC, /const fallbackBlob = \(\) =>/, 'shell 缺少 Blob 降级函数');
  // 声优库子页（顶层直开降级路径）
  assert.match(SUB_SRC, /typeof window\.showSaveFilePicker === 'function'/, '声优库子页未检测 showSaveFilePicker');
  assert.match(SUB_SRC, /showSaveFilePicker\(\{\s*suggestedName:\s*filename/, '声优库子页未传 suggestedName');
  assert.match(SUB_SRC, /const legacyBlob = \(\) =>/, '声优库子页缺少 Blob 降级函数');
});

test('deploy 镜像与根文件 byte-equal（发布零漂移）', () => {
  const a = fs.readFileSync(SHELL);
  const b = fs.readFileSync(DEPLOY_SHELL);
  assert.ok(a.equals(b), 'vo-manager-refined.html 根 vs deploy 应 byte-equal');
  const c = fs.readFileSync(SUB);
  const d = fs.readFileSync(DEPLOY_SUB);
  assert.ok(c.equals(d), 'preview-声优库-精修版.html 根 vs deploy 应 byte-equal');
});
