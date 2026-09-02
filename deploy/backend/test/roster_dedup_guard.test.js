// 防线②：声优库列表清洗守卫测试
// 直接从 preview-声优库-精修版.html 抽取真实函数源码执行，避免测试与实现脱节。
// 背景：docx 解析曾把「克劳斯·阿德勒 (Klaus Adler) 代号"钟表匠"」切成「克劳斯·阿德勒 (Klaus」，
// 导致静态快照与 DB 各一条、role_cn 键对不上，页面渲染出同一角色的两条。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, '..', '..', '..', 'preview-声优库-精修版.html');
const SRC = fs.readFileSync(HTML, 'utf8');

// 抽取「名册清洗」整段：从注释锚点到 loadRosterDeleteQueue 之前
const START = '// ---- 名册清洗';
const END = 'function loadRosterDeleteQueue(){';
const i0 = SRC.indexOf(START);
const i1 = SRC.indexOf(END);
assert.ok(i0 > -1 && i1 > i0, '应在声优库页面中找到名册清洗代码块');
const BLOCK = SRC.slice(i0, i1);

const {
  rosterNameBalanced, rosterDedupKey, rosterTrustScore, sanitizeRosterList
} = new Function(BLOCK + '\nreturn {rosterNameBalanced, rosterDedupKey, rosterTrustScore, sanitizeRosterList};')();

const row = (o) => Object.assign({ id: 1, role_cn: '', role_en: '', revision: 1 }, o);

// ---------- rosterNameBalanced ----------
test('括号闭合：平衡的中英文组合一律放行', () => {
  assert.equal(rosterNameBalanced('克劳斯·阿德勒'), true);
  assert.equal(rosterNameBalanced('Luna (Lara)'), true);
  assert.equal(rosterNameBalanced('Twins（Haddawi、Tokamak）'), true);
  assert.equal(rosterNameBalanced('SOL-GTI指挥官'), true);
  assert.equal(rosterNameBalanced(''), true);
});

test('括号闭合：半截括号一律判脏（半角 + 全角都要抓）', () => {
  assert.equal(rosterNameBalanced('克劳斯·阿德勒 (Klaus'), false);
  assert.equal(rosterNameBalanced('Klaus Adler)'), false);
  assert.equal(rosterNameBalanced('克劳斯（阿德勒'), false);
  assert.equal(rosterNameBalanced('阿德勒）'), false);
});

// ---------- rosterDedupKey ----------
test('归一键：抹平括号别名 / 空白 / 大小写差异', () => {
  assert.equal(rosterDedupKey('克劳斯·阿德勒 (Klaus'), rosterDedupKey('克劳斯·阿德勒'));
  assert.equal(rosterDedupKey('Luna (Lara)'), rosterDedupKey('Luna'));
  assert.equal(rosterDedupKey('  Luna  '), rosterDedupKey('luna'));
});

test('归一键：未闭合括号的截断名必须与干净名同键（否则去重失效）', () => {
  assert.equal(rosterDedupKey('克劳斯·阿德勒 (Klaus'), rosterDedupKey('克劳斯·阿德勒'));
  assert.equal(rosterDedupKey('克劳斯（阿德勒'), rosterDedupKey('克劳斯'));
  assert.equal(rosterDedupKey('Luna (Lara'), rosterDedupKey('Luna'));
  assert.equal(rosterDedupKey('Lara)'), rosterDedupKey('Lara'));
});

test('归一键：不同角色不能撞键', () => {
  assert.notEqual(rosterDedupKey('克劳斯·阿德勒'), rosterDedupKey('露娜'));
  assert.notEqual(rosterDedupKey('Luna'), rosterDedupKey('Lunar'));
});

// ---------- sanitizeRosterList ----------
test('清洗：剔除括号不闭合的脏行', () => {
  const out = sanitizeRosterList([
    row({ id: 1, role_cn: '克劳斯·阿德勒', db_id: 303, revision: 7 }),
    row({ id: 2, role_cn: '克劳斯·阿德勒 (Klaus', revision: 3 }),
    row({ id: 3, role_cn: '露娜', db_id: 304 })
  ]);
  assert.equal(out.length, 2);
  assert.ok(out.every(r => rosterNameBalanced(r.role_cn)));
});

test('清洗：脏/净双胞胎折叠成一条，且保留已入库（db_id）的那条', () => {
  const out = sanitizeRosterList([
    row({ id: 2, role_cn: '克劳斯·阿德勒 (Klaus', role_en: 'Klaus Adler)', revision: 9 }),
    row({ id: 1, role_cn: '克劳斯·阿德勒', role_en: 'Klaus Adler', db_id: 303, revision: 7 })
  ]);
  assert.equal(out.length, 1, '同一角色只应剩一条');
  assert.equal(out[0].role_cn, '克劳斯·阿德勒');
  assert.equal(out[0].role_en, 'Klaus Adler');
  assert.equal(out[0].db_id, 303);
});

test('清洗：真重名（role_cn 写法完全一致）两条都保留，不误删', () => {
  const out = sanitizeRosterList([
    row({ id: 1, role_cn: '同名角色', db_id: 10 }),
    row({ id: 2, role_cn: '同名角色', db_id: 11 })
  ]);
  assert.equal(out.length, 2);
});

test('清洗：全干净的同键行（括号别名不同）整组保留，不折叠', () => {
  const out = sanitizeRosterList([
    row({ id: 1, role_cn: '代号A (Alpha)', db_id: 21 }),
    row({ id: 2, role_cn: '代号A (Beta)', db_id: 22 })
  ]);
  assert.equal(out.length, 2, '干净行之间不得互相折叠');
});

test('清洗：合法含括号名不被误伤', () => {
  const src = [
    row({ id: 1, role_cn: 'Luna (Lara)', db_id: 1 }),
    row({ id: 2, role_cn: 'Twins（Haddawi、Tokamak）', db_id: 2 }),
    row({ id: 3, role_cn: 'SOL-GTI指挥官', db_id: 3 }),
    row({ id: 4, role_cn: '08-H1000', db_id: 4 })
  ];
  const out = sanitizeRosterList(src);
  assert.equal(out.length, 4);
});

test('清洗：全表皆脏时原样返回，绝不把列表清成空', () => {
  const src = [row({ id: 1, role_cn: 'A (B' }), row({ id: 2, role_cn: 'C)' })];
  assert.equal(sanitizeRosterList(src).length, 2);
});

test('清洗：空输入安全返回', () => {
  assert.deepEqual(sanitizeRosterList([]), []);
  assert.equal(sanitizeRosterList(null), null);
});

test('清洗：100 行全正常时数量与顺序零变动', () => {
  const src = Array.from({ length: 100 }, (_, i) => row({ id: i + 1, role_cn: '角色' + (i + 1), db_id: i + 1 }));
  const out = sanitizeRosterList(src);
  assert.equal(out.length, 100);
  assert.deepEqual(out.map(r => r.id), src.map(r => r.id));
});

// ---------- 挂载守卫：确保清洗真的接进了 loadRoster ----------
test('守卫：loadRoster 出口必须过 sanitize + purgeLegacyDraftKeys', () => {
  assert.ok(/TALENT_LIST = sanitizeRosterList\(list\);/.test(SRC), 'TALENT_LIST 必须经 sanitizeRosterList');
  assert.ok(/purgeLegacyDraftKeys\(\);\s+\/\//.test(SRC), 'loadRoster 必须调用 purgeLegacyDraftKeys');
  // 清洗必须在 renderRoster 之前
  assert.ok(SRC.indexOf('TALENT_LIST = sanitizeRosterList(list);') < SRC.indexOf('renderRoster();'));
});

test('守卫：草稿 key 已升 v2 且旧 key 会被清除', () => {
  assert.ok(/ROSTER_DRAFT_KEYS = \{[^}]*edits:'vo_talent_edits_v2'[^}]*\}/.test(SRC), 'edits key 应为 v2');
  assert.ok(/adds:'vo_talent_adds_v2'/.test(SRC), 'adds key 应为 v2');
  assert.ok(/ROSTER_LEGACY_DRAFT_KEYS = \['vo_talent_edits_v1','vo_talent_adds_v1','vo_talent_deletes_v1'\]/.test(SRC),
    '旧 key 清单应包含三个 v1 key');
  assert.ok(/function purgeLegacyDraftKeys\(\)\{\s*ROSTER_LEGACY_DRAFT_KEYS\.forEach/.test(SRC),
    'purgeLegacyDraftKeys 应遍历清除旧 key');
  // 业务代码里不允许再出现硬编码的 v1 key（常量清单除外）
  const business = SRC.replace(/ROSTER_LEGACY_DRAFT_KEYS = \[[^\]]*\]/, '');
  assert.equal(/vo_talent_(edits|adds|deletes)_v1/.test(business), false,
    '业务代码中不应残留硬编码 v1 草稿 key');
});
