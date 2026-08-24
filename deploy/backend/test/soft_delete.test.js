'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { deletePrecondition } = require('../src/soft_delete');

const row = { role_cn: '测试角色', revision: 7 };

test('soft delete requires an optimistic-lock revision', () => {
  assert.deepEqual(
    deletePrecondition(row, { confirm_name: '测试角色' }, 'role_cn'),
    { status: 428, error: 'revision_required' }
  );
});

test('soft delete requires an exact typed name', () => {
  assert.deepEqual(
    deletePrecondition(row, { expected_revision: 7 }, 'role_cn'),
    { status: 428, error: 'delete_confirmation_required' }
  );
  assert.deepEqual(
    deletePrecondition(row, { expected_revision: 7, confirm_name: '其他角色' }, 'role_cn'),
    { status: 409, error: 'delete_confirmation_mismatch' }
  );
});

test('soft delete rejects stale revisions', () => {
  assert.deepEqual(
    deletePrecondition(row, { expected_revision: 6, confirm_name: '测试角色' }, 'role_cn'),
    { status: 409, error: 'revision_conflict', current_revision: 7 }
  );
});

test('soft delete accepts exact confirmation and current revision', () => {
  assert.equal(
    deletePrecondition(row, { expected_revision: 7, confirm_name: '测试角色' }, 'role_cn'),
    null
  );
});
