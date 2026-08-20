'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const backend = fs.readFileSync(path.resolve(__dirname, '../src/index.js'), 'utf8');
const rosterPage = fs.readFileSync(path.resolve(__dirname, '../../frontend/preview-声优库-精修版.html'), 'utf8');

test('voice records are never hard-deleted by API routes', () => {
  assert.doesNotMatch(backend, /DELETE\s+FROM\s+voice_roles/i);
  assert.doesNotMatch(backend, /DELETE\s+FROM\s+voice_actors/i);
  assert.match(backend, /soft_deleted:true/);
  assert.match(backend, /deleted_at=NOW\(\)/);
});

test('frontend never infers deletion from a row missing in the current list', () => {
  assert.doesNotMatch(rosterPage, /for\s*\(const\s+d\s+of\s+db\)[\s\S]{0,300}method:\s*['"]DELETE['"]/);
  assert.match(rosterPage, /ROSTER_DELETE_QUEUE_KEY/);
  assert.match(rosterPage, /仅处理显式确认过的回收站队列/);
});

test('frontend delete request carries typed-name and revision preconditions', () => {
  assert.match(rosterPage, /confirm_name:roleCn/);
  assert.match(rosterPage, /expected_revision:Number\(hit\.revision\|\|1\)/);
  assert.match(rosterPage, /请输入完整角色名确认/);
});
