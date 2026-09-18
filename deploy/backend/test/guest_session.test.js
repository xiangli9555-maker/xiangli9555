'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const script = fs.readFileSync(path.resolve(__dirname, '../../../assets/guest-mode.js'), 'utf8');
function run({ token, url = 'http://vomi.test/', guest = '1' } = {}) {
  const local = new Map(token ? [['vomi_owner_token_v1', token]] : []);
  const session = new Map(guest ? [['vomi_guest_mode', guest]] : []);
  const events = {};
  const nodes = new Map();
  const storage = map => ({ getItem: k => map.get(k) || null, setItem: (k,v) => map.set(k,v), removeItem: k => map.delete(k) });
  const doc = { readyState: 'loading', documentElement: {}, addEventListener: (k,f) => { (events[k] ||= []).push(f); },
    getElementById: k => nodes.get(k) || null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, set innerHTML(v) { this.html = v; nodes.set('vomi-unlock-btn', {}); nodes.set('vomi-guest-banner-close', {}); } }),
    body: { appendChild: n => nodes.set(n.id,n), style: { setProperty() {} } } };
  const win = { location: { href: url, reload() { win.reloaded = true; } }, addEventListener: (k,f) => { events[k] = [f]; } };
  win.top = win.self = win;
  vm.runInNewContext(script, { window: win, document: doc, location: win.location, URL, Date, localStorage: storage(local), sessionStorage: storage(session), atob: s => Buffer.from(s,'base64').toString('binary'), setTimeout() {}, clearTimeout() {}, MutationObserver: class { observe() {} } });
  (events.DOMContentLoaded || []).forEach(f => f());
  return { win, events, local, banner: nodes.has('vomi-guest-banner') };
}
const encode = p => Buffer.from(JSON.stringify(p)).toString('base64url') + '.test-signature';
const p = { sub: 'twinkyli', name: '李莹莹', group: 'audio', role: 'editor', iat: Date.now(), exp: Date.now() + 36525 * 86400000 };
test('remembered member has no banner even in explicit read-only share, writes stay disabled', () => {
  const r = run({ token: encode(p), url: 'http://vomi.test/?role=guest' });
  assert.equal(r.banner, false);
  assert.equal(r.win.__VOMI_READONLY__, true);
});
test('guest flag never overrides remembered identity on normal links', () => {
  const r = run({ token: encode(p) });
  assert.equal(r.banner, false);
  assert.equal(r.win.__VOMI_READONLY__, false);
});
test('anonymous visitor still sees permission entry', () => {
  const r = run();
  assert.equal(r.banner, true);
  assert.equal(r.win.__VOMI_READONLY__, true);
});
test('front-end caps legacy sessions to six months, rejects missing expiry', () => {
  const r = run({ token: encode({ ...p, iat: Date.now() - 210 * 86400000 }) });
  assert.equal(r.win.__VOMI_READONLY__, true);
  assert.equal(r.banner, true);
  const bad = run({ token: encode({ sub: 'twinkyli' }) });
  assert.equal(bad.win.__VOMI_READONLY__, true);
});
test('another tab login makes already-open page re-evaluate permissions', () => {
  const r = run();
  assert.ok(r.events.storage, 'must subscribe to storage changes');
  r.events.storage[0]({ key: 'vomi_owner_token_v1', oldValue: null, newValue: encode(p) });
  assert.equal(r.win.reloaded, true);
});
