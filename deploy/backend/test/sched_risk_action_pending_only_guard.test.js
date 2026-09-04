// 录制档期风险预警「仅看未预约」按钮守卫（2026-09-03 加回）
// 契约：① HTML 按钮存在且位置正确 ② CSS 已就绪（pill 形 + 黄色 + active 态实心）
// ③ ACTOR_STATE.pendingOnly 字段 ④ 4 处死码清除 ⑤ 过滤逻辑只在主分支应用
// ⑥ clearAllFilters 同步复位 ⑦ DOMContentLoaded 后已绑 click handler ⑧ deploy 副本一致
'use strict';
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'preview-录制档期-精修版.html');
const DEPLOY = path.join(ROOT, 'deploy', 'frontend', 'preview-录制档期-精修版.html');

function read(file){ return fs.readFileSync(file, 'utf8'); }

test('1. 风险预警按钮元素存在（位于 riskBanner / body / stats 之间）', () => {
  const html = read(SRC);
  const m = html.match(/<div class="risk-banner"[^>]*id="riskBanner"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/);
  // 取 banner 内三个子节点（body、button、stats）相对位置
  const bannerBlock = html.match(/<div class="risk-banner"[^>]*id="riskBanner"[^>]*>([\s\S]*?)<div class="risk-stats"/);
  assert.ok(bannerBlock, '必须能在 riskBanner 内 risk-body 与 risk-stats 之间定位');
  const inside = bannerBlock[1];
  assert.match(inside, /<button[^>]*id="riskAction"/, 'riskAction 按钮必须在 riskBanner 里');
  assert.match(inside, /class="risk-action"/, '按钮必须套用 .risk-action 样式');
  assert.match(inside, /type="button"/, '按钮必须是 type=button（避免默认 submit）');
  assert.match(inside, /aria-pressed="false"/, '按钮默认 aria-pressed=false');
  assert.match(inside, /仅看未预约/, '按钮文案必须是"仅看未预约"');
  assert.match(inside, /data-tip="[^"]+"/, '按钮必须有 data-tip 提示');
});

test('2. CSS 已就绪（pill 形 + 黄色 + active 态实心黄黑）', () => {
  const css = read(SRC);
  assert.match(css, /\.risk-action\{[^}]*background:rgba\(255,210,76/);
  assert.match(css, /\.risk-action\{[^}]*border:1px solid rgba\(255,210,76/);
  assert.match(css, /\.risk-action\{[^}]*color:#FFD24C/);
  assert.match(css, /\.risk-action\{[^}]*border-radius:999px/);
  assert.match(css, /\.risk-action:hover\{[^}]*background:rgba\(255,210,76,\.22\)/);
  assert.match(css, /\.risk-action\.active\{[^}]*background:#FFD24C[^}]*color:#0F171C/s);
});

test('3. ACTOR_STATE 新增 pendingOnly 字段（默认 false）', () => {
  const js = read(SRC);
  const m = js.match(/let ACTOR_STATE\s*=\s*\{[^}]+\};/);
  assert.ok(m, '必须能找到 ACTOR_STATE 初始定义');
  assert.match(m[0], /pendingOnly:\s*false/, 'pendingOnly 默认必须为 false');
});

test('4. 4 处 action 死码已清除', () => {
  const js = read(SRC);
  assert.equal((js.match(/if\(action\)\{/g) || []).length, 0, '所有 if(action){...} 死码必须清掉');
  assert.equal((js.match(/const action\s*=\s*document\.getElementById\(['"]riskAction['"]\)/g) || []).length, 0,
    'const action = ... 赋值必须改成 riskBtn 或去掉');
  assert.equal((js.match(/\/\/ 已下线：筛选器里已有"未约"选项/g) || []).length, 0,
    '"已下线"注释必须移除');
});

test('5. 过滤逻辑应用 schedStatusBucket 归一化（兼容 pending/draft/草稿/未约）', () => {
  const js = read(SRC);
  assert.match(js, /ACTOR_STATE\.pendingOnly\s*&&\s*schedStatusBucket\(r\.status\)\s*!==\s*['"]unbooked['"]\)\s*return\s+false/,
    '过滤必须用 schedStatusBucket 判 unbooked');
});

test('6. clearAllFilters 同步清掉 pendingOnly + 复位按钮', () => {
  const js = read(SRC);
  const block = js.match(/function clearAllFilters\(\)\{[\s\S]*?\n\}/);
  assert.ok(block, '必须能找到 clearAllFilters');
  assert.match(block[0], /ACTOR_STATE\.pendingOnly\s*=\s*false/, '必须清 pendingOnly');
  assert.match(block[0], /riskBtn\.classList\.remove\(['"]active['"]\)/, '必须移除 active');
  assert.match(block[0], /riskBtn\.setAttribute\(['"]aria-pressed['"],\s*['"]false['"]\)/, '必须复位 aria-pressed');
});

test('7. hasActiveFilters 把 pendingOnly 也算激活态', () => {
  const js = read(SRC);
  assert.match(js, /function hasActiveFilters\(\)\{[\s\S]*?ACTOR_STATE\.pendingOnly[\s\S]*?\}/,
    'hasActiveFilters 必须把 pendingOnly 视为激活');
});

test('8. DOMContentLoaded 已绑按钮 click handler（toggle + aria-pressed + render）', () => {
  const js = read(SRC);
  assert.match(js,
    /var riskBtn\s*=\s*document\.getElementById\(['"]riskAction['"]\);[\s\S]*?riskBtn\.addEventListener\(['"]click['"],\s*function\(\)\{/,
    '必须在 DOMContentLoaded 监听器里绑按钮 click');
  assert.match(js,
    /ACTOR_STATE\.pendingOnly\s*=\s*!ACTOR_STATE\.pendingOnly/,
    'click handler 必须 toggle pendingOnly');
  assert.match(js,
    /riskBtn\.classList\.toggle\(['"]active['"],\s*ACTOR_STATE\.pendingOnly\)/,
    'click handler 必须同步 .active 类');
  assert.match(js,
    /riskBtn\.setAttribute\(['"]aria-pressed['"],\s*ACTOR_STATE\.pendingOnly\s*\?\s*['"]true['"]\s*:\s*['"]false['"]\)/,
    'click handler 必须同步 aria-pressed');
  assert.match(js,
    /renderActorRollup\(\)/,
    'click handler 必须触发重渲染');
});

test('9. deploy 副本与根文件 byte-equal', () => {
  assert.ok(fs.existsSync(DEPLOY), 'deploy 副本应存在');
  assert.equal(read(DEPLOY), read(SRC), 'deploy 副本必须与根文件 byte-equal');
});

test('10. pendingOnly 模式：line-group 加 pendingOnly 类，整行拓宽给待预约（2026-09-04 用户定稿）', () => {
  const js = read(SRC);
  // JS: renderActorSixBoard 必须按 ACTOR_STATE.pendingOnly 切换 line-group class
  assert.match(js, /<div class="line-group\$\{ACTOR_STATE\.pendingOnly\s*\?\s*['"] pendingOnly['"]\s*:\s*['"]['"]\}" data-lang="\$\{grp\.lang\}">/,
    'line-group 模板必须按 ACTOR_STATE.pendingOnly 追加 pendingOnly 类');

  // CSS: .line-group.pendingOnly 三条规则（每条独立成行，便于断言）
  const css = read(SRC);
  assert.match(css, /\.line-group\.pendingOnly\s*\{[^}]*grid-template-columns:\s*minmax\(0,1fr\)\s*\}/,
    '.line-group.pendingOnly 必须收紧为单列 minmax(0,1fr)');
  assert.match(css, /\.line-group\.pendingOnly\s+\.line-board\.seg-up,\s*\.line-group\.pendingOnly\s+\.line-board\.seg-done\s*\{[^}]*display:none\s*\}/,
    '必须合并隐藏 seg-up / seg-done 板');
  assert.match(css, /\.line-group\.pendingOnly\s+\.lh-stat\.up,\s*\.line-group\.pendingOnly\s+\.lh-stat\.done\s*\{[^}]*display:none\s*\}/,
    '必须合并隐藏 up / done 行头统计');
});
