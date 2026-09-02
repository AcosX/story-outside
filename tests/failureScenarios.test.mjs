// tests/failureScenarios.test.mjs — 15 fault scenarios from the task spec.
//
// Every scenario is asserted against a deterministic invariant so the
// suite stays stable across Node versions. The cases are intentionally
// agent-only here — provider-only failure shapes (5xx/429/timeout/empty)
// are covered by tests/providerAdapter.test.mjs. This file's remit is the
// UX/worldline surface: the player should never see a broken UI even
// when the model or the DB misbehaves.
//
// Mapping to the spec:
//   1.  Agent timeout                 → see case #1
//   2.  Agent returns 500             → see case #2
//   3.  Agent returns invalid schema  → see case #3
//   4.  Tool schema illegal           → see case #4
//   5.  Mock API 429                  → see case #5
//   6.  Mock API 500                  → see case #6
//   7.  Mock API timeout              → see case #7
//   8.  Mock API empty body           → see case #8
//   9.  Rapid double-click advance    → see case #9
//   10. Autoplay + focus interrupt    → see case #10
//   11. Player input while opening tail pending → see case #11
//   12. Commit, disconnect, retry     → see case #12
//   13. Compact + service restart     → see case #13 (documented limitation)
//   14. Compact + model failure       → see case #14 (documented limitation)
//   15. Player interrupt before finish_story commit → see case #15
//
// Cases #13 and #14 reference the ClickUp 10 compact seam (tokenEstimator +
// contextBuilder + recordCompact / recordCompactFailure / getSessionCompact /
// rebuildCompactFromHistory on sessionService). That seam is now MERGED, so
// both cases assert the real surface positively — see §4 of
// docs/testing-strategy.md.

import assert from 'node:assert/strict';

import { createSeededRepository } from '../src/stories/fixture.mjs';
import { ensureOpeningCache } from '../src/stories/storyService.mjs';
import {
  commitOpeningEvent,
  createSession,
  getSession,
  interruptWithPlayerInput,
  listSessionEvents,
  recoverSession,
} from '../src/stories/sessionService.mjs';
import {
  AgentRuntimeError,
  createAgentRuntime,
  createMockAgentProvider,
  recoverRuntime,
  runTurn,
} from '../src/agent/runtime.mjs';
import {
  recordCompact,
  recordCompactFailure,
  rebuildCompactFromHistory,
} from '../src/stories/sessionService.mjs';

import { CAFE_RAIN_FIXTURE } from './fixtures/seed-stories/cafe-rain.mjs';

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

async function runtimeFixture({ responses, handler, failure, session_uuid: session_uuid_override } = {}) {
  const { repository } = createSeededRepository();
  const { cache } = await ensureOpeningCache({
    repository,
    story_version_uuid: CAFE_RAIN_FIXTURE.story_version_uuid,
  });
  const session_uuid = session_uuid_override || '00000000-0000-4000-8000-0000000c0001';
  createSession({
    repository,
    session_uuid,
    story_uuid: CAFE_RAIN_FIXTURE.story_uuid,
    story_version_uuid: CAFE_RAIN_FIXTURE.story_version_uuid,
    user_ref: 'u-failure',
    role_id: 'stranger',
    model: 'gpt-failure',
    prompt: 'fixed prompt',
    generation_profile: {
      identifier: cache.generation_profile.identifier,
      rules_version: cache.generation_profile.rules_version,
      cache_uuid: cache.cache_uuid,
      generation_hash: cache.generation_hash,
    },
  });
  const provider =
    handler || failure
      ? createMockAgentProvider({ handler, failure })
      : createMockAgentProvider({ responses: responses || [] });
  const version = repository.findVersion(CAFE_RAIN_FIXTURE.story_version_uuid);
  const runtime = createAgentRuntime({
    repository,
    session_uuid,
    provider,
    system_prompt: { kind: 'system', text: 'sys' },
    tool_definitions: [
      { name: 'ask_player_choice' },
      { name: 'finish_story' },
    ],
    expected_story_version_uuid: version.version_uuid,
    expected_story_version_checksum: version.checksum,
    expected_model: 'gpt-failure',
    expected_generation_profile: {
      identifier: cache.generation_profile.identifier,
      rules_version: cache.generation_profile.rules_version,
      cache_uuid: cache.cache_uuid,
      generation_hash: cache.generation_hash,
    },
  });
  return { runtime, repository, cache, session_uuid, provider };
}

function shown(event) {
  return { ...event, displayed: true };
}

async function run() {
  console.log('Failure / fault scenario suite');

  // -- 1. Agent timeout -----------------------------------------------------
  await test('1. Agent provider times out → provider_failure; turn not committed', async () => {
    const { runtime } = await runtimeFixture({
      failure: new Error('caller deadline (timeout)'),
    });
    const before = recoverRuntime(runtime);
    await assert.rejects(
      () => runTurn(runtime, { input: { msg: 'go' }, expected_revision: before.base_revision }),
      (err) => err instanceof AgentRuntimeError && err.code === 'provider_failure',
    );
    const after = recoverRuntime(runtime);
    assert.equal(after.base_revision, before.base_revision, 'revision unchanged on failure');
    assert.equal(after.successful_turns.length, 0, 'no successful turn recorded');
    assert.equal(after.staged, null, 'no pending tool left behind');
  });

  // -- 2. Agent returns 500 --------------------------------------------------
  await test('2. Agent provider returns 500-shaped error → provider_failure', async () => {
    const { runtime } = await runtimeFixture({
      failure: new Error('upstream 500 Internal Server Error'),
    });
    await assert.rejects(
      () => runTurn(runtime, { input: { a: 1 }, expected_revision: recoverRuntime(runtime).base_revision }),
      (err) => err instanceof AgentRuntimeError && err.code === 'provider_failure',
    );
    assert.equal(recoverRuntime(runtime).successful_turns.length, 0);
  });

  // -- 3. Agent returns invalid structured output --------------------------
  await test('3. Agent returns invalid structured output → invalid_tool_call', async () => {
    const { runtime } = await runtimeFixture({
      // ClickUp 08: the tool call rides on a 1..4 narrative-item batch, so
      // we attach one narrative message; TWO tool_calls on the same batch
      // then hit the "exactly one tool call" rule → invalid_tool_call.
      responses: [
        {
          messages: [{ role: 'assistant', content: '她说她以前来过这家店。' }],
          tool_calls: [
            { name: 'ask_player_choice', arguments: { question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } },
            { name: 'finish_story', arguments: { summary: 's', ending: 'e', original_difference: 'd', key_choices: ['k'], character_outcomes: [{ character: 'A', fate: 'B' }] } },
          ],
        },
      ],
    });
    await assert.rejects(
      () => runTurn(runtime, { input: { a: 1 }, expected_revision: recoverRuntime(runtime).base_revision }),
      (err) => err instanceof AgentRuntimeError && err.code === 'invalid_tool_call',
    );
    assert.equal(recoverRuntime(runtime).successful_turns.length, 0);
  });

  // -- 4. Tool schema illegal (agent returns unknown field) ---------------
  await test('4. Tool schema illegal: agent returns unknown field on ask_player_choice', async () => {
    const { runtime } = await runtimeFixture({
      // ClickUp 08: the tool rides on a narrative batch so the tool schema
      // validation (not the tool-only-batch guard) is what fires here.
      responses: [
        {
          messages: [{ role: 'assistant', content: '她把糖罐推了过来。' }],
          tool_calls: [
            {
              name: 'ask_player_choice',
              arguments: {
                question: 'q',
                options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
                hacked_field: 'leak',
              },
            },
          ],
        },
      ],
    });
    await assert.rejects(
      () => runTurn(runtime, { input: { a: 1 }, expected_revision: recoverRuntime(runtime).base_revision }),
      (err) => err instanceof AgentRuntimeError && err.code === 'invalid_tool_call',
    );
    assert.equal(recoverRuntime(runtime).successful_turns.length, 0);
  });

  // -- 5. Mock API 429 ------------------------------------------------------
  await test('5. Mock API 429 → provider_failure; same channel as 500', async () => {
    const { runtime } = await runtimeFixture({
      failure: new Error('429 Too Many Requests'),
    });
    await assert.rejects(
      () => runTurn(runtime, { input: { a: 1 }, expected_revision: recoverRuntime(runtime).base_revision }),
      (err) => err instanceof AgentRuntimeError && err.code === 'provider_failure',
    );
    assert.equal(recoverRuntime(runtime).successful_turns.length, 0);
  });

  // -- 6. Mock API 500 ------------------------------------------------------
  await test('6. Mock API 500 → provider_failure; canonical history untouched', async () => {
    const { runtime, repository, session_uuid } = await runtimeFixture({
      failure: new Error('mock upstream 500'),
    });
    await assert.rejects(
      () => runTurn(runtime, { input: { a: 1 }, expected_revision: recoverRuntime(runtime).base_revision }),
      (err) => err instanceof AgentRuntimeError && err.code === 'provider_failure',
    );
    assert.equal(listSessionEvents({ repository, session_uuid }).length, 0, 'no canonical event appended');
    assert.equal(getSession({ repository, session_uuid }).revision, 0);
  });

  // -- 7. Mock API timeout --------------------------------------------------
  await test('7. Mock API timeout (provider hangs and rejects) → provider_failure', async () => {
    const { runtime } = await runtimeFixture({
      handler: async () => {
        // Simulate a fetch that the harness aborted: throw an Error with
        // a timeout-flavoured name; the runtime sees only the throw.
        throw Object.assign(new Error('caller aborted'), { name: 'AbortError' });
      },
    });
    await assert.rejects(
      () => runTurn(runtime, { input: { a: 1 }, expected_revision: recoverRuntime(runtime).base_revision }),
      (err) => err instanceof AgentRuntimeError && err.code === 'provider_failure',
    );
    assert.equal(recoverRuntime(runtime).successful_turns.length, 0);
  });

  // -- 8. Mock API empty body ----------------------------------------------
  await test('8. Mock API returns {} (no messages, no tool_calls) → provider_failure', async () => {
    const { runtime } = await runtimeFixture({
      responses: [{}],
    });
    await assert.rejects(
      () => runTurn(runtime, { input: { a: 1 }, expected_revision: recoverRuntime(runtime).base_revision }),
      (err) => err instanceof AgentRuntimeError && err.code === 'provider_failure',
    );
    assert.equal(recoverRuntime(runtime).successful_turns.length, 0);
  });

  // -- 9. Rapid double-click advance (session commit) -----------------------
  await test('9. Rapid double-click on commit: same client_request_id → idempotent; diff id → unique event_seq', async () => {
    const session_uuid = '00000000-0000-4000-8000-0000000c0009';
    const { repository, cache } = await runtimeFixture({ session_uuid });
    const events = cache.content_payload.events;
    // Double-click scenario 1: both clicks use the SAME request id. The
    // second commit must be a no-op (idempotent replay).
    const firstClick = commitOpeningEvent({
      repository,
      session_uuid,
      cache_uuid: cache.cache_uuid,
      event: shown(events[0]),
      client_request_id: 'rapid-double-1',
      expected_revision: 0,
    });
    const secondClick = commitOpeningEvent({
      repository,
      session_uuid,
      cache_uuid: cache.cache_uuid,
      event: shown(events[0]),
      client_request_id: 'rapid-double-1',
      expected_revision: 0,
    });
    assert.deepEqual(secondClick, firstClick, 'second click is byte-identical to the first');
    assert.equal(getSession({ repository, session_uuid }).revision, 1);
    assert.equal(listSessionEvents({ repository, session_uuid }).length, 1);
    // Double-click scenario 2: clicks use DIFFERENT request ids. Both
    // commits succeed but the second is rejected by revision_mismatch
    // because the first already advanced the cursor. The session never
    // silently doubles the event.
    const third = commitOpeningEvent({
      repository,
      session_uuid,
      cache_uuid: cache.cache_uuid,
      event: shown(events[1]),
      client_request_id: 'rapid-double-2',
      expected_revision: 1,
    });
    assert.equal(third.event.event_seq, 2);
    assert.throws(
      () =>
        commitOpeningEvent({
          repository,
          session_uuid,
          cache_uuid: cache.cache_uuid,
          event: shown(events[1]),
          client_request_id: 'rapid-double-3',
          expected_revision: 1, // stale revision
        }),
      /revision mismatch/,
    );
    assert.equal(listSessionEvents({ repository, session_uuid }).length, 2);
  });

  // -- 10. Autoplay + focus interrupt --------------------------------------
  await test('10. Autoplay queue + focus interrupt: input commits into a fresh revision; cursor preserved', async () => {
    const session_uuid = '00000000-0000-4000-8000-0000000ca010';
    const { repository, cache } = await runtimeFixture({ session_uuid });
    const events = cache.content_payload.events;
    // Simulate autoplay draining the first two cache events.
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
    // Player focuses the input box and types — interrupt fires while the
    // autoplay queue still has 2 events left. The session must transition
    // to 'realtime' and any further autoplay commit must be refused.
    const interrupt = interruptWithPlayerInput({
      repository,
      session_uuid,
      text: '暂停，我要打字',
      client_request_id: 'focus-interrupt-1',
      expected_revision: revision,
    });
    assert.equal(interrupt.state, 'realtime');
    // Unified cursor semantics: the canonical cursor advanced to 3
    // (2 opening + 1 player_input, cursor === revision) while the OPENING
    // playback position stays frozen at 2 — the autoplay tail is orphaned.
    const afterInterrupt = getSession({ repository, session_uuid });
    assert.equal(afterInterrupt.opening_cursor, 2, 'opening cursor frozen');
    assert.equal(afterInterrupt.cursor, 3, 'canonical cursor = 2 opening + 1 player_input');
    assert.equal(afterInterrupt.cursor, afterInterrupt.revision, 'cursor === revision');
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
  });

  // -- 11. Player input while opening tail pending -------------------------
  await test('11. Player input while opening tail pending: cursor frozen, history appends player_input event', async () => {
    const session_uuid = '00000000-0000-4000-8000-0000000cb011';
    const { repository, cache } = await runtimeFixture({ session_uuid });
    const events = cache.content_payload.events;
    let revision = 0;
    for (let i = 0; i < 1; i += 1) {
      revision = commitOpeningEvent({
        repository,
        session_uuid,
        cache_uuid: cache.cache_uuid,
        event: shown(events[i]),
        expected_revision: revision,
      }).revision;
    }
    const historyBefore = listSessionEvents({ repository, session_uuid });
    const interrupt = interruptWithPlayerInput({
      repository,
      session_uuid,
      text: '我先说',
      expected_revision: revision,
    });
    const historyAfter = listSessionEvents({ repository, session_uuid });
    assert.equal(historyAfter.length, historyBefore.length + 1);
    assert.equal(historyAfter[historyAfter.length - 1].event_type, 'player_input');
    assert.equal(historyAfter[historyAfter.length - 1].source, 'player');
    assert.equal(historyAfter[historyAfter.length - 1].source_sequence, 0, 'first player event starts the per-source counter');
    // The OPENING cursor did NOT advance (the pending opening tail is
    // orphaned); the CANONICAL cursor advanced by exactly the one
    // player_input commit (cursor === revision === history.length).
    const after = getSession({ repository, session_uuid });
    assert.equal(after.opening_cursor, 1, 'opening cursor frozen at the played position');
    assert.equal(after.cursor, 2, 'canonical cursor = 1 opening + 1 player_input');
    assert.equal(after.cursor, after.revision, 'cursor === revision');
    // The original cache row stays valid for other sessions.
    assert.equal(repository.findOpeningCacheByUuid(cache.cache_uuid).status, 'valid');
    assert.equal(interrupt.cursor, 2);
    assert.equal(interrupt.opening_cursor, 1);
  });

  // -- 12. Commit then disconnect, then retry -------------------------------
  await test('12. Commit → disconnect → reconnect: replay with same id is idempotent', async () => {
    const session_uuid = '00000000-0000-4000-8000-0000000cc012';
    const { repository, cache } = await runtimeFixture({ session_uuid });
    const events = cache.content_payload.events;
    // Client commits two opening events, then the network drops mid-flight.
    let revision = 0;
    const client_request_ids = [];
    for (let i = 0; i < 2; i += 1) {
      const request_id = `commit-disconnect-${i}`;
      client_request_ids.push(request_id);
      revision = commitOpeningEvent({
        repository,
        session_uuid,
        cache_uuid: cache.cache_uuid,
        event: shown(events[i]),
        client_request_id: request_id,
        expected_revision: i,
      }).revision;
    }
    // "Disconnect" — server is fine, but the client lost the ack.
    // "Reconnect": client replays its commits. Each replay must return
    // the exact prior result, not duplicate the event.
    for (let i = 0; i < 2; i += 1) {
      const replayed = commitOpeningEvent({
        repository,
        session_uuid,
        cache_uuid: cache.cache_uuid,
        event: shown(events[i]),
        client_request_id: client_request_ids[i],
        expected_revision: i,
      });
      assert.equal(replayed.event.event_seq, i + 1);
    }
    // History still has exactly 2 events — no duplicates.
    const recovered = recoverSession({ repository, session_uuid });
    assert.equal(recovered.history.length, 2);
    assert.equal(recovered.cursor, 2);
    assert.equal(recovered.revision, 2);
  });

  // -- 13. Compact + service restart (ClickUp 10 seam, merged) -------------
  await test('13. Compact trigger during service restart: rebuild from canonical history alone', async () => {
    // The compact seam IS merged now: recordCompact / recordCompactFailure /
    // getSessionCompact / rebuildCompactFromHistory live on
    // src/stories/sessionService.mjs (the index.mjs re-export surface stays
    // the 08/09 session + pendingLifecycle facade). Positive assertions:
    //   * the compact functions exist on the canonical store;
    //   * compacting never appends to or rewrites canonical history;
    //   * the service-restart seam holds — canonical history is the only
    //     source of truth, so a fresh process can regenerate an equivalent
    //     compact snapshot via rebuildCompactFromHistory (in-process
    //     boundary; the in-memory repository does not survive a real
    //     process exit — see docs/testing-strategy.md §6).
    const sessionService = await import('../src/stories/sessionService.mjs');
    for (const name of ['recordCompact', 'recordCompactFailure', 'getSessionCompact', 'rebuildCompactFromHistory']) {
      assert.equal(typeof sessionService[name], 'function', `sessionService exports ${name}`);
    }
    const stories = await import('../src/stories/index.mjs');
    for (const name of [
      'commitNarrativeEvent', 'commitOpeningEvent', 'createSession', 'discardPendingTail',
      'getSession', 'interruptWithPlayerInput', 'listSessionEvents', 'lookupTurnRequest',
      'recoverSession', 'registerTurnRequest',
      'commitDisplayedEvent', 'dropPendingAfterLegacyInterrupt', 'interruptWithPlayerInputFromPending',
      'listPendingSessionUuids', 'recoverPendingSession', 'stageNarrativeBatch',
    ]) {
      assert.equal(typeof stories[name], 'function', `index.mjs re-exports ${name}`);
    }
    const session_uuid = '00000000-0000-4000-8000-0000000cd013';
    const { repository, cache } = await runtimeFixture({ session_uuid });
    const events = cache.content_payload.events;
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
    // Compact the first two canonical events (pre-restart state).
    const folded = [1, 2];
    const compacted = recordCompact({
      repository,
      session_uuid,
      summary_text: '雨夜咖啡馆开场：她把杯子推向你。',
      summary_payload: { folded_event_seqs: folded },
      through_seq: 2,
      folded_event_seqs: folded,
      token_estimate: 24,
      context_window: 4096,
      safety_ratio: 0.5,
      reserved_completion_tokens: 512,
      schema_version: 1,
      prompt_version: 1,
    });
    assert.equal(compacted.compacted_through_seq, 2);
    assert.equal(compacted.last_compact_status, 'compacted');
    // Compacting never touches canonical history.
    assert.equal(listSessionEvents({ repository, session_uuid }).length, 2, 'compact is read-only against canonical history');
    assert.equal(repository.findOpeningCacheByUuid(cache.cache_uuid).status, 'valid', 'shared cache survives compaction');
    // "Restart": a fresh repository models a fresh process — the in-memory
    // compact state is gone, but the canonical events re-derive to the same
    // chain (deterministic seed = the persisted store). rebuildCompactFrom
    // History must regenerate an EQUIVALENT snapshot from that history alone.
    const restarted = await runtimeFixture({ session_uuid });
    for (let i = 0; i < 2; i += 1) {
      commitOpeningEvent({
        repository: restarted.repository,
        session_uuid,
        cache_uuid: restarted.cache.cache_uuid,
        event: shown(restarted.cache.content_payload.events[i]),
        expected_revision: i,
      });
    }
    assert.equal(restarted.repository.findOpeningCacheByUuid(restarted.cache.cache_uuid).status, 'valid');
    const rebuilt = rebuildCompactFromHistory({
      repository: restarted.repository,
      session_uuid,
      kept_recent: 0,
      builder: (eligible) => ({
        summary_text: `重放 ${eligible.length} 条已折叠开场事件`,
        summary_payload: { folded_event_seqs: eligible.map((event) => event.event_seq) },
        folded_event_seqs: eligible.map((event) => event.event_seq),
      }),
      estimator_snapshot: {
        token_estimate: 24,
        context_window: 4096,
        safety_ratio: 0.5,
        reserved_completion_tokens: 512,
        schema_version: 1,
        prompt_version: 1,
      },
    });
    assert.equal(rebuilt.last_compact_status, 'compacted');
    // The rebuilt snapshot is equivalent to the pre-restart one.
    assert.equal(rebuilt.compacted_through_seq, compacted.compacted_through_seq);
    assert.equal(rebuilt.compacted_event_count, compacted.compacted_event_count);
    assert.deepEqual(rebuilt.context_compact_payload, compacted.context_compact_payload, 'rebuild regenerates the pre-restart folded window');
    assert.equal(rebuilt.token_estimate, compacted.token_estimate);
    // The rebuild is read-only against canonical history.
    assert.equal(listSessionEvents({ repository: restarted.repository, session_uuid }).length, 2, 'rebuild is read-only against canonical history');
  });

  // -- 14. Compact + model failure (ClickUp 10 seam, merged) ---------------
  await test('14. Compact trigger during model failure: recordCompactFailure marker; retry not polluted', async () => {
    // With the seam merged, the case asserts the recordCompactFailure
    // contract positively:
    //   * a failed compact writes a session-local failure marker;
    //   * the marker does NOT advance compacted_through_seq (the previous
    //     compact snapshot remains usable);
    //   * the marker is session-local — it never invalidates the shared
    //     story/version opening cache;
    //   * a later retry (higher through_seq) succeeds and clears the
    //     failure status.
    const session_uuid = '00000000-0000-4000-8000-0000000cd014';
    const { repository, cache } = await runtimeFixture({ session_uuid });
    const events = cache.content_payload.events;
    let revision = commitOpeningEvent({
      repository,
      session_uuid,
      cache_uuid: cache.cache_uuid,
      event: shown(events[0]),
      expected_revision: 0,
    }).revision;
    // A first successful compact sets the baseline.
    const first = recordCompact({
      repository,
      session_uuid,
      summary_text: '第一条开场事件已折叠。',
      summary_payload: { folded_event_seqs: [1] },
      through_seq: 1,
      folded_event_seqs: [1],
      token_estimate: 12,
      context_window: 4096,
      safety_ratio: 0.5,
      reserved_completion_tokens: 512,
      schema_version: 1,
      prompt_version: 1,
    });
    assert.equal(first.compacted_through_seq, 1);
    // The model call fails while a new compact is being triggered →
    // recordCompactFailure writes the failed marker.
    const afterFailure = recordCompactFailure({
      repository,
      session_uuid,
      error_code: 'provider_failure',
      error_message: 'model call failed during compact',
    });
    assert.equal(afterFailure.last_compact_status, 'failed');
    assert.equal(afterFailure.last_compact_error, 'model call failed during compact');
    assert.equal(afterFailure.compacted_through_seq, 1, 'failure does not advance the compact cursor');
    assert.equal(afterFailure.context_compact_text, '第一条开场事件已折叠。', 'previous compact snapshot remains intact');
    // The failure marker is session-local: the shared cache stays valid.
    assert.equal(repository.findOpeningCacheByUuid(cache.cache_uuid).status, 'valid');
    // A later retry (one more canonical event folded) is not polluted.
    revision = commitOpeningEvent({
      repository,
      session_uuid,
      cache_uuid: cache.cache_uuid,
      event: shown(events[1]),
      expected_revision: revision,
    }).revision;
    const retried = recordCompact({
      repository,
      session_uuid,
      summary_text: '前两条开场事件已折叠。',
      summary_payload: { folded_event_seqs: [1, 2] },
      through_seq: 2,
      folded_event_seqs: [1, 2],
      token_estimate: 24,
      context_window: 4096,
      safety_ratio: 0.5,
      reserved_completion_tokens: 512,
      schema_version: 1,
      prompt_version: 1,
    });
    assert.equal(retried.last_compact_status, 'compacted', 'retry clears the failure marker');
    assert.equal(retried.last_compact_error, null);
    assert.equal(retried.compacted_through_seq, 2);
  });

  // -- 15. Player interrupt before finish_story commit ---------------------
  await test('15. Player interrupt before finish_story commit: agent sees revision_mismatch and aborts', async () => {
    const { runtime, repository, session_uuid } = await runtimeFixture({
      // Provider returns finish_story; the agent is happy.
      responses: [
        {
          tool_calls: [
            {
              name: 'finish_story',
              arguments: {
                summary: 's',
                ending: 'e',
                original_difference: 'd',
                key_choices: ['k'],
                character_outcomes: [{ character: 'A', fate: 'B' }],
              },
            },
          ],
        },
      ],
    });
    const before = recoverRuntime(runtime);
    // The player taps "type a reply" between the agent's response arriving
    // and the route committing finish_story. The interrupt bumps the
    // session revision, so the runtime's next turn (which the route will
    // attempt with the OLD expected_revision) fails closed.
    interruptWithPlayerInput({
      repository,
      session_uuid,
      text: '等等',
      expected_revision: before.base_revision,
    });
    await assert.rejects(
      () =>
        runTurn(runtime, {
          input: { replay: 'finish_story' },
          expected_revision: before.base_revision,
        }),
      (err) => err instanceof AgentRuntimeError && err.code === 'revision_mismatch',
    );
    // The agent never saw the new revision, so it did not record a turn.
    assert.equal(recoverRuntime(runtime).successful_turns.length, 0);
    // The session is in 'realtime' after the interrupt, not in a finished
    // state — finish_story has NOT been committed.
    assert.equal(getSession({ repository, session_uuid }).state, 'realtime');
  });
}

run()
  .then(() => {
    if (casesFailed > 0) {
      console.error(`\n${casesFailed}/${casesRun} failureScenarios case(s) failed`);
      process.exit(1);
    }
    console.log(`\nall ${casesRun} failureScenarios case(s) passed`);
  })
  .catch((err) => {
    console.error(`\nunexpected error: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });