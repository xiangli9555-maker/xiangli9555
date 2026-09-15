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
  assert.match(INDEX, /issueOwnerToken\(OWNER_SUBJECT\)/);
});
