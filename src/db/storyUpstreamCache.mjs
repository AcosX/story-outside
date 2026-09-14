import { createHash } from 'node:crypto';
import mysql from 'mysql2/promise';
import { loadDatabaseConfig } from './mariadb.mjs';

const cacheKey = url => createHash('sha256').update(url).digest('hex');
const query = (connection, sql, values = []) => connection.query({ sql, values, timeout: 2000 });

// A driver query timeout alone does not bound pool acquisition or a pending
// Galera COMMIT. Destroy the dedicated connection at the total deadline; a lost
// COMMIT response is treated as uncertain, and the next upsert is idempotent.
async function withConnection(pool, work, deadline = Date.now() + 4000) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Story cache database deadline exceeded');
  let connection;
  let expired = false;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      connection?.destroy();
      reject(new Error('Story cache database deadline exceeded'));
    }, remaining);
  });
  const operation = (async () => {
    connection = await pool.getConnection();
    if (expired) { connection.release(); throw new Error('Story cache database deadline exceeded'); }
    try { return await work(connection); } finally { connection.release(); }
  })();
  try { return await Promise.race([operation, timeout]); } finally { clearTimeout(timer); }
}

// Separate from gameplay snapshots: reading a catalog must not rewrite sessions
// or manufacture imported story versions. Each put waits for its own COMMIT.
export function createMariaStoryCache(pool) {
  let writes = Promise.resolve();
  return {
    async get(url) {
      const [rows] = await withConnection(pool, connection => query(connection,
        'SELECT source_url, fetched_at_ms, payload_json, format_version FROM story_upstream_cache WHERE cache_key = ? AND OCTET_LENGTH(payload_json) <= 1048576 LIMIT 1', [cacheKey(url)]));
      const row = rows[0];
      if (!row || row.source_url !== url || Number(row.format_version) !== 1) return null;
      return { version: 1, url, savedAt: Number(row.fetched_at_ms), payload: typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json };
    },
    async put(url, record) {
      const deadline = Date.now() + 4000;
      const task = writes.then(() => withConnection(pool, async connection => {
        try {
          await query(connection, 'START TRANSACTION');
          await query(connection,
            `INSERT INTO story_upstream_cache (cache_key, source_url, resource_id, fetched_at_ms, payload_json, format_version)
             VALUES (?, ?, ?, ?, ?, 1)
             ON DUPLICATE KEY UPDATE
               payload_json = IF(fetched_at_ms <= VALUES(fetched_at_ms), VALUES(payload_json), payload_json),
               fetched_at_ms = GREATEST(fetched_at_ms, VALUES(fetched_at_ms))`,
            [cacheKey(url), url, decodeURIComponent(new URL(url).pathname.split('/').at(-1)), record.savedAt, JSON.stringify(record.payload)]);
          // Pin the complete list; evict only the oldest detail responses.
          const [old] = await query(connection,
            "SELECT cache_key FROM story_upstream_cache ORDER BY (resource_id = 'list') DESC, fetched_at_ms DESC, cache_key LIMIT 256, 256");
          if (old.length) await query(connection,
            `DELETE FROM story_upstream_cache WHERE cache_key IN (${old.map(() => '?').join(',')})`, old.map(row => row.cache_key));
          await query(connection, 'COMMIT');
        } catch (error) {
          await query(connection, 'ROLLBACK').catch(() => {});
          throw error;
        }
      }, deadline));
      writes = task.catch(() => {});
      return task;
    },
  };
}

let configuredStore;
export function storyCacheFromEnv() {
  const mode = process.env.STORY_OUTSIDE_STORY_CACHE;
  if (!mode) return undefined;
  if (mode !== 'mariadb') throw new Error('STORY_OUTSIDE_STORY_CACHE must be mariadb');
  if (configuredStore) return configuredStore;
  const config = loadDatabaseConfig();
  if (!config) throw new Error('MariaDB story cache requires database configuration');
  const pool = mysql.createPool({ ...config, connectionLimit: 2, queueLimit: 4, maxIdle: 0, idleTimeout: 1000, connectTimeout: Math.min(config.connectTimeout, 1500) });
  configuredStore = createMariaStoryCache(pool);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void pool.end().catch(() => {}); });
  return configuredStore;
}
