'use strict';
/**
 * 在最小浏览器环境里跑 assets/guest-mode.js（2026-09-18：进站必须登录）。
 * guest_session.test.js 与 login_gate.test.js 共用，避免各自维护一套 DOM stub。
 * 不是测试文件（文件名不含 .test.js），node --test 不会直接执行它。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT = fs.readFileSync(
  path.resolve(__dirname, '../../../../assets/guest-mode.js'),
  'utf8'
);

function el(id) {
  return {
    id,
    value: '',
    listeners: {},
    style: { setProperty() {} },
    addEventListener(k, f) { (this.listeners[k] = this.listeners[k] || []).push(f); },
    remove() { this.removed = true; },
    focus() {},
  };
}

/** @param {{token?:string, url?:string, frame?:boolean, guestFlag?:string}} options */
function runGuest({ token, url = 'http://vomi.test/', frame = false, guestFlag } = {}) {
  const local = new Map(token ? [['vomi_owner_token_v1', token]] : []);
  const session = new Map(guestFlag ? [['vomi_guest_mode', guestFlag]] : []);
  const nodes = new Map();
  const events = {};
  const storage = (map) => ({
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  });
  const register = (html) => {
    for (const m of String(html).matchAll(/id="([^"]+)"/g)) {
      if (!nodes.has(m[1])) nodes.set(m[1], el(m[1]));
    }
  };
  const doc = {
    readyState: 'loading',
    documentElement: {},
    addEventListener: (k, f) => { (events[k] = events[k] || []).push(f); },
    getElementById: (k) => nodes.get(k) || null,
    querySelectorAll: () => [],
    createElement: () => {
      const node = el('');
      Object.defineProperty(node, 'innerHTML', {
        set(v) { this.html = v; register(v); },
        get() { return this.html || ''; },
      });
      node.appendChild = () => {};
      return node;
    },
    body: { appendChild: (n) => nodes.set(n.id, n), style: { setProperty() {} } },
  };
  const win = {
    location: { href: url, reload() { win.reloaded = true; } },
    addEventListener: (k, f) => { events[k] = [f]; },
  };
  win.top = frame ? { other: true } : win;
  win.self = win;
  vm.runInNewContext(SCRIPT, {
    window: win,
    document: doc,
    location: win.location,
    URL,
    Date,
    localStorage: storage(local),
    sessionStorage: storage(session),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    setTimeout() {},
    clearTimeout() {},
    MutationObserver: class { observe() {} },
  });
  (events.DOMContentLoaded || []).forEach((f) => f());
  return {
    win,
    nodes,
    local,
    session,
    events,
    mask: nodes.get('vomi-unlock-mask') || null,
    banner: nodes.get('vomi-guest-banner') || null,
  };
}

const encode = (payload) =>
  Buffer.from(JSON.stringify(payload)).toString('base64url') + '.sig';

const memberPayload = (overrides = {}) => ({
  sub: 'twinkyli',
  name: '李莹莹',
  group: 'audio',
  role: 'editor',
  iat: Date.now(),
  exp: Date.now() + 180 * 86400000,
  ...overrides,
});

module.exports = { runGuest, encode, memberPayload };
