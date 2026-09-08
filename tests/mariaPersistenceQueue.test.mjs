import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMariaDbRepositories } from '../src/db/mariaPersistence.mjs';
import { createInMemoryStoryRepository } from '../src/stories/repository.mjs';
import { createInMemoryCommunityProfileRepository } from '../src/community/repository.mjs';
import { createInMemoryFollowingRepository } from '../src/ecosystem/following/repository.mjs';
import { createInMemoryEcosystemSearchCacheRepository } from '../src/providers/ecosystem/search.mjs';

// Exercise the actual adapter queue. The pool injects transient faults at
// connection acquisition, SQL execution and commit; no live database needed.
for (const failurePoint of ['acquire', 'query', 'commit']) {
  let acquisitions = 0;
  let commits = 0;
  let rollbacks = 0;
  let releases = 0;
  let active = 0;
  let persistedFollows = [];
  const outage = new Error(`transient ${failurePoint} failure`);
  const pool = {
    query: async () => [[]], // empty database on hydrate
    async getConnection() {
      const attempt = ++acquisitions;
      if (attempt === 1 && failurePoint === 'acquire') throw outage;
      assert.equal(active++, 0, 'writes must remain serialized');
      let staged = [];
      return {
        async beginTransaction() {},
        async query(sql, values) {
          if (attempt === 1 && failurePoint === 'query') throw outage;
          if (sql.startsWith('INSERT INTO ecosystem_follow_edges')) staged.push(values.slice(0, 2));
          return [[]];
        },
        async commit() {
          if (attempt === 1 && failurePoint === 'commit') throw outage;
          persistedFollows = staged;
          commits++;
        },
        async rollback() { rollbacks++; },
        release() { releases++; active--; },
      };
    },
  };
  const db = await createMariaDbRepositories({
    pool,
    storyRepository: createInMemoryStoryRepository(),
    communityProfileRepository: createInMemoryCommunityProfileRepository(),
    followingRepository: createInMemoryFollowingRepository(),
    ecosystemSearchCacheRepository: createInMemoryEcosystemSearchCacheRepository(),
  });
  const follower = randomUUID();
  const target = randomUUID();
  db.followingRepository.upsertFollow(follower, target);
  // Queue the retry before the failed operation has settled.
  const first = db.flush();
  const retry = db.flush();
  await assert.rejects(first, (error) => error === outage);
  await retry;
  assert.equal(acquisitions, 2, 'the retry must acquire a fresh connection');
  assert.equal(commits, 1);
  assert.deepEqual(persistedFollows, [[follower, target]], 'retry must persist the unacknowledged snapshot');
  assert.equal(rollbacks, failurePoint === 'acquire' ? 0 : 1);
  assert.equal(releases, failurePoint === 'acquire' ? 1 : 2);
  await db.flush();
  assert.equal(acquisitions, 2, 'successful unchanged snapshots need no extra write');
  db.followingRepository.removeFollow(follower, target);
  await db.flush();
  assert.deepEqual(persistedFollows, [], 'later mutations must continue to persist');
  assert.equal(commits, 2);
}
console.log('MariaDB persistence queue recovery tests passed');
