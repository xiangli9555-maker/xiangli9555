'use strict';
// cw_doc_recipe_v6.js — v6：每需求一份腾讯文档企业版智能表格
// 与旧 cw_doc_recipe.js 差异：
//   1) 输入不再是 cw_id + N story_ids，而是**单个 demand**（story_id）
//   2) 文档命名统一 《台词表·<release>·<task_name>》
//   3) 一份 doc 一个 tab（tab 名=task_name），不再多 tab 拼多需求
//   4) 列 = v5 原版 10 列不改
//   5) 幂等键 = (demand_id, NO.序号)，程序侧 script_lines 表用联合主键
//   6) 声优字段不入表（要展示时查 voice_roles by role_cn）

const fs = require('fs');
const path = require('path');

const CAT_COLOR = { '指挥官':3, '干员':4, 'Boss':1, 'AI兵':5, 'NPC':2, 'AI系统音':7 };

// —— 数据源读取（沿用 v5 逻辑）——
function readSnapshot(WS) {
  const candidates = [
    path.join(WS, 'assets', 'tapd-snapshot.js'),
    path.join(WS, 'preview-需求汇总-精修版.html'),
    path.join(WS, '_vo_snapshot_data.json')
  ];
  for (const f of candidates) {
    try {
      const txt = fs.readFileSync(f, 'utf8');
      let m = txt.match(/window\.TAPD_SNAPSHOT\s*=\s*(\[[\s\S]*?\n\]);/);
      if (!m) m = txt.match(/const TAPD_SNAPSHOT\s*=\s*(\[[\s\S]*?\n\]);/);
      if (!m && f.endsWith('.json')) m = [null, txt];
      if (m) {
        const arr = JSON.parse(m[1]);
        if (Array.isArray(arr) && arr.length) return arr;
      }
    } catch (e) { /* try next */ }
  }
  throw new Error('TAPD_SNAPSHOT not found');
}
function readRoster(WS) {
  const r = JSON.parse(fs.readFileSync(path.join(WS, 'assets/roster.json'), 'utf8'));
  return r.roster || r;
}

// —— 命名规则（PM 2026-08-14 定）——
//   文档名：《台词表·<release>·<task_name>》
//   ⚠ tab 也用 task_name（≤26 字截断避免超限）
function docTitle(demand) {
  const rel = demand.release_plan || demand.release || '';
  const name = String(demand.task_name || '').replace(/[《》|\/\\]/g, '').trim();
  return `《台词表·${rel}·${name}》`;
}
function tabName(demand) {
  let n = String(demand.task_name || '').replace(/[|\/\\]/g, '-').replace(/\s+/g, ' ').trim();
  if (n.length > 26) n = n.slice(0, 26) + '…';
  return n || String(demand.id);
}

/**
 * 计算 v6 建表配方（单需求 → 单文档）。
 * @param {object} p
 * @param {string} p.WS                项目根目录
 * @param {object} p.demand            需求对象（含 id/task_name/area/release_plan/tapd_url/creator）
 * @param {object[]} [p.roster]        可选：预加载的 roster（省一次 IO）
 * @returns {{step1, step2, step3, roleOptions, _summary}}
 */
function buildRecipeV6({ WS, demand, roster }) {
  if (!demand || !demand.id || !demand.task_name) {
    throw new Error('buildRecipeV6 requires demand{id,task_name,...}');
  }
  const rosterArr = roster || readRoster(WS);
  const roleOptions = rosterArr.map(r => ({
    text: r.role_cn,
    style: CAT_COLOR[r.category] || 8
  }));

  const title = docTitle(demand);
  // Step 1: 建智能表格
  const step1 = {
    tool: 'mcp__tencent-docs-oa__manage.create_file',
    params: { title, type: 9 }   // 9 = SMART_SHEET
  };

  // Step 2: 建单 tab（一份 doc 一个 tab）· 与 v5 一致包装成数组，automation 遍历
  const step2 = [{
    tool: 'mcp__tencent-docs-oa__smartsheet.add_table',
    params: {
      file_id: '<file_id from step1>',
      properties: { title: tabName(demand), index: 1 }
    },
    _meta: {
      demand_id: demand.id, area: demand.area,
      release: demand.release_plan || demand.release,
      tapd_url: demand.tapd_url, creator: demand.creator
    }
  }];

  // Step 3: 加 10 列字段（严格照 v5，一列不改；声优/归属/Release 都不入表——文档名已带 release+task_name，声优派生查 voice_roles）
  // 注：字段名 params_template 与 v5 一致（file_id/sheet_id 由执行器在运行时填入），automation 提示词无需改。
  const step3 = {
    tool: 'mcp__tencent-docs-oa__smartsheet.add_fields',
    params_template: {
      file_id: '<file_id>',
      sheet_id: '<sheet_id from step2>',
      fields: [
        { field_title: 'NO.序号',          field_type: 'autoNumber', property_auto_number: { type: 1 } },
        { field_title: '游戏角色名',        field_type: 'singleSelect',
          property_single_select: { is_quick_add: false, options: roleOptions } },
        { field_title: '台词-中',           field_type: 'text', property_text: {} },
        { field_title: '台词-英 Lines',     field_type: 'text', property_text: {} },
        { field_title: '情绪',             field_type: 'text', property_text: {} },
        { field_title: '触发条件',          field_type: 'text', property_text: {} },
        { field_title: 'GP Audio Event/音频文件名', field_type: 'text', property_text: {} },
        { field_title: '备注信息',          field_type: 'text', property_text: {} },
        { field_title: '录制时间-中',       field_type: 'dateTime',
          property_date_time: { format: 'yyyy-mm-dd', auto_fill: false } },
        { field_title: '录制时间-英',       field_type: 'dateTime',
          property_date_time: { format: 'yyyy-mm-dd', auto_fill: false } }
      ]
    }
  };

  return {
    step1, step2, step3, roleOptions,
    // 兼容 v5 automation 的 kind 字段：v6 恒为 'full'（每 doc 全新建）；追加模式不存在
    kind: 'full',
    _summary: {
      demand_id: demand.id, task_name: demand.task_name,
      area: demand.area, release: demand.release_plan || demand.release,
      doc_title: title, tab_name: tabName(demand),
      col_count: step3.params_template.fields.length
    }
  };
}

// —— 序号生成器：为一行台词生成 <demand_id>-<3位序> ——
function makeRowNo(demandId, idxWithinTab) {
  return `${demandId}-${String(idxWithinTab).padStart(3, '0')}`;
}

// —— 声优派生：按 role_cn 查 voice_roles（或 roster）返回 {cn_va, en_va} ——
function deriveVoiceActors(roleCn, rosterOrVoiceRoles) {
  if (!roleCn) return { cn_va: '', en_va: '' };
  const target = String(roleCn).trim();
  const hit = (rosterOrVoiceRoles || []).find(r => String(r.role_cn || '').trim() === target);
  return {
    cn_va: (hit && (hit.cn_va || '')) || '',
    en_va: (hit && (hit.en_va || '')) || ''
  };
}

module.exports = {
  buildRecipeV6, readSnapshot, readRoster, docTitle, tabName,
  makeRowNo, deriveVoiceActors, CAT_COLOR
};
