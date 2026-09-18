'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const security = require('../src/security');
const source = fs.readFileSync(require.resolve('../src/index'), 'utf8');
function harness(fail = false) {
  const routes = new Map();
  const calls = [];
  const app = {};
  for (const method of ['get', 'post']) app[method] = (url, ...handlers) => routes.set(method + url, handlers);
  const stats = { record: async (id, kind) => { if (fail) throw new Error('db unavailable'); calls.push([id.account, kind]); }, report: async () => ({ ok: true, users: [] }) };
  const text = source.slice(source.indexOf("app.post('/api/session/unlock'"), source.indexOf('// 音频文件上传'));
  vm.runInNewContext(text, { app, IDENTITY_TOKEN_TTL_MS: 100 * 365.25 * 86400000, ...security, loginStats: stats, console, Date, Math });
  async function request(method, url, body = {}, auth = { role: 'viewer' }) {
    const handlers = routes.get(method + url);
    assert.ok(handlers, 'route must exist: ' + url);
    const req = { body, auth, headers: {}, ip: 'test-' + Math.random(), socket: {} };
    const res = { statusCode: 200, setHeader() {}, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } };
    for (const fn of handlers) { let next = false; await fn(req, res, () => { next = true; }); if (!next) break; }
    return res;
  }
  return { request, calls };
}
test('successful unlock commits a login record before six-month token is returned', async () => {
  const h = harness();
  const res = await h.request('post', '/api/session/unlock', { account: 'twinkyli(李莹莹)' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(h.calls, [['twinkyli', 'login']]);
  const p = JSON.parse(Buffer.from(res.body.token.split('.')[0], 'base64url'));
  assert.equal(p.exp, security.identityExpiresAt(p.iat));
  assert.equal(res.body.expiresIn, Math.floor((p.exp - p.iat) / 1000));
});
test('failed/empty account never creates a login statistic', async () => {
  const h = harness();
  assert.equal((await h.request('post', '/api/session/unlock', { account: 'not-on-list' })).statusCode, 403);
  assert.equal((await h.request('post', '/api/session/unlock')).statusCode, 400);
  assert.equal(h.calls.length, 0);
});
test('DB failure is explicit and does not return an unrecorded login token', async () => {
  const res = await harness(true).request('post', '/api/session/unlock', { account: 'twinkyli' });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'login_record_unavailable');
  assert.equal(res.body.token, undefined);
});
test('resume records an existing session separately, preserves original login timestamp and expiry', async () => {
  const h = harness();
  const old = security.issueOwnerToken('twinkyli', 100 * 365.25 * 86400000, Date.now() - 86400000);
  const auth = { ...security.verifySessionToken(old), via: 'owner-session' };
  const res = await h.request('post', '/api/session/resume', {}, auth);
  assert.equal(res.statusCode, 200);
  const p = JSON.parse(Buffer.from(res.body.token.split('.')[0], 'base64url'));
  assert.equal(p.iat, auth.issuedAt);
  assert.equal(p.exp, auth.expiresAt);
  assert.deepEqual(h.calls, [['twinkyli', 'resume']]);
});
test('resume cannot self-report arbitrary users and requires real browser session', async () => {
  const h = harness();
  for (const auth of [{ role: 'viewer' }, { role: 'admin', via: 'loopback' }]) {
    const res = await h.request('post', '/api/session/resume', { account: 'twinkyli' }, auth);
    assert.equal(res.statusCode, 401);
  }
  assert.equal(h.calls.length, 0);
});
test('login statistics reject non-admins', async () => {
  const h = harness();
  assert.equal((await h.request('get', '/api/admin/login-stats', {}, { role: 'editor' })).statusCode, 403);
  assert.equal((await h.request('get', '/api/admin/login-stats', {}, { role: 'admin' })).statusCode, 200);
});
