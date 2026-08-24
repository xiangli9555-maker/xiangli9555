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

const { apiAuth, corsGuard, methodRbac, secureHeaders } = require('../src/security');

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

function authenticate(token) {
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = responseMock();
  let passed = false;
  apiAuth(req, res, () => { passed = true; });
  return { req, res, passed };
}

test('open-access mode resolves every request as admin', () => {
  const { req, passed } = authenticate('not-valid');
  assert.equal(passed, true);
  assert.deepEqual(req.auth, { subject: 'open-access', role: 'admin' });
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
  assert.equal(deleteRes.body.required_role, 'admin');
});

test('editor can write but cannot delete', () => {
  const req = { auth: { subject: 'editor-user', role: 'editor' } };
  req.method = 'PATCH';
  let passed = false;
  methodRbac(req, responseMock(), () => { passed = true; });
  assert.equal(passed, true);

  req.method = 'DELETE';
  const res = responseMock();
  methodRbac(req, res, () => assert.fail('editor delete should not pass'));
  assert.equal(res.statusCode, 403);
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
