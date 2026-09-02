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
  defaultGenerationProfile,
  ensureOpeningCache,
} from '../src/stories/storyService.mjs';
import {
  commitOpeningEvent,
  createSession,
  getSession,
  interruptWithPlayerInput,
  listSessionEvents,
  recoverSession,
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
    assert.equal(getSession({ repository, session_uuid }).cursor, 2, 'opening cursor frozen');
    assert.equal(getSession({ repository, session_uuid }).state, 'realtime');
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
    // The interrupt at the end is event_type=player_input and its
    // source_sequence continues the canonical numbering.
    const last = history[history.length - 1];
    assert.equal(last.event_type, 'player_input');
    assert.equal(last.event_seq, history.length);
    assert.equal(last.source_sequence, history.length);
    assert.match(last.event_id, UUID_PATTERN);
    assert.equal(last.origin, 'user');
    assert.equal(last.source, 'player');
    // Cursor remained 4 (opening fully drained) before interrupt.
    assert.equal(getSession({ repository, session_uuid }).cursor, 4);
    assert.equal(interruptRevision, getSession({ repository, session_uuid }).revision);
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
    assert.equal(beforeSnapshot.cursor, lastResult.cursor);
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

// Re-export the default profile helper for any suite that wants to
// import via this file rather than reach into storyService directly.
export { defaultGenerationProfile };