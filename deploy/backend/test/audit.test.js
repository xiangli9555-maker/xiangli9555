// 审计模块单元测试（无需真实数据库，使用内存 mock）
const test = require('node:test');
const assert = require('node:assert');
const { ensureAuditTable, writeAudit } = require('../src/audit');

test('ensureAuditTable 发出 CREATE TABLE IF NOT EXISTS', async () => {
  let captured = '';
  const pool = { query: async (sql) => { captured = sql; return [{}]; } };
  await ensureAuditTable(pool);
  assert.match(captured, /CREATE TABLE IF NOT EXISTS audit_log/);
  assert.match(captured, /actor|action|table_name|record_id|detail_json/);
});

test('writeAudit 写入动作/表/记录/详情', async () => {
  let captured = null;
  const conn = { query: async (sql, params) => { captured = { sql, params }; return [{}]; } };
  await writeAudit(conn, {
    actor: 'alice', action: 'soft_delete', table_name: 'voice_roles',
    record_id: 42, detail: { role_cn: '干员A' }
  });
  assert.match(captured.sql, /INSERT INTO audit_log/);
  assert.deepStrictEqual(captured.params, ['alice', 'soft_delete', 'voice_roles', '42', JSON.stringify({ role_cn: '干员A' })]);
});

test('writeAudit 详情对象可序列化，失败不抛出', async () => {
  let captured = null;
  const conn = { query: async (sql, params) => { captured = { sql, params }; return [{}]; } };
  await writeAudit(conn, { actor: 'bob', action: 'create', table_name: 'voice_actors', record_id: 'x9', detail: { a: 1 } });
  assert.strictEqual(captured.params[4], '{"a":1}');

  // 写库抛错时不应向上抛出（审计失败不阻断主流程）
  const bad = { query: async () => { throw new Error('db down'); } };
  await assert.doesNotReject(writeAudit(bad, { actor: 'x', action: 'y', table_name: 't' }));
});

test('writeAudit 缺省值安全截断', async () => {
  let captured = null;
  const conn = { query: async (sql, params) => { captured = { sql, params }; return [{}]; } };
  await writeAudit(conn, { actor: 'a'.repeat(200), action: 'update', table_name: 't', record_id: undefined });
  assert.strictEqual(captured.params[0].length, 64); // actor 截断到 64
  assert.strictEqual(captured.params[3], null);       // record_id undefined -> null
});
