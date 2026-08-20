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

module.exports = { ensureAuditTable, writeAudit };
