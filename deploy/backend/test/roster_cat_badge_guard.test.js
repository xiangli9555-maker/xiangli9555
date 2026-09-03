// 声优库分组标题徽章化 + 工具行合并到 header（2026-09-03 用户截图定稿）
//   1. 分组标题 → 独立圆角药丸徽章（不再通栏），色点 + 中文 + 英文 + 数字集成
//   2. 分组色板与顶部 meter bar 对齐（同一份 PALETTE，禁止两套色）
//   3. 删掉 meter 头部 eyebrow / hint 那一行
//   4. 搜索框 + 男女筛选移到「新建声优」左边（原独立 .toolbar 行下线）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..', 'preview-声优库-精修版.html');
const MIRROR = path.join(__dirname, '..', '..', 'frontend', 'preview-声优库-精修版.html');
const SRC = fs.readFileSync(ROOT, 'utf8');

const rule = name => {
  const i = SRC.indexOf(name + '{');
  assert.ok(i > -1, `应存在样式规则 ${name}`);
  return SRC.slice(i + name.length + 1, SRC.indexOf('}', i));
};

// ---------- 1. 徽章化 ----------
test('分组标题为圆角药丸徽章，非通栏底色', () => {
  const label = rule('#rosterTable tbody tr.cat-section .cat-label');
  assert.match(label, /border-radius:999px/, '应为药丸圆角');
  assert.match(label, /background:/, '徽章自身带底色');
  assert.match(label, /border:1px solid/, '徽章带描边');
  const tr = rule('#rosterTable tbody tr.cat-section');
  assert.ok(!/background:color-mix\(in srgb, var\(--cat-color[^)]*\) 8%/.test(tr), '整行不得再铺通栏底色');
});

test('徽章内含色点 + 中文名 + 英文名 + 数字四段', () => {
  assert.match(SRC, /class="cat-dot"/, '应有色点');
  assert.match(SRC, /class="cat-text"/, '应有中文名');
  assert.match(SRC, /class="cat-en"/, '应有英文名');
  assert.match(SRC, /class="cat-cnt"/, '应有数字');
  assert.ok(!/· \$\{cnt\} 个角色/.test(SRC), '数字不再带「个角色」后缀');
  const dot = rule('#rosterTable tbody tr.cat-section .cat-dot');
  assert.match(dot, /border-radius:50%/, '色点为圆形');
  assert.ok(!SRC.includes('class="cat-bar"'), '原竖条应被色点取代');
});

test('中英文拆成独立字段，不再靠字符串里的 · 拼接', () => {
  assert.match(SRC, /const CAT_EN = \{/, '应有独立英文名映射');
  assert.ok(!/'指挥官':'指挥官 · COMMANDER'/.test(SRC), '不得再用拼接式 CAT_LABEL');
});

// ---------- 2. 色板统一 ----------
test('分组色板与顶部 bar 共用同一份定义', () => {
  assert.match(SRC, /const CAT_COLORS = \{'指挥官':'#727665','干员':'#CEA06C','Boss':'#E9E6DF','AI兵':'#D3DFDD','NPC':'#474C40','AI系统音':'#608980'\}/, '应统一为用户给定色板');
  // 色块色板（CAT_COLORS）与徽章文字墨色（CAT_INKS）各只允许一份定义
  assert.equal((SRC.match(/const CAT_COLORS\s*=/g) || []).length, 1, 'CAT_COLORS 只允许一份定义');
  assert.equal((SRC.match(/const CAT_INKS\s*=/g) || []).length, 1, 'CAT_INKS 只允许一份定义');
  assert.equal((SRC.match(/'指挥官':\s*'#/g) || []).length, 2, '除 CAT_COLORS / CAT_INKS 外不得再另开色板');
  assert.match(SRC, /const PALETTE = CAT_COLORS/, 'meter 应复用 CAT_COLORS');
});

test('暗色大类的徽章文字使用提亮墨色，保证深底可读', () => {
  const m = SRC.match(/const CAT_INKS = \{([^}]+)\}/);
  assert.ok(m, '应存在 CAT_INKS 定义');
  const inks = m[1];
  // 指挥官 #727665 / NPC #474C40 在深底上过暗，文字必须换用提亮值
  assert.doesNotMatch(inks, /'指挥官':\s*'#727665'/, '指挥官墨色不得沿用过暗的 #727665');
  assert.doesNotMatch(inks, /'NPC':\s*'#474C40'/, 'NPC 墨色不得沿用过暗的 #474C40');
  // 徽章文字与描边走 --cat-ink，色点与色条仍走原色 --cat-color
  assert.match(SRC, /--cat-color:\$\{color\};--cat-ink:\$\{ink\}/, 'tr 应同时写入色块色与墨色');
  assert.match(SRC, /\.cat-cnt\{color:var\(--cat-ink/, '数量文字应使用墨色');
  assert.match(SRC, /\.cat-dot\{[^}]*background:var\(--cat-color/, '色点应保留原色');
});

// ---------- 3. 删除 meter 头部 ----------
test('meter 头部 eyebrow / hint 行已移除', () => {
  assert.ok(!SRC.includes('class="meter-head"'), 'meter-head 应移除');
  assert.ok(!SRC.includes('ROSTER · 横向编制分布'), 'eyebrow 文案应移除');
  assert.ok(!SRC.includes('ANTEE'), 'hint 文案应移除');
  assert.ok(!SRC.includes('class="meter-eyebrow"'), 'eyebrow 元素应移除');
});

// ---------- 4. 工具行合并进 header ----------
test('搜索与性别筛选移入 header，位于新建声优左侧', () => {
  const i = SRC.indexOf('<div class="actions">');
  assert.ok(i > -1, '应存在 actions 容器');
  const block = SRC.slice(i, SRC.indexOf('</div>\n    </div>', i));
  const searchAt = block.indexOf('id="rosterSearch"');
  const genderAt = block.indexOf('data-gender="男"');
  const addAt = block.indexOf('openAddVA()');
  assert.ok(searchAt > -1, '搜索框应在 actions 内');
  assert.ok(genderAt > -1, '性别筛选应在 actions 内');
  assert.ok(addAt > -1, '新建声优应在 actions 内');
  assert.ok(searchAt < addAt, '搜索框须在新建声优左侧');
  assert.ok(genderAt < addAt, '性别筛选须在新建声优左侧');
});

test('原独立 toolbar 行已下线', () => {
  assert.ok(!/<div class="toolbar">/.test(SRC), '独立 toolbar 容器应移除');
  assert.match(SRC, /id="rosterSearch"/, '搜索框本体必须保留');
  assert.match(SRC, /data-gender="女"/, '性别筛选必须保留');
});

// ---------- 部署副本 ----------
test('部署副本与根权威文件保持一致', () => {
  assert.equal(fs.readFileSync(MIRROR, 'utf8'), SRC, 'deploy/frontend 副本必须与根文件一致');
});
