// 声优库角色字段级审计模块单元测试（无需真实数据库，使用内存 mock）
const test = require('node:test');
const assert = require('node:assert');
const {
  ensureVoiceRolesAuditTable,
  diffVoiceRoleChanges,
  writeVoiceRoleAudit,
} = require('../src/audit');

test('ensureVoiceRolesAuditTable 发出 CREATE TABLE IF NOT EXISTS voice_roles_audit', async () => {
  let captured = '';
  const pool = { query: async (sql) => { captured = sql; return [{}]; } };
  await ensureVoiceRolesAuditTable(pool);
  assert.match(captured, /CREATE TABLE IF NOT EXISTS voice_roles_audit/);
  assert.match(captured, /role_id/);
  assert.match(captured, /field_name/);
  assert.match(captured, /old_value/);
  assert.match(captured, /new_value/);
  assert.match(captured, /changed_by/);
});

test('writeVoiceRoleAudit 写入角色/动作/字段/新旧值/操作者', async () => {
  let captured = null;
  const conn = { query: async (sql, params) => { captured = { sql, params }; return [{}]; } };
  await writeVoiceRoleAudit(conn, {
    role_id: 42, action: 'update', field_name: 'cn_va',
    old_value: '张三', new_value: '李四', changed_by: 'alice'
  });
  assert.match(captured.sql, /INSERT INTO voice_roles_audit/);
  assert.deepStrictEqual(captured.params, [42, 'update', 'cn_va', '张三', '李四', 'alice']);
});

test('writeVoiceRoleAudit 对 create 动作级记录字段名可为 null', async () => {
  let captured = null;
  const conn = { query: async (sql, params) => { captured = { sql, params }; return [{}]; } };
  await writeVoiceRoleAudit(conn, {
    role_id: 7, action: 'create', field_name: null, old_value: null,
    new_value: '{"module":"干员","role_cn":"角色A"}', changed_by: 'bob'
  });
  assert.deepStrictEqual(captured.params, [7, 'create', null, null, '{"module":"干员","role_cn":"角色A"}', 'bob']);
});

test('writeVoiceRoleAudit 无效 role_id 时跳过不写', async () => {
  let called = 0;
  const conn = { query: async () => { called++; return [{}]; } };
  await writeVoiceRoleAudit(conn, { role_id: null, action: 'bulk_import', field_name: null });
  await writeVoiceRoleAudit(conn, { role_id: 0, action: 'update', field_name: 'x' });
  await writeVoiceRoleAudit(conn, { role_id: -1, action: 'update', field_name: 'x' });
  assert.strictEqual(called, 0);
});

test('writeVoiceRoleAudit 写库抛错不向上抛出（审计失败不阻断主流程）', async () => {
  const bad = { query: async () => { throw new Error('db down'); } };
  await assert.doesNotReject(writeVoiceRoleAudit(bad, { role_id: 1, action: 'update', field_name: 'cn_va' }));
});

test('diffVoiceRoleChanges 识别真正变化的字段', () => {
  const oldRow = { id: 1, role_cn: '角色A', cn_va: '张三', en_va: '', gender: '男' };
  const body = { cn_va: '李四', en_va: 'Mike', gender: '男' }; // gender 值未变
  const changes = diffVoiceRoleChanges(oldRow, body, ['cn_va', 'en_va', 'gender'], (f, v) => v);
  assert.deepStrictEqual(changes, [
    { field_name: 'cn_va', old_value: '张三', new_value: '李四' },
    { field_name: 'en_va', old_value: '', new_value: 'Mike' },
  ]);
});

test('diffVoiceRoleChanges 忽略未提交的字段', () => {
  const oldRow = { role_cn: '角色A', cn_va: '张三' };
  const body = { cn_va: '李四' }; // 未提交 role_cn
  const changes = diffVoiceRoleChanges(oldRow, body, ['role_cn', 'cn_va'], (f, v) => v);
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].field_name, 'cn_va');
});

test('diffVoiceRoleChanges 通过 normalize 归一化 JSON 字段后比较', () => {
  // DB 旧值存的是带空格的 JSON 字符串，新值是数组；两者语义相同，归一化后应判为「无变化」
  const oldRow = { rec_time_cn: '["2026-09-01", "2026-09-02"]' };
  const body = { rec_time_cn: ['2026-09-01', '2026-09-02'] };
  const normalize = (f, v) => (Array.isArray(v) ? JSON.stringify(v) : JSON.stringify(JSON.parse(v)));
  const changes = diffVoiceRoleChanges(oldRow, body, ['rec_time_cn'], normalize);
  assert.strictEqual(changes.length, 0);
});

test('diffVoiceRoleChanges null 与空串视为相同', () => {
  const oldRow = { remark: null };
  const body = { remark: '' };
  const changes = diffVoiceRoleChanges(oldRow, body, ['remark'], (f, v) => v);
  assert.strictEqual(changes.length, 0);
});

test('diffVoiceRoleChanges 空入参返回空数组', () => {
  assert.deepStrictEqual(diffVoiceRoleChanges(null, {}, ['a'], (f, v) => v), []);
  assert.deepStrictEqual(diffVoiceRoleChanges({}, null, ['a'], (f, v) => v), []);
  assert.deepStrictEqual(diffVoiceRoleChanges({}, {}, null, (f, v) => v), []);
});
