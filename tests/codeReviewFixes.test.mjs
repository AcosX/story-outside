// tests/codeReviewFixes.test.mjs — regression tests for the issues found
// during the 2026-09-03 code review (docs/code-review-2026-09-03.md).
//
// Focus:
//   * ensureOpeningCache awaits async generators / retry reuses failed row
//   * stageNarrativeBatch rejects tool-only batches
//   * observeSession counts state transitions, not raw observations
//   * sessionError does not hide unknown server errors as client 400s

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

test('observeSession counts state transitions, not raw observations', () => {
  _resetMetricsForTests();
  const session_uuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  observeSession({ session_uuid, state: 'realtime' });
  observeSession({ session_uuid, state: 'realtime' });
  observeSession({ session_uuid, state: 'realtime' });
  let snapshot = snapshotMetricsAll();
  assert.equal(snapshot.global.sessionsByState.realtime, 1);
  observeSession({ session_uuid, state: 'opening' });
  observeSession({ session_uuid, state: 'opening' });
  snapshot = snapshotMetricsAll();
  assert.equal(snapshot.global.sessionsByState.realtime, 1);
  assert.equal(snapshot.global.sessionsByState.opening, 1);
});

test('sessionError maps unknown errors to 500, not validation_failed', () => {
  assert.equal(sessionError(new Error('totally unexpected inner failure')).status, 500);
  assert.equal(sessionError(new Error('sessionService: pending_id must be a UUID')).status, 400);
  assert.equal(sessionError(new Error('unknown session')).status, 404);
});
