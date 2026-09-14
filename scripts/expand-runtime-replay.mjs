// Run with the writer stopped before rolling back to a release without the codec.
// Default is read-only; --apply performs compare-and-swap expansion.
import mysql from 'mysql2/promise';
import { loadDatabaseConfig } from '../src/db/mariadb.mjs';
import { decodeRuntimePayload } from '../src/db/runtimePayloadCodec.mjs';
const config = loadDatabaseConfig();
if (!config) throw new Error('Database configuration required');
const pool = mysql.createPool(config);
try {
  const [rows] = await pool.query("SELECT id, runtime_payload FROM game_sessions WHERE JSON_EXTRACT(runtime_payload, '$.replay_cache.codec') IS NOT NULL");
  for (const row of rows) {
    const runtime = typeof row.runtime_payload === 'string' ? JSON.parse(row.runtime_payload) : row.runtime_payload;
    const expanded = decodeRuntimePayload(runtime);
    if (process.argv.includes('--apply')) {
      const [result] = await pool.query('UPDATE game_sessions SET runtime_payload = ? WHERE id = ? AND JSON_EXTRACT(runtime_payload, \'$.replay_cache.data\') = ?',
        [JSON.stringify(expanded), row.id, runtime.replay_cache.data]);
      if (result.affectedRows !== 1) throw new Error('Concurrent runtime mutation; stop all writers before rollback');
    }
  }
  console.log(`${process.argv.includes('--apply') ? 'Expanded' : 'Would expand'} ${rows.length} runtime replay caches`);
} finally { await pool.end(); }
