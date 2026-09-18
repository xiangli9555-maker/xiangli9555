const test = require('node:test');
const assert = require('node:assert/strict');
const { createLoginStats } = require('../src/login_stats');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakePool(handler = async () => [[]]) {
  const calls = [];
  return {
    calls,
    query(sql, params) {
      calls.push({ sql, params });
      return handler(sql, params);
    },
  };
}

const identity = { account: 'alice', name: '测试人员', group: 'audio' };
const historyNote = '仅统计功能上线后的记录；旧登录凭据首次访问只记访问，不补造历史登录。';

function observedRow(overrides = {}) {
  return {
    account: 'alice',
    name: '历史姓名',
    group_name: 'old',
    first_seen_at: '2026-09-18T01:02:03.004000Z',
    last_seen_at: '2026-09-18T02:03:04.005000Z',
    first_login_at: '2026-09-18T01:02:03.004000Z',
    last_login_at: '2026-09-18T01:02:03.004000Z',
    login_count: '1',
    visit_count: '2',
    ...overrides,
  };
}

test('ensure 幂等创建独立表，仅包含统计字段', async () => {
  const pool = fakePool();
  const stats = createLoginStats(pool);
  await stats.ensure();
  await stats.ensure();
  assert.equal(pool.calls.length, 1);
  const sql = pool.calls[0].sql;
  assert.match(sql, /CREATE TABLE IF NOT EXISTS vomi_login_stats/i);
  assert.match(sql, /account\s+VARCHAR\(64\)\s+NOT NULL\s+PRIMARY KEY/i);
  assert.match(sql, /name\s+VARCHAR\(128\)\s+NOT NULL/i);
  assert.match(sql, /group_name\s+VARCHAR\(16\)\s+NOT NULL/i);
  for (const field of ['first_seen_at', 'last_seen_at']) {
    assert.match(sql, new RegExp(`${field}\\s+DATETIME\\(3\\)\\s+NOT NULL`, 'i'));
  }
  for (const field of ['first_login_at', 'last_login_at']) {
    assert.match(sql, new RegExp(`${field}\\s+DATETIME\\(3\\)\\s+NULL`, 'i'));
  }
  for (const field of ['login_count', 'visit_count']) {
    assert.match(sql, new RegExp(`${field}\\s+(?:BIG)?INT\\s+UNSIGNED\\s+NOT NULL\\s+DEFAULT 0`, 'i'));
  }
  assert.doesNotMatch(sql, /\b(token|ip|browser|user_agent|secret)\b/i);
});

test('ensure 合并同时进行的初始化请求', async () => {
  const gate = deferred();
  const pool = fakePool(() => gate.promise);
  const stats = createLoginStats(pool);
  const first = stats.ensure();
  const second = stats.ensure();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(pool.calls.length, 1);
  gate.resolve([[]]);
  await Promise.all([first, second]);
  await stats.ensure();
  assert.equal(pool.calls.length, 1);
});

test('ensure 初始化失败向调用方抛错，随后可重试', async () => {
  const failure = new Error('初始化数据库失败');
  let attempts = 0;
  const pool = fakePool(async () => {
    if (++attempts === 1) throw failure;
    return [[]];
  });
  const stats = createLoginStats(pool);
  const results = await Promise.allSettled([stats.ensure(), stats.ensure()]);
  assert.equal(attempts, 1);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, failure);
  }
  await stats.ensure();
  await stats.ensure();
  assert.equal(attempts, 2);
});

test('record 等待建表完成后才写入', async () => {
  const gate = deferred();
  const pool = fakePool(sql => /^\s*CREATE/i.test(sql) ? gate.promise : Promise.resolve([{}]));
  const pending = createLoginStats(pool).record(identity, 'login');
  await Promise.resolve();
  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].sql, /CREATE TABLE/i);
  gate.resolve([[]]);
  await pending;
  assert.equal(pool.calls.length, 2);
  assert.match(pool.calls[1].sql, /INSERT INTO vomi_login_stats/i);
});

test('record 登录用参数化单条 upsert 原子递增登录数，不递增访问数', async () => {
  const pool = fakePool();
  const stats = createLoginStats(pool);
  await stats.record(identity, 'login');
  assert.equal(pool.calls.length, 2);
  const { sql, params } = pool.calls[1];
  assert.match(sql, /INSERT INTO vomi_login_stats/i);
  assert.match(sql, /ON DUPLICATE KEY UPDATE/i);
  assert.match(sql, /UTC_TIMESTAMP\(3\)/i);
  assert.doesNotMatch(sql, /NOW\(|CURRENT_TIMESTAMP/i);
  assert.doesNotMatch(sql, /SELECT|START TRANSACTION/i);
  assert.deepEqual(params, ['alice', '测试人员', 'audio', 1, 1, 1, 0]);
  assert.equal((sql.match(/\?/g) || []).length, params.length);
  assert.match(sql, /login_count\s*=\s*login_count\s*\+\s*VALUES\(login_count\)/i);
  assert.match(sql, /visit_count\s*=\s*visit_count\s*\+\s*VALUES\(visit_count\)/i);
});

test('record 恢复旧凭据仅递增访问数，不补造首次或末次登录', async () => {
  const pool = fakePool();
  await createLoginStats(pool).record(identity, 'resume');
  const { sql, params } = pool.calls[1];
  assert.deepEqual(params, ['alice', '测试人员', 'audio', 0, 0, 0, 1]);
  assert.match(sql, /IF\(\?\s*=\s*1,\s*UTC_TIMESTAMP\(3\),\s*NULL\)/i);
  const updateSql = sql.split(/ON DUPLICATE KEY UPDATE/i)[1];
  assert.match(updateSql, /first_login_at\s*=\s*COALESCE\(first_login_at,\s*VALUES\(first_login_at\)\)/i);
  assert.match(updateSql, /last_login_at\s*=\s*COALESCE\(VALUES\(last_login_at\),\s*last_login_at\)/i);
  assert.match(updateSql, /last_seen_at\s*=\s*VALUES\(last_seen_at\)/i);
  assert.doesNotMatch(updateSql, /first_seen_at\s*=/i);
  assert.match(updateSql, /name\s*=\s*VALUES\(name\)/i);
  assert.match(updateSql, /group_name\s*=\s*VALUES\(group_name\)/i);
});

test('record 仅持久化身份白名单字段，带引号身份仍只进入参数', async () => {
  const pool = fakePool();
  const special = {
    account: "alice'; DROP TABLE t; --", name: "测试'人员", group: 'audio',
    key: '不可持久化密钥', token: '不可持久化令牌', ip: '127.0.0.1', browser: '测试浏览器',
  };
  await createLoginStats(pool).record(special, 'login');
  const { sql, params } = pool.calls[1];
  assert.deepEqual(params.slice(0, 3), [special.account, special.name, special.group]);
  for (const value of [special.account, special.name, special.key, special.token, special.ip, special.browser]) {
    assert.equal(sql.includes(value), false);
  }
  for (const value of [special.key, special.token, special.ip, special.browser]) {
    assert.equal(params.includes(value), false);
  }
});

test('并发记录共享一次初始化，每次事件只执行一条原子写入', async () => {
  const pool = fakePool();
  const stats = createLoginStats(pool);
  await Promise.all(Array.from({ length: 20 }, (_, index) => stats.record(identity, index % 2 ? 'login' : 'resume')));
  assert.equal(pool.calls.filter(({ sql }) => /^\s*CREATE/i.test(sql)).length, 1);
  const inserts = pool.calls.filter(({ sql }) => /^\s*INSERT/i.test(sql));
  assert.equal(inserts.length, 20);
  assert.equal(pool.calls.length, 21);
  assert.equal(inserts.reduce((sum, { params }) => sum + params[5], 0), 10);
  assert.equal(inserts.reduce((sum, { params }) => sum + params[6], 0), 10);
});

test('record 写入失败原样抛错，不清除已成功的建表状态', async () => {
  const failure = new Error('统计写入失败');
  const pool = fakePool(async sql => {
    if (/^\s*INSERT/i.test(sql)) throw failure;
    return [[]];
  });
  const stats = createLoginStats(pool);
  await assert.rejects(stats.record(identity, 'login'), error => error === failure);
  await stats.ensure();
  assert.equal(pool.calls.length, 2);
});

test('建表失败时 record 和 report 均不继续读写', async () => {
  const failure = new Error('建表权限不足');
  const pool = fakePool(async () => { throw failure; });
  const stats = createLoginStats(pool);
  const results = await Promise.allSettled([stats.record(identity, 'resume'), stats.report([])]);
  assert.equal(pool.calls.length, 1);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, failure);
  }
});

test('report 等待建表，固定字段查询且日期由 SQL 输出 UTC 字符串', async () => {
  const gate = deferred();
  const pool = fakePool(sql => /^\s*CREATE/i.test(sql) ? gate.promise : Promise.resolve([[]]));
  const pending = createLoginStats(pool).report([]);
  await Promise.resolve();
  assert.equal(pool.calls.length, 1);
  gate.resolve([[]]);
  const result = await pending;
  const sql = pool.calls[1].sql;
  assert.match(sql, /SELECT/i);
  assert.match(sql, /FROM vomi_login_stats/i);
  assert.doesNotMatch(sql, /SELECT\s*\*/i);
  for (const field of ['first_seen_at', 'last_seen_at', 'first_login_at', 'last_login_at']) {
    assert.ok(sql.includes(`DATE_FORMAT(${field}, '%Y-%m-%dT%H:%i:%s.%fZ') AS ${field}`));
  }
  assert.doesNotMatch(sql, /\b(key|token|ip|browser)\b/i);
  assert.deepEqual(result, {
    ok: true, users: [],
    summary: { rosterUsers: 0, observedUsers: 0, loggedInUsers: 0, totalLogins: 0, totalVisits: 0 },
    historyNote,
  });
});

test('report 未观测名单人员以零统计返回，不泄漏 key 或其他名单字段', async () => {
  const pool = fakePool();
  const roster = [{ ...identity, key: '不要泄漏', role: 'admin' }];
  const original = JSON.stringify(roster);
  const report = await createLoginStats(pool).report(roster);
  assert.deepEqual(report.users, [{
    ...identity, inRoster: true, hasLoggedIn: false, hasVisited: false,
    firstSeenAt: null, lastSeenAt: null, firstLoginAt: null, lastLoginAt: null,
    loginCount: 0, visitCount: 0,
  }]);
  assert.deepEqual(report.summary, { rosterUsers: 1, observedUsers: 0, loggedInUsers: 0, totalLogins: 0, totalVisits: 0 });
  assert.equal(JSON.stringify(roster), original);
  assert.equal(JSON.stringify(report).includes('不要泄漏'), false);
});

test('report 使用当前名单姓名分组，保留已移出人员并按实际记录汇总', async () => {
  const rows = [
    observedRow({ key: '数据库额外密钥', token: '数据库额外令牌' }),
    observedRow({
      account: 'removed', name: '已移出人员', group_name: 'design',
      first_login_at: null, last_login_at: null, login_count: '0', visit_count: '3',
    }),
  ];
  const pool = fakePool(async sql => /^\s*SELECT/i.test(sql) ? [rows] : [[]]);
  const report = await createLoginStats(pool).report([{ ...identity, key: '名单密钥' }, { account: 'new', name: '尚未访问', group: 'audio' }]);
  assert.equal(report.users.length, 3);
  const alice = report.users.find(user => user.account === 'alice');
  assert.deepEqual(alice, {
    ...identity, inRoster: true, hasLoggedIn: true, hasVisited: true,
    firstSeenAt: rows[0].first_seen_at, lastSeenAt: rows[0].last_seen_at,
    firstLoginAt: rows[0].first_login_at, lastLoginAt: rows[0].last_login_at,
    loginCount: 1, visitCount: 2,
  });
  const removed = report.users.find(user => user.account === 'removed');
  assert.deepEqual(removed, {
    account: 'removed', name: '已移出人员', group: 'design', inRoster: false,
    hasLoggedIn: false, hasVisited: true,
    firstSeenAt: rows[1].first_seen_at, lastSeenAt: rows[1].last_seen_at,
    firstLoginAt: null, lastLoginAt: null, loginCount: 0, visitCount: 3,
  });
  assert.deepEqual(report.summary, { rosterUsers: 2, observedUsers: 2, loggedInUsers: 1, totalLogins: 1, totalVisits: 5 });
  assert.equal(report.historyNote, historyNote);
  for (const secret of ['数据库额外密钥', '数据库额外令牌', '名单密钥']) {
    assert.equal(JSON.stringify(report).includes(secret), false);
  }
});

test('report 仅登录也属于已观测到访，登录及恢复次数保持独立', async () => {
  const row = observedRow({ visit_count: 0, login_count: 2 });
  const pool = fakePool(async sql => /^\s*SELECT/i.test(sql) ? [[row]] : [[]]);
  const report = await createLoginStats(pool).report([]);
  assert.equal(report.users[0].hasVisited, true);
  assert.equal(report.users[0].hasLoggedIn, true);
  assert.equal(report.users[0].inRoster, false);
  assert.deepEqual(report.summary, { rosterUsers: 0, observedUsers: 1, loggedInUsers: 1, totalLogins: 2, totalVisits: 0 });
});

test('report 读取失败原样抛错', async () => {
  const failure = new Error('统计读取失败');
  const pool = fakePool(async sql => {
    if (/^\s*SELECT/i.test(sql)) throw failure;
    return [[]];
  });
  await assert.rejects(createLoginStats(pool).report([]), error => error === failure);
});
