/**
 * One-time TAPD snapshot import script
 * Reads tapd-snapshot.js and upserts into demands table via /api/demands POST
 * Run on CVM: node import_tapd.js
 */
const fs = require('fs');
const path = require('path');

// Read tapd-snapshot.js
const snapPath = path.resolve(process.env.TAPD_SNAPSHOT_PATH || path.join(__dirname, 'frontend/assets/tapd-snapshot.js'));
const content = fs.readFileSync(snapPath, 'utf-8');
const start = content.indexOf('[');
const end = content.lastIndexOf(']') + 1;
const data = JSON.parse(content.slice(start, end));

console.log(`TAPD snapshot: ${data.length} items`);

// Use mysql2 directly (same as backend)
const mysql = require('mysql2/promise');

async function run() {
  if (!process.env.DB_PASSWORD) throw new Error('DB_PASSWORD is required');
  const pool = await mysql.createPool({
    host: process.env.DB_HOST || 'mysql',
    user: process.env.DB_USER || 'vo_manager',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'vo_manager',
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 1
  });

  let inserted = 0, updated = 0, errors = 0;

  for (const item of data) {
    const tid = item.id;
    if (!tid) { errors++; continue; }
    const extId = BigInt(tid);

    try {
      // Check if exists
      const [existing] = await pool.query(
        'SELECT id FROM demands WHERE external_id = ?', [extId]
      );

      const fields = {
        external_id: extId,
        release_plan: item.release_plan || 'Ma5.0',
        version: item.release_plan || 'Ma5.0',
        area: item.area || '',
        task_name: item.task_name || '',
        description: (item.description || '').slice(0, 500),
        creator: item.creator || '',
        developer: item.developer || '',
        handler: item.handler || '',
        cn_lines_handler: item.cn_lines_handler || '',
        clarification: (item.clarification || '').slice(0, 1000),
        remark: (item.remark || '').slice(0, 1000),
        video_sync: item.video_sync || '',
        status: item.status || 'new',
        story_type: '音频',
        sync_source: 'tapd_snapshot',
        last_synced_at: new Date()
      };

      if (existing.length > 0) {
        // UPDATE
        const sets = [];
        const vals = [];
        for (const [k, v] of Object.entries(fields)) {
          if (k === 'external_id') continue;
          sets.push(`${k}=?`);
          vals.push(v);
        }
        vals.push(extId);
        await pool.query(`UPDATE demands SET ${sets.join(',')} WHERE external_id=?`, vals);
        updated++;
      } else {
        // INSERT
        const cols = Object.keys(fields);
        const placeholders = cols.map(() => '?').join(',');
        await pool.query(
          `INSERT INTO demands (${cols.join(',')}) VALUES (${placeholders})`,
          Object.values(fields)
        );
        inserted++;
      }

      if ((inserted + updated) % 10 === 0) {
        process.stdout.write(`\r  progress: ${inserted} inserted, ${updated} updated, ${errors} errors`);
      }
    } catch (e) {
      errors++;
      console.error(`\nError on ${tid}: ${e.message}`);
    }
  }

  // Verify
  const [rows] = await pool.query(
    "SELECT COUNT(*) as total, SUM(external_id IS NOT NULL) as tapd FROM demands WHERE story_type='音频'"
  );
  console.log(`\nDone! ${inserted} inserted, ${updated} updated, ${errors} errors`);
  console.log(`DB: ${rows[0].total} total audio rows, ${rows[0].tapd} with TAPD ID`);

  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
