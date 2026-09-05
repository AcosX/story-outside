// tests/codeReviewFixes.test.mjs — regression tests for the issues found
// during the 2026-09-03 code review (docs/code-review-2026-09-03.md).
//
// Focus:
//   * ensureOpeningCache awaits async generators / retry reuses failed row
//   * ensureOpeningCache keeps the same cache_uuid after valid→invalidated→rebuild→fail
//   * stageNarrativeBatch rejects tool-only batches
//   * observeSession counts state transitions, not raw observations
//   * sessionError does not hide unknown server errors as client 400s
//   * sessionError preserves ValidationError codes (e.g. payload_too_large, bad_json) as 400

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createSeededRepository,
  defaultGenerationProfile,
  ensureOpeningCache,
  deriveOpeningCacheKey,
  generateOpeningCache,
} from '../src/stories/index.mjs';
import { createSession, stageNarrativeBatch } from '../src/stories/sessionService.mjs';
import {
  observeSession,
  snapshotAll as snapshotMetricsAll,
  _resetMetricsForTests,
} from '../src/observability/metrics.mjs';
import { sessionError } from '../src/server.mjs';

test('ensureOpeningCache awaits an async generator', async () => {
  const { repository, fixtures } = createSeededRepository();
  const f = fixtures[0];
  const profile = defaultGenerationProfile();
  const generator = async ({ story, profile: p }) => generateOpeningCache({
    story_uuid: f.story_uuid,
    story_version_uuid: f.story_version_uuid,
    opening_key: 'default',
    profile: p,
    story,
  });
  const result = await ensureOpeningCache({
    repository,
    story_version_uuid: f.story_version_uuid,
    options: { profile, generator },
  });
  assert.equal(result.cache.status, 'valid');
  assert.ok(Number.isInteger(result.cache.content_payload.event_count));
});

test('ensureOpeningCache retry reuses a failed row instead of orphaning it', async () => {
  const { repository, fixtures } = createSeededRepository();
  const f = fixtures[0];
  const profile = defaultGenerationProfile();
  let calls = 0;
  const generator = async ({ story, profile: p }) => {
    calls += 1;
    if (calls === 1) throw new Error('generator boom');
    return generateOpeningCache({
      story_uuid: f.story_uuid,
      story_version_uuid: f.story_version_uuid,
      opening_key: 'default',
      profile: p,
      story,
    });
  };
  await assert.rejects(
    () => ensureOpeningCache({ repository, story_version_uuid: f.story_version_uuid, options: { profile, generator } }),
    /generation failed/,
  );
  const key = deriveOpeningCacheKey({
    story_uuid: f.story_uuid,
    story_version_uuid: f.story_version_uuid,
    opening_key: 'default',
    profile,
  });
  const failed = repository.findOpeningCacheByScope(f.story_uuid, f.story_version_uuid, 'default', key);
  assert.equal(failed.status, 'failed');
  const result = await ensureOpeningCache({
    repository,
    story_version_uuid: f.story_version_uuid,
    options: { profile, generator },
  });
  assert.equal(result.cache.status, 'valid');
  assert.equal(result.cache.cache_uuid, failed.cache_uuid);
  assert.equal(repository.stats().cache_count, 1);
});

test('stageNarrativeBatch rejects tool-only batches', async () => {
  const { repository, fixtures } = createSeededRepository();
  const f = fixtures[0];
  const cache = (await ensureOpeningCache({
    repository,
    story_version_uuid: f.story_version_uuid,
    options: { profile: defaultGenerationProfile() },
  })).cache;
  const session_uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  createSession({
    repository,
    session_uuid,
    story_uuid: f.story_uuid,
    story_version_uuid: f.story_version_uuid,
    user_ref: 'u',
    role_id: 'stranger',
    model: 'm',
    prompt: 'p',
    generation_profile: { ...cache.generation_profile, cache_uuid: cache.cache_uuid },
  });
  assert.throws(() => stageNarrativeBatch({
    repository,
    session_uuid,
    items: [],
    tool_call: { name: 'ask_player_choice', arguments: {} },
    expected_revision: 0,
  }), /tool-only batches are not allowed/);
});

test('observeSession tracks the CURRENT state as a gauge, not a transition counter', () => {
  _resetMetricsForTests();
  const session_uuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  // Same session observed multiple times in the same state must NOT
  // double-count — gauge semantics: one session in `realtime`.
  observeSession({ session_uuid, state: 'realtime' });
  observeSession({ session_uuid, state: 'realtime' });
  observeSession({ session_uuid, state: 'realtime' });
  let snapshot = snapshotMetricsAll();
  assert.equal(snapshot.global.sessionsByState.realtime, 1);
  assert.equal(snapshot.global.sessionsByState.opening, 0);
  // Same session moved to `opening` must decrement realtime AND increment
  // opening — the previous broken implementation left realtime at 1 and
  // bumped opening to 1, so a single session counted as 2.
  observeSession({ session_uuid, state: 'opening' });
  observeSession({ session_uuid, state: 'opening' });
  snapshot = snapshotMetricsAll();
  assert.equal(snapshot.global.sessionsByState.realtime, 0);
  assert.equal(snapshot.global.sessionsByState.opening, 1);
  // A second session arriving in `realtime` must bump only the realtime
  // bucket; opening stays at 1 because session #1 is still there.
  const session_uuid2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  observeSession({ session_uuid: session_uuid2, state: 'realtime' });
  snapshot = snapshotMetricsAll();
  assert.equal(snapshot.global.sessionsByState.realtime, 1);
  assert.equal(snapshot.global.sessionsByState.opening, 1);
});

test('sessionError maps unknown errors to 500, not validation_failed', async () => {
  const { SessionNotFoundError } = await import('../src/providers/dto.mjs');
  assert.equal(sessionError(new Error('totally unexpected inner failure')).status, 500);
  assert.equal(sessionError(new Error('sessionService: pending_id must be a UUID')).status, 400);
  // M4 follow-up: the service throws SessionNotFoundError with a stable
  // code 'session_not_found' instead of a free-floating 'unknown session'
  // message; sessionError short-circuits on the code to 404. A bare
  // 'unknown session' string no longer auto-maps to 404 so unrelated
  // messages starting with 'unknown' cannot be silently re-classified.
  assert.equal(sessionError(new SessionNotFoundError('00000000-0000-4000-8000-000000000000')).status, 404);
  assert.equal(sessionError(new SessionNotFoundError('00000000-0000-4000-8000-000000000000')).code, 'session_not_found');
});

test('sessionError preserves ValidationError codes as 400, not 500', async () => {
  const { ValidationError } = await import('../src/providers/dto.mjs');
  // B1 regression: oversized body throws ValidationError('payload_too_large', { code: 'payload_too_large' }).
  // sessionError must surface the precise code at 400 so clients see
  // {"error":"payload_too_large", "details":{"limit_bytes":65536}} instead of
  // a generic {"error":"invalid_input"}. The default-code path stays 400 too,
  // so the B1 'not 500' invariant continues to hold for callers that did
  // not pin one.
  const r1 = sessionError(new ValidationError('payload_too_large', { code: 'payload_too_large' }));
  assert.equal(r1.status, 400);
  assert.equal(r1.code, 'payload_too_large');
  const r2 = sessionError(new ValidationError('bad_json', { code: 'bad_json' }));
  assert.equal(r2.status, 400);
  assert.equal(r2.code, 'bad_json');
  // Generic ValidationError without a pinned code still maps to 400 invalid_input.
  const r3 = sessionError(new ValidationError('story summary missing id'));
  assert.equal(r3.status, 400);
  assert.equal(r3.code, 'invalid_input');
});

test('sessionError does NOT over-match free-floating "invalid" as 400', () => {
  // B2 regression: a service-layer message starting with "invalid" that
  // lacks the sessionService:/endingService: prefix must not be silently
  // re-classified as a client validation failure.
  assert.equal(sessionError(new Error('invalid upstream response')).status, 500);
  // But the explicit "sessionService: invalid X" form still maps to 400.
  assert.equal(sessionError(new Error('sessionService: invalid tool call name')).status, 400);
  // And the documented "tool-only batches are not allowed" still maps to 400.
  assert.equal(
    sessionError(new Error('stageNarrativeBatch: tool-only batches are not allowed')).status,
    400,
  );
});

test('ensureOpeningCache keeps the same cache_uuid after valid→invalidated→rebuild→fail', async () => {
  // S4 regression: the original PR #5 promise is that retries reuse the
  // same generation_hash (and therefore the same cache_uuid). After
  // invalidation, however, the scope key is dropped, so the FIRST
  // post-invalidation failure creates a fresh failed row. We assert the
  // current contract: invalidation is a hard break; the prior failed
  // row is not silently resurrected, but the new failed row is reusable
  // by the next retry at the same generation_hash.
  const { repository, fixtures } = createSeededRepository();
  const f = fixtures[0];
  const profile = defaultGenerationProfile();
  let calls = 0;
  const okGen = async ({ story, profile: p }) => generateOpeningCache({
    story_uuid: f.story_uuid,
    story_version_uuid: f.story_version_uuid,
    opening_key: 'default',
    profile: p,
    story,
  });
  // 1) first build → valid
  const first = await ensureOpeningCache({
    repository,
    story_version_uuid: f.story_version_uuid,
    options: { profile, generator: okGen },
  });
  assert.equal(first.cache.status, 'valid');
  // 2) invalidate that row
  repository.recordCacheInvalidation(first.cache.cache_uuid, 'manual_invalidation');
  // 3) rebuild with a generator that always fails → must surface as failed
  const boomGen = async () => { calls += 1; throw new Error('post-invalidation boom'); };
  await assert.rejects(
    () => ensureOpeningCache({
      repository,
      story_version_uuid: f.story_version_uuid,
      options: { profile, generator: boomGen },
    }),
    /generation failed/,
  );
  const key = deriveOpeningCacheKey({
    story_uuid: f.story_uuid,
    story_version_uuid: f.story_version_uuid,
    opening_key: 'default',
    profile,
  });
  const afterFail = repository.findOpeningCacheByScope(f.story_uuid, f.story_version_uuid, 'default', key);
  assert.equal(afterFail.status, 'failed');
  // 4) retry at the same generation_hash must reuse the post-invalidation
  //    failed row instead of orphaning a third row.
  const result = await ensureOpeningCache({
    repository,
    story_version_uuid: f.story_version_uuid,
    options: { profile, generator: okGen },
  });
  assert.equal(result.cache.status, 'valid');
  assert.equal(result.cache.cache_uuid, afterFail.cache_uuid);
  // One invalidated row + one (now valid) replacement; no orphan.
  assert.equal(repository.stats().cache_count, 2);
});
