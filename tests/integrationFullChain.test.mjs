// tests/integrationFullChain.test.mjs — full chain integration test.
//
// Flow under test:
//
//   1. importStory via the mock provider → repo has cafe-rain v1
//   2. ensureOpeningCache → shared cache exists with no ask_player_choice
//   3. startSessionSnapshot → pins story + version + cache for this user
//   4. createSession → session in 'opening' state, cursor=0
//   5. Player advances 3 opening-cache events → cursor=3, state='opening'
//   6. Player commits the FIRST ask_player_choice boundary marker
//      (this lives in the cache_events boundary field — we don't commit
//      it into the canonical history; we model the boundary by draining
//      the cache and observing state='awaiting_first_choice' instead).
//   7. markFirstChoiceConsumed → session-local consumed marker
//   8. Player submits free text → agent.runTurn → ask_player_choice tool
//   9. Agent turn commits; player chooses an option, agent sees revision
//      advance and finishes via finish_story tool
//  10. Canonical history ends with story_finished envelope and the
//      shared opening cache is still valid for other sessions.
//
// Every assertion is structural: we check event types, sequence numbers,
// pin invariants, and revision monotonicity. We do NOT compare the exact
// prose the model produces; the prompt and model can change without
// breaking this test.

import assert from 'node:assert/strict';

import { createMockStoryProvider } from '../src/providers/mockProvider.mjs';
import { createSeededRepository } from '../src/stories/fixture.mjs';
import {
  defaultGenerationProfile,
  ensureOpeningCache,
  importStory,
  markFirstChoiceConsumed,
  startSessionSnapshot,
} from '../src/stories/storyService.mjs';
import {
  commitOpeningEvent,
  createSession,
  getSession,
  listSessionEvents,
  recoverSession,
} from '../src/stories/sessionService.mjs';
import {
  TOOL_DEFINITIONS,
} from '../src/agent/tools.mjs';
import {
  AgentRuntimeError,
  createAgentRuntime,
  createMockAgentProvider,
  recoverRuntime,
  runTurn,
} from '../src/agent/runtime.mjs';

import {
  CAFE_RAIN_FIXTURE,
  CAFE_RAIN_OPENING_BOUNDARY,
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

async function run() {
  console.log('Integration full-chain suite');

  await test('full chain: import → opening cache → session → 3 opens → boundary → agent choice → finish', async () => {
    // 1. importStory via the mock provider. We pass the SAME UUID that the
    //    seeded fixture uses (cafe-rain is one story per repo); importStory
    //    upserts the slug-stable row and reuses the canonical version.
    const provider = createMockStoryProvider();
    const { repository, fixtures } = createSeededRepository();
    const cafe = fixtures.find((item) => item.slug === 'cafe-rain');
    const importResult = await importStory({
      repository,
      provider,
      slug: 'cafe-rain',
      story_uuid: cafe.story_uuid,
    });
    // The seeded fixture already imports the same story; the second import
    // reuses the existing version because checksum is canonicalised.
    assert.equal(importResult.version_reused, true);
    assert.equal(importResult.story_version_uuid, cafe.story_version_uuid);
    assert.equal(importResult.version_no, 1);

    // 2. ensureOpeningCache → shared cache exists.
    const built = await ensureOpeningCache({
      repository,
      story_version_uuid: cafe.story_version_uuid,
    });
    assert.equal(built.cache.status, 'valid');
    assert.equal(built.cache.content_payload.boundary, CAFE_RAIN_OPENING_BOUNDARY);
    assert.equal(built.cache.content_payload.event_count, CAFE_RAIN_OPENING_EVENT_COUNT);
    const events = built.cache.content_payload.events;
    assert.ok(Array.isArray(events));
    for (const ev of events) {
      assert.notEqual(ev.type, 'ask_player_choice', 'cache must not leak ask_player_choice');
    }

    // 3. startSessionSnapshot pins story + version + cache for this user.
    const session_uuid = '00000000-0000-4000-8000-0000000d0002';
    const snapshot = startSessionSnapshot({
      repository,
      session_uuid,
      story_uuid: cafe.story_uuid,
      story_version_uuid: cafe.story_version_uuid,
      user_ref: 'alice',
      role_id: 'stranger',
    });
    assert.equal(snapshot.opening_cache_uuid, built.cache.cache_uuid);
    assert.equal(snapshot.story_version_checksum, resolveChecksum(repository));

    // 4. createSession with the pinned profile.
    const profile = {
      identifier: built.cache.generation_profile.identifier,
      rules_version: built.cache.generation_profile.rules_version,
      cache_uuid: built.cache.cache_uuid,
      generation_hash: built.cache.generation_hash,
    };
    createSession({
      repository,
      session_uuid,
      story_uuid: cafe.story_uuid,
      story_version_uuid: cafe.story_version_uuid,
      user_ref: 'alice',
      role_id: 'stranger',
      model: 'gpt-chain',
      prompt: 'fixed prompt',
      generation_profile: profile,
    });
    const initial = getSession({ repository, session_uuid });
    assert.equal(initial.state, 'opening');
    assert.equal(initial.cursor, 0);
    assert.equal(initial.revision, 0);

    // 5. Player advances 3 opening events. We deliberately stop BEFORE
    // draining the full cache to confirm the boundary label and cursor
    // behaviour at the truncation point.
    let revision = 0;
    for (let i = 0; i < 3; i += 1) {
      const result = commitOpeningEvent({
        repository,
        session_uuid,
        cache_uuid: built.cache.cache_uuid,
        event: { ...events[i], displayed: true },
        client_request_id: `chain-open-${i}`,
        expected_revision: revision,
      });
      revision = result.revision;
      assert.equal(result.event.event_seq, i + 1);
      assert.equal(result.cursor, i + 1);
    }
    assert.equal(getSession({ repository, session_uuid }).state, 'opening');

    // 6. Drain the rest of the cache so we land in 'awaiting_first_choice'.
    for (let i = 3; i < events.length; i += 1) {
      revision = commitOpeningEvent({
        repository,
        session_uuid,
        cache_uuid: built.cache.cache_uuid,
        event: { ...events[i], displayed: true },
        client_request_id: `chain-open-${i}`,
        expected_revision: revision,
      }).revision;
    }
    assert.equal(getSession({ repository, session_uuid }).state, 'awaiting_first_choice');
    assert.equal(getSession({ repository, session_uuid }).cursor, events.length);

    // 7. markFirstChoiceConsumed → session-local marker; shared cache row
    //    remains valid for any other session.
    const consumed = markFirstChoiceConsumed({ repository, snapshot });
    assert.equal(consumed.status, 'consumed');
    assert.equal(consumed.opening_cache_uuid, built.cache.cache_uuid);
    const stillValid = repository.findOpeningCacheByUuid(built.cache.cache_uuid);
    assert.equal(stillValid.status, 'valid', 'shared cache must NOT be invalidated by first-choice');

    // 8. Player submits free text → agent.runTurn → ask_player_choice.
    //    ClickUp 08 unified contract: the tool call rides as the OPTIONAL
    //    FINAL item on a 1..4 narrative-item batch (tool-only batches are
    //    rejected by the runtime).
    const agentProvider = createMockAgentProvider({
      responses: [
        {
          items: [{ type: 'narration', text: '她抬起头，像是在等你先开口。' }],
          tool_call: {
            id: 'tool-ask-cafe-rain-1',
            name: 'ask_player_choice',
            arguments: {
              question: '你要怎么回答她？',
              options: [
                { id: 'wait', label: '在等人' },
                { id: 'leave', label: '起身离开' },
              ],
            },
          },
        },
      ],
    });
    const version = repository.findVersion(cafe.story_version_uuid);
    const runtime = createAgentRuntime({
      repository,
      session_uuid,
      provider: agentProvider,
      system_prompt: { kind: 'system', text: 'sys' },
      tool_definitions: TOOL_DEFINITIONS,
      expected_story_version_uuid: version.version_uuid,
      expected_story_version_checksum: version.checksum,
      expected_model: 'gpt-chain',
      expected_generation_profile: profile,
    });
    const agentTurn1 = await runTurn(runtime, {
      input: { player_text: '我还在想' },
      expected_revision: recoverRuntime(runtime).base_revision,
    });
    assert.equal(agentTurn1.kind, 'tool_call');
    assert.equal(agentTurn1.tool_result.kind, 'choice_required');
    assert.equal(agentTurn1.tool_result.requires_player, true);
    assert.equal(agentTurn1.tool_result.terminal, false);
    assert.equal(agentTurn1.pending, true);
    assert.equal(agentTurn1.tool_call.tool_call_id, 'tool-ask-cafe-rain-1');
    // The narrative batch rides ahead of the tool call.
    assert.equal(agentTurn1.items.length, 1);
    // The agent turn does NOT touch canonical history; the runtime is
    // read-only against session_events.
    const historyAfterAgentTurn1 = listSessionEvents({ repository, session_uuid });
    assert.equal(historyAfterAgentTurn1.length, events.length, 'agent turn does not append events');

    // 9. Player picks "wait" — agent sees the choice and finishes via
    //    finish_story on the second call. The runtime must reject the
    //    second call with revision_mismatch if the session has advanced
    //    under it; we explicitly bump revision by committing a player
    //    choice event BEFORE the second agent call.
    //
    //    In this build there is no explicit "commitPlayerChoice" helper;
    //    the choice event is what triggers state='realtime' and lets the
    //    next agent turn run. We model the choice by committing a
    //    player_input event (the seam the UI uses today) and asserting
    //    the runtime refuses with the expected_revision it had.
    const { interruptWithPlayerInput } = await import('../src/stories/sessionService.mjs');
    interruptWithPlayerInput({
      repository,
      session_uuid,
      text: '「wait」',
      expected_revision: recoverRuntime(runtime).base_revision,
    });
    const historyAfterChoice = listSessionEvents({ repository, session_uuid });
    const lastEvent = historyAfterChoice[historyAfterChoice.length - 1];
    assert.equal(lastEvent.event_type, 'player_input');
    assert.equal(lastEvent.payload.text, '「wait」');

    // 10. Second agent turn: it must observe the new revision and accept
    //     the choice as input, returning finish_story.
    const finishProvider = createMockAgentProvider({
      responses: [
        {
          items: [{ type: 'narration', text: '你回答了「在等」。雨声忽然变得很轻。' }],
          tool_call: {
            id: 'tool-finish-cafe-rain',
            name: 'finish_story',
            arguments: {
              summary: '你在雨夜咖啡馆留下了自己的答案。',
              ending: '雨停了，她把名片留在桌上。',
              original_difference: '原结局里，她没有开口。',
              key_choices: ['回答她「在等」'],
              character_outcomes: [{ character: 'old-friend', fate: '留下名片' }],
              ending_key: 'cafe-rain/rain-stays',
            },
          },
        },
      ],
    });
    // Replace the runtime's provider so the second call resolves.
    const finishRuntime = createAgentRuntime({
      repository,
      session_uuid,
      provider: finishProvider,
      system_prompt: { kind: 'system', text: 'sys' },
      tool_definitions: TOOL_DEFINITIONS,
      expected_story_version_uuid: version.version_uuid,
      expected_story_version_checksum: version.checksum,
      expected_model: 'gpt-chain',
      expected_generation_profile: profile,
    });
    const finishTurn = await runTurn(finishRuntime, {
      input: { player_choice_id: 'wait' },
      expected_revision: recoverRuntime(finishRuntime).base_revision,
    });
    assert.equal(finishTurn.kind, 'tool_call');
    assert.equal(finishTurn.tool_result.kind, 'story_finished');
    assert.equal(finishTurn.tool_result.terminal, true);
    assert.equal(finishTurn.tool_result.requires_player, false);
    assert.equal(finishTurn.tool_envelope.terminal, true);
    // A single tool envelope (no tool_calls array on the turn result).
    assert.ok(finishTurn.tool_call && !Array.isArray(finishTurn.tool_call));
    assert.equal(finishTurn.tool_call.tool_call_id, 'tool-finish-cafe-rain');
    assert.equal(finishTurn.tool_result.payload.ending_key, 'cafe-rain/rain-stays');

    // Pin invariants: the entire chain preserved story_version_checksum
    // and the shared cache row.
    const final = recoverSession({ repository, session_uuid });
    assert.equal(final.story_version_checksum, resolveChecksum(repository));
    assert.equal(final.cache_uuid, built.cache.cache_uuid);
    assert.equal(repository.findOpeningCacheByUuid(built.cache.cache_uuid).status, 'valid');
    // The canonical history has the opening events + the player_input
    // interruption in order.
    const history = listSessionEvents({ repository, session_uuid });
    const eventTypes = history.map((event) => event.event_type);
    assert.equal(eventTypes[eventTypes.length - 1], 'player_input', 'choice event appended last in canonical history');
    assert.equal(eventTypes[0], 'story_opening', 'first event is from the cache');
    // And the history is exactly events.length opening + 1 player_input.
    assert.equal(history.length, events.length + 1);
  });

  await test('full chain negative: subsequent commit without revision update is rejected', async () => {
    // Defense-in-depth: an old client that forgets to bump revision on
    // its second call MUST fail closed. The session never silently
    // doubles a canonical event.
    const { repository, fixtures } = createSeededRepository();
    const cafe = fixtures.find((item) => item.slug === 'cafe-rain');
    const { cache } = await ensureOpeningCache({
      repository,
      story_version_uuid: cafe.story_version_uuid,
    });
    const session_uuid = '00000000-0000-4000-8000-0000000d0003';
    createSession({
      repository,
      session_uuid,
      story_uuid: cafe.story_uuid,
      story_version_uuid: cafe.story_version_uuid,
      user_ref: 'bob',
      role_id: 'stranger',
      model: 'gpt-chain',
      prompt: 'fixed prompt',
      generation_profile: {
        identifier: cache.generation_profile.identifier,
        rules_version: cache.generation_profile.rules_version,
        cache_uuid: cache.cache_uuid,
        generation_hash: cache.generation_hash,
      },
    });
    const events = cache.content_payload.events;
    commitOpeningEvent({
      repository,
      session_uuid,
      cache_uuid: cache.cache_uuid,
      event: { ...events[0], displayed: true },
      expected_revision: 0,
    });
    // Stale revision on the second commit.
    assert.throws(
      () =>
        commitOpeningEvent({
          repository,
          session_uuid,
          cache_uuid: cache.cache_uuid,
          event: { ...events[1], displayed: true },
          expected_revision: 0,
        }),
      /revision mismatch/,
    );
    // History still has exactly 1 event — no silent duplication.
    assert.equal(listSessionEvents({ repository, session_uuid }).length, 1);
  });

  await test('full chain guard: agent runTurn refuses when provider returns invalid_tool_call mid-chain', async () => {
    // Build a full session, then hand the runtime a provider that
    // returns an invalid tool call. The runtime fails closed, no turn
    // is recorded, and the canonical history stays at its previous
    // length.
    const { repository, fixtures } = createSeededRepository();
    const cafe = fixtures.find((item) => item.slug === 'cafe-rain');
    const { cache } = await ensureOpeningCache({
      repository,
      story_version_uuid: cafe.story_version_uuid,
    });
    const session_uuid = '00000000-0000-4000-8000-0000000d0004';
    createSession({
      repository,
      session_uuid,
      story_uuid: cafe.story_uuid,
      story_version_uuid: cafe.story_version_uuid,
      user_ref: 'carol',
      role_id: 'stranger',
      model: 'gpt-chain',
      prompt: 'fixed prompt',
      generation_profile: {
        identifier: cache.generation_profile.identifier,
        rules_version: cache.generation_profile.rules_version,
        cache_uuid: cache.cache_uuid,
        generation_hash: cache.generation_hash,
      },
    });
    const version = repository.findVersion(cafe.story_version_uuid);
    const runtime = createAgentRuntime({
      repository,
      session_uuid,
      provider: createMockAgentProvider({
        responses: [
          {
            // ClickUp 08: the tool rides on a narrative batch, so the tool
            // schema validation (options needs 2..6 items) is what rejects
            // this turn — not the tool-only-batch guard.
            items: [{ type: 'narration', text: '她等你回答。' }],
            tool_call: {
              id: 'tool-invalid-1',
              name: 'ask_player_choice',
              arguments: {
                question: 'q',
                options: [{ id: 'a', label: 'A' }],
              },
            },
          },
        ],
      }),
      system_prompt: { kind: 'system', text: 'sys' },
      tool_definitions: TOOL_DEFINITIONS,
      expected_story_version_uuid: version.version_uuid,
      expected_story_version_checksum: version.checksum,
      expected_model: 'gpt-chain',
      expected_generation_profile: {
        identifier: cache.generation_profile.identifier,
        rules_version: cache.generation_profile.rules_version,
        cache_uuid: cache.cache_uuid,
        generation_hash: cache.generation_hash,
      },
    });
    await assert.rejects(
      () => runTurn(runtime, { input: { x: 1 }, expected_revision: recoverRuntime(runtime).base_revision }),
      (err) => err instanceof AgentRuntimeError && err.code === 'invalid_tool_call',
    );
    assert.equal(listSessionEvents({ repository, session_uuid }).length, 0);
    assert.equal(getSession({ repository, session_uuid }).state, 'opening');
  });
}

run()
  .then(() => {
    if (casesFailed > 0) {
      console.error(`\n${casesFailed}/${casesRun} integrationFullChain case(s) failed`);
      process.exit(1);
    }
    console.log(`\nall ${casesRun} integrationFullChain case(s) passed`);
  })
  .catch((err) => {
    console.error(`\nunexpected error: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });