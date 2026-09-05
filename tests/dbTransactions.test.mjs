// tests/dbTransactions.test.mjs — DB / transaction integrity suite.
//
// Scope: assert the contract that the in-memory repository (and its future
// MariaDB DAO twin) MUST hold for any session/event write path. The five
// guarantees tested here mirror the schema triggers defined in
// docs/data-model.md → §3.3 canonical event history:
//
//   1. Per-event commit (逐句 commit): every commitOpeningEvent produces
//      exactly one appended event with strictly monotonic event_seq and
//      prev_event_seq linkage.
//   2. Idempotency (重复点击幂等): replaying the same client_request_id
//      returns the original result verbatim; reusing the same id with a
//      different payload is rejected.
//   3. Interrupt deletes pending (打断删除 pending): a player input
//      committed before the cache is fully drained transitions the
//      session out of 'opening' and any further commitOpeningEvent is
//      rejected as 'not in opening state' — the in-flight opening tail
//      is effectively abandoned.
//   4. event_seq uniqueness (sequence 唯一): no two committed events in a
//      session can share event_seq; the canonical history is append-only
//      and prev_event_seq forms a single linked chain.
//   5. Session recovery (Session recover): recoverSession rebuilds the
//      exact cursor / revision / history seen at commit time, so a
//      disconnected client can resume without loss.

import assert from 'node:assert/strict';

import {
  createSeededRepository,
} from '../src/stories/fixture.mjs';
import {
  ensureOpeningCache,
} from '../src/stories/storyService.mjs';
import {
  commitNarrativeEvent,
  commitOpeningEvent,
  createSession,
  getSession,
  interruptWithPlayerInput,
  listSessionEvents,
  recoverSession,
  stageNarrativeBatch,
} from '../src/stories/sessionService.mjs';

import { CAFE_RAIN_FIXTURE } from './fixtures/seed-stories/cafe-rain.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let casesRun = 0;
let casesFailed = 0;

function test(name, fn) {
  casesRun += 1;
  return Promise.resolve()
    .then(fn)
    .then(
      () => console.log(`  ok   ${name}`),
      (err) => {
        casesFailed += 1;
        console.log(`  FAIL ${name}`);
        console.log(`    ${err && err.message ? err.message : err}`);
      },
    );
}

async function sessionFixture({ session_uuid, user_ref = 'u-tx', expected_revision_start = 0 } = {}) {
  const { repository } = createSeededRepository();
  const { cache } = await ensureOpeningCache({
    repository,
    story_version_uuid: CAFE_RAIN_FIXTURE.story_version_uuid,
  });
  const profile = {
    identifier: cache.generation_profile.identifier,
    rules_version: cache.generation_profile.rules_version,
    cache_uuid: cache.cache_uuid,
    generation_hash: cache.generation_hash,
  };
  createSession({
    repository,
    session_uuid,
    story_uuid: CAFE_RAIN_FIXTURE.story_uuid,
    story_version_uuid: CAFE_RAIN_FIXTURE.story_version_uuid,
    user_ref,
    role_id: 'stranger',
    model: 'gpt-tx',
    prompt: 'fixed prompt',
    generation_profile: profile,
  });
  return { repository, cache, profile };
}

function shown(event) {
  return { ...event, displayed: true };
}

async function run() {
  console.log('DB transaction integrity suite');

  await test('1. per-event commit is strictly monotonic and prev-linked', async () => {
    const session_uuid = '00000000-0000-4000-8000-0000000a0001';
    const { repository, cache } = await sessionFixture({ session_uuid });
    const events = cache.content_payload.events;
    let lastSeq = 0;
    let lastRevision = 0;
    let lastPrev = null;
    const historySeen = [];
    for (let i = 0; i < events.length; i += 1) {
      const result = commitOpeningEvent({
        repository,
        session_uuid,
        cache_uuid: cache.cache_uuid,
        event: shown(events[i]),
        client_request_id: `open-${i}`,
        expected_revision: lastRevision,
      });
      assert.equal(result.event.event_seq, lastSeq + 1, 'event_seq strictly increasing');
      assert.equal(result.event.event_seq, i + 1, 'event_seq matches 1-based position');
      assert.equal(result.event.prev_event_seq, lastPrev, 'prev_event_seq links back to previous');
      historySeen.push(result.event);
      lastSeq = result.event.event_seq;
      lastRevision = result.revision;
      lastPrev = result.event.event_seq;
    }
    // The canonical history must equal exactly what we observed during commit
    // (no double-write, no skipping, no out-of-order persistence).
    const persisted = listSessionEvents({ repository, session_uuid });
    assert.deepEqual(persisted, historySeen);
    assert.equal(persisted.length, events.length);
  });

  await test('2. same client_request_id is idempotent; mismatched payload is rejected', async () => {
    const session_uuid = '00000000-0000-4000-8000-0000000a0002';
    const { repository, cache } = await sessionFixture({ session_uuid });
    const events = cache.content_payload.events;
    const first = commitOpeningEvent({
      repository,
      session_uuid,
      cache_uuid: cache.cache_uuid,
      event: shown(events[0]),
      client_request_id: 'idemp-1',
      expected_revision: 0,
    });
    // Replaying the EXACT same call must return the exact prior result, not
    // advance revision or append a new event.
    const replay = commitOpeningEvent({
      repository,
      session_uuid,
      cache_uuid: cache.cache_uuid,
      event: shown(events[0]),
      client_request_id: 'idemp-1',
      expected_revision: 0,
    });
    assert.deepEqual(replay, first);
    assert.equal(replay.event.event_id, first.event.event_id);
    assert.equal(getSession({ repository, session_uuid }).revision, 1);
    assert.equal(listSessionEvents({ repository, session_uuid }).length, 1);
    // Reusing the same id with a DIFFERENT event payload must be rejected —
    // protects against the "client retried with mutated text" footgun.
    assert.throws(
      () =>
        commitOpeningEvent({
          repository,
          session_uuid,
          cache_uuid: cache.cache_uuid,
          event: shown(events[1]),
          client_request_id: 'idemp-1',
          expected_revision: 1,
        }),
      /different request/,
    );
    // After the failed replay the history is still a single event.
    assert.equal(listSessionEvents({ repository, session_uuid }).length, 1);
    assert.equal(getSession({ repository, session_uuid }).revision, 1);
  });

  await test('3. player input mid-opening transitions session and orphans pending opening tail', async () => {
    const session_uuid = '00000000-0000-4000-8000-0000000a0003';
    const { repository, cache } = await sessionFixture({ session_uuid });
    const events = cache.content_payload.events;
    // Drain the first two opening events; cursor = 2, two more remain.
    let revision = 0;
    for (let i = 0; i < 2; i += 1) {
      revision = commitOpeningEvent({
        repository,
        session_uuid,
        cache_uuid: cache.cache_uuid,
        event: shown(events[i]),
        expected_revision: revision,
      }).revision;
    }
    assert.equal(getSession({ repository, session_uuid }).state, 'opening');
    // The user types before the cache is fully drained — the session must
    // move to 'realtime' and any further cache commit must be refused.
    const interrupt = interruptWithPlayerInput({
      repository,
      session_uuid,
      text: '先打断，等一下',
      client_request_id: 'interrupt-1',
      expected_revision: revision,
    });
    assert.equal(interrupt.state, 'realtime');
    // ClickUp 08 P1.1 unified cursor semantics: `cursor` is the CANONICAL
    // cursor (2 opening commits + 1 player_input commit = 3) and always
    // equals revision / history.length; the OPENING playback position is
    // the separate `opening_cursor`, which stays frozen at 2 — the
    // un-drained opening tail is abandoned, not silently advanced.
    const afterInterrupt = getSession({ repository, session_uuid });
    assert.equal(afterInterrupt.opening_cursor, 2, 'opening cursor frozen');
    assert.equal(afterInterrupt.cursor, 3, 'canonical cursor = 2 opening + 1 player_input');
    assert.equal(afterInterrupt.revision, 3, 'cursor === revision');
    assert.equal(afterInterrupt.state, 'realtime');
    // The next opening commit must throw — the opening tail is abandoned.
    assert.throws(
      () =>
        commitOpeningEvent({
          repository,
          session_uuid,
          cache_uuid: cache.cache_uuid,
          event: shown(events[2]),
          expected_revision: interrupt.revision,
        }),
      /not in opening/,
    );
    // The cached row itself is untouched (interrupting one session must not
    // invalidate the shared cache).
    assert.equal(repository.findOpeningCacheByUuid(cache.cache_uuid).status, 'valid');
  });

  await test('4. event_seq is unique per session and forms a single linked chain', async () => {
    const session_uuid = '00000000-0000-4000-8000-0000000a0004';
    const { repository, cache } = await sessionFixture({ session_uuid });
    const events = cache.content_payload.events;
    let revision = 0;
    for (let i = 0; i < events.length; i += 1) {
      revision = commitOpeningEvent({
        repository,
        session_uuid,
        cache_uuid: cache.cache_uuid,
        event: shown(events[i]),
        client_request_id: `seq-${i}`,
        expected_revision: revision,
      }).revision;
    }
    const interruptRevision = interruptWithPlayerInput({
      repository,
      session_uuid,
      text: '再补一句',
      expected_revision: revision,
    }).revision;
    const history = listSessionEvents({ repository, session_uuid });
    const seqs = history.map((event) => event.event_seq);
    // Strictly 1..N, no duplicates, no gaps.
    assert.deepEqual(
      seqs,
      history.map((_, idx) => idx + 1),
      'event_seq is 1..N contiguous',
    );
    const uniqueSeqs = new Set(seqs);
    assert.equal(uniqueSeqs.size, seqs.length, 'event_seq is unique across the session');
    // prev_event_seq forms a single linked chain — every prev equals its
    // index in the array.
    for (let i = 0; i < history.length; i += 1) {
      const expectedPrev = i === 0 ? null : history[i - 1].event_seq;
      assert.equal(history[i].prev_event_seq, expectedPrev, `prev_event_seq at ${i}`);
    }
    // The interrupt at the end is event_type=player_input. Under the
    // unified 08/09 semantics source_sequence is a per-(session, source)
    // 0-based contiguous counter: the opening events carry the
    // 'opening_cache' source with their pinned cache sequences, and the
    // FIRST player event starts the 'player' counter at 0.
    const last = history[history.length - 1];
    assert.equal(last.event_type, 'player_input');
    assert.equal(last.event_seq, history.length);
    assert.equal(last.source, 'player');
    assert.equal(last.source_sequence, 0, 'first player_input starts the per-source counter at 0');
    const openingSeqs = history
      .filter((event) => event.source === 'opening_cache')
      .map((event) => event.source_sequence);
    assert.deepEqual(openingSeqs, [0, 1, 2, 3], 'opening events keep their pinned cache sequence');
    assert.match(last.event_id, UUID_PATTERN);
    assert.equal(last.origin, 'user');
    assert.equal(last.source, 'player');
    // Unified cursor semantics: opening_cursor stayed at the fully drained
    // cache count (4); the canonical cursor advanced to 5 (4 opening + 1
    // player_input) and equals revision.
    const after = getSession({ repository, session_uuid });
    assert.equal(after.opening_cursor, 4, 'opening cursor stayed at the drained cache count');
    assert.equal(after.cursor, 5, 'canonical cursor = 4 opening + 1 player_input');
    assert.equal(after.cursor, after.revision, 'cursor === revision');
    assert.equal(interruptRevision, after.revision);
  });

  await test('5. recoverSession rebuilds exact cursor, revision, and history after disconnect', async () => {
    const session_uuid = '00000000-0000-4000-8000-0000000a0005';
    const { repository, cache } = await sessionFixture({ session_uuid });
    const events = cache.content_payload.events;
    let lastResult = null;
    for (let i = 0; i < events.length; i += 1) {
      lastResult = commitOpeningEvent({
        repository,
        session_uuid,
        cache_uuid: cache.cache_uuid,
        event: shown(events[i]),
        client_request_id: `recover-${i}`,
        expected_revision: lastResult ? lastResult.revision : 0,
      });
    }
    interruptWithPlayerInput({
      repository,
      session_uuid,
      text: '断了又连回来',
      client_request_id: 'recover-interrupt',
      expected_revision: lastResult.revision,
    });

    // Snapshot the full session state at the disconnect moment.
    const beforeSnapshot = recoverSession({ repository, session_uuid });
    assert.equal(beforeSnapshot.session_uuid, session_uuid);
    // Unified cursor semantics: cursor === revision === history.length
    // (4 opening commits + 1 interrupt commit = 5); opening_cursor is
    // rebuilt at the drained cache count (4).
    assert.equal(beforeSnapshot.cursor, beforeSnapshot.revision, 'cursor === revision === history.length');
    assert.equal(beforeSnapshot.cursor, lastResult.cursor + 1, '+1 for the interrupt');
    assert.equal(beforeSnapshot.opening_cursor, lastResult.opening_cursor, 'opening cursor rebuilt');
    assert.equal(beforeSnapshot.revision, lastResult.revision + 1); // +1 for the interrupt
    assert.equal(beforeSnapshot.history.length, events.length + 1);
    assert.equal(beforeSnapshot.history[beforeSnapshot.history.length - 1].event_type, 'player_input');

    // "Reconnect": read again and confirm projection is byte-identical.
    const afterSnapshot = recoverSession({ repository, session_uuid });
    assert.deepEqual(afterSnapshot, beforeSnapshot, 'recovery is idempotent across reads');
    assert.deepEqual(afterSnapshot.history, listSessionEvents({ repository, session_uuid }));
    // Generation profile pinned at createSession is intact.
    assert.equal(afterSnapshot.cache_uuid, cache.cache_uuid);
    assert.equal(afterSnapshot.story_version_uuid, CAFE_RAIN_FIXTURE.story_version_uuid);
    assert.equal(afterSnapshot.role_id, 'stranger');
    // After the interrupt the public cache row is still valid for other
    // sessions — recovery never pollutes cross-session state.
    assert.equal(repository.findOpeningCacheByUuid(cache.cache_uuid).status, 'valid');
  });

  await test('6. client_request_id uniqueness is a bounded per-process window (B3 downgrade)', async () => {
    // B3 follow-up (PR #7 ChatGPT 2026-09-05 re-review): the in-memory
    // demo no longer mirrors the SQL GLOBAL UNIQUE constraint on
    // session_events.client_request_id. Once the previous owning
    // session is evicted, a fresh session MAY reuse the id. Within the
    // window, the same-session replay rules still apply:
    //   * same id + same payload → idempotent replay;
    //   * same id + different payload → fail closed.
    // The cross-session case is now ACCEPTED so this test pins the new
    // contract; the SQL UNIQUE constraint is owned by the production DAO,
    // not by the in-memory demo. See the comment on
    // `MAX_TRACKED_CLIENT_REQUEST_IDS` in sessionService.mjs and the
    // dedicated `chatgptReviewFixes.test.mjs` regression tests.
    const sessionA = '00000000-0000-4000-8000-0000000a0006';
    const sessionB = '00000000-0000-4000-8000-0000000a0007';
    const { repository, cache, profile } = await sessionFixture({ session_uuid: sessionA });
    // Second session on the SAME repository (same "database").
    createSession({
      repository,
      session_uuid: sessionB,
      story_uuid: CAFE_RAIN_FIXTURE.story_uuid,
      story_version_uuid: CAFE_RAIN_FIXTURE.story_version_uuid,
      user_ref: 'u-tx-b',
      role_id: 'stranger',
      model: 'gpt-tx',
      prompt: 'fixed prompt',
      generation_profile: profile,
    });
    const events = cache.content_payload.events;
    const first = commitOpeningEvent({
      repository,
      session_uuid: sessionA,
      cache_uuid: cache.cache_uuid,
      event: shown(events[0]),
      client_request_id: 'tx-shared-open-1',
      expected_revision: 0,
    });
    // Same session + same payload: still a plain idempotent replay (no new
    // event, no uniqueness violation).
    const replay = commitOpeningEvent({
      repository,
      session_uuid: sessionA,
      cache_uuid: cache.cache_uuid,
      event: shown(events[0]),
      client_request_id: 'tx-shared-open-1',
      expected_revision: 0,
    });
    assert.deepEqual(replay, first);
    // A DIFFERENT session reusing the id while sessionA is still in the
    // window is now ACCEPTED under the B3 downgrade — the in-memory
    // demo treats `clientRequestIndex` as a bounded sliding window, not
    // a mirror of the SQL UNIQUE constraint. Session A still owns one
    // canonical event; session B commits a fresh event under the same
    // id.
    const reused = commitOpeningEvent({
      repository,
      session_uuid: sessionB,
      cache_uuid: cache.cache_uuid,
      event: shown(events[0]),
      client_request_id: 'tx-shared-open-1',
      expected_revision: 0,
    });
    assert.equal(reused.session_uuid, sessionB);
    assert.equal(reused.event.client_request_id, 'tx-shared-open-1');
    // Each session has its own event_seq counter, so both will be 1 —
    // the differentiator is event_id (server-generated UUID per event).
    assert.notEqual(reused.event.event_id, first.event.event_id);
    // Both sessions still have their own event chains.
    assert.equal(listSessionEvents({ repository, session_uuid: sessionA }).length, 1);
    assert.equal(listSessionEvents({ repository, session_uuid: sessionB }).length, 1);
  });

  await test('7. final-commit retry with the same client_request_id replays the prior result (response-lost regression)', async () => {
    // Regression lock for the ClickUp 08 P1.5 final-commit idempotency: the
    // last commit clears session.pending; a retry of that same commit
    // (client never got the response) must return the ORIGINAL result
    // instead of failing the pending_id check with a 400.
    const session_uuid = '00000000-0000-4000-8000-0000000a0008';
    const { repository } = await sessionFixture({ session_uuid });
    const staged = stageNarrativeBatch({
      repository,
      session_uuid,
      items: [{ type: 'narration', text: '唯一的剧情句' }],
      client_request_id: 'tx-stage-final',
      expected_revision: 0,
    });
    const commit = commitNarrativeEvent({
      repository,
      session_uuid,
      pending_id: staged.pending_id,
      sequence: 0,
      expected_revision: 0,
      client_request_id: 'tx-final-commit',
    });
    assert.equal(commit.pending_remaining, 0);
    assert.equal(commit.pending_tool_call, null);
    // Retry AFTER the pending was cleared: same client_request_id, same
    // payload → replay the prior result verbatim.
    const retry = commitNarrativeEvent({
      repository,
      session_uuid,
      pending_id: staged.pending_id,
      sequence: 0,
      expected_revision: 0,
      client_request_id: 'tx-final-commit',
    });
    assert.deepEqual(retry, commit);
    assert.equal(retry.event.event_id, commit.event.event_id);
    // No duplicate append.
    assert.equal(listSessionEvents({ repository, session_uuid }).length, 1);
    assert.equal(getSession({ repository, session_uuid }).revision, 1);
    // Same id with a different payload still fails closed.
    assert.throws(
      () =>
        commitNarrativeEvent({
          repository,
          session_uuid,
          pending_id: staged.pending_id,
          sequence: 1,
          expected_revision: 1,
          client_request_id: 'tx-final-commit',
        }),
      /different request/,
    );
    assert.equal(listSessionEvents({ repository, session_uuid }).length, 1);
  });
}

run()
  .then(() => {
    if (casesFailed > 0) {
      console.error(`\n${casesFailed}/${casesRun} dbTransactions case(s) failed`);
      process.exit(1);
    }
    console.log(`\nall ${casesRun} dbTransactions case(s) passed`);
  })
  .catch((err) => {
    console.error(`\nunexpected error: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });