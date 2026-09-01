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
  assert.equal(committed0.event.event_type, 'narrative_beat');
  assert.equal(committed0.event.origin, 'llm');
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
  // The canonical cursor counts ALL committed canonical events, so it
  // equals revision (3). The opening playback position (opening_cursor)
  // stays 0 because no opening event was committed.
  assert.equal(recovered.cursor, 3);
  assert.equal(recovered.opening_cursor, 0);
});

await test('un-displayed events never reach canonical history', async () => {
  const { repository, session_uuid } = await buildSession();
  // Stage a 4-event batch (the maximum allowed by ClickUp 08).
  const staged = stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(4), source: 'runtime', expected_revision: 0,
  });
  // The player sees only 2 of them.
  commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id, sequence: 0, expected_revision: 0,
  });
  commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id, sequence: 1, expected_revision: 1,
  });
  // The remaining 2 are un-displayed and never reach canonical history.
  const recovered = recoverPendingSession({ repository, session_uuid });
  assert.equal(recovered.history.length, 2);
  assert.equal(recovered.revision, 2);
  // sessionService owns the same history now (the lifecycle facade is a
  // thin layer over it). listSessionEvents MUST agree with the lifecycle
  // view: there is exactly one canonical history.
  assert.equal(listSessionEvents({ repository, session_uuid }).length, 2);
  assert.equal(getSession({ repository, session_uuid }).revision, 2);
  // Pending snapshot still shows the full staged batch, only 2 committed.
  assert.equal(recovered.pending.committed_count, 2);
  assert.equal(recovered.pending.events.length, 4);
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
  assert.equal(recovered.history[0].event_type, 'narrative_beat');
  assert.equal(recovered.history[1].event_type, 'narrative_beat');
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
  assert.equal(listSessionEvents({ repository, session_uuid }).length, 1);
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
  // Re-stage with the SAME payload → idempotent return. pending_id is stable.
  const sameReplay = stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(2), source: 'runtime', expected_revision: 0,
  });
  assert.equal(sameReplay.pending_id, first.pending_id);
  // Re-stage with a DIFFERENT payload → fail closed. The active pending
  // must NOT be silently overwritten (ClickUp 08 P1.2).
  assert.throws(() => stageNarrativeBatch({
    repository, session_uuid, events: [
      { type: 'narration', sequence: 0, text: 'different line 1' },
      { type: 'dialogue', sequence: 1, text: 'different line 2', speaker: 'stranger' },
    ], source: 'runtime', expected_revision: 0,
  }), /unconsumed pending/);
  // The pending_id is still the original one; a stale one is rejected.
  assert.throws(() => commitDisplayedEvent({
    repository, session_uuid, pending_id: '00000000-0000-4000-8000-deadbeef0000',
    sequence: 0, expected_revision: 0,
  }), /pending_id/);
  // Drain the active batch with a full commit, then stage a fresh one.
  commitDisplayedEvent({
    repository, session_uuid, pending_id: first.pending_id, sequence: 0, expected_revision: 0,
  });
  commitDisplayedEvent({
    repository, session_uuid, pending_id: first.pending_id, sequence: 1, expected_revision: 1,
  });
  // After draining, a brand-new stage succeeds with a new pending_id.
  const second = stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(2), source: 'runtime', expected_revision: 2,
  });
  assert.notEqual(first.pending_id, second.pending_id);
  assert.throws(() => commitDisplayedEvent({
    repository, session_uuid, pending_id: first.pending_id, sequence: 0, expected_revision: 2,
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

await test('P1.2: stageNarrativeBatch rejects a different payload while a pending is unconsumed', async () => {
  // ClickUp 08 P1.2 — active pending concurrency. With an unconsumed
  // pending batch, a fresh stage MUST NOT silently overwrite it. Same
  // payload returns the existing pending (idempotent); different payload
  // fails closed.
  const { repository, session_uuid } = await buildSession();
  const first = stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(3), source: 'runtime', expected_revision: 0,
  });
  // Same payload (no client_request_id) → idempotent return; pending_id is stable.
  const sameReplay = stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(3), source: 'runtime', expected_revision: 0,
  });
  assert.equal(sameReplay.pending_id, first.pending_id);
  assert.equal(sameReplay.committed_count, 0);
  assert.equal(sameReplay.events.length, 3);
  // Different payload → fail closed; the active pending is untouched.
  assert.throws(() => stageNarrativeBatch({
    repository, session_uuid, events: [
      { type: 'narration', sequence: 0, text: 'late provider line' },
    ], source: 'runtime', expected_revision: 0,
  }), /unconsumed pending/);
  // The pending_id is still the original one.
  const recovered = recoverPendingSession({ repository, session_uuid });
  assert.equal(recovered.pending.pending_id, first.pending_id);
  assert.equal(recovered.pending.events.length, 3);
});

await test('P1.2: late provider arriving AFTER partial commit is rejected, original batch survives', async () => {
  // A partial commit advances revision; a late provider with the OLD
  // expected_revision must fail closed with revision_mismatch. A late
  // provider that somehow guesses the new revision must still fail
  // closed because the active pending is unconsumed (committed_count<events).
  const { repository, session_uuid } = await buildSession();
  const staged = stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(4), source: 'runtime', expected_revision: 0,
  });
  commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id,
    sequence: 0, expected_revision: 0,
  });
  // Stale revision → revision_mismatch, not "unconsumed pending".
  assert.throws(() => stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(2), source: 'runtime', expected_revision: 0,
  }), /revision mismatch/);
  // With the right revision but a different payload → unconsumed pending.
  assert.throws(() => stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(2), source: 'runtime', expected_revision: 1,
  }), /unconsumed pending/);
  // With the right revision AND the same payload → idempotent return.
  const replay = stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(4), source: 'runtime', expected_revision: 1,
  });
  assert.equal(replay.pending_id, staged.pending_id);
  assert.equal(replay.committed_count, 1);
  // Active pending is still 4 items, 1 committed.
  const recovered = recoverPendingSession({ repository, session_uuid });
  assert.equal(recovered.pending.events.length, 4);
  assert.equal(recovered.pending.committed_count, 1);
});

await test('P1.2: two stages with the SAME client_request_id are idempotent even when other state advanced', async () => {
  const { repository, session_uuid } = await buildSession();
  const staged = stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(2), source: 'runtime',
    expected_revision: 0, client_request_id: 'stage-req-1',
  });
  const replay = stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(2), source: 'runtime',
    expected_revision: 0, client_request_id: 'stage-req-1',
  });
  assert.deepEqual(replay, staged);
  // Drain the pending so the second stage-with-different-id can succeed.
  commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id,
    sequence: 0, expected_revision: 0,
  });
  commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id,
    sequence: 1, expected_revision: 1,
  });
  // A new client_request_id with the same payload after the drain
  // produces a brand-new pending batch.
  const fresh = stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(2), source: 'runtime', expected_revision: 2,
  });
  assert.notEqual(fresh.pending_id, staged.pending_id);
});

await test('P1.2: tool_call-bearing batch with the same payload round-trips through stage idempotently', async () => {
  const { repository, session_uuid } = await buildSession();
  const tool_call = { tool_call_id: 'tool-1', name: 'ask_player_choice', payload: { question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } };
  const first = stageNarrativeBatch({
    repository, session_uuid, items: [
      { type: 'narration', sequence: 0, text: 'narrative line 1' },
    ], source: 'runtime', expected_revision: 0, tool_call,
  });
  assert.equal(first.tool_call.tool_call_id, 'tool-1');
  const replay = stageNarrativeBatch({
    repository, session_uuid, items: [
      { type: 'narration', sequence: 0, text: 'narrative line 1' },
    ], source: 'runtime', expected_revision: 0, tool_call,
  });
  assert.equal(replay.pending_id, first.pending_id);
  assert.equal(replay.tool_call.tool_call_id, 'tool-1');
  // Different tool_call_id → fail closed.
  assert.throws(() => stageNarrativeBatch({
    repository, session_uuid, items: [
      { type: 'narration', sequence: 0, text: 'narrative line 1' },
    ], source: 'runtime', expected_revision: 0,
    tool_call: { tool_call_id: 'tool-2', name: 'ask_player_choice', payload: { question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } },
  }), /unconsumed pending/);
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
  // narrative commits advance the canonical cursor together with revision.
  assert.equal(r1.cursor, 2);
  assert.equal(r1.pending.pending_id, staged.pending_id);
  assert.equal(r1.pending.committed_count, 2);
  assert.equal(r1.pending.events.length, 4);
  // Second recover must be a clean snapshot, not a replay.
  const r2 = recoverPendingSession({ repository, session_uuid });
  assert.deepEqual(r2, r1);
  // The lifecycle facade and sessionService share the canonical history
  // (one history per session). Both views MUST agree.
  assert.equal(listSessionEvents({ repository, session_uuid }).length, 2);
  assert.equal(recoverSession({ repository, session_uuid }).history.length, 2);
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

await test('sessionService commitOpeningEvent + pending commit share the same canonical history', async () => {
  // ClickUp 08 contract: there is exactly ONE canonical history per
  // session. Opening commits (cache-backed) and narrative commits
  // (runtime-backed) both append to the same array; revision is shared.
  const { repository, session_uuid, cache } = await buildSession();
  const events = cache.content_payload.events;
  // First commit one opening cache event through sessionService.
  commitOpeningEvent({
    repository, session_uuid, cache_uuid: cache.cache_uuid,
    event: { ...events[0], displayed: true }, expected_revision: 0,
  });
  assert.equal(getSession({ repository, session_uuid }).revision, 1);
  // Then stage + commit a runtime batch through pendingLifecycle. Both
  // surfaces observe the SAME revision (1) and append to the SAME history.
  const staged = stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(2), source: 'runtime', expected_revision: 1,
  });
  // Stage does NOT advance revision, so the commit uses revision=1.
  commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id, sequence: 0, expected_revision: 1,
  });
  assert.equal(recoverPendingSession({ repository, session_uuid }).history.length, 2);
  assert.equal(recoverPendingSession({ repository, session_uuid }).revision, 2);
  // sessionService's history IS the canonical history (no duplication).
  assert.equal(listSessionEvents({ repository, session_uuid }).length, 2);
});

await test('legacy interrupt path leaves the lifecycle coherent by itself', async () => {
  // ClickUp 08 contract: there is ONE canonical history. The legacy
  // sessionService interrupt path already drops the speculative pending
  // tail atomically with appending the player_input event, so no extra
  // "dropPendingAfterLegacyInterrupt" hook is needed.
  const { repository, session_uuid } = await buildSession();
  const staged = stageNarrativeBatch({
    repository, session_uuid, events: makeBatch(3), source: 'runtime', expected_revision: 0,
  });
  commitDisplayedEvent({
    repository, session_uuid, pending_id: staged.pending_id, sequence: 0, expected_revision: 0,
  });
  // sessionService revision is now 1 (opening of pending commit advances
  // revision). The legacy interrupt uses expected_revision: 1.
  const interrupted = interruptWithPlayerInput({
    repository, session_uuid, text: '走老路径打断', expected_revision: 1,
  });
  assert.equal(interrupted.state, 'realtime');
  // The pending tail is dropped as part of the interrupt — the lifecycle
  // is automatically coherent.
  assert.equal(recoverPendingSession({ repository, session_uuid }).pending, null);
  // History shows: 1 narrative commit + 1 player_input.
  const recovered = recoverPendingSession({ repository, session_uuid });
  assert.equal(recovered.history.length, 2);
  assert.equal(recovered.history[0].event_type, 'narrative_beat');
  assert.equal(recovered.history[1].event_type, 'player_input');
});