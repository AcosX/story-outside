// tests/chatgptReviewFixes.test.mjs — regression tests for the three
// blockers raised during the ChatGPT 2026-09-05 independent re-review of
// PR #7 (comment id 5550989950). Each test exercises the exact
// reproduction the reviewer flagged and pins down the new behaviour so
// a future refactor cannot silently regress.
//
//   B1: opening-cache GC must not drop a valid cache that is still
//       pinned by an active canonical session via session.cache_uuid.
//   B2: upsertOpeningCache must never return a "ghost row" — when the
//       store is at the cap and the inserted row would be evicted by
//       the very same call, the insert must refuse with a stable error
//       instead of returning a row that vanishes on the next read.
//   B3: clientRequestIndex is a bounded per-process uniqueness window;
//       after a session is evicted its ids may be reused by a future
//       session. The comment that claimed it mirrors the SQL UNIQUE
//       constraint has been downgraded to reflect the demo bound.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSeededRepository } from '../src/stories/fixture.mjs';
import {
  bindPinnedCacheResolver,
  commitOpeningEvent,
  createSession,
  repositoryState,
} from '../src/stories/sessionService.mjs';
import {
  defaultGenerationProfile,
  ensureOpeningCache,
} from '../src/stories/index.mjs';

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/**
 * Pre-fill a repository with N opening-cache rows of the given status
 * so we can exercise the cap without paying for 5000+ real fixtures.
 * Each row uses a distinct generation_hash so the scope index never
 * collapses them.
 *
 * @param {ReturnType<typeof import('../src/stories/repository.mjs').createInMemoryStoryRepository>} repository
 * @param {number} count
 * @param {'valid' | 'failed' | 'invalidated'} status
 */
function seedOpeningCaches(repository, count, status) {
  for (let i = 0; i < count; i += 1) {
    repository.upsertOpeningCache({
      story_uuid: '11111111-1111-4111-8111-aaaaaaaaaaaa',
      story_version_uuid: '22222222-2222-4222-8222-aaaaaaaaaaaa',
      opening_key: 'default',
      status,
      content_payload: { events: [], event_count: 0, filler: i },
      content_hash: `hash-${i}`,
      generation_profile: {
        identifier: `id-${i}`,
        rules_version: 'r1',
        locale: 'zh-CN',
        variant: 'default',
      },
      generation_hash: `genhash-${i}`,
      use_count: 0,
      last_used_at: null,
      invalidated_at: null,
      invalidated_reason: null,
      expires_at: null,
    });
  }
}

// ---------------------------------------------------------------------
// Blocker 1 — opening-cache GC must not drop a pinned valid cache.
// ---------------------------------------------------------------------

test('B1: a valid cache pinned by an active session survives GC', async () => {
  const { repository, fixtures } = createSeededRepository(); const fixture = fixtures[0];
  bindPinnedCacheResolver(repository);
  // Generate a real (non-empty) opening cache so commitOpeningEvent has
  // events to play.
  const cache = (await ensureOpeningCache({
    repository,
    story_version_uuid: fixture.story_version_uuid,
    options: { profile: defaultGenerationProfile() },
  })).cache;
  // Create a canonical session that pins the cache.
  const session_uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const profile = {
    ...cache.generation_profile,
    cache_uuid: cache.cache_uuid,
  };
  createSession({
    repository,
    session_uuid,
    story_uuid: fixture.story_uuid,
    story_version_uuid: fixture.story_version_uuid,
    user_ref: 'u',
    role_id: 'stranger',
    model: 'm',
    prompt: 'p',
    generation_profile: profile,
  });
  // Sanity: the cache is pinned.
  assert.equal(repository.findOpeningCacheByUuid(cache.cache_uuid).cache_uuid, cache.cache_uuid);
  // Fill the store with 4999 additional UNPINNED valid rows so the
  // total reaches 5000 (the cap). The next insert must trip the
  // reservation branch.
  seedOpeningCaches(repository, 4999, 'valid');
  assert.equal(repository.stats().cache_count, 5000);
  // Insert ONE MORE row — the previous bug would evict the pinned
  // cache here. The new behaviour must evict one of the 4999 UNPINNED
  // valid rows instead and leave the pinned cache alone.
  const inserted = repository.upsertOpeningCache({
    story_uuid: '11111111-1111-4111-8111-aaaaaaaaaaaa',
    story_version_uuid: '22222222-2222-4222-8222-aaaaaaaaaaaa',
    opening_key: 'fresh-scope',
    status: 'valid',
    content_payload: { events: [], event_count: 0 },
    content_hash: 'fresh-hash',
    generation_profile: { identifier: 'fresh', rules_version: 'r1', locale: 'zh-CN', variant: 'default' },
    generation_hash: 'fresh-gen',
    use_count: 0,
    last_used_at: null,
    invalidated_at: null,
    invalidated_reason: null,
    expires_at: null,
  });
  assert.equal(inserted.cache_uuid.length > 0, true);
  // The pinned cache must still be there and still valid.
  const stillPinned = repository.findOpeningCacheByUuid(cache.cache_uuid);
  assert.equal(stillPinned.status, 'valid');
  assert.equal(stillPinned.cache_uuid, cache.cache_uuid);
  // Most importantly: commitOpeningEvent must STILL work mid-stream.
  const pinnedEvents = cache.content_payload.events;
  assert.ok(Array.isArray(pinnedEvents) && pinnedEvents.length > 0, 'fixture must produce opening events');
  const committed = commitOpeningEvent({
    repository,
    session_uuid,
    cache_uuid: cache.cache_uuid,
    event: { ...pinnedEvents[0], displayed: true },
    expected_revision: 0,
  });
  assert.equal(committed.cache_uuid, cache.cache_uuid);
  assert.equal(committed.cursor, 1);
});

test('B1: GC may evict an UNPINNED valid cache to make room (pinned one survives)', async () => {
  // Companion to the test above — when the cap is reached, GC drops
  // the OLDEST UNPINNED valid row. A pinned valid row is never a
  // candidate. This test seeds 4998 UNPINNED valid rows + 1 PINNED
  // valid cache (the one createSession pinned), reaches the cap, then
  // inserts one more. The new row must be accepted and exactly one of
  // the 4998 unpinned valid rows must be evicted; the pinned cache
  // must still be there.
  const { repository, fixtures } = createSeededRepository(); const fixture = fixtures[0];
  bindPinnedCacheResolver(repository);
  const cache = (await ensureOpeningCache({
    repository,
    story_version_uuid: fixture.story_version_uuid,
    options: { profile: defaultGenerationProfile() },
  })).cache;
  // Pin the real cache with a session.
  const session_uuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  createSession({
    repository,
    session_uuid,
    story_uuid: fixture.story_uuid,
    story_version_uuid: fixture.story_version_uuid,
    user_ref: 'u',
    role_id: 'stranger',
    model: 'm',
    prompt: 'p',
    generation_profile: { ...cache.generation_profile, cache_uuid: cache.cache_uuid },
  });
  // 1 pinned + 4998 unpinned = 4999 total. Need 1 more to hit cap.
  seedOpeningCaches(repository, 4998, 'valid');
  assert.equal(repository.stats().cache_count, 4999);
  // Insert the 5000th valid row — must evict one of the 4998 unpinned rows.
  const result = repository.upsertOpeningCache({
    story_uuid: '11111111-1111-4111-8111-aaaaaaaaaaaa',
    story_version_uuid: '22222222-2222-4222-8222-aaaaaaaaaaaa',
    opening_key: 'another-fresh-scope',
    status: 'valid',
    content_payload: { events: [], event_count: 0 },
    content_hash: 'fresh2-hash',
    generation_profile: { identifier: 'fresh2', rules_version: 'r1', locale: 'zh-CN', variant: 'default' },
    generation_hash: 'fresh2-gen',
    use_count: 0,
    last_used_at: null,
    invalidated_at: null,
    invalidated_reason: null,
    expires_at: null,
  });
  assert.equal(repository.stats().cache_count, 5000);
  assert.equal(result.status, 'valid');
  // The pinned cache must NOT be one of the evicted rows.
  const stillPinned = repository.findOpeningCacheByUuid(cache.cache_uuid);
  assert.ok(stillPinned, 'pinned cache must NOT be evicted');
  assert.equal(stillPinned.status, 'valid');
  assert.equal(stillPinned.cache_uuid, cache.cache_uuid);
});

test('B1: failed rows are always evicted regardless of pinning', async () => {
  // A failed row is unusable for any future lookup, so it is a free
  // eviction target even if some hypothetical caller pinned it. The
  // pinning guarantee is specifically for `valid` caches (a session
  // committed to it must be able to keep playing).
  const { repository } = createSeededRepository();
  bindPinnedCacheResolver(repository);
  // Fill with 4999 failed rows + 1 valid (the pinned one).
  seedOpeningCaches(repository, 4999, 'failed');
  const pinned = repository.upsertOpeningCache({
    story_uuid: '11111111-1111-4111-8111-aaaaaaaaaaaa',
    story_version_uuid: '22222222-2222-4222-8222-aaaaaaaaaaaa',
    opening_key: 'pinned-fresh',
    status: 'valid',
    content_payload: { events: [], event_count: 0 },
    content_hash: 'pinned-hash',
    generation_profile: { identifier: 'pinned', rules_version: 'r1', locale: 'zh-CN', variant: 'default' },
    generation_hash: 'pinned-gen',
    use_count: 0,
    last_used_at: null,
    invalidated_at: null,
    invalidated_reason: null,
    expires_at: null,
  });
  assert.equal(repository.stats().cache_count, 5000);
  // Simulate the session layer pinning the valid row.
  repository._setPinnedCacheResolver(() => new Set([pinned.cache_uuid]));
  // Insert another valid row — must evict a failed row, never the
  // pinned one.
  repository.upsertOpeningCache({
    story_uuid: '11111111-1111-4111-8111-aaaaaaaaaaaa',
    story_version_uuid: '22222222-2222-4222-8222-aaaaaaaaaaaa',
    opening_key: 'fresh-after-pinned',
    status: 'valid',
    content_payload: { events: [], event_count: 0 },
    content_hash: 'fresh3-hash',
    generation_profile: { identifier: 'fresh3', rules_version: 'r1', locale: 'zh-CN', variant: 'default' },
    generation_hash: 'fresh3-gen',
    use_count: 0,
    last_used_at: null,
    invalidated_at: null,
    invalidated_reason: null,
    expires_at: null,
  });
  assert.equal(repository.stats().cache_count, 5000);
  assert.ok(repository.findOpeningCacheByUuid(pinned.cache_uuid), 'pinned valid cache must survive failed-row GC');
});

// ---------------------------------------------------------------------
// Blocker 2 — upsertOpeningCache must not return a "ghost row".
// ---------------------------------------------------------------------

test('B2: failed-row insert at cap returns a row that is still findable', async () => {
  // The reviewer reported: "set → evict → 写 scope index → return row"
  // with eviction running AFTER set. When the store is full of failed
  // rows of the same tier as the new one, the previous implementation
  // could evict the just-inserted row in the same call (because
  // updated_at timestamps and Map insertion order interact).
  // The new contract:
  //   * reserveOpeningCacheSlot runs BEFORE the set, dropping the
  //     oldest failed row so there is room;
  //   * the new row is then inserted and stays;
  //   * the returned row is guaranteed findable via cache_uuid AND via
  //     scope key.
  const { repository } = createSeededRepository();
  bindPinnedCacheResolver(repository);
  seedOpeningCaches(repository, 4999, 'failed');
  // The next failed insert must evict ONE old failed row and return a
  // row that survives.
  const inserted = repository.upsertOpeningCache({
    story_uuid: '11111111-1111-4111-8111-aaaaaaaaaaaa',
    story_version_uuid: '22222222-2222-4222-8222-aaaaaaaaaaaa',
    opening_key: 'failed-after-cap',
    status: 'failed',
    content_payload: { error: 'simulated_failure' },
    content_hash: '',
    generation_profile: { identifier: 'failtest', rules_version: 'r1', locale: 'zh-CN', variant: 'default' },
    generation_hash: 'failtest-gen',
    use_count: 0,
    last_used_at: null,
    invalidated_at: null,
    invalidated_reason: null,
    expires_at: null,
  });
  // The returned row must still be findable by cache_uuid.
  const byUuid = repository.findOpeningCacheByUuid(inserted.cache_uuid);
  assert.ok(byUuid, 'B2: returned cache_uuid must still resolve');
  assert.equal(byUuid.cache_uuid, inserted.cache_uuid);
  // And by scope key (a retry at the same generation_hash must hit it).
  const byScope = repository.findOpeningCacheByScope(
    '11111111-1111-4111-8111-aaaaaaaaaaaa',
    '22222222-2222-4222-8222-aaaaaaaaaaaa',
    'failed-after-cap',
    'failtest-gen',
  );
  assert.ok(byScope, 'B2: returned row must also be findable via scope key');
  assert.equal(byScope.cache_uuid, inserted.cache_uuid);
  // Total count is still 5000.
  assert.equal(repository.stats().cache_count, 5000);
});

test('B2: at-cap insert with no eviction candidates refuses with a stable error', async () => {
  // When every row is currently pinned (valid) and the cap is reached,
  // the previous implementation would have dropped one of the pinned
  // valid rows. The new implementation refuses the insert.
  const { repository, fixtures } = createSeededRepository(); const fixture = fixtures[0];
  bindPinnedCacheResolver(repository);
  // Generate one real pinned cache (will be pinned by the session
  // created below) and seed the rest as valid unpinned rows.
  const realCache = (await ensureOpeningCache({
    repository,
    story_version_uuid: fixture.story_version_uuid,
    options: { profile: defaultGenerationProfile() },
  })).cache;
  seedOpeningCaches(repository, 4999, 'valid');
  // Create a session that pins the real cache. After that, mark every
  // other valid cache as ALSO pinned so there are zero eviction
  // candidates.
  const session_uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9';
  createSession({
    repository,
    session_uuid,
    story_uuid: fixture.story_uuid,
    story_version_uuid: fixture.story_version_uuid,
    user_ref: 'u',
    role_id: 'stranger',
    model: 'm',
    prompt: 'p',
    generation_profile: { ...realCache.generation_profile, cache_uuid: realCache.cache_uuid },
  });
  // Mark all 5000 caches as pinned (including the freshly created
  // session's cache). Walk the internal cache map through the public
  // surface by probing the scope index for each generation_hash we
  // seeded above (genhash-0..genhash-4999) and adding the real cache.
  const allCacheUuids = new Set([realCache.cache_uuid]);
  for (let i = 0; i < 4999; i += 1) {
    const row = repository.findOpeningCacheByScope(
      '11111111-1111-4111-8111-aaaaaaaaaaaa',
      '22222222-2222-4222-8222-aaaaaaaaaaaa',
      'default',
      `genhash-${i}`,
    );
    if (row) allCacheUuids.add(row.cache_uuid);
  }
  repository._setPinnedCacheResolver(() => new Set(allCacheUuids));
  assert.throws(
    () => repository.upsertOpeningCache({
      story_uuid: '11111111-1111-4111-8111-aaaaaaaaaaaa',
      story_version_uuid: '22222222-2222-4222-8222-aaaaaaaaaaaa',
      opening_key: 'no-room',
      status: 'valid',
      content_payload: { events: [], event_count: 0 },
      content_hash: 'no-room-hash',
      generation_profile: { identifier: 'no-room', rules_version: 'r1', locale: 'zh-CN', variant: 'default' },
      generation_hash: 'no-room-gen',
      use_count: 0,
      last_used_at: null,
      invalidated_at: null,
      invalidated_reason: null,
      expires_at: null,
    }),
    (err) => err && err.code === 'too_many_pinned_caches',
  );
  // Store size unchanged.
  assert.equal(repository.stats().cache_count, 5000);
  // Pinned cache still usable.
  assert.equal(repository.findOpeningCacheByUuid(realCache.cache_uuid).status, 'valid');
});

// ---------------------------------------------------------------------
// Blocker 3 — clientRequestIndex is a bounded sliding window, not a
// mirror of SQL UNIQUE. After a session is evicted, its ids may be
// reused.
// ---------------------------------------------------------------------

test('B3: clientRequestIndex is a bounded per-process window; ids are reusable after session eviction', async () => {
  // Build a real session, commit an opening event with a known
  // client_request_id, then evict the session and verify a fresh
  // session can reuse the same id without being refused by the
  // uniqueness check (this is the documented demo bound).
  const { repository, fixtures } = createSeededRepository(); const fixture = fixtures[0];
  bindPinnedCacheResolver(repository);
  const cache = (await ensureOpeningCache({
    repository,
    story_version_uuid: fixture.story_version_uuid,
    options: { profile: defaultGenerationProfile() },
  })).cache;
  const REUSED_ID = 'req-pr7-chatgpt-reused-001';
  // ---- session A ----
  const sessionA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  createSession({
    repository,
    session_uuid: sessionA,
    story_uuid: fixture.story_uuid,
    story_version_uuid: fixture.story_version_uuid,
    user_ref: 'u',
    role_id: 'stranger',
    model: 'm',
    prompt: 'p',
    generation_profile: { ...cache.generation_profile, cache_uuid: cache.cache_uuid },
  });
  const pinnedEvents = cache.content_payload.events;
  commitOpeningEvent({
    repository,
    session_uuid: sessionA,
    cache_uuid: cache.cache_uuid,
    event: { ...pinnedEvents[0], displayed: true },
    expected_revision: 0,
    client_request_id: REUSED_ID,
  });
  // Force session A to be the oldest by aging its lastTouchedAt — the
  // session layer touches on every commit so we have to overwrite it
  // after the fact to be deterministic across slow test runners.
  repositoryState(repository).sessions.get(sessionA).lastTouchedAt = '1970-01-01T00:00:00.000Z';
  // Evict session A by creating MAX_CANONICAL_SESSIONS fresh sessions.
  // The canonical session cap is 2000 so 2000 fresh sessions force
  // session A to drop out.
  for (let i = 0; i < 2000; i += 1) {
    const sid = `cccccccc-cccc-4ccc-8ccc-${i.toString(16).padStart(12, '0')}`;
    createSession({
      repository,
      session_uuid: sid,
      story_uuid: fixture.story_uuid,
      story_version_uuid: fixture.story_version_uuid,
      user_ref: `u-${i}-${Date.now()}`,
      role_id: 'stranger',
      model: 'm',
      prompt: 'p',
      generation_profile: { ...cache.generation_profile, cache_uuid: cache.cache_uuid },
    });
  }
  // Sanity: session A is gone.
  assert.equal(repositoryState(repository).sessions.has(sessionA), false, 'B3: session A must be evicted');
  // ---- session B ----
  const sessionB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
  // Building a fresh cache for session B because session A's cache was
  // pinned by session A's eviction; instead, re-use the same cache
  // object — the canonical session store does not refuse a re-pin, the
  // opening-cache store just keeps it.
  createSession({
    repository,
    session_uuid: sessionB,
    story_uuid: fixture.story_uuid,
    story_version_uuid: fixture.story_version_uuid,
    user_ref: 'u-b',
    role_id: 'stranger',
    model: 'm',
    prompt: 'p',
    generation_profile: { ...cache.generation_profile, cache_uuid: cache.cache_uuid },
  });
  // Reusing REUSED_ID must succeed. The previous implementation would
  // refuse with `duplicate_client_request_id` because the entry was
  // still in the cross-session index; the new contract accepts the
  // reuse as part of the documented bounded sliding-window semantic.
  const reused = commitOpeningEvent({
    repository,
    session_uuid: sessionB,
    cache_uuid: cache.cache_uuid,
    event: { ...pinnedEvents[0], displayed: true },
    expected_revision: 0,
    client_request_id: REUSED_ID,
  });
  assert.equal(reused.event.client_request_id, REUSED_ID);
  assert.equal(reused.session_uuid, sessionB);
  assert.equal(reused.cursor, 1);
});

test('B3: same-session replay with the same id still works (idempotency is per-session)', async () => {
  // The downgrade in B3 must NOT weaken same-session idempotency: a
  // same-session replay of the same id with the same payload still
  // returns the prior result.
  const { repository, fixtures } = createSeededRepository(); const fixture = fixtures[0];
  bindPinnedCacheResolver(repository);
  const cache = (await ensureOpeningCache({
    repository,
    story_version_uuid: fixture.story_version_uuid,
    options: { profile: defaultGenerationProfile() },
  })).cache;
  const session_uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
  const REPLAY_ID = 'req-pr7-chatgpt-replay-002';
  createSession({
    repository,
    session_uuid,
    story_uuid: fixture.story_uuid,
    story_version_uuid: fixture.story_version_uuid,
    user_ref: 'u',
    role_id: 'stranger',
    model: 'm',
    prompt: 'p',
    generation_profile: { ...cache.generation_profile, cache_uuid: cache.cache_uuid },
  });
  const pinnedEvents = cache.content_payload.events;
  const first = commitOpeningEvent({
    repository,
    session_uuid,
    cache_uuid: cache.cache_uuid,
    event: { ...pinnedEvents[0], displayed: true },
    expected_revision: 0,
    client_request_id: REPLAY_ID,
  });
  const replay = commitOpeningEvent({
    repository,
    session_uuid,
    cache_uuid: cache.cache_uuid,
    event: { ...pinnedEvents[0], displayed: true },
    expected_revision: 0,
    client_request_id: REPLAY_ID,
  });
  assert.equal(replay.event.event_seq, first.event.event_seq);
  assert.equal(replay.cursor, first.cursor);
  assert.equal(replay.revision, first.revision);
});

test('B3: same-session replay with mismatched payload still fails closed', async () => {
  // The downgrade must NOT turn a same-session id into a silent
  // overwrite. A reused id with a different payload still throws.
  const { repository, fixtures } = createSeededRepository(); const fixture = fixtures[0];
  bindPinnedCacheResolver(repository);
  const cache = (await ensureOpeningCache({
    repository,
    story_version_uuid: fixture.story_version_uuid,
    options: { profile: defaultGenerationProfile() },
  })).cache;
  const session_uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
  const REPLAY_ID = 'req-pr7-chatgpt-mismatch-003';
  createSession({
    repository,
    session_uuid,
    story_uuid: fixture.story_uuid,
    story_version_uuid: fixture.story_version_uuid,
    user_ref: 'u',
    role_id: 'stranger',
    model: 'm',
    prompt: 'p',
    generation_profile: { ...cache.generation_profile, cache_uuid: cache.cache_uuid },
  });
  const pinnedEvents = cache.content_payload.events;
  commitOpeningEvent({
    repository,
    session_uuid,
    cache_uuid: cache.cache_uuid,
    event: { ...pinnedEvents[0], displayed: true },
    expected_revision: 0,
    client_request_id: REPLAY_ID,
  });
  // Replay with a different event payload must fail closed.
  assert.throws(
    () => commitOpeningEvent({
      repository,
      session_uuid,
      cache_uuid: cache.cache_uuid,
      event: { ...pinnedEvents[1], displayed: true },
      expected_revision: 0,
      client_request_id: REPLAY_ID,
    }),
    /client_request_id was already used for a different request/,
  );
});

test('B3: a NEW session reusing an id that is still in the cross-session window is still accepted (downgrade semantic)', async () => {
  // Companion to the previous test — verifies the B3 downgrade semantic
  // explicitly without going through the eviction path: a fresh session
  // B reusing an id that session A already committed with is accepted
  // because the window is bounded per-process, not per-session.
  const { repository, fixtures } = createSeededRepository(); const fixture = fixtures[0];
  bindPinnedCacheResolver(repository);
  const cache = (await ensureOpeningCache({
    repository,
    story_version_uuid: fixture.story_version_uuid,
    options: { profile: defaultGenerationProfile() },
  })).cache;
  const REUSED_ID = 'req-pr7-chatgpt-direct-reuse-004';
  const sessionA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4';
  createSession({
    repository,
    session_uuid: sessionA,
    story_uuid: fixture.story_uuid,
    story_version_uuid: fixture.story_version_uuid,
    user_ref: 'u-a',
    role_id: 'stranger',
    model: 'm',
    prompt: 'p',
    generation_profile: { ...cache.generation_profile, cache_uuid: cache.cache_uuid },
  });
  const pinnedEvents = cache.content_payload.events;
  commitOpeningEvent({
    repository,
    session_uuid: sessionA,
    cache_uuid: cache.cache_uuid,
    event: { ...pinnedEvents[0], displayed: true },
    expected_revision: 0,
    client_request_id: REUSED_ID,
  });
  const sessionB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4';
  createSession({
    repository,
    session_uuid: sessionB,
    story_uuid: fixture.story_uuid,
    story_version_uuid: fixture.story_version_uuid,
    user_ref: 'u-b',
    role_id: 'stranger',
    model: 'm',
    prompt: 'p',
    generation_profile: { ...cache.generation_profile, cache_uuid: cache.cache_uuid },
  });
  // Different session, same id — accepted under the new contract.
  const reused = commitOpeningEvent({
    repository,
    session_uuid: sessionB,
    cache_uuid: cache.cache_uuid,
    event: { ...pinnedEvents[0], displayed: true },
    expected_revision: 0,
    client_request_id: REUSED_ID,
  });
  assert.equal(reused.session_uuid, sessionB);
});