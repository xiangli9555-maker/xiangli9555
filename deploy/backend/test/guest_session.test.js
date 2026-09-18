'use strict';
/**
 * 身份记忆与跨标签同步（2026-09-18 更新）
 * 站点已改为「进站必须登录」：没有只读浏览横幅这个中间态，未登录直接弹登录层。
 * 这里只钉住「记住身份」相关的行为：六个月免输入、分享链接、跨标签同步、过期清理。
 * 门禁本身的行为见 login_gate.test.js。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { runGuest, encode, memberPayload } = require('./helpers/guest_vm');

const DAY = 86400000;

test('remembered member enters directly, also on explicit read-only share links', () => {
  const shared = runGuest({ token: encode(memberPayload()), url: 'http://vomi.test/?role=guest' });
  assert.equal(shared.mask, null, '已登录不该再被要求登录');
  assert.equal(shared.banner, null);
  assert.equal(shared.win.__VOMI_READONLY__, true, '分享链接仍保留写保护');

  const normal = runGuest({ token: encode(memberPayload()) });
  assert.equal(normal.mask, null);
  assert.equal(normal.win.__VOMI_READONLY__, false);
});

test('stale guest flag never overrides remembered identity on normal links', () => {
  const r = runGuest({ token: encode(memberPayload()), guestFlag: '1' });
  assert.equal(r.mask, null);
  assert.equal(r.win.__VOMI_READONLY__, false);
});

test('front-end caps legacy sessions to six months and clears expired identity', () => {
  const stale = runGuest({ token: encode(memberPayload({ iat: Date.now() - 210 * DAY })) });
  assert.ok(stale.mask, '超过六个月必须重新登录');
  assert.equal(stale.local.has('vomi_owner_token_v1'), false, '过期令牌要清掉，不能反复弹');

  const broken = runGuest({ token: encode({ sub: 'twinkyli' }) });
  assert.ok(broken.mask, '缺 iat/exp 的令牌不算登录态');
});

test('another tab login or logout makes already-open page re-evaluate', () => {
  const r = runGuest();
  assert.ok(r.mask, '未登录先弹登录层');
  assert.ok(r.events.storage, 'must subscribe to storage changes');
  r.events.storage[0]({ key: 'vomi_owner_token_v1', oldValue: null, newValue: encode(memberPayload()) });
  assert.equal(r.win.reloaded, true);
});
