// tests/pendingLifecycle.test.mjs — ClickUp 08 minimum slice.
//
// Verifies:
//   1. normal one-at-a-time commit: pending -> history grows by one
//   2. un-displayed events never touch canonical history
//   3. mid-batch interrupt: keeps committed, drops the rest
//   4. idempotent commit: same client_request_id replays the same result
//   5. out-of-order / stale revision / wrong pending_id fail closed
//   6. recover does not call provider and does not duplicate history
//
// Existing sessionService + agentRuntime + HTTP suites stay untouched on
// purpose; this file is additive.

import assert from 'node:assert/strict';
import {
  commitDisplayedEvent,
  commitOpeningEvent,
  createSeededRepository,
  createSession,
  defaultGenerationProfile,
  discardPendingTail,
  ensureOpeningCache,
  getSession,
  interruptWithPlayerInput,
  interruptWithPlayerInputFromPending,
  listSessionEvents,
  recoverPendingSession,
  recoverSession,
  stageNarrativeBatch,
} from '../src/stories/index.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function buildSession() {
  const { repository, fixtures } = createSeededRepository();
  const story = fixtures.find((row) => row.slug === 'cafe-rain');
  const { cache } = await ensureOpeningCache({ repository, story_version_uuid: story.story_version_uuid });
  const profile = {
    identifier: cache.generation_profile.identifier,
    rules_version: cache.generation_profile.rules_version,
    locale: cache.generation_profile.locale,
    variant: cache.generation_profile.variant,
    cache_uuid: cache.cache_uuid,
    generation_hash: cache.generation_hash,
  };
  const session_uuid = '00000000-0000-4000-8000-000000000301';
  createSession({
    repository,
    session_uuid,
    story_uuid: story.story_uuid,
    story_version_uuid: story.story_version_uuid,
    user_ref: 'pending-test-user',
    role_id: 'stranger',
    model: 'mock-pending',
    prompt: 'pending test prompt',
    generation_profile: profile,
  });
  return { repository, session_uuid, story, cache, profile };
}

function makeBatch(size, startSeq = 0) {
  const out = [];
  for (let i = 0; i < size; i += 1) {
    out.push({
      type: i % 2 === 0 ? 'narration' : 'dialogue',
      sequence: startSeq + i,
      text: `narrative line ${startSeq + i + 1}`,
      ...(i % 2 === 1 ? { speaker: 'stranger' } : {}),
    });
  }
  return out;
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

await test('stageNarrativeBatch parks the batch and does NOT touch canonical history', async () => {
  const { repository, session_uuid } = await buildSession();
  const batch = makeBatch(3);
  const staged = stageNarrativeBatch({
    repository, session_uuid, events: batch, source: 'runtime', expected_revision: 0,
  });
  assert.equal(staged.session_uuid, session_uuid);
  assert.match(staged.pending_id, UUID_PATTERN);
  assert.equal(staged.committed_count, 0);
  assert.equal(staged.events.length, 3);
  assert.equal(staged.revision, 0);
  // History is unchanged: a stage is purely speculative.
  assert.equal(listSessionEvents({ repository, session_uuid }).length, 0);
  assert.equal(recoverPendingSession({ repository, session_uuid }).pending.pending_id, staged.pending_id);
  assert.equal(recoverPendingSession({ repository, session_uuid }).history.length, 0);
});

await test('commitDisplayedEvent appends exactly one canonical event per call', async () => {
  const { repository, session_uuid } = await buildSession();
  const staged = stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(3), source: 'runtime', expected_revision: 0,
  });
  const committed0 = commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id, sequence: 0, expected_revision: 0,
  });
  assert.equal(committed0.event.event_seq, 1);
  assert.equal(committed0.event.prev_event_seq, null);
  assert.equal(committed0.event.event_type, 'narrative');
  assert.equal(committed0.event.origin, 'runtime');
  assert.equal(committed0.event.source, 'runtime');
  assert.equal(committed0.event.source_sequence, 0);
  assert.equal(committed0.event.payload.text, 'narrative line 1');
  assert.equal(committed0.revision, 1);
  assert.equal(committed0.pending_remaining, 2);
  assert.equal(committed0.pending_committed_count, 1);
  const committed1 = commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id, sequence: 1, expected_revision: 1,
  });
  assert.equal(committed1.event.event_seq, 2);
  assert.equal(committed1.event.prev_event_seq, 1);
  assert.equal(committed1.event.payload.text, 'narrative line 2');
  assert.equal(committed1.revision, 2);
  const committed2 = commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id, sequence: 2, expected_revision: 2,
  });
  assert.equal(committed2.event.event_seq, 3);
  assert.equal(committed2.revision, 3);
  assert.equal(committed2.pending_remaining, 0);
  assert.equal(committed2.pending_committed_count, 3);
  // After the last commit the pending snapshot is cleared.
  assert.equal(recoverPendingSession({ repository, session_uuid }).pending, null);
  const recovered = recoverPendingSession({ repository, session_uuid });
  assert.equal(recovered.history.length, 3);
  assert.equal(recovered.revision, 3);
  assert.equal(recovered.cursor, 3);
});

await test('un-displayed events never reach canonical history', async () => {
  const { repository, session_uuid } = await buildSession();
  // Stage a 5-event batch.
  const staged = stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(5), source: 'runtime', expected_revision: 0,
  });
  // The player sees only 2 of them.
  commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id, sequence: 0, expected_revision: 0,
  });
  commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id, sequence: 1, expected_revision: 1,
  });
  // The remaining 3 are un-displayed and never reach canonical history.
  const recovered = recoverPendingSession({ repository, session_uuid });
  assert.equal(recovered.history.length, 2);
  assert.equal(recovered.revision, 2);
  // The lifecycle view carries its own canonical history; the legacy
  // sessionService view stays untouched (no events were committed through
  // that surface in this test).
  assert.equal(listSessionEvents({ repository, session_uuid }).length, 0);
  assert.equal(getSession({ repository, session_uuid }).revision, 0);
  // Pending snapshot still shows the full staged batch, only 2 committed.
  assert.equal(recovered.pending.committed_count, 2);
  assert.equal(recovered.pending.events.length, 5);
});

await test('mid-batch interrupt keeps only committed canonical history and drops pending tail', async () => {
  const { repository, session_uuid } = await buildSession();
  const staged = stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(4), source: 'runtime', expected_revision: 0,
  });
  // Player sees 2 of the 4, then interrupts.
  commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id, sequence: 0, expected_revision: 0,
  });
  commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id, sequence: 1, expected_revision: 1,
  });
  const interrupted = interruptWithPlayerInputFromPending({
    repository, session_uuid, text: '我等一个答案', expected_revision: 2,
  });
  assert.equal(interrupted.dropped_pending_count, 2);
  assert.equal(interrupted.dropped_pending_id, staged.pending_id);
  assert.equal(interrupted.state, 'realtime');
  assert.equal(interrupted.event.event_type, 'player_input');
  assert.equal(interrupted.event.event_seq, 3);
  assert.equal(interrupted.event.prev_event_seq, 2);
  assert.equal(interrupted.revision, 3);
  // Pending is gone; only committed + player_input remain.
  const recovered = recoverPendingSession({ repository, session_uuid });
  assert.equal(recovered.pending, null);
  assert.equal(recovered.history.length, 3);
  assert.equal(recovered.history[0].event_type, 'narrative');
  assert.equal(recovered.history[1].event_type, 'narrative');
  assert.equal(recovered.history[2].event_type, 'player_input');
  assert.equal(recovered.revision, 3);
  assert.equal(recovered.state, 'realtime');
});

await test('immediate interrupt before any commit keeps history empty and drops full batch', async () => {
  const { repository, session_uuid } = await buildSession();
  const staged = stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(3), source: 'runtime', expected_revision: 0,
  });
  const interrupted = interruptWithPlayerInputFromPending({
    repository, session_uuid, text: '先打断', expected_revision: 0,
  });
  assert.equal(interrupted.dropped_pending_count, 3);
  assert.equal(interrupted.dropped_pending_id, staged.pending_id);
  assert.equal(interrupted.state, 'realtime');
  const recovered = recoverPendingSession({ repository, session_uuid });
  assert.equal(recovered.history.length, 1);
  assert.equal(recovered.history[0].event_type, 'player_input');
  assert.equal(recovered.pending, null);
});

await test('commitDisplayedEvent is idempotent on client_request_id', async () => {
  const { repository, session_uuid } = await buildSession();
  const staged = stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(3), source: 'runtime', expected_revision: 0,
  });
  const first = commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id, sequence: 0,
    expected_revision: 0, client_request_id: 'commit-req-1',
  });
  const replay = commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id, sequence: 0,
    expected_revision: 0, client_request_id: 'commit-req-1',
  });
  assert.deepEqual(replay, first);
  // No duplicate append.
  assert.equal(listSessionEvents({ repository, session_uuid }).length, 0);
  assert.equal(recoverPendingSession({ repository, session_uuid }).history.length, 1);
});

await test('reusing client_request_id with different sequence is rejected', async () => {
  const { repository, session_uuid } = await buildSession();
  const staged = stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(3), source: 'runtime', expected_revision: 0,
  });
  commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id, sequence: 0,
    expected_revision: 0, client_request_id: 'reuse',
  });
  assert.throws(() => commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id, sequence: 1,
    expected_revision: 1, client_request_id: 'reuse',
  }), /different request/);
});

await test('stale revision is rejected', async () => {
  const { repository, session_uuid } = await buildSession();
  const staged = stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(3), source: 'runtime', expected_revision: 0,
  });
  commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id, sequence: 0, expected_revision: 0,
  });
  assert.throws(() => commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id, sequence: 1, expected_revision: 0,
  }), /revision mismatch/);
  assert.throws(() => commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id, sequence: 1, expected_revision: 99,
  }), /revision mismatch/);
});

await test('out-of-order sequence is rejected', async () => {
  const { repository, session_uuid } = await buildSession();
  const staged = stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(3), source: 'runtime', expected_revision: 0,
  });
  assert.throws(() => commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id, sequence: 2, expected_revision: 0,
  }), /out-of-order|committed_count/);
  commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id, sequence: 0, expected_revision: 0,
  });
  // Skipping sequence 1 is also rejected.
  assert.throws(() => commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id, sequence: 2, expected_revision: 1,
  }), /out-of-order|committed_count/);
});

await test('wrong pending_id is rejected', async () => {
  const { repository, session_uuid } = await buildSession();
  const staged = stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(3), source: 'runtime', expected_revision: 0,
  });
  // Non-UUID string → UUID format error.
  assert.throws(() => commitDisplayedEvent({
    repository, session_uuid, pending_id: 'not-a-uuid',
    sequence: 0, expected_revision: 0,
  }), /UUID/);
  // Valid UUID but not the active pending_id → mismatch error.
  assert.throws(() => commitDisplayedEvent({
    repository, session_uuid, pending_id: '00000000-0000-4000-8000-deadbeef0000',
    sequence: 0, expected_revision: 0,
  }), /pending_id/);
});

await test('stale pending_id after a fresh stage is rejected', async () => {
  const { repository, session_uuid } = await buildSession();
  const first = stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(2), source: 'runtime', expected_revision: 0,
  });
  // Replace the pending batch.
  const second = stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(2), source: 'runtime', expected_revision: 0,
  });
  assert.notEqual(first.pending_id, second.pending_id);
  assert.throws(() => commitDisplayedEvent({
    repository, session_uuid, pending_id: first.pending_id, sequence: 0, expected_revision: 0,
  }), /pending_id/);
});

await test('stage rejects non-contiguous sequences', async () => {
  const { repository, session_uuid } = await buildSession();
  assert.throws(() => stageNarrativeBatch({
    repository, session_uuid, events: [
      { type: 'narration', sequence: 0, text: 'one' },
      { type: 'narration', sequence: 2, text: 'two' },
    ], source: 'runtime', expected_revision: 0,
  }), /sequence must equal/);
});

await test('stage rejects unknown event types and missing text', async () => {
  const { repository, session_uuid } = await buildSession();
  assert.throws(() => stageNarrativeBatch({
    repository, session_uuid, events: [{ type: 'ask_player_choice', sequence: 0, text: 'choice' }],
    source: 'runtime', expected_revision: 0,
  }), /type must be/);
  assert.throws(() => stageNarrativeBatch({
    repository, session_uuid, events: [{ type: 'narration', sequence: 0 }],
    source: 'runtime', expected_revision: 0,
  }), /text must be/);
  assert.throws(() => stageNarrativeBatch({
    repository, session_uuid, events: [{ type: 'narration', sequence: 0, text: '' }],
    source: 'runtime', expected_revision: 0,
  }), /text must be/);
});

await test('recover does not duplicate history and never calls provider', async () => {
  const { repository, session_uuid } = await buildSession();
  const staged = stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(4), source: 'runtime', expected_revision: 0,
  });
  commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id, sequence: 0, expected_revision: 0,
  });
  commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id, sequence: 1, expected_revision: 1,
  });
  // First recover.
  const r1 = recoverPendingSession({ repository, session_uuid });
  assert.equal(r1.history.length, 2);
  assert.equal(r1.revision, 2);
  assert.equal(r1.cursor, 2);
  assert.equal(r1.pending.pending_id, staged.pending_id);
  assert.equal(r1.pending.committed_count, 2);
  assert.equal(r1.pending.events.length, 4);
  // Second recover must be a clean snapshot, not a replay.
  const r2 = recoverPendingSession({ repository, session_uuid });
  assert.deepEqual(r2, r1);
  // pendingLifecycle owns its own canonical history; the sessionService
  // view stays untouched by these commits.
  assert.equal(listSessionEvents({ repository, session_uuid }).length, 0);
  assert.equal(recoverSession({ repository, session_uuid }).history.length, 0);
});

await test('discardPendingTail wipes speculative state without appending', async () => {
  const { repository, session_uuid } = await buildSession();
  const staged = stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(3), source: 'runtime', expected_revision: 0,
  });
  commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id, sequence: 0, expected_revision: 0,
  });
  const dropped = discardPendingTail({ repository, session_uuid });
  assert.equal(dropped.dropped_pending_id, staged.pending_id);
  assert.equal(dropped.dropped_pending_count, 2);
  const recovered = recoverPendingSession({ repository, session_uuid });
  assert.equal(recovered.pending, null);
  assert.equal(recovered.history.length, 1);
});

await test('sessionService commitOpeningEvent + pending commit coexist on the same session', async () => {
  // The two surfaces share the session but write to disjoint history
  // arrays. commitOpeningEvent writes through sessionService; pending
  // writes through pendingLifecycle. A client may freely mix them.
  const { repository, session_uuid, cache } = await buildSession();
  const events = cache.content_payload.events;
  // First commit one opening cache event through sessionService.
  commitOpeningEvent({
    repository, session_uuid, cache_uuid: cache.cache_uuid,
    event: { ...events[0], displayed: true }, expected_revision: 0,
  });
  assert.equal(getSession({ repository, session_uuid }).revision, 1);
  // Then stage + commit a runtime batch through pendingLifecycle.
  // pendingLifecycle's revision starts from its own history.length (0).
  const staged = stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(2), source: 'runtime', expected_revision: 0,
  });
  commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id, sequence: 0, expected_revision: 0,
  });
  assert.equal(recoverPendingSession({ repository, session_uuid }).history.length, 1);
  assert.equal(recoverPendingSession({ repository, session_uuid }).revision, 1);
  // sessionService's history is unchanged by the pending commit.
  assert.equal(listSessionEvents({ repository, session_uuid }).length, 1);
});

await test('legacy interrupt path leaves the lifecycle coherent after dropPendingAfterLegacyInterrupt', async () => {
  const { repository, session_uuid } = await buildSession();
  const staged = stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(3), source: 'runtime', expected_revision: 0,
  });
  commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id, sequence: 0, expected_revision: 0,
  });
  // sessionService revision is still 0 (pendingLifecycle owns a separate
  // history), so the legacy interrupt uses expected_revision: 0.
  const interrupted = interruptWithPlayerInput({
    repository, session_uuid, text: '走老路径打断', expected_revision: 0,
  });
  assert.equal(interrupted.state, 'realtime');
  // The pending lifecycle still holds the orphaned batch; the route layer
  // should call dropPendingAfterLegacyInterrupt to keep them coherent.
  const { dropPendingAfterLegacyInterrupt } = await import('../src/stories/pendingLifecycle.mjs');
  const dropped = dropPendingAfterLegacyInterrupt({ repository, session_uuid });
  assert.equal(dropped.dropped_pending_id, staged.pending_id);
  assert.equal(recoverPendingSession({ repository, session_uuid }).pending, null);
});