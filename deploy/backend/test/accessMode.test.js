'use strict';
/**
 * 访问模式守卫（2026-09-14）
 * 站点默认只读、仅 lycheelli 用编辑口令解锁后可写。这类约束散落在前端脚本 + 后端中间件两处，
 * 很容易在后续重构里被悄悄改掉（比如又把默认角色改回 admin），所以这里用源码字面量钉住。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const GUEST = read('assets/guest-mode.js');
const SECURITY = read('deploy/backend/src/security.js');
const INDEX = read('deploy/backend/src/index.js');

test('前端：默认只读，写请求被拦并提示找 lycheelli 申请权限', () => {
  assert.match(GUEST, /请找 lycheelli 申请权限/);
  assert.match(GUEST, /window\.__VOMI_READONLY__\s*=\s*READONLY/);
  assert.match(GUEST, /READONLY\s*=\s*!TOKEN/);
  assert.match(GUEST, /var\s+WRITE_METHODS\s*=\s*\{[^}]*POST:\s*1[^}]*DELETE:\s*1/);
  assert.match(GUEST, /headers\.set\('X-Vomi-Role',\s*'guest'\)/);
  assert.match(GUEST, /headers\.set\('X-Vomi-Editor',\s*TOKEN\)/);
  assert.match(GUEST, /localStorage\.setItem\(TOKEN_KEY/);
});

test('前端：解锁走 /api/session/unlock，且绕过自身写拦截', () => {
  assert.match(GUEST, /\/api\/session\/unlock/);
  assert.match(GUEST, /window\.__vomiRawFetch\s*\|\|\s*window\.fetch/);
  assert.match(GUEST, /vomi_owner_token_v1/);
});

test('后端：无凭据请求默认 viewer（不是 admin）', () => {
  assert.match(SECURITY, /req\.auth\s*=\s*\{\s*subject:\s*'visitor',\s*role:\s*'viewer'/);
  assert.match(SECURITY, /请找 lycheelli 申请权限/);
  assert.match(SECURITY, /const\s+OWNER_SUBJECT\s*=\s*'lycheelli'/);
  // 回环放权只能认 socket 地址，不能认 req.ip（会被 XFF 伪造）
  assert.match(SECURITY, /req\s*&&\s*req\.socket\s*&&\s*req\.socket\.remoteAddress/);
  assert.doesNotMatch(SECURITY, /req\.ip\s*\|\|\s*\(req\s*&&\s*req\.socket/);
});

test('后端：解锁接口注册在写权限中间件白名单里', () => {
  assert.match(INDEX, /PUBLIC_API_PATHS\s*=\s*new Set\(\['\/health',\s*'\/session\/unlock'\]\)/);
  assert.match(INDEX, /app\.post\('\/api\/session\/unlock'/);
  // 2026-09-16：解锁按企微账号签发带职能组的令牌
  assert.match(INDEX, /resolveIdentity\(account\)/);
  // 2026-09-17：名单内填一次永久记住 —— 令牌按 100 年有效期签发
  assert.match(INDEX, /issueOwnerToken\(identity\.account, IDENTITY_TOKEN_TTL_MS\)/);
  assert.match(SECURITY, /IDENTITY_TOKEN_TTL_MS = 100 \* 365\.25/);
  assert.match(INDEX, /unknown_account/);
  assert.match(INDEX, /account_required/);
  // 2026-09-17：名单即授权 —— 只有开了 VOMI_UNLOCK_KEY / 专属口令才校验口令
  assert.match(INDEX, /normalizeAccountInput\(\(req\.body && req\.body\.account\) \|\| ''\)/);
  assert.match(INDEX, /if \(UNLOCK_REQUIRES_KEY\)/);
  assert.match(INDEX, /key_required/);
  // 口令校验必须落在 UNLOCK_REQUIRES_KEY 分支内（默认不校验）
  assert.ok(
    INDEX.indexOf('if (UNLOCK_REQUIRES_KEY)') < INDEX.indexOf('checkAccountKey(account, key)'),
    'checkAccountKey 必须位于 UNLOCK_REQUIRES_KEY 分支内'
  );
});

test('后端：录制档期写接口只对音频组开放（scope 鉴权）', () => {
  for (const route of [
    "app.post('/api/schedules', requireScope('schedule')",
    "app.post('/api/schedules/publish', requireScope('schedule')",
    "app.patch('/api/schedules/:id', requireScope('schedule')",
    "app.delete('/api/schedules/:id', requireScope('schedule')",
    "app.post('/api/schedule-from-sheet/refresh', requireScope('schedule')",
  ]) {
    assert.ok(INDEX.includes(route), `缺少 scope 守卫：${route}`);
  }
  assert.match(SECURITY, /const\s+SCOPE_GROUPS\s*=\s*Object\.freeze\(\{\s*schedule:\s*Object\.freeze\(\['audio'\]\)/);
  // 删除不再是 admin 特权
  assert.doesNotMatch(SECURITY, /req\.method === 'DELETE'\) return requireRole\('admin'\)/);
});

test('前端：解锁弹窗收集企微账号，删除走二次确认', () => {
  assert.match(GUEST, /vomi-unlock-account/);
  assert.match(GUEST, /body:\s*JSON\.stringify\(\{\s*account:/);
  assert.match(GUEST, /__VOMI_IDENTITY__/);
  assert.match(GUEST, /确认删除|删除后不可恢复/);
  // 2026-09-17：只填账号即可解锁 —— 保留一句说明 + 输入框灰色示例占位 + 口令框默认隐藏 + 账号容错
  assert.match(GUEST, /placeholder="Vomi（温米）"/);
  assert.match(GUEST, /#vomi-unlock-account::placeholder/);
  assert.match(GUEST, /输入企业微信账号/);
  assert.doesNotMatch(GUEST, /在权限名单里即可编辑/);
  assert.doesNotMatch(GUEST, /粘贴「Vomi（温米）」或直接写中文名/);
  assert.match(GUEST, /display:none;width:100%;box-sizing:border-box;margin-top:8px/);
  assert.match(GUEST, /function cleanAccount\(/);
  // 解锁后本地记住身份：2026-09-17 起令牌长期有效（填一次永久记住，不做 30 天过期）
  assert.match(GUEST, /localStorage\.setItem\(TOKEN_KEY, j\.token\)/);
  assert.match(GUEST, /身份已记住，下次免登录/);
  assert.doesNotMatch(GUEST, /30 天内免登录/);
});
