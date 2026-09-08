import mysql from 'mysql2/promise';

const DATABASE_URL_ENV = 'STORY_OUTSIDE_DATABASE_URL';
let pool = null;
let state = Object.freeze({ configured: false, status: 'disabled', version: null });

function loadDatabaseConfig(env = process.env) {
  const raw = env[DATABASE_URL_ENV];
  let connection;
  if (raw) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`${DATABASE_URL_ENV} must be a valid mariadb:// or mysql:// URL`);
    }
    if (!['mariadb:', 'mysql:'].includes(url.protocol)) {
      throw new Error(`${DATABASE_URL_ENV} must use mariadb:// or mysql://`);
    }
    if (!url.hostname || !url.pathname || url.pathname === '/') {
      throw new Error(`${DATABASE_URL_ENV} must include a host and database name`);
    }
    connection = {
      host: url.hostname,
      port: url.port ? Number(url.port) : 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)),
    };
  } else if (env.STORY_OUTSIDE_DB_HOST) {
    const required = ['STORY_OUTSIDE_DB_NAME', 'STORY_OUTSIDE_DB_USER', 'STORY_OUTSIDE_DB_PASSWORD'];
    const missing = required.filter((key) => !env[key]);
    if (missing.length) throw new Error(`MariaDB configuration is missing: ${missing.join(', ')}`);
    connection = {
      host: env.STORY_OUTSIDE_DB_HOST,
      port: Number(env.STORY_OUTSIDE_DB_PORT || 3306),
      user: env.STORY_OUTSIDE_DB_USER,
      password: env.STORY_OUTSIDE_DB_PASSWORD,
      database: env.STORY_OUTSIDE_DB_NAME,
    };
  } else {
    return null;
  }

  const connectionLimit = Number(env.STORY_OUTSIDE_DATABASE_POOL_SIZE || 10);
  const connectTimeout = Number(env.STORY_OUTSIDE_DATABASE_CONNECT_TIMEOUT_MS || 5000);
  if (!Number.isInteger(connectionLimit) || connectionLimit < 1 || connectionLimit > 100) {
    throw new Error('STORY_OUTSIDE_DATABASE_POOL_SIZE must be an integer from 1 to 100');
  }
  if (!Number.isInteger(connectTimeout) || connectTimeout < 100 || connectTimeout > 60000) {
    throw new Error('STORY_OUTSIDE_DATABASE_CONNECT_TIMEOUT_MS must be an integer from 100 to 60000');
  }

  return {
    ...connection,
    charset: 'utf8mb4',
    timezone: 'Z',
    waitForConnections: true,
    connectionLimit,
    connectTimeout,
    ssl: env.STORY_OUTSIDE_DATABASE_SSL === 'true' ? {} : undefined,
  };
}

export function databaseStatus() {
  return state;
}

export function databaseConfigured(env = process.env) {
  return Boolean(env[DATABASE_URL_ENV] || env.STORY_OUTSIDE_DB_HOST);
}

export async function connectDatabase(env = process.env) {
  if (pool) return pool;
  const config = loadDatabaseConfig(env);
  if (!config) {
    state = Object.freeze({ configured: false, status: 'disabled', version: null });
    return null;
  }

  state = Object.freeze({ configured: true, status: 'connecting', version: null });
  const candidate = mysql.createPool(config);
  try {
    const [rows] = await candidate.query(
      'SELECT VERSION() AS version, DATABASE() AS database_name, UTC_TIMESTAMP(6) AS server_time',
    );
    const [migrations] = await candidate.query(
      'SELECT migration_name FROM schema_migrations WHERE migration_name = ?',
      ['0007_session_event_request_scope'],
    );
    if (migrations.length !== 1) {
      const error = new Error('MariaDB schema requires npm run db:migrate');
      error.code = 'SCHEMA_MIGRATION_REQUIRED';
      throw error;
    }
    pool = candidate;
    state = Object.freeze({
      configured: true,
      status: 'ready',
      version: String(rows[0].version),
    });
    return pool;
  } catch (error) {
    await candidate.end().catch(() => {});
    state = Object.freeze({ configured: true, status: 'error', version: null });
    const code = error && typeof error === 'object' && 'code' in error ? ` (${error.code})` : '';
    throw new Error(`MariaDB connection or schema validation failed${code}`);
  }
}

export function getDatabasePool() {
  if (!pool) throw new Error('MariaDB is not connected');
  return pool;
}

export async function closeDatabase() {
  if (pool) await pool.end();
  pool = null;
  state = Object.freeze({ configured: databaseConfigured(), status: 'closed', version: null });
}

export { loadDatabaseConfig };
