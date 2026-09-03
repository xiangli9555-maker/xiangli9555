'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const backend = fs.readFileSync(path.resolve(__dirname, '../src/index.js'), 'utf8');
const schema = fs.readFileSync(path.resolve(__dirname, '../sql/init.sql'), 'utf8');
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
  assert.match(rosterPage, /绝不按「当前列表缺失」推断删除/);
  assert.match(rosterPage, /if\(typed !== label\)/);            // 必须输入完整角色名才能删
});

test('frontend delete request carries typed-name and revision preconditions', () => {
  assert.match(rosterPage, /confirm_name: label/);
  assert.match(rosterPage, /expected_revision: Number\(hit\.revision \|\| 1\)/);
  assert.match(rosterPage, /请输入完整角色名确认/);
});

test('voice-role patch is guarded by an atomic optimistic-lock revision', () => {
  assert.match(backend, /updatePrecondition\(req\.body\)/);
  assert.match(backend, /WHERE id=\? AND revision=\? AND is_deleted=0/);
  assert.match(backend, /error:'revision_conflict'/);
  assert.match(backend, /current_revision/);
  assert.match(backend, /res\.json\(\{ ok: true, revision: expectedRevision \+ 1 \}\)/);
});

test('frontend patch sends the current revision and stores the returned revision', () => {
  assert.match(rosterPage, /expected_revision: Number\(hit\.revision \|\| 1\)/);
  assert.match(rosterPage, /const j = await r\.json\(\)\.catch\(\(\)=>\(\{\}\)\)/);
  assert.match(rosterPage, /hit\.revision = Number\(j\.revision \|\| \(Number\(hit\.revision \|\| 1\) \+ 1\)\)/);
  assert.match(rosterPage, /row\.revision = hit\.revision/);          // 写回本地行，后续 PATCH 才不会撞锁
});

// 2026-09-02：「保存到系统」批量按钮退役，单元格编辑改为直写 voice_roles
// 2026-09-03 更新：编辑入口从方案 A（td contenteditable 就地编辑）改为方案 C（行尾铅笔 + popover 卡），
//   落库层 saveCellEdits / persistVoiceRole 不变；原「复合字段合并成一次 PATCH」的断言随
//   loc_studio 复合单元格一起下线 —— 方案 C 里地点与录音棚本就是两个独立输入，
//   仍由 saveRowEditor 汇总成单次 saveCellEdits 调用，合并语义未丢失。
test('roster cell edits write straight to the voice_roles API', () => {
  assert.doesNotMatch(rosterPage, /syncRosterToBackend/);             // 旧批量回写入口已删除
  assert.doesNotMatch(rosterPage, /id="btnSyncRoster"/);              // 按钮 DOM 已删除
  assert.match(rosterPage, /async function saveCellEdits\(/);          // 落库统一入口
  assert.match(rosterPage, /function saveCellEdit\(id, field, val\)\{ return saveCellEdits\(/);
  assert.match(rosterPage, /await persistVoiceRole\(row, uiPatch\)/);  // 走落库层而非 localStorage
  // 方案 C：一次编辑的多字段仍必须合并成单次 saveCellEdits（含地点 + 录音棚），不得逐字段连发
  assert.match(rosterPage, /async function saveRowEditor\(/);
  const i0 = rosterPage.indexOf('async function saveRowEditor(');
  const block = rosterPage.slice(i0, i0 + 2200);
  assert.equal((block.match(/saveCellEdits\(/g) || []).length, 1, '整卡保存只允许一次落库调用');
});

// 落库失败不能静默：必须提示「未入库」，且草稿要有自动回写出口
test('failed roster writes are never silent and drafts auto-write-back', () => {
  assert.match(rosterPage, /async function migrateRosterDrafts\(/);
  assert.match(rosterPage, /^  migrateRosterDrafts\(\);$/m);           // loadRoster 末尾自动触发
  assert.match(rosterPage, /未入库/);                                  // 失败提示明确
  assert.match(rosterPage, /function saveRosterDraft\(/);              // 离线草稿兜底
});

test('rich roster fields persist in voice_roles', () => {
  for (const field of ['remark', 'casting_note', 'rec_time_cn', 'rec_time_en']) {
    assert.match(rosterPage, new RegExp(`${field}:`));
    assert.match(backend, new RegExp(`['"]${field}['"]`));
    assert.match(schema, new RegExp(`\\b${field}\\s+`, 'i'));
  }
});
