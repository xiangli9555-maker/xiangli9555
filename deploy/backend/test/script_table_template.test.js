'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const tpl = require('../src/script_table_template');
const recipe = require('../cw_doc_recipe_v6');

test('Tab1固定双区9列，角色校验读取B/G', () => {
  assert.equal(tpl.STAT.columns.length, 9);
  assert.deepEqual(tpl.STAT.validationRoleColumns, ['B', 'G']);
  const f = tpl.roleValidationFormula(3);
  assert.match(f, /\$B\$3:\$B\$502/);
  assert.match(f, /\$G\$3:\$G\$502/);
});

test('Tab2固定11列且没有录制时间-中', () => {
  assert.equal(tpl.LINE.columns.length, 11);
  assert.equal(tpl.LINE.columns[10].key, 'role_validation');
  assert.equal(tpl.LINE.columns.some(x => x.title === '录制时间-中'), false);
  assert.equal(tpl.DATA_ROWS, 500);
});

test('公式安全转义单引号需求名', () => {
  assert.equal(tpl.quoteSheetName("John's Mission"), "'John''s Mission'");
  const f = tpl.statActualFormula("John's Mission", 'B', 3);
  assert.match(f, /'John''s Mission'!/);
});

test('recipe只消费模板唯一真源', () => {
  const r = recipe.buildRecipeV6({demand:{id:'1',task_name:"John's Mission",release_plan:'Yang1.0'}});
  assert.equal(r.template, tpl);
  assert.equal(r._summary.stat_col_count, 9);
  assert.equal(r._summary.line_col_count, 11);
  assert.equal(r._summary.tab_name, "John's Mission");
});
