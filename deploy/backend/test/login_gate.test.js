'use strict';
/**
 * 进站登录门禁（2026-09-18 PM 拍板）
 * 站点不再是「匿名只读 + 手动申请编辑权限」：**打开网站必须先输入企微账号登录**，
 * 没登录就看不到业务内容（后端 /api 一律 401 login_required），也就没有只读横幅这种中间态。
 * 已登录的人六个月内直接进入；?role=guest 分享链接只在登录后生效（保留写保护）。
 *
 * 这里同时钉住后端中间件和前端脚本，防止后续重构又把匿名浏览放回来。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const security = require('../src/security');
const { apiAuth, issueOwnerToken, requireLogin } = security;

const { runGuest, encode, memberPayload } = require('./helpers/guest_vm');
const ROOT = path.resolve(__dirname, '../../..');
const INDEX = fs.readFileSync(path.join(ROOT, 'deploy/backend/src/index.js'), 'utf8');
const GUEST_SRC = fs.readFileSync(path.join(ROOT, 'assets/guest-mode.js'), 'utf8');

// ---------- 后端：中间件真实行为 ----------
function responseMock() {
  return {
    headers: {},
    statusCode: 200,
    body: undefined,
    setHeader(n, v) { this.headers[String(n).toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
/** 走完整的 apiAuth → requireLogin 链，返回 { passed, status, body, auth }。 */
function gate(headers = {}, socket = {}) {
  const req = { headers, socket };
  const res = responseMock();
  let passed = false;
  apiAuth(req, res, () => {
    requireLogin(req, res, () => { passed = true; });
  });
  return { passed, status: res.statusCode, body: res.body, auth: req.auth, headers: res.headers };
}
const editorHeader = (account = 'twinkyli') => ({ 'x-vomi-editor': issueOwnerToken(account) });

test('anonymous visitor is blocked: business API answers 401 login_required', () => {
  const r = gate();
  assert.equal(r.passed, false);
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'login_required');
  assert.equal(r.headers['x-vomi-login-required'], '1');
});

test('read-only share header alone is not an identity: still 401', () => {
  const r = gate({ 'x-vomi-role': 'guest' });
  assert.equal(r.passed, false);
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'login_required');
});

test('signed-in member passes the gate', () => {
  const r = gate(editorHeader());
  assert.equal(r.passed, true);
  assert.equal(r.auth.via, 'owner-session');
  assert.equal(r.auth.group, 'audio');
});

test('signed-in member opening a share link stays read-only but keeps identity', () => {
  // 登录后打开 ?role=guest：写保护保留，但身份仍在（resume 能记到访，不会被当成匿名弹登录）
  const r = gate({ ...editorHeader(), 'x-vomi-role': 'guest' });
  assert.equal(r.passed, true);
  assert.equal(r.auth.role, 'viewer');
  assert.equal(r.auth.via, 'owner-session');
  assert.equal(r.auth.subject, 'twinkyli');
});

test('service credentials and container loopback jobs are unaffected', () => {
  const bearer = gate({ authorization: 'Bearer ' + 'x'.repeat(40) });
  assert.equal(bearer.status, 401, 'unknown bearer is still not an identity');
  const loopback = gate({}, { remoteAddress: '127.0.0.1' });
  assert.equal(loopback.passed, true);
  assert.equal(loopback.auth.via, 'loopback');
});

test('login gate is mounted on /api before the write-permission middleware', () => {
  assert.match(INDEX, /requireLogin,/);
  assert.match(
    INDEX,
    /PUBLIC_API_PATHS\.has\(req\.path\) \? next\(\) : requireLogin\(req, res, next\)/
  );
  assert.match(INDEX, /PUBLIC_API_PATHS\.has\(req\.path\) \? next\(\) : methodRbac\(req, res, next\)/);
  assert.ok(
    INDEX.indexOf('requireLogin(req, res, next)') < INDEX.indexOf('methodRbac(req, res, next)'),
    '登录门禁必须先于写权限判定'
  );
  // health 探活与登录入口必须保持公开，否则没人能登录
  assert.match(INDEX, /PUBLIC_API_PATHS\s*=\s*new Set\(\['\/health',\s*'\/session\/unlock'\]\)/);
});

// ---------- 前端：进站即弹登录 ----------
const payload = memberPayload();
const DAY = 86400000;

test('first visit shows the login dialog without any interaction', () => {
  const r = runGuest();
  assert.ok(r.mask, '未登录必须自动弹出登录层');
  assert.equal(r.banner, null, '不再有只读浏览横幅这个中间态');
  assert.equal(r.win.__VOMI_READONLY__, true);
});

test('login dialog has no cancel/close escape hatch', () => {
  const r = runGuest();
  const html = String(r.mask.html || '');
  assert.match(html, /输入企业微信账号/);
  assert.match(html, /placeholder="Vomi（温米）"/);
  assert.doesNotMatch(html, /取消/);
  assert.doesNotMatch(html, /申请编辑权限/);
});

test('remembered member enters directly, no dialog and no banner', () => {
  const r = runGuest({ token: encode(payload) });
  assert.equal(r.mask, null);
  assert.equal(r.banner, null);
  assert.equal(r.win.__VOMI_READONLY__, false);
});

test('expired identity falls back to the login dialog', () => {
  const r = runGuest({ token: encode({ ...payload, iat: Date.now() - 200 * DAY }) });
  assert.ok(r.mask);
  assert.equal(r.local.has('vomi_owner_token_v1'), false);
});

test('nested iframe does not stack a second login dialog', () => {
  const r = runGuest({ frame: true });
  assert.equal(r.mask, null);
});

test('front-end recognizes login_required and reopens the login dialog', () => {
  assert.match(GUEST_SRC, /login_required/);
  assert.match(GUEST_SRC, /__vomiOpenUnlock/);
});
