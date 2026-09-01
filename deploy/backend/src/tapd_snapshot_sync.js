'use strict';

function snapshotScopes(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('tapd_snapshot_empty');
  const scopes = new Map();
  for (const item of items) {
    const release = String((item && item.release_plan) || '').trim();
    const externalId = String((item && item.id) || '').trim();
    if (!release || !/^\d{19}$/.test(externalId)) continue;
    if (!scopes.has(release)) scopes.set(release, new Set());
    scopes.get(release).add(externalId);
  }
  if (scopes.size === 0) throw new Error('tapd_snapshot_has_no_valid_scope');
  return scopes;
}

async function reconcileMissingTapdDemands(conn, items, syncedAt = new Date()) {
  const scopes = snapshotScopes(items);
  let deactivated = 0;
  for (const [release, ids] of scopes) {
    const externalIds = Array.from(ids);
    const placeholders = externalIds.map(() => '?').join(',');
    const sql = `UPDATE demands SET status='suspended', last_synced_at=?
      WHERE sync_source='tapd_snapshot'
        AND story_type='音频'
        AND release_plan=?
        AND external_id IS NOT NULL
        AND status!='suspended'
        AND external_id NOT IN (${placeholders})`;
    const [result] = await conn.query(sql, [syncedAt, release, ...externalIds]);
    deactivated += Number(result && result.affectedRows || 0);
  }
  return { deactivated, releases: Array.from(scopes.keys()) };
}

module.exports = { reconcileMissingTapdDemands, snapshotScopes };
