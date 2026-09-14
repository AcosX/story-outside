// tests/agentRegression.test.mjs — agent regression suite.
//
// Goal: catch regressions in the agent runtime + tool envelope contract
// when prompts, models, or fixture data change. We do NOT compare the
// prose the model produces — we assert STRUCTURE:
//   * tool kind (choice_required / story_finished)
//   * tool_call_id presence and uniqueness
//   * canonical-history untouched by agent turns
//   * revision_mismatch on stale requests
//   * recovery snapshot is byte-identical across reads
//   * the same fixture produces the same envelope on the same provider
//
// This suite is the canary the prompt team reads when iterating: if any
// case here turns red, the agent contract changed shape and the route
// layer needs to follow.

import assert from 'node:assert/strict';

import { createSeededRepository } from '../src/stories/fixture.mjs';
import { ensureOpeningCache } from '../src/stories/storyService.mjs';
import {
  commitOpeningEvent,
  createSession,
  discardPendingTail,
  interruptWithPlayerInput,
  listSessionEvents,
} from '../src/stories/sessionService.mjs';
import { TOOL_DEFINITIONS } from '../src/agent/tools.mjs';
import {
  AgentRuntimeError,
  createAgentRuntime,
  createMockAgentProvider,
  recoverRuntime,
  runTurn,
} from '../src/agent/runtime.mjs';

import {
  CAFE_RAIN_FIXTURE,
  CAFE_RAIN_OPENING_EVENT_COUNT,
  resolveChecksum,
} from './fixtures/seed-stories/cafe-rain.mjs';

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

function shown(event) {
  return { ...event, displayed: true };
}

async function pinnedRuntimeFixture({ responses, handler, failure, session_uuid: session_uuid_override } = {}) {
  const { repository } = createSeededRepository();
  const { cache } = await ensureOpeningCache({
    repository,
    story_version_uuid: CAFE_RAIN_FIXTURE.story_version_uuid,
  });
  const session_uuid = session_uuid_override || '00000000-0000-4000-8000-0000000e0001';
  createSession({
    repository,
    session_uuid,
    story_uuid: CAFE_RAIN_FIXTURE.story_uuid,
    story_version_uuid: CAFE_RAIN_FIXTURE.story_version_uuid,
    user_ref: 'u-regression',
    role_id: 'stranger',
    model: 'gpt-regression',
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
    tool_definitions: TOOL_DEFINITIONS,
    expected_story_version_uuid: version.version_uuid,
    expected_story_version_checksum: version.checksum,
    expected_model: 'gpt-regression',
    expected_generation_profile: {
      identifier: cache.generation_profile.identifier,
      rules_version: cache.generation_profile.rules_version,
      cache_uuid: cache.cache_uuid,
      generation_hash: cache.generation_hash,
    },
  });
  return { runtime, repository, cache, session_uuid, version, provider };
}

async function run() {
  console.log('Agent regression suite');

  await test('R1. pinned fixture + canned tool call: envelope is structurally stable across reads', async () => {
    const { runtime, repository, session_uuid } = await pinnedRuntimeFixture({
      responses: [
        {
          // Story 08 unified contract: the tool call rides as the OPTIONAL
          // FINAL item on a 1..4 narrative-item batch (tool-only batches are
          // rejected by the runtime).
          items: [{ type: 'narration', text: '她把杯沿又朝你推近了一点。' }],
          tool_call: {
            id: 'tool-ask-cafe-rain-1',
            name: 'ask_player_choice',
            arguments: CAFE_RAIN_FIXTURE.ask_player_choice_envelope.arguments,
          },
        },
      ],
    });
    const before = recoverRuntime(runtime);
    const result = await runTurn(runtime, { input: { turn: 1 }, expected_revision: before.base_revision });
    // 1. tool envelope kind
    assert.equal(result.kind, 'tool_call');
    assert.equal(result.tool_result.kind, 'choice_required');
    assert.equal(result.tool_envelope.kind, 'choice_required');
    // 2. tool_call_id presence: exactly ONE tool envelope per turn.
    assert.ok(result.tool_call && !Array.isArray(result.tool_call), 'a single tool envelope is surfaced');
    assert.equal(result.tool_call.tool_call_id, 'tool-ask-cafe-rain-1');
    assert.equal(result.tool_envelope.tool_call_id, 'tool-ask-cafe-rain-1');
    // The narrative batch still rides along (1 item) ahead of the tool.
    assert.equal(result.items.length, 1);
    assert.equal(result.pending_total, 1);
    // 3. canonical history untouched by agent turn
    const history = listSessionEvents({ repository, session_uuid });
    assert.equal(history.length, 0, 'agent turn must not append canonical events');
    // 4. revision unchanged
    assert.equal(result.base_revision, before.base_revision);
    // 5. session pin invariants
    assert.equal(result.tool_envelope.session_uuid, session_uuid);
    assert.equal(result.tool_envelope.turn_id, result.turn_id);
    // 6. recoverRuntime byte-identical across reads (modulo pending state)
    const snap1 = recoverRuntime(runtime);
    const snap2 = recoverRuntime(runtime);
    assert.deepEqual(snap2, snap1);
  });

  await test('R2. pinned fixture + canned finish_story: terminal envelope; character_outcomes survives', async () => {
    const { runtime } = await pinnedRuntimeFixture({
      responses: [
        {
          // 08 contract: finish_story also rides on a narrative batch.
          items: [{ type: 'narration', text: '雨停之前，她终于开了口。' }],
          tool_call: {
            id: 'tool-finish-cafe-rain',
            name: 'finish_story',
            arguments: CAFE_RAIN_FIXTURE.finish_story_envelope.arguments,
          },
        },
      ],
    });
    const before = recoverRuntime(runtime);
    const result = await runTurn(runtime, { input: { turn: 2 }, expected_revision: before.base_revision });
    assert.equal(result.kind, 'tool_call');
    assert.equal(result.tool_result.kind, 'story_finished');
    assert.equal(result.tool_result.terminal, true);
    assert.equal(result.tool_result.requires_player, false);
    assert.equal(result.tool_envelope.terminal, true);
    // The fixture character_outcomes survives normalisation (no truncation,
    // no field reordering, no extra defaults). The validated tool arguments
    // live on tool_result.payload.
    assert.equal(result.tool_result.payload.character_outcomes.length, 1);
    assert.equal(result.tool_result.payload.character_outcomes[0].character, 'old-friend');
    assert.equal(result.tool_result.payload.character_outcomes[0].fate, '留下名片');
    assert.equal(result.tool_result.payload.character_outcomes[0].change, '沉默多年后终于开口');
    assert.equal(result.tool_result.payload.ending_key, 'cafe-rain/rain-stays');
    assert.equal(result.tool_result.payload.key_choices.length, 2);
    // The narrative batch rides ahead of the terminal tool call.
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].type, 'narration');
  });

  await test('R3. revision_mismatch: a turn that arrives after the session advanced fails closed', async () => {
    const { runtime, repository, session_uuid, cache } = await pinnedRuntimeFixture({
      responses: [
        {
          tool_calls: [
            {
              id: 'tool-ask-1',
              name: 'ask_player_choice',
              arguments: { question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
            },
          ],
        },
      ],
    });
    const before = recoverRuntime(runtime);
    // Advance the session out from under the runtime: drain 2 cache
    // events via the canonical history.
    let revision = before.base_revision;
    for (let i = 0; i < 2; i += 1) {
      revision = commitOpeningEvent({
        repository,
        session_uuid,
        cache_uuid: cache.cache_uuid,
        event: shown(cache.content_payload.events[i]),
        client_request_id: `regression-open-${i}`,
        expected_revision: revision,
      }).revision;
    }
    // A stale agent request now fails closed; no canonical append.
    await assert.rejects(
      () => runTurn(runtime, { input: { turn: 1 }, expected_revision: before.base_revision }),
      (err) => err instanceof AgentRuntimeError && err.code === 'revision_mismatch',
    );
    // Runtime did not record the failed turn.
    assert.equal(recoverRuntime(runtime).successful_turns.length, 0);
  });

  await test('R4. canonical-history untouched across multiple agent turns', async () => {
    // The agent MUST be read-only against session_events regardless of how
    // many turns it runs. The canonical history only grows when the
    // player commits an opening event or a player input.
    // Story 08 pending hardening: there is exactly ONE active pending
    // per session, so the application layer must drain (commit) or drop
    // (discardPendingTail) the staged batch before the next turn can be
    // staged. We drop it here — discarding appends nothing, which keeps
    // the "agent is read-only" invariant directly observable.
    const { runtime, repository, session_uuid } = await pinnedRuntimeFixture({
      responses: [
        { messages: [{ role: 'assistant', content: 'narration 1' }] },
        { messages: [{ role: 'assistant', content: 'narration 2' }] },
        {
          items: [{ type: 'narration', text: '她抬起头等你开口。' }],
          tool_call: {
            id: 'tool-ask-3',
            name: 'ask_player_choice',
            arguments: { question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
          },
        },
      ],
    });
    for (let i = 0; i < 3; i += 1) {
      const revision = recoverRuntime(runtime).base_revision;
      await runTurn(runtime, { input: { turn: i }, expected_revision: revision });
      // App-layer cleanup between turns: drop the unconsumed staged batch.
      const dropped = discardPendingTail({ repository, session_uuid });
      assert.ok(dropped.dropped_pending_id, 'each agent turn staged a pending batch that is now dropped');
    }
    assert.equal(listSessionEvents({ repository, session_uuid }).length, 0);
    // Runtime pinned snapshot also reflects no canonical events.
    assert.equal(recoverRuntime(runtime).canonical_history.length, 0);
  });

  await test('R5. duplicate request_id with the same payload is idempotent; different payload is rejected', async () => {
    const { runtime } = await pinnedRuntimeFixture({
      responses: [
        {
          // 08 contract: tool call rides on a 1..4 item batch.
          items: [{ type: 'narration', text: '她等你先开口。' }],
          tool_call: {
            id: 'tool-1',
            name: 'ask_player_choice',
            arguments: { question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
          },
        },
      ],
    });
    const before = recoverRuntime(runtime);
    const first = await runTurn(runtime, {
      request_id: 'req-A',
      input: { a: 1 },
      expected_revision: before.base_revision,
    });
    const replay = await runTurn(runtime, {
      request_id: 'req-A',
      input: { a: 1 },
      expected_revision: before.base_revision,
    });
    assert.deepEqual(replay, first);
    // Same id, different payload → duplicate_request.
    await assert.rejects(
      () =>
        runTurn(runtime, {
          request_id: 'req-A',
          input: { a: 2 },
          expected_revision: before.base_revision,
        }),
      (err) => err instanceof AgentRuntimeError && err.code === 'duplicate_request',
    );
  });

  await test('R6. pin invariants hold against session_uuid / story_version_uuid / role_id swaps', async () => {
    // Two sessions with the same story_version but different roles MUST
    // still observe the same opening cache. Agent runtime rejects when
    // any of the pin fields diverge.
    const { repository } = await pinnedRuntimeFixture();
    const cacheResult = await ensureOpeningCache({
      repository,
      story_version_uuid: CAFE_RAIN_FIXTURE.story_version_uuid,
    });
    const session_a = '00000000-0000-4000-8000-0000000e000a';
    const session_b = '00000000-0000-4000-8000-0000000e000b';
    for (const [session_uuid, role_id] of [[session_a, 'stranger'], [session_b, 'old-friend']]) {
      createSession({
        repository,
        session_uuid,
        story_uuid: CAFE_RAIN_FIXTURE.story_uuid,
        story_version_uuid: CAFE_RAIN_FIXTURE.story_version_uuid,
        user_ref: `u-${role_id}`,
        role_id,
        model: 'gpt-regression',
        prompt: 'fixed prompt',
        generation_profile: {
          identifier: cacheResult.cache.generation_profile.identifier,
          rules_version: cacheResult.cache.generation_profile.rules_version,
          cache_uuid: cacheResult.cache.cache_uuid,
          generation_hash: cacheResult.cache.generation_hash,
        },
      });
    }
    const version = repository.findVersion(CAFE_RAIN_FIXTURE.story_version_uuid);
    // Wrong story_version_checksum → pin_mismatch.
    assert.throws(
      () =>
        createAgentRuntime({
          repository,
          session_uuid: session_a,
          provider: createMockAgentProvider(),
          system_prompt: { kind: 'system', text: 'sys' },
          tool_definitions: TOOL_DEFINITIONS,
          expected_story_version_uuid: version.version_uuid,
          expected_story_version_checksum: 'bad-checksum',
          expected_model: 'gpt-regression',
          expected_generation_profile: {
            identifier: cacheResult.cache.generation_profile.identifier,
            rules_version: cacheResult.cache.generation_profile.rules_version,
            cache_uuid: cacheResult.cache.cache_uuid,
            generation_hash: cacheResult.cache.generation_hash,
          },
        }),
      (err) => err instanceof AgentRuntimeError && err.code === 'pin_mismatch',
    );
    // Same pin set → runtime is constructed successfully.
    const runtime = createAgentRuntime({
      repository,
      session_uuid: session_a,
      provider: createMockAgentProvider(),
      system_prompt: { kind: 'system', text: 'sys' },
      tool_definitions: TOOL_DEFINITIONS,
      expected_story_version_uuid: version.version_uuid,
      expected_story_version_checksum: resolveChecksum(repository),
      expected_model: 'gpt-regression',
      expected_generation_profile: {
        identifier: cacheResult.cache.generation_profile.identifier,
        rules_version: cacheResult.cache.generation_profile.rules_version,
        cache_uuid: cacheResult.cache.cache_uuid,
        generation_hash: cacheResult.cache.generation_hash,
      },
    });
    const snap = recoverRuntime(runtime);
    assert.equal(snap.pinned.story_version_checksum, resolveChecksum(repository));
    // Pin mismatch on generation_profile → pin_mismatch.
    assert.throws(
      () =>
        createAgentRuntime({
          repository,
          session_uuid: session_a,
          provider: createMockAgentProvider(),
          system_prompt: { kind: 'system', text: 'sys' },
          tool_definitions: TOOL_DEFINITIONS,
          expected_story_version_uuid: version.version_uuid,
          expected_story_version_checksum: resolveChecksum(repository),
          expected_model: 'gpt-regression',
          expected_generation_profile: {
            identifier: 'wrong',
            rules_version: 'opening-rules/1',
            cache_uuid: cacheResult.cache.cache_uuid,
            generation_hash: cacheResult.cache.generation_hash,
          },
        }),
      (err) => err instanceof AgentRuntimeError && err.code === 'pin_mismatch',
    );
  });

  await test('R7. player interrupt mid-opening advances revision; cache row remains valid for siblings', async () => {
    // Pin invariants guarantee that an interrupt in session A does not
    // touch the shared opening cache. A new session B can still pin the
    // SAME cache_uuid and observe a valid row.
    const session_a = '00000000-0000-4000-8000-0000000e000c';
    const session_b = '00000000-0000-4000-8000-0000000e000d';
    const { repository, cache } = await pinnedRuntimeFixture({ session_uuid: session_a });
    // Drain 1 opening event from session A.
    commitOpeningEvent({
      repository,
      session_uuid: session_a,
      cache_uuid: cache.cache_uuid,
      event: shown(cache.content_payload.events[0]),
      expected_revision: 0,
    });
    // Player types — interrupt fires; session A enters 'realtime'.
    interruptWithPlayerInput({
      repository,
      session_uuid: session_a,
      text: '我先说一句',
      expected_revision: 1,
    });
    // Session B has not touched the cache yet and can pin it normally.
    createSession({
      repository,
      session_uuid: session_b,
      story_uuid: CAFE_RAIN_FIXTURE.story_uuid,
      story_version_uuid: CAFE_RAIN_FIXTURE.story_version_uuid,
      user_ref: 'u-b',
      role_id: 'stranger',
      model: 'gpt-regression',
      prompt: 'fixed prompt',
      generation_profile: {
        identifier: cache.generation_profile.identifier,
        rules_version: cache.generation_profile.rules_version,
        cache_uuid: cache.cache_uuid,
        generation_hash: cache.generation_hash,
      },
    });
    const sharedCacheRow = repository.findOpeningCacheByUuid(cache.cache_uuid);
    assert.equal(sharedCacheRow.status, 'valid', 'shared cache must NOT be invalidated by session A interrupt');
    // Session B still sees the same opening event_count.
    assert.equal(sharedCacheRow.content_payload.event_count, CAFE_RAIN_OPENING_EVENT_COUNT);
  });
}

run()
  .then(() => {
    if (casesFailed > 0) {
      console.error(`\n${casesFailed}/${casesRun} agentRegression case(s) failed`);
      process.exit(1);
    }
    console.log(`\nall ${casesRun} agentRegression case(s) passed`);
  })
  .catch((err) => {
    console.error(`\nunexpected error: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
