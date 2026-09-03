// tests/agentCompact.test.mjs — integration tests for the long-context
// compact pipeline introduced for ClickUp 10.
//
// DEPENDENCY NOTE: uses the same in-memory seeded repository as
// tests/sessionService.test.mjs (08/09 boundary). Asserts the public
// contract of `sessionService.recordCompact` / `getSessionCompact` /
// `rebuildCompactFromHistory`. The "rebuild from real history" path uses
// events lifted from the seeded opening cache to satisfy the
// "payload matches pinned cache" check.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createSeededRepository,
  createSession,
  defaultGenerationProfile,
  ensureOpeningCache,
  getSession,
  interruptWithPlayerInput,
  commitOpeningEvent,
  listSessionEvents,
  // ClickUp 10 compact API — re-exported from the application-layer surface.
  recordCompact,
  recordCompactFailure,
  getSessionCompact,
  rebuildCompactFromHistory,
} from '../src/stories/index.mjs';

import { assembleContext } from '../src/agent/contextBuilder.mjs';
import { createTokenEstimator } from '../src/agent/tokenEstimator.mjs';

const SESSION_UUID = '33333333-3333-4333-8333-333333333333';

async function fixture() {
  const { repository, fixtures } = createSeededRepository();
  const story = fixtures.find((item) => item.slug === 'cafe-rain');
  const { cache } = await ensureOpeningCache({ repository, story_version_uuid: story.story_version_uuid });
  const profile = { ...defaultGenerationProfile(), cache_uuid: cache.cache_uuid };
  const session = createSession({
    repository,
    session_uuid: SESSION_UUID,
    story_uuid: story.story_uuid,
    story_version_uuid: story.story_version_uuid,
    user_ref: 'tester',
    role_id: 'stranger',
    model: 'mock/test',
    prompt: 'narrate',
    generation_profile: profile,
  });
  return { repository, story, cache, profile, session };
}

// Commit the first N events from the pinned opening cache. This satisfies
// sessionService's "payload matches pinned cache" check (08/09 contract)
// while still letting us build up a small history for the compact tests.
async function commitFirstNEvents({ repository, cache, n }) {
  const events = cache.content_payload.events;
  const limit = Math.min(n, events.length);
  for (let i = 0; i < limit; i++) {
    const e = { ...events[i], displayed: true };
    commitOpeningEvent({
      repository,
      session_uuid: SESSION_UUID,
      cache_uuid: cache.cache_uuid,
      event: e,
      client_request_id: `open-${i}`,
      expected_revision: i,
    });
  }
  return limit;
}

test('recordCompact: stores summary and advances cursor', async () => {
  const { repository } = await fixture();
  const result = recordCompact({
    repository,
    session_uuid: SESSION_UUID,
    summary_text: 'Prior: opened cafe in rain; met stranger.',
    summary_payload: { event_count: 4, sections: ['facts', 'choices'] },
    through_seq: 4,
    folded_event_seqs: [1, 2, 3, 4],
    token_estimate: 1500,
    context_window: 8_000,
    safety_ratio: 0.10,
    reserved_completion_tokens: 1024,
    schema_version: 1,
    prompt_version: 1,
  });
  assert.equal(result.compacted_through_seq, 4);
  assert.equal(result.compacted_event_count, 4);
  assert.equal(result.last_compact_status, 'compacted');
  assert.equal(result.context_window, 8_000);
  assert.ok(result.context_compact_text.includes('opened cafe'));
});

test('recordCompact: rejects through_seq <= existing (monotonic invariant)', async () => {
  const { repository } = await fixture();
  recordCompact({
    repository,
    session_uuid: SESSION_UUID,
    summary_text: 'a',
    summary_payload: {},
    through_seq: 5,
    folded_event_seqs: [1, 2, 3, 4, 5],
    token_estimate: 100,
    context_window: 8_000,
    safety_ratio: 0.10,
    reserved_completion_tokens: 1024,
    schema_version: 1,
    prompt_version: 1,
  });
  // Replay same through_seq must throw
  assert.throws(
    () =>
      recordCompact({
        repository,
        session_uuid: SESSION_UUID,
        summary_text: 'b',
        summary_payload: {},
        through_seq: 5,
        folded_event_seqs: [5],
        token_estimate: 100,
        context_window: 8_000,
        safety_ratio: 0.10,
        reserved_completion_tokens: 1024,
        schema_version: 1,
        prompt_version: 1,
      }),
    /strictly greater/,
  );
  // through_seq < existing must also throw
  assert.throws(
    () =>
      recordCompact({
        repository,
        session_uuid: SESSION_UUID,
        summary_text: 'c',
        summary_payload: {},
        through_seq: 3,
        folded_event_seqs: [3],
        token_estimate: 100,
        context_window: 8_000,
        safety_ratio: 0.10,
        reserved_completion_tokens: 1024,
        schema_version: 1,
        prompt_version: 1,
      }),
    /strictly greater/,
  );
});

test('recordCompact: requires all mandatory fields', async () => {
  const { repository } = await fixture();
  // missing summary_text
  assert.throws(
    () =>
      recordCompact({
        repository,
        session_uuid: SESSION_UUID,
        summary_payload: {},
        through_seq: 1,
        folded_event_seqs: [1],
        token_estimate: 100,
        context_window: 8_000,
        safety_ratio: 0.10,
        reserved_completion_tokens: 1024,
        schema_version: 1,
        prompt_version: 1,
      }),
    /summary_text/,
  );
});

test('recordCompact: rejects non-array folded_event_seqs', async () => {
  const { repository } = await fixture();
  assert.throws(
    () =>
      recordCompact({
        repository,
        session_uuid: SESSION_UUID,
        summary_text: 'ok',
        summary_payload: {},
        through_seq: 1,
        folded_event_seqs: 'not-an-array',
        token_estimate: 100,
        context_window: 8_000,
        safety_ratio: 0.10,
        reserved_completion_tokens: 1024,
        schema_version: 1,
        prompt_version: 1,
      }),
    /folded_event_seqs/,
  );
});

test('recordCompact: rejects out-of-range safety_ratio', async () => {
  const { repository } = await fixture();
  assert.throws(
    () =>
      recordCompact({
        repository,
        session_uuid: SESSION_UUID,
        summary_text: 'ok',
        summary_payload: {},
        through_seq: 1,
        folded_event_seqs: [1],
        token_estimate: 100,
        context_window: 8_000,
        safety_ratio: 1.5,
        reserved_completion_tokens: 1024,
        schema_version: 1,
        prompt_version: 1,
      }),
    /safety_ratio/,
  );
  assert.throws(
    () =>
      recordCompact({
        repository,
        session_uuid: SESSION_UUID,
        summary_text: 'ok',
        summary_payload: {},
        through_seq: 1,
        folded_event_seqs: [1],
        token_estimate: 100,
        context_window: 8_000,
        safety_ratio: -0.1,
        reserved_completion_tokens: 1024,
        schema_version: 1,
        prompt_version: 1,
      }),
    /safety_ratio/,
  );
});

test('recordCompactFailure: leaves cursor intact, records status', async () => {
  const { repository } = await fixture();
  recordCompact({
    repository,
    session_uuid: SESSION_UUID,
    summary_text: 'first',
    summary_payload: { n: 1 },
    through_seq: 3,
    folded_event_seqs: [1, 2, 3],
    token_estimate: 500,
    context_window: 8_000,
    safety_ratio: 0.10,
    reserved_completion_tokens: 1024,
    schema_version: 1,
    prompt_version: 1,
  });
  const failResult = recordCompactFailure({
    repository,
    session_uuid: SESSION_UUID,
    error_code: 'estimator_unavailable',
    error_message: 'token estimator down',
  });
  assert.equal(failResult.last_compact_status, 'failed');
  assert.equal(failResult.last_compact_error, 'token estimator down');
  // Cursor must NOT have advanced
  assert.equal(failResult.compacted_through_seq, 3);
});

test('getSessionCompact: returns null fields when no compact yet', async () => {
  const { repository } = await fixture();
  const result = getSessionCompact({ repository, session_uuid: SESSION_UUID });
  assert.equal(result.context_compact_text, null);
  assert.equal(result.compacted_through_seq, null);
  assert.equal(result.last_compact_status, 'idle');
});

test('rebuildCompactFromHistory: works on session with committed opening events', async () => {
  const { repository, cache } = await fixture();
  const committed = await commitFirstNEvents({ repository, cache, n: 3 });
  assert.ok(committed >= 1, 'should commit at least one event from cache');
  const rebuilt = rebuildCompactFromHistory({
    repository,
    session_uuid: SESSION_UUID,
    builder: (events) => ({
      summary_text: 'rebuilt from committed history',
      summary_payload: { rebuilt: true, committed },
      folded_event_seqs: events.map((e) => e.event_seq),
      token_estimate: 800,
      context_window: 8_000,
      safety_ratio: 0.10,
      reserved_completion_tokens: 1024,
      schema_version: 1,
      prompt_version: 1,
    }),
  });
  assert.ok(rebuilt.last_compact_status === 'compacted');
  assert.ok(rebuilt.compacted_through_seq >= 1);
});

test('rebuildCompactFromHistory: empty history records a skipped attempt instead of throwing', async () => {
  const { repository } = await fixture();
  // No compact, no history: the old implementation passed an empty
  // summary_text into recordCompact and blew up on assertCompactInput.
  const result = rebuildCompactFromHistory({
    repository,
    session_uuid: SESSION_UUID,
    builder: () => ({ summary_text: 'x', summary_payload: {}, folded_event_seqs: [] }),
  });
  assert.equal(result.last_compact_status, 'skipped');
  assert.equal(result.last_compact_error, null);
  // No compact snapshot was written (the cursor stays unset).
  assert.equal(result.compacted_through_seq, null);
  assert.equal(result.context_compact_text, null);
  const session = _peekRawSession(repository);
  assert.equal(session.compact_history.length, 1);
  assert.equal(session.compact_history[0].status, 'skipped');
});

test('rebuildCompactFromHistory: existing compact + no new events records a skipped attempt and keeps the snapshot', async () => {
  const { repository, cache } = await fixture();
  await commitFirstNEvents({ repository, cache, n: 3 });
  const first = rebuildCompactFromHistory({
    repository,
    session_uuid: SESSION_UUID,
    kept_recent: 0,
    builder: (events) => ({
      summary_text: `folded ${events.length} events`,
      summary_payload: { folded_event_seqs: events.map((e) => e.event_seq) },
      folded_event_seqs: events.map((e) => e.event_seq),
      token_estimate: 100,
      context_window: 8_000,
      safety_ratio: 0.10,
      reserved_completion_tokens: 1024,
      schema_version: 1,
      prompt_version: 1,
    }),
  });
  assert.equal(first.last_compact_status, 'compacted');
  assert.equal(first.compacted_through_seq, 3);
  // Re-run with nothing new to fold: the rebuilt summary would NOT
  // strictly advance compacted_through_seq, so a 'skipped' attempt is
  // recorded and the previous compact snapshot stays intact — no throw.
  const second = rebuildCompactFromHistory({
    repository,
    session_uuid: SESSION_UUID,
    kept_recent: 0,
    builder: (events) => ({
      summary_text: `folded ${events.length} events again`,
      summary_payload: { folded_event_seqs: events.map((e) => e.event_seq) },
      folded_event_seqs: events.map((e) => e.event_seq),
      token_estimate: 100,
      context_window: 8_000,
      safety_ratio: 0.10,
      reserved_completion_tokens: 1024,
      schema_version: 1,
      prompt_version: 1,
    }),
  });
  assert.equal(second.last_compact_status, 'skipped');
  assert.equal(second.last_compact_error, null);
  assert.equal(second.compacted_through_seq, 3, 'cursor must not move');
  assert.equal(second.context_compact_text, 'folded 3 events', 'previous summary must stay intact');
  const session = _peekRawSession(repository);
  assert.equal(session.compact_history.length, 2);
  assert.deepEqual(session.compact_history.map((record) => record.status), ['compacted', 'skipped']);
});

test('rebuildCompactFromHistory: full recompute folds the whole prefix, not just the post-cursor delta', async () => {
  const { repository, cache } = await fixture();
  await commitFirstNEvents({ repository, cache, n: 3 });
  // Fold everything so far (kept_recent 0 → the whole history is prefix).
  rebuildCompactFromHistory({
    repository,
    session_uuid: SESSION_UUID,
    kept_recent: 0,
    builder: (events) => ({
      summary_text: 'v1',
      summary_payload: { folded_event_seqs: events.map((e) => e.event_seq) },
      folded_event_seqs: events.map((e) => e.event_seq),
    }),
  });
  // One more canonical event lands after the compact.
  const events = cache.content_payload.events;
  commitOpeningEvent({
    repository,
    session_uuid: SESSION_UUID,
    cache_uuid: cache.cache_uuid,
    event: { ...events[3], displayed: true },
    client_request_id: 'rebuild-full-4',
    expected_revision: 3,
  });
  // Force-recompute: the builder must see ALL 4 events (the full prefix),
  // not only the delta after compacted_through_seq=3.
  let seen = null;
  const rebuilt = rebuildCompactFromHistory({
    repository,
    session_uuid: SESSION_UUID,
    kept_recent: 0,
    builder: (prefixEvents) => {
      seen = prefixEvents.map((e) => e.event_seq);
      return {
        summary_text: 'v2 full recompute',
        summary_payload: { folded_event_seqs: seen },
        folded_event_seqs: seen,
        token_estimate: 200,
        context_window: 8_000,
        safety_ratio: 0.10,
        reserved_completion_tokens: 1024,
        schema_version: 2,
        prompt_version: 2,
      };
    },
  });
  assert.deepEqual(seen, [1, 2, 3, 4], 'builder must receive the full prefix including already-compacted events');
  assert.equal(rebuilt.last_compact_status, 'compacted');
  assert.equal(rebuilt.compacted_through_seq, 4);
  assert.equal(rebuilt.compacted_event_count, 4);
  assert.equal(rebuilt.context_compact_text, 'v2 full recompute');
});

test('recordCompact: truncates last_compact_error to the VARCHAR(500) schema bound', async () => {
  const { repository } = await fixture();
  const longError = 'x'.repeat(900);
  const result = recordCompact({
    repository,
    session_uuid: SESSION_UUID,
    status: 'failed',
    summary_text: 'unused',
    summary_payload: {},
    through_seq: 1,
    folded_event_seqs: [1],
    token_estimate: 10,
    context_window: 8_000,
    safety_ratio: 0.10,
    reserved_completion_tokens: 1024,
    schema_version: 1,
    prompt_version: 1,
    error_code: 'estimator_boom',
    error_message: longError,
  });
  assert.equal(result.last_compact_status, 'failed');
  assert.equal(result.last_compact_error.length, 500, 'must match last_compact_error VARCHAR(500)');
  assert.ok(longError.startsWith(result.last_compact_error));
  const failed = recordCompactFailure({
    repository,
    session_uuid: SESSION_UUID,
    error_code: 'estimator_boom',
    error_message: longError,
  });
  assert.equal(failed.last_compact_error.length, 500);
});

test('assembleContext + recordCompact integration: roundtrip usable', async () => {
  const { repository, cache } = await fixture();
  await commitFirstNEvents({ repository, cache, n: 3 });
  const compact = recordCompact({
    repository,
    session_uuid: SESSION_UUID,
    summary_text: 'opening: cafe in the rain, narrator and stranger',
    summary_payload: { sections: ['facts'] },
    through_seq: 1,
    folded_event_seqs: [1],
    token_estimate: 600,
    context_window: 8_000,
    safety_ratio: 0.10,
    reserved_completion_tokens: 1024,
    schema_version: 1,
    prompt_version: 1,
  });
  const session = getSession({ repository, session_uuid: SESSION_UUID });
  const history = listSessionEvents({ repository, session_uuid: SESSION_UUID });
  const ctx = assembleContext({
    estimator: createTokenEstimator({ model: 'mock/test' }),
    canonicalHistory: history,
    existingCompact: {
      summary_text: compact.context_compact_text,
      through_seq: compact.compacted_through_seq,
    },
    input: { text: 'continue' },
  });
  assert.equal(ctx.decision, 'no_compact');
  assert.equal(ctx.compact_text, compact.context_compact_text);
  assert.ok(ctx.compact_through_seq >= 1);
});

test('compact does not touch canonical history', async () => {
  const { repository, cache } = await fixture();
  await commitFirstNEvents({ repository, cache, n: 3 });
  const before = listSessionEvents({ repository, session_uuid: SESSION_UUID });
  const beforeCount = before.length;

  recordCompact({
    repository,
    session_uuid: SESSION_UUID,
    summary_text: 'compact',
    summary_payload: {},
    through_seq: 1,
    folded_event_seqs: [1],
    token_estimate: 100,
    context_window: 8_000,
    safety_ratio: 0.10,
    reserved_completion_tokens: 1024,
    schema_version: 1,
    prompt_version: 1,
  });

  const after = listSessionEvents({ repository, session_uuid: SESSION_UUID });
  assert.equal(after.length, beforeCount, 'history length must not change after compact');
});

test('interrupt (opening state) does not block subsequent compact', async () => {
  const { repository, cache } = await fixture();
  // commit a couple of opening events so the session is in 'opening' state
  // and the cache is not yet exhausted
  await commitFirstNEvents({ repository, cache, n: 2 });
  // interrupt while still in opening state
  interruptWithPlayerInput({
    repository,
    session_uuid: SESSION_UUID,
    text: 'pause',
    client_request_id: 'req-int',
    expected_revision: 2,
  });
  // Compact still works after interrupt
  const result = recordCompact({
    repository,
    session_uuid: SESSION_UUID,
    summary_text: 'after interrupt',
    summary_payload: {},
    through_seq: 1,
    folded_event_seqs: [1],
    token_estimate: 200,
    context_window: 8_000,
    safety_ratio: 0.10,
    reserved_completion_tokens: 1024,
    schema_version: 1,
    prompt_version: 1,
  });
  assert.equal(result.last_compact_status, 'compacted');
});

// Read the raw session row (same access pattern as tests/sessionService.test.mjs)
// for assertions on the internal compact audit log.
function _peekRawSession(repository) {
  const session = repository.sessionState.sessions.get(SESSION_UUID);
  if (!session) throw new Error('agentCompact fixture: session missing');
  return session;
}

test('token estimator: threshold math is correct', () => {
  const est = createTokenEstimator({ model: 'openai/gpt-4o' });
  // 128000 * 0.9 = 115200, - 1024 = 114176
  assert.equal(est.compactThreshold(), 114_176);
  assert.equal(est.contextWindow(), 128_000);
  assert.equal(est.reservedCompletionTokens(), 1024);
});
