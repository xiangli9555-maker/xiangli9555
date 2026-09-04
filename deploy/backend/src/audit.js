// audit.js — 统一审计日志
// 记录对核心业务表的增删改/恢复操作，便于事后追溯与合规。
// 表结构（幂等创建）：
//   audit_log(id, actor, action, table_name, record_id, detail_json, created_at)

async function ensureAuditTable(pool) {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS audit_log (
      id          BIGINT AUTO_INCREMENT PRIMARY KEY,
      actor       VARCHAR(64)  NOT NULL DEFAULT 'anonymous',
      action      VARCHAR(32)  NOT NULL,
      table_name  VARCHAR(64)  NOT NULL,
      record_id   VARCHAR(64)  NULL,
      detail_json MEDIUMTEXT   NULL,
      created_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_audit_table_record (table_name, record_id),
      INDEX idx_audit_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  } catch (e) {
    console.error('[audit] ensure table fail:', e.message);
  }
}

/**
 * 写入审计记录。
 * @param {object} conn 连接对象（事务内）或 pool（自动提交）
 * @param {object} opt { actor, action, table_name, record_id, detail }
 */
async function writeAudit(conn, opt) {
  const actor = String(opt.actor || 'anonymous').slice(0, 64);
  const action = String(opt.action || 'unknown').slice(0, 32);
  const table_name = String(opt.table_name || '').slice(0, 64);
  const record_id = opt.record_id === undefined || opt.record_id === null ? null : String(opt.record_id).slice(0, 64);
  let detail_json = null;
  if (opt.detail !== undefined && opt.detail !== null) {
    try { detail_json = typeof opt.detail === 'string' ? opt.detail : JSON.stringify(opt.detail); }
    catch (_) { detail_json = null; }
  }
  try {
    await conn.query(
      'INSERT INTO audit_log (actor, action, table_name, record_id, detail_json) VALUES (?,?,?,?,?)',
      [actor, action, table_name, record_id, detail_json]
    );
  } catch (e) {
    // 审计失败不应阻断主流程
    console.warn('[audit] write failed:', e.message);
  }
}

// ---------- 声优库角色变更审计（字段级 diff） ----------
// 与通用 audit_log（整行快照）互补：audit_log 记「谁对哪个角色做了 create/update/delete」，
// voice_roles_audit 记「谁在何时把哪个字段从什么改成什么」，对标 script_line_history 留痕范式。
// 表结构（幂等创建）：
//   voice_roles_audit(id, role_id, action, field_name, old_value, new_value, changed_by, changed_at)

async function ensureVoiceRolesAuditTable(pool) {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS voice_roles_audit (
      id          BIGINT AUTO_INCREMENT PRIMARY KEY,
      role_id     INT NOT NULL COMMENT 'voice_roles.id',
      action      VARCHAR(32) NOT NULL DEFAULT 'update' COMMENT 'create/update/soft_delete/restore',
      field_name  VARCHAR(64) NULL COMMENT '变更字段；动作级记录（create）为 NULL',
      old_value   MEDIUMTEXT NULL,
      new_value   MEDIUMTEXT NULL,
      changed_by  VARCHAR(64) NULL COMMENT '操作者（登录身份）',
      changed_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_role (role_id),
      INDEX idx_role_time (role_id, changed_at),
      INDEX idx_changed_at (changed_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  } catch (e) {
    console.error('[audit] ensure voice_roles_audit fail:', e.message);
  }
}

/**
 * 计算字段级变更（纯函数，便于单测）。
 * @param {object} oldRow  数据库旧行（含各字段 DB 存储值）
 * @param {object} newBody 请求体（前端提交的新值）
 * @param {string[]} fields 参与比较的字段白名单
 * @param {function} [normalize] (field, value) => 归一化后的存储值（如 JSON 字段紧凑化）
 * @returns {{field_name:string, old_value:string, new_value:string}[]}
 */
function diffVoiceRoleChanges(oldRow, newBody, fields, normalize) {
  const changes = [];
  if (!oldRow || !newBody || !Array.isArray(fields)) return changes;
  for (const f of fields) {
    if (!(f in newBody)) continue;
    const oldV = normalize ? normalize(f, oldRow[f]) : oldRow[f];
    const newV = normalize ? normalize(f, newBody[f]) : newBody[f];
    const oldS = oldV == null ? '' : String(oldV);
    const newS = newV == null ? '' : String(newV);
    if (oldS !== newS) changes.push({ field_name: f, old_value: oldS, new_value: newS });
  }
  return changes;
}

/**
 * 写入一条声优库角色审计（字段级）。审计失败不阻断主流程。
 * @param {object} conn 事务连接或 pool
 * @param {object} entry { role_id, action, field_name, old_value, new_value, changed_by }
 */
async function writeVoiceRoleAudit(conn, entry) {
  const role_id = Number(entry.role_id);
  if (!Number.isInteger(role_id) || role_id <= 0) return;
  const action = String(entry.action || 'update').slice(0, 32);
  const field_name = entry.field_name == null ? null : String(entry.field_name).slice(0, 64);
  const changed_by = entry.changed_by == null ? null : String(entry.changed_by).slice(0, 64);
  const toText = (v) => (v == null ? null : String(v));
  try {
    await conn.query(
      'INSERT INTO voice_roles_audit (role_id, action, field_name, old_value, new_value, changed_by) VALUES (?,?,?,?,?,?)',
      [role_id, action, field_name, toText(entry.old_value), toText(entry.new_value), changed_by]
    );
  } catch (e) {
    console.warn('[audit] voice_roles_audit write failed:', e.message);
  }
}

module.exports = {
  ensureAuditTable,
  writeAudit,
  ensureVoiceRolesAuditTable,
  diffVoiceRoleChanges,
  writeVoiceRoleAudit,
};
