'use strict';
// 守卫测试：角色名括号闭合校验（src/role_name.js）。
//
// 背景（2026-09-02）：docx 解析器的切分 bug 把 `克劳斯·阿德勒 (Klaus Adler) 代号“钟表匠”`
// 切成 role_cn=`克劳斯·阿德勒 (Klaus` / role_en=`Klaus Adler)` 并落库。
// 前端 loadRoster 按 role_cn 合并「静态 roster.json + DB」时键对不上，同一角色渲染出两条。
// 本测试锁定 assertRoleNameBalanced 的判定边界，并守卫后端三个写入口都挂上了校验。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { assertRoleNameBalanced } = require('../src/role_name');

// ---------- 放行：平衡 / 无需校验 ----------

test('纯中文名（无括号）放行', () => {
  assert.strictEqual(assertRoleNameBalanced('克劳斯·阿德勒'), null);
});

test('英文名（无括号）放行', () => {
  assert.strictEqual(assertRoleNameBalanced('Klaus Adler'), null);
});

test('空字符串与 null/undefined 放行（交给必填校验，不重复报错）', () => {
  assert.strictEqual(assertRoleNameBalanced(''), null);
  assert.strictEqual(assertRoleNameBalanced(null), null);
  assert.strictEqual(assertRoleNameBalanced(undefined), null);
});

test('半角括号成对：Luna (Lara) 放行', () => {
  assert.strictEqual(assertRoleNameBalanced('Luna (Lara)'), null);
});

test('全角括号成对：露娜（Lara）放行', () => {
  assert.strictEqual(assertRoleNameBalanced('露娜（Lara）'), null);
});

// 关键：多组括号是合法数据，绝不能误杀
test('多组括号成对：Twins (Haddawi、Tokamak) 放行', () => {
  assert.strictEqual(assertRoleNameBalanced('Twins (Haddawi、Tokamak)'), null);
});

test('含顿号/间隔号/连字符的合法名放行', () => {
  assert.strictEqual(assertRoleNameBalanced('SOL-GTI指挥官'), null);
  assert.strictEqual(assertRoleNameBalanced('08-H1000'), null);
});

// ---------- 拦截：不平衡 ----------

test('历史 bug 值：克劳斯·阿德勒 (Klaus 被拦截', () => {
  const r = assertRoleNameBalanced('克劳斯·阿德勒 (Klaus');
  assert.ok(r, '应返回错误对象');
  assert.strictEqual(r.error, 'role_cn_unbalanced_brackets');
  assert.strictEqual(r.open, 1);
  assert.strictEqual(r.close, 0);
});

test('历史 bug 值：Klaus Adler) 被拦截', () => {
  const r = assertRoleNameBalanced('Klaus Adler)');
  assert.ok(r, '应返回错误对象');
  assert.strictEqual(r.open, 0);
  assert.strictEqual(r.close, 1);
});

test('全角半开：露娜（Lara 被拦截', () => {
  const r = assertRoleNameBalanced('露娜（Lara');
  assert.ok(r);
  assert.strictEqual(r.open, 1);
  assert.strictEqual(r.close, 0);
});

test('field 参数可切换，错误信息随字段名变化', () => {
  const r = assertRoleNameBalanced('Klaus Adler)', 'role_en');
  assert.strictEqual(r.field, 'role_en');
  assert.strictEqual(r.error, 'role_en_unbalanced_brackets');
});

test('返回值可直接作为 400 响应体：含 ok:false 与原值便于前端提示', () => {
  const name = '克劳斯·阿德勒 (Klaus';
  const r = assertRoleNameBalanced(name);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.value, name);
});

// ---------- 守卫：后端三个写入口都必须挂校验 ----------

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

test('守卫：index.js 已从 ./role_name 引入校验函数', () => {
  assert.ok(
    /require\(['"]\.\/role_name['"]\)/.test(SRC),
    'index.js 应 require ./role_name'
  );
  assert.ok(
    /assertRoleNameBalanced\s*[,}]/.test(SRC) || /const \{\s*assertRoleNameBalanced\s*\}/.test(SRC),
    'index.js 应解构出 assertRoleNameBalanced'
  );
});

test('守卫：POST 单条 upsert 挂载校验', () => {
  assert.ok(
    /unbalancedPost/.test(SRC) && /assertRoleNameBalanced\(body\.role_cn/.test(SRC),
    'POST / 应在建连前校验 body.role_cn'
  );
});

test('守卫：PATCH 更新挂载校验', () => {
  assert.ok(
    /unbalancedPatch/.test(SRC) && /assertRoleNameBalanced\(req\.body\.role_cn/.test(SRC),
    'PATCH /:id 应校验 req.body.role_cn'
  );
});

test('守卫：bulk 批量导入在开启事务前全量预检', () => {
  // 只截取 /bulk 这一个 handler，避免用全文件的 indexOf 造成误判
  const start = SRC.indexOf("voiceRoleRouter.post('/bulk'");
  assert.ok(start !== -1, '应存在 POST /bulk handler');
  const rest = SRC.slice(start);
  const end = rest.indexOf('\nvoiceRoleRouter.', 1);
  const handler = end === -1 ? rest : rest.slice(0, end);

  assert.ok(
    /assertRoleNameBalanced\(r\.role_cn/.test(handler),
    'POST /bulk 应逐行预检 role_cn'
  );
  // 预检必须早于 getConnection（即 beginTransaction / clear 软删全表之前）
  assert.ok(
    handler.indexOf('const bulkBad = []') !== -1 &&
    handler.indexOf('const bulkBad = []') < handler.indexOf('pool.getConnection'),
    'bulk 预检必须在获取连接（开启事务、clear 软删全表）之前，否则清完库才发现脏数据'
  );
});

test('守卫：bulk 预检只校验会被写入的行（与写入循环跳过口径一致）', () => {
  assert.ok(
    /if\s*\(!r\s*\|\|\s*!r\.module\s*\|\|\s*!r\.role_cn\)\s*return;/.test(SRC),
    '预检应跳过 module/role_cn 缺失的行，与 INSERT 循环的 continue 口径保持一致'
  );
});
