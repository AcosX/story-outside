import assert from 'node:assert/strict';
import {
  createSeededRepository, createSession, defaultGenerationProfile,
  ensureOpeningCache, getSession, interruptWithPlayerInput, listSessionEvents,
} from '../src/stories/index.mjs';
import {
  exportSessionPersistenceSnapshot, hydrateSessionPersistence,
  registerPersistentSessionRepository, repositoryState,
} from '../src/stories/sessionService.mjs';
import { createMariaDbRepositories } from '../src/db/mariaPersistence.mjs';
import { createInMemoryCommunityProfileRepository } from '../src/community/repository.mjs';
import { createInMemoryFollowingRepository } from '../src/ecosystem/following/repository.mjs';
import { createInMemoryEcosystemSearchCacheRepository } from '../src/providers/ecosystem/search.mjs';

const sessionUuid = (index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

async function fixture(persistent) {
  const { repository: original, fixtures } = createSeededRepository();
  const story = fixtures.find((item) => item.slug === 'cafe-rain');
  const { cache } = await ensureOpeningCache({ repository: original, story_version_uuid: story.story_version_uuid });
  let repository = original;
  if (persistent) {
    // Exercise the adapter's registration rather than marking the fixture
    // manually. Empty SQL hydration keeps the seeded story projection.
    const adapter = await createMariaDbRepositories({
      pool: { query: async () => [[]] },
      storyRepository: original,
      communityProfileRepository: createInMemoryCommunityProfileRepository(),
      followingRepository: createInMemoryFollowingRepository(),
      ecosystemSearchCacheRepository: createInMemoryEcosystemSearchCacheRepository(),
    });
    repository = adapter.storyRepository;
  }
  const create = (index, target = repository) => createSession({
    repository: target, session_uuid: sessionUuid(index), story_uuid: story.story_uuid,
    story_version_uuid: story.story_version_uuid, user_ref: 'retention-test', role_id: 'stranger',
    model: 'test-model', prompt: 'retention',
    generation_profile: { ...defaultGenerationProfile(), cache_uuid: cache.cache_uuid },
  });
  return { original, repository, create };
}

const demo = await fixture(false);
for (let index = 1; index <= 2001; index++) demo.create(index);
assert.equal(repositoryState(demo.repository).sessions.size, 2000);
assert.throws(() => getSession({ repository: demo.repository, session_uuid: sessionUuid(1) }), /session.*not found/i);
assert.equal(getSession({ repository: demo.repository, session_uuid: sessionUuid(2001) }).session_uuid, sessionUuid(2001));

const durable = await fixture(true);
durable.create(1);
interruptWithPlayerInput({
  repository: durable.repository, session_uuid: sessionUuid(1), text: 'preserve canonical history',
  client_request_id: '10000000-0000-4000-8000-000000000001', expected_revision: 0,
});
const firstHistory = listSessionEvents({ repository: durable.repository, session_uuid: sessionUuid(1) });
for (let index = 2; index <= 2001; index++) durable.create(index);
// The raw repository and its proxy share the same retention marker.
durable.create(2002, durable.original);
assert.equal(repositoryState(durable.repository).sessions.size, 2002);
assert.deepEqual(listSessionEvents({ repository: durable.repository, session_uuid: sessionUuid(1) }), firstHistory);
assert.equal(getSession({ repository: durable.repository, session_uuid: sessionUuid(1) }).revision, 1);

// Restart restores more than the demo cap, and later creation must not
// evict the oldest restored session either.
const snapshots = exportSessionPersistenceSnapshot(durable.repository);
const restored = await fixture(false);
registerPersistentSessionRepository(restored.repository);
for (const row of snapshots) {
  hydrateSessionPersistence({ repository: restored.repository, row, history: row.history, runtime_payload: row.runtime_payload });
}
restored.create(2003);
assert.equal(repositoryState(restored.repository).sessions.size, 2003);
assert.deepEqual(listSessionEvents({ repository: restored.repository, session_uuid: sessionUuid(1) }), firstHistory);
assert.throws(() => restored.create(1), /session already exists/);

console.log('MariaDB persistent session retention regression tests passed');
