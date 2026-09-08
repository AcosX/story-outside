import assert from 'node:assert/strict';

import { databaseConfigured, loadDatabaseConfig } from '../src/db/mariadb.mjs';

assert.equal(databaseConfigured({}), false);
assert.equal(loadDatabaseConfig({}), null);

const config = loadDatabaseConfig({
  STORY_OUTSIDE_DATABASE_URL: 'mariadb://story_user:p%40ss@db.internal:3307/story_outside',
  STORY_OUTSIDE_DATABASE_POOL_SIZE: '7',
  STORY_OUTSIDE_DATABASE_CONNECT_TIMEOUT_MS: '2500',
  STORY_OUTSIDE_DATABASE_SSL: 'true',
});
assert.equal(config.host, 'db.internal');
assert.equal(config.port, 3307);
assert.equal(config.user, 'story_user');
assert.equal(config.password, 'p@ss');
assert.equal(config.database, 'story_outside');
assert.equal(config.connectionLimit, 7);
assert.equal(config.connectTimeout, 2500);
assert.deepEqual(config.ssl, {});

const splitConfig = loadDatabaseConfig({
  STORY_OUTSIDE_DB_HOST: '127.0.0.1',
  STORY_OUTSIDE_DB_PORT: '3307',
  STORY_OUTSIDE_DB_NAME: 'story_outside',
  STORY_OUTSIDE_DB_USER: 'story_outside',
  STORY_OUTSIDE_DB_PASSWORD: 'test-only',
});
assert.equal(splitConfig.host, '127.0.0.1');
assert.equal(splitConfig.port, 3307);
assert.equal(splitConfig.database, 'story_outside');
assert.equal(databaseConfigured({ STORY_OUTSIDE_DB_HOST: '127.0.0.1' }), true);

assert.throws(
  () => loadDatabaseConfig({ STORY_OUTSIDE_DATABASE_URL: 'postgres://localhost/story_outside' }),
  /must use mariadb/,
);
assert.throws(
  () => loadDatabaseConfig({ STORY_OUTSIDE_DATABASE_URL: 'not a url' }),
  /must be a valid/,
);
assert.throws(
  () => loadDatabaseConfig({
    STORY_OUTSIDE_DATABASE_URL: 'mariadb://localhost/story_outside',
    STORY_OUTSIDE_DATABASE_POOL_SIZE: '0',
  }),
  /POOL_SIZE/,
);

console.log('mariadb config tests passed');
