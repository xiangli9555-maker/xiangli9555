'use strict';
// 回归测试：NPC 声线表锚点行的中/英文名切分。
// 历史 bug（2026-09-02 修复）：`克劳斯·阿德勒 (Klaus Adler) 代号“钟表匠”` 被切成
// role_cn=`克劳斯·阿德勒 (Klaus` + role_en=`Klaus Adler)` 并落库，原因是旧正则
// `/\s+[A-Za-z].*$/` 在 "Klaus Adler" 中间的空格处就命中了。
const test = require('node:test');
const assert = require('node:assert');
const { splitRoleName } = require('../src/vadoc');

test('括号英文名 + 中文尾注：中英各就各位', () => {
  const r = splitRoleName('克劳斯·阿德勒 (Klaus Adler) 代号“钟表匠”');
  assert.strictEqual(r.cn, '克劳斯·阿德勒');
  assert.strictEqual(r.en, 'Klaus Adler');
});

test('全角括号同样生效', () => {
  const r = splitRoleName('克劳斯·阿德勒（Klaus Adler）');
  assert.strictEqual(r.cn, '克劳斯·阿德勒');
  assert.strictEqual(r.en, 'Klaus Adler');
});

test('空格分隔的英文名', () => {
  const r = splitRoleName('药贩少年-亚尼 Yani');
  assert.strictEqual(r.cn, '药贩少年-亚尼');
  assert.strictEqual(r.en, 'Yani');
});

test('紧贴合的英文名', () => {
  const r = splitRoleName('卢卡斯Lukas');
  assert.strictEqual(r.cn, '卢卡斯');
  assert.strictEqual(r.en, 'Lukas');
});

test('纯中文名保持原样', () => {
  const r = splitRoleName('「棋社」成员');
  assert.strictEqual(r.cn, '「棋社」成员');
  assert.strictEqual(r.en, '');
});

test('带间隔号的英文名不被截断', () => {
  const r = splitRoleName('维罗妮卡·卡尔多佐 Veronica Cardozo');
  assert.strictEqual(r.cn, '维罗妮卡·卡尔多佐');
  assert.strictEqual(r.en, 'Veronica Cardozo');
});
