import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMariaDbRepositories } from '../src/db/mariaPersistence.mjs';
import { createInMemoryCommunityProfileRepository } from '../src/community/repository.mjs';
import { createInMemoryFollowingRepository } from '../src/ecosystem/following/repository.mjs';
import {
  createEcosystemHotOrchestrator,
  createInMemoryEcosystemHotCacheRepository,
  ECOSYSTEM_HOT_CACHE_KEY,
} from '../src/providers/ecosystem/hot.mjs';
import { createInMemoryEcosystemSearchCacheRepository } from '../src/providers/ecosystem/search.mjs';
import { createInMemoryStoryRepository } from '../src/stories/repository.mjs';

const migration = await readFile(new URL('../db/migrations/0011_ecosystem_hot_cache.sql', import.meta.url), 'utf8');
assert.match(migration, /CREATE TABLE IF NOT EXISTS ecosystem_hot_cache/);
assert.match(migration, /PRIMARY KEY \(cache_key\)/);
assert.match(migration, /fetched_at_ms BIGINT UNSIGNED NOT NULL/);
assert.match(migration, /INSERT IGNORE INTO schema_migrations/);

let persistedRow = null;
const connectionQueries = [];
const pool = {
  async query(sql) {
    const text = typeof sql === 'string' ? sql : sql.sql;
    if (text.includes('FROM ecosystem_hot_cache')) return [persistedRow ? [persistedRow] : []];
    return [[]];
  },
  async getConnection() {
    return {
      async beginTransaction() {},
      async query(sql, values = []) {
        const text = typeof sql === 'string' ? sql : sql.sql;
        connectionQueries.push(text);
        if (text === 'DELETE FROM ecosystem_hot_cache') persistedRow = null;
        if (text.includes('INSERT INTO ecosystem_hot_cache')) {
          persistedRow = {
            cache_key: values[0],
            value: values[1],
            fetched_at_ms: values[2],
            expires_at_ms: values[3],
            swr_expires_at_ms: values[4],
            source: values[5],
          };
        }
        return [[]];
      },
      async commit() {},
      async rollback() {},
      release() {},
    };
  },
};

function repositories(hotCache) {
  return createMariaDbRepositories({
    pool,
    storyRepository: createInMemoryStoryRepository(),
    communityProfileRepository: createInMemoryCommunityProfileRepository(),
    followingRepository: createInMemoryFollowingRepository(),
    ecosystemSearchCacheRepository: createInMemoryEcosystemSearchCacheRepository(),
    ecosystemHotCacheRepository: hotCache,
  });
}

const source = {
  name: 'real',
  fetchHotList: async () => [{
    id: 'durable-hot',
    title: 'durable',
    url: 'https://www.zhihu.com/question/durable',
  }],
};
const firstDb = await repositories(createInMemoryEcosystemHotCacheRepository());
const firstOrchestrator = createEcosystemHotOrchestrator({
  source,
  cache: firstDb.ecosystemHotCacheRepository,
});
await firstOrchestrator.fetchHot();
await firstDb.flush();
assert.ok(persistedRow);
assert.equal(persistedRow.cache_key, ECOSYSTEM_HOT_CACHE_KEY);
assert.match(persistedRow.value, /durable-hot/);
assert.ok(connectionQueries.some((sql) => sql.includes('INSERT INTO ecosystem_hot_cache')));

const secondDb = await repositories(createInMemoryEcosystemHotCacheRepository());
let upstreamCallsAfterRestart = 0;
const secondOrchestrator = createEcosystemHotOrchestrator({
  source: {
    name: 'real',
    fetchHotList: async () => { upstreamCallsAfterRestart++; return []; },
  },
  cache: secondDb.ecosystemHotCacheRepository,
});
const restored = await secondOrchestrator.fetchHot();
assert.equal(restored.cached, true);
assert.equal(restored.hot[0].question_uuid, 'durable-hot');
assert.equal(upstreamCallsAfterRestart, 0);
assert.equal(secondDb.captureSnapshot().hot.length, 1);

console.log('MariaDB hot cache persistence: flush, hydrate, stable key, and restart cache hit passed');
