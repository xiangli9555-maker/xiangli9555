'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const TOKENS = {
  viewer: 'viewer-token-0000000000000000000000000001',
  editor: 'editor-token-0000000000000000000000000001',
  admin: 'admin-token-00000000000000000000000000001',
};
process.env.NODE_ENV = 'test';
process.env.ALLOWED_ORIGINS = 'https://trusted.example';
process.env.API_TOKENS_JSON = JSON.stringify([
  { token: TOKENS.viewer, subject: 'viewer-user', role: 'viewer' },
  { token: TOKENS.editor, subject: 'editor-user', role: 'editor' },
  { token: TOKENS.admin, subject: 'admin-user', role: 'admin' },
]);

const {
  apiAuth,
  accountForKey,
  accountKeyFor,
  checkAccountKey,
  checkOwnerKey,
  corsGuard,
  hasScope,
  issueOwnerToken,
  listUsers,
  methodRbac,
  normalizeAccountInput,
  OWNER_SUBJECT,
  requireScope,
  resolveIdentity,
  secureHeaders,
  verifyOwnerToken,
  verifySessionToken,
} = require('../src/security');

function responseMock() {
  return {
    headers: {},
    statusCode: 200,
    body: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    sendStatus(code) { this.statusCode = code; return this; },
  };
}

function authenticate(token, extraHeaders) {
  const req = { headers: { authorization: `Bearer ${token}`, ...(extraHeaders || {}) } };
  const res = responseMock();
  let passed = false;
  apiAuth(req, res, () => { passed = true; });
  return { req, res, passed };
}

// 2026-09-14：站点默认只读，只有 lycheelli 的编辑令牌才能写。
test('anonymous request resolves as read-only visitor', () => {
  const req = { headers: {} };
  const res = responseMock();
  let passed = false;
  apiAuth(req, res, () => { passed = true; });
  assert.equal(passed, true);
  assert.equal(req.auth.role, 'viewer');
  assert.equal(req.auth.subject, 'visitor');
});

test('guest share header resolves as viewer', () => {
  const { req } = authenticate('', { 'x-vomi-role': 'guest' });
  assert.equal(req.auth.role, 'viewer');
  assert.equal(req.auth.subject, 'guest');
});

test('owner session token elevates to admin and is tamper proof', () => {
  const token = issueOwnerToken(OWNER_SUBJECT);
  assert.equal(verifyOwnerToken(token), OWNER_SUBJECT);
  assert.equal(verifyOwnerToken(`${token}x`), null);
  assert.equal(verifyOwnerToken('garbage.signature'), null);
  assert.equal(verifyOwnerToken(''), null);

  const { req } = authenticate('', { 'x-vomi-editor': token });
  assert.equal(req.auth.role, 'admin');
  assert.equal(req.auth.subject, OWNER_SUBJECT);
  assert.equal(req.auth.via, 'owner-session');
});

test('expired owner session token is rejected', () => {
  const token = issueOwnerToken(OWNER_SUBJECT, -1000);
  assert.equal(verifyOwnerToken(token), null);
});

test('owner key check accepts configured key only', () => {
  assert.equal(checkOwnerKey('vomi-owner-2026'), true);
  assert.equal(checkOwnerKey('nope'), false);
  assert.equal(checkOwnerKey(''), false);
});

test('service bearer token keeps its own role', () => {
  const { req } = authenticate(TOKENS.editor);
  assert.equal(req.auth.role, 'editor');
  assert.equal(req.auth.subject, 'editor-user');
});

test('viewer role guard still blocks writes when called directly', () => {
  const req = { auth: { subject: 'viewer-user', role: 'viewer' } };
  const readRes = responseMock();
  req.method = 'GET';
  let readPassed = false;
  methodRbac(req, readRes, () => { readPassed = true; });
  assert.equal(readPassed, true);

  const writeRes = responseMock();
  req.method = 'POST';
  methodRbac(req, writeRes, () => assert.fail('viewer write should not pass'));
  assert.equal(writeRes.statusCode, 403);
  assert.equal(writeRes.body.required_role, 'editor');

  const deleteRes = responseMock();
  req.method = 'DELETE';
  methodRbac(req, deleteRes, () => assert.fail('viewer delete should not pass'));
  assert.equal(deleteRes.statusCode, 403);
  // 2026-09-16 PM 拍板：删除不再是 admin 特权，降为 editor + 前端二次确认。
  assert.equal(deleteRes.body.required_role, 'editor');
});

test('editor can write and delete (delete is confirmed on the client)', () => {
  const req = { auth: { subject: 'editor-user', role: 'editor' } };
  req.method = 'PATCH';
  let passed = false;
  methodRbac(req, responseMock(), () => { passed = true; });
  assert.equal(passed, true);

  req.method = 'DELETE';
  let deletePassed = false;
  methodRbac(req, responseMock(), () => { deletePassed = true; });
  assert.equal(deletePassed, true);
});

// ── 2026-09-16 职能组 / scope 鉴权 ─────────────────────────────────────────
test('roster resolves 文案 / 音频 groups', () => {
  const copy = resolveIdentity('archili');
  assert.ok(copy);
  assert.equal(copy.group, 'copy');
  assert.equal(copy.role, 'editor');
  assert.equal(copy.name, '李光源');

  const copyPm = resolveIdentity('UKONGWANG');
  assert.equal(copyPm.group, 'copy');
  assert.equal(copyPm.title, 'pm');

  const audioPm = resolveIdentity('lycheelli');
  assert.equal(audioPm.group, 'audio');
  assert.equal(audioPm.role, 'admin');

  assert.equal(resolveIdentity('nobody-here'), null);
  assert.equal(resolveIdentity(''), null);

  // 名单完整性（2026-09-16 PM 名单 + 后续增补）
  const users = listUsers();
  assert.equal(users.length, 29);
  assert.equal(users.filter((u) => u.group === 'copy').length, 12);
  assert.equal(users.filter((u) => u.group === 'audio').length, 17);
  assert.equal(resolveIdentity('twinkyli').name, '李莹莹'); // 不是 twinkli
  assert.equal(resolveIdentity('twinkli'), null);
  assert.equal(resolveIdentity('elliexiong').name, '熊雯玥');
  assert.equal(resolveIdentity('elliexiong').group, 'copy');
});

test('账号输入容错：通讯录复制带中文名 / 邮箱后缀 / 只写中文名都能解锁', () => {
  // 归一化：'twinkyli(李莹莹)'、'twinkyli (李莹莹)'、'twinkyli@corp.com' → 'twinkyli'
  assert.equal(normalizeAccountInput('twinkyli(李莹莹)'), 'twinkyli');
  assert.equal(normalizeAccountInput('twinkyli (李莹莹)'), 'twinkyli');
  assert.equal(normalizeAccountInput('twinkyli@corp.com'), 'twinkyli');
  assert.equal(normalizeAccountInput('  TWINKYLI '), 'TWINKYLI');
  assert.equal(normalizeAccountInput('李莹莹'), '李莹莹');
  assert.equal(normalizeAccountInput(''), '');

  // 名单即授权：粘贴带中文名的账号同样命中，并拿到正确职能组
  const pasted = resolveIdentity('twinkyli(李莹莹)');
  assert.equal(pasted.account, 'twinkyli');
  assert.equal(pasted.name, '李莹莹');
  assert.equal(pasted.group, 'audio');
  // 只写中文名也能反查（名单内唯一命中）
  assert.equal(resolveIdentity('李莹莹').account, 'twinkyli');
  assert.equal(resolveIdentity('熊雯玥').group, 'copy');
  // 不在名单里的一律 null
  assert.equal(resolveIdentity('路人甲'), null);
});

test('session token carries group and is honoured by scope guard', () => {
  const copyToken = issueOwnerToken('archili');
  const copySession = verifySessionToken(copyToken);
  assert.equal(copySession.group, 'copy');
  assert.equal(copySession.role, 'editor');

  const copyReq = { headers: { 'x-vomi-editor': copyToken } };
  apiAuth(copyReq, responseMock(), () => {});
  assert.equal(copyReq.auth.group, 'copy');
  assert.equal(hasScope(copyReq, 'schedule'), false);

  const res = responseMock();
  requireScope('schedule')(copyReq, res, () => assert.fail('copy group must not write schedule'));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'scope_forbidden');

  const audioToken = issueOwnerToken('axuanzhang');
  const audioReq = { headers: { 'x-vomi-editor': audioToken } };
  apiAuth(audioReq, responseMock(), () => {});
  assert.equal(audioReq.auth.group, 'audio');
  assert.equal(hasScope(audioReq, 'schedule'), true);
  let schedulePassed = false;
  requireScope('schedule')(audioReq, responseMock(), () => { schedulePassed = true; });
  assert.equal(schedulePassed, true);
});

test('unlock falls back to the shared key unless a per-account key exists', () => {
  // 名单里没配专属口令 → 用共享编辑口令
  assert.equal(accountKeyFor('archili'), '');
  assert.equal(checkAccountKey('archili', 'vomi-owner-2026'), true);
  assert.equal(checkAccountKey('archili', 'nope'), false);
  assert.equal(checkAccountKey('nobody-here', 'vomi-owner-2026'), true); // 账号存在性由上层另行判 403
  // 未开启专属口令时，口令反查不可用（保持旧的「账号 + 共享口令」行为）
  assert.equal(accountForKey('vomi-owner-2026'), null);
});

test('per-account key derives from master key and reverse-resolves to the account', () => {
  const securityPath = path.resolve(__dirname, '../src/security');
  const env = { ...process.env, NODE_ENV: 'test', VOMI_PER_ACCOUNT_KEYS: 'true', VOMI_OWNER_KEY: 'test-master-key' };
  const script = `
    const s = require(${JSON.stringify(securityPath)});
    const k = s.accountKeyFor('archili');
    process.stdout.write(JSON.stringify({
      stable: k === s.deriveAccountKey('archili'),
      differs: k !== s.accountKeyFor('lycheelli'),
      reverse: s.accountForKey(k),
      sharedRejected: s.checkAccountKey('archili', 'vomi-owner-2026'),
      unknown: s.accountForKey('definitely-not-a-key')
    }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(String(result.stdout || '').trim());
  assert.equal(out.stable, true);
  assert.equal(out.differs, true);
  assert.equal(out.reverse, 'archili');
  assert.equal(out.sharedRejected, false);
  assert.equal(out.unknown, null);
});

test('auditor without group (loopback / service token) keeps schedule write', () => {
  assert.equal(hasScope({ auth: { subject: 'loopback', role: 'admin' } }, 'schedule'), true);
  assert.equal(hasScope({ auth: { subject: 'editor-user', role: 'editor' } }, 'schedule'), true);
});

test('admin can delete', () => {
  const req = { auth: { subject: 'admin-user', role: 'admin' } };
  req.method = 'DELETE';
  let passed = false;
  methodRbac(req, responseMock(), () => { passed = true; });
  assert.equal(passed, true);
});

test('CORS allows same origin and configured origin, blocks others', () => {
  for (const [origin, expected] of [
    ['https://vomi.example', 200],
    ['https://trusted.example', 200],
    ['https://evil.example', 403],
  ]) {
    const req = {
      method: 'GET',
      protocol: 'https',
      headers: { origin, host: 'vomi.example' },
    };
    const res = responseMock();
    let passed = false;
    corsGuard(req, res, () => { passed = true; });
    assert.equal(res.statusCode, expected);
    assert.equal(passed, expected === 200);
  }
});

test('CORS preflight is terminated before authentication', () => {
  const req = {
    method: 'OPTIONS',
    protocol: 'https',
    headers: { origin: 'https://vomi.example', host: 'vomi.example' },
  };
  const res = responseMock();
  corsGuard(req, res, () => assert.fail('preflight should end in CORS middleware'));
  assert.equal(res.statusCode, 204);
});

test('security headers are attached', () => {
  const req = { path: '/api/demands' };
  const res = responseMock();
  let passed = false;
  secureHeaders(req, res, () => { passed = true; });
  assert.equal(passed, true);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['cache-control'], 'private, no-store');
});

test('production startup fails closed without credentials', () => {
  const securityPath = path.resolve(__dirname, '../src/security.js');
  const env = { ...process.env, NODE_ENV: 'production', API_TOKENS_JSON: '', API_AUTH_TOKEN: '', ALLOW_INSECURE_DEV: '' };
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(securityPath)})`], { env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required in production/);
});
