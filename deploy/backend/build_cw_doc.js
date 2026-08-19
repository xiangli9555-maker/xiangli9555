'use strict';
// build_cw_doc.js — 生成"文案策划台词汇总表"建表配方（CLI 调试用，不实际执行）
// 实际建表由十方文档 MCP 执行（见 dfai-live-server.js 的 /api/cw-doc 执行器）。
//
// 用法：node build_cw_doc.js <cw_id> <cw_name> <release> <story_id1,story_id2,...>
// 例：node build_cw_doc.js julyyyhu 胡瑞璋 Ma5.0 1020421949136163580,1020421949134949966

const fs = require('fs');
const path = require('path');
const { buildRecipe } = require('./cw_doc_recipe');

const WS = __dirname;
const cwId = process.argv[2];
const cwName = process.argv[3];
const release = process.argv[4];
const storyIds = (process.argv[5] || '').split(',').filter(Boolean);

if (!cwId || !release || !storyIds.length) {
  console.error('Usage: node build_cw_doc.js <cw_id> <cw_name> <release> <story_id1,story_id2,...>');
  process.exit(1);
}

const recipe = buildRecipe({ WS, cw_id: cwId, cw_name: cwName, release, story_ids: storyIds });

// 输出到文件供 AI / 调试逐步查看
const out = {
  step1_create_file: recipe.step1,
  step2_add_tables: recipe.step2,
  step3_add_fields_per_tab: recipe.step3,
  _summary: recipe._summary
};
fs.writeFileSync(path.join(WS, '_cw_doc_recipe.json'), JSON.stringify(out, null, 2));
console.log('✅ 配方已生成 → _cw_doc_recipe.json');
console.log('   文档名:', recipe._summary.doc_title);
console.log('   需求数:', recipe._summary.story_count, '  缺失:', recipe._summary.missing_count);
console.log('   角色下拉选项:', recipe.roleOptions.length);
recipe._summary.stories.forEach((r, i) => console.log('   ' + (i + 1) + '. [' + r.area + '] ' + String(r.name).slice(0, 40)));
