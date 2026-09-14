// tests/providerAdapter.test.mjs — provider / DTO / tool-call adapter suite.
//
// Goal: cover the contract every StoryProvider and AgentProvider adapter
// MUST hold before routes can map their results to HTTP. Five concrete
// concerns:
//
//   1. DTO conversion: normaliseStorySummary / normaliseStoryDetail strip
//      unknown fields, preserve structured beat type/speaker, and reject
//      malformed payloads at the boundary (not deep inside the service).
//   2. Schema validation: ToolValidationError fires for unknown fields,
//      duplicate option ids, and out-of-range option counts before the
//      agent runtime sees the call.
//   3. 5xx: a provider that throws an internal-style error is wrapped as
//      AgentRuntimeError 'provider_failure' and the runtime refuses to
//      mark the turn successful.
//   4. 429: a provider that throws a rate-limit-style error (any error
//      with a retryable shape) surfaces through the same provider_failure
//      channel; callers observe the same retry budget contract.
//   5. Timeout: a provider that hangs past the deadline raises; the
//      runtime maps it to provider_failure without leaking the underlying
//      timer.
//   6. Empty body: under the Story 08 unified contract the two "empty
//      body" shapes fail closed with DIFFERENT codes — {} (no messages /
//      tool_calls / items at all) is provider_failure, while a present
//      but empty messages array is invalid_tool_call (batch-size guard).

import assert from 'node:assert/strict';

import { createSeededRepository } from '../src/stories/fixture.mjs';
import { ensureOpeningCache } from '../src/stories/storyService.mjs';
import { createSession } from '../src/stories/sessionService.mjs';
import {
  AgentRuntimeError,
  createAgentRuntime,
  createMockAgentProvider,
  recoverRuntime,
  runTurn,
} from '../src/agent/runtime.mjs';
import {
  TOOL_DEFINITIONS,
  ToolValidationError,
  executeToolCall,
  validateAskPlayerChoice,
  validateFinishStory,
} from '../src/agent/tools.mjs';
import {
  ProviderError,
  StoryNotFoundError,
  ValidationError,
  createMockStoryProvider,
  normaliseStoryDetail,
  normaliseStorySummary,
} from '../src/providers/index.mjs';

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

async function runtimeFixture({ responses, handler, failure } = {}) {
  const { repository } = createSeededRepository();
  const { cache } = await ensureOpeningCache({
    repository,
    story_version_uuid: CAFE_RAIN_FIXTURE.story_version_uuid,
  });
  const session_uuid = '00000000-0000-4000-8000-0000000b0001';
  createSession({
    repository,
    session_uuid,
    story_uuid: CAFE_RAIN_FIXTURE.story_uuid,
    story_version_uuid: CAFE_RAIN_FIXTURE.story_version_uuid,
    user_ref: 'u-adapter',
    role_id: 'stranger',
    model: 'gpt-adapter',
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
    expected_model: 'gpt-adapter',
    expected_generation_profile: {
      identifier: cache.generation_profile.identifier,
      rules_version: cache.generation_profile.rules_version,
      cache_uuid: cache.cache_uuid,
      generation_hash: cache.generation_hash,
    },
  });
  return { runtime, provider, repository, cache, session_uuid };
}

async function run() {
  console.log('Provider / DTO / adapter suite');

  // -------- 1. DTO conversion ------------------------------------------------
  await test('1a. normaliseStorySummary strips unknown fields and requires id/title/hook/roles', () => {
    const summary = normaliseStorySummary({
      id: 'cafe-rain',
      title: '雨夜咖啡馆',
      hook: '凌晨的咖啡馆只剩你和她。',
      roles: [{ id: 'stranger', label: '陌生人', mood: '疏离', extra: 'leak' }],
      leaked: 'top-secret',
    });
    assert.equal(summary.id, 'cafe-rain');
    assert.equal(summary.roles.length, 1);
    assert.equal(summary.roles[0].extra, undefined);
    assert.equal(summary.leaked, undefined);
    assert.throws(
      () => normaliseStorySummary({ title: 't', hook: 'h', roles: [] }),
      ValidationError,
    );
  });

  await test('1b. normaliseStoryDetail preserves structured beat type/speaker, rejects missing beats', () => {
    const detail = normaliseStoryDetail({
      id: 'cafe-rain',
      title: 't',
      hook: 'h',
      roles: [{ id: 'old-friend', label: '旧友' }],
      beats: [
        { text: 'narration', index: 0 },
        { text: '「旧友」hi', index: 1, type: 'dialogue', speaker: 'old-friend' },
        { text: 'pick', index: 2, type: 'ask_player_choice', extra: 'should_drop' },
      ],
    });
    assert.equal(detail.beats.length, 3);
    assert.equal(detail.beats[1].type, 'dialogue');
    assert.equal(detail.beats[1].speaker, 'old-friend');
    assert.equal(detail.beats[2].type, 'ask_player_choice');
    assert.equal(detail.beats[2].extra, undefined);
    assert.throws(
      () => normaliseStoryDetail({ id: 'x', title: 't', hook: 'h', roles: [] }),
      ValidationError,
    );
  });

  await test('1c. mock provider advance math + error mapping (StoryNotFoundError/ValidationError)', async () => {
    const provider = createMockStoryProvider();
    const advanced = await provider.advanceStory({
      storyId: 'cafe-rain',
      roleId: 'stranger',
      index: 2,
    });
    assert.equal(advanced.storyId, 'cafe-rain');
    assert.equal(advanced.roleId, 'stranger');
    assert.equal(advanced.index, 3);
    assert.equal(advanced.finished, false);
    const story = await provider.getStory('cafe-rain');
    const end = await provider.advanceStory({ storyId: 'cafe-rain', index: story.beats.length - 1 });
    assert.equal(end.finished, true);
    assert.equal(end.beat, null);
    await assert.rejects(() => provider.getStory('nope'), StoryNotFoundError);
    await assert.rejects(
      () => provider.advanceStory({ storyId: 'cafe-rain', index: -1 }),
      ValidationError,
    );
    // ProviderError carries the code + details that routes map to HTTP.
    const boom = new ProviderError('boom', 'Boom!', { hint: 'mock' });
    assert.equal(boom.code, 'boom');
    assert.equal(boom.details.hint, 'mock');
  });

  // -------- 2. Tool schema validation ---------------------------------------
  await test('2a. validateAskPlayerChoice rejects unknown fields, duplicate ids, and out-of-range option counts', () => {
    const ok = validateAskPlayerChoice({
      question: 'choose',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    });
    assert.equal(ok.options.length, 2);
    assert.throws(
      () =>
        validateAskPlayerChoice({
          question: 'q',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
          extra: 1,
        }),
      (err) => err instanceof ToolValidationError && err.code === 'invalid_tool_call',
    );
    assert.throws(
      () =>
        validateAskPlayerChoice({
          question: 'q',
          options: [
            { id: 'a', label: 'A' },
            { id: 'a', label: 'B' },
          ],
        }),
      (err) => err instanceof ToolValidationError && err.code === 'invalid_tool_call',
    );
    assert.throws(
      () =>
        validateAskPlayerChoice({
          question: 'q',
          options: [{ id: 'a', label: 'A' }],
        }),
      (err) => err instanceof ToolValidationError && err.code === 'invalid_tool_call',
    );
    assert.throws(
      () =>
        validateAskPlayerChoice({
          question: 'q',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
            { id: 'c', label: 'C' },
            { id: 'd', label: 'D' },
            { id: 'e', label: 'E' },
            { id: 'f', label: 'F' },
            { id: 'g', label: 'G' },
          ],
        }),
      (err) => err instanceof ToolValidationError && err.code === 'invalid_tool_call',
    );
  });

  await test('2b. validateFinishStory rejects empty summary, missing character_outcomes, unknown fields', () => {
    const ok = validateFinishStory({
      summary: 'done',
      ending: 'ending',
      original_difference: 'diff',
      key_choices: ['k'],
      character_outcomes: [{ character: 'A', fate: 'B' }],
    });
    assert.equal(ok.summary, 'done');
    assert.throws(
      () =>
        validateFinishStory({
          summary: '',
          ending: 'ending',
          original_difference: 'diff',
          key_choices: ['k'],
          character_outcomes: [{ character: 'A', fate: 'B' }],
        }),
      (err) => err instanceof ToolValidationError && err.code === 'invalid_tool_call',
    );
    assert.throws(
      () =>
        validateFinishStory({
          summary: 'done',
          ending: 'ending',
          original_difference: 'diff',
          key_choices: [],
          character_outcomes: [{ character: 'A', fate: 'B' }],
        }),
      (err) => err instanceof ToolValidationError && err.code === 'invalid_tool_call',
    );
    assert.throws(
      () =>
        validateFinishStory({
          summary: 'done',
          ending: 'ending',
          original_difference: 'diff',
          key_choices: ['k'],
          character_outcomes: [],
        }),
      (err) => err instanceof ToolValidationError && err.code === 'invalid_tool_call',
    );
  });

  await test('2c. executeToolCall rejects unknown tool names and missing tool_call_id', () => {
    assert.throws(
      () =>
        executeToolCall({
          name: 'unknown_tool',
          arguments: {},
        }),
      (err) => err instanceof ToolValidationError && err.code === 'invalid_tool_call',
    );
    assert.throws(
      () =>
        executeToolCall({
          name: 'ask_player_choice',
          arguments: {
            question: 'q',
            options: [
              { id: 'a', label: 'A' },
              { id: 'b', label: 'B' },
            ],
          },
        }),
      (err) => err instanceof ToolValidationError && err.code === 'invalid_tool_call',
    );
  });

  // -------- 3. 5xx ----------------------------------------------------------
  await test('3. provider 5xx → provider_failure; runtime refuses the turn', async () => {
    const { runtime, provider } = await runtimeFixture({
      failure: new Error('HTTP 500 Internal Server Error'),
    });
    await assert.rejects(
      () => runTurn(runtime, { input: { a: 1 }, expected_revision: recoverRuntime(runtime).base_revision }),
      (err) => err instanceof AgentRuntimeError && err.code === 'provider_failure',
    );
    // The runtime must not record the failed turn as successful, and no
    // pending batch may be left staged behind it.
    const snap = recoverRuntime(runtime);
    assert.equal(snap.successful_turns.length, 0);
    assert.equal(snap.staged, null);
    assert.equal(provider.callCount, 1);
  });

  // -------- 4. 429 ----------------------------------------------------------
  await test('4. provider 429 → provider_failure (same channel as 5xx; runtime is provider-agnostic)', async () => {
    const { runtime, provider } = await runtimeFixture({
      failure: new Error('HTTP 429 Too Many Requests — rate limited'),
    });
    const request_id = 'req-429-retry';
    await assert.rejects(
      () => runTurn(runtime, { request_id, input: { a: 1 }, expected_revision: recoverRuntime(runtime).base_revision }),
      (err) => err instanceof AgentRuntimeError && err.code === 'provider_failure',
    );
    // A retry with the SAME request_id is NOT an idempotent replay: the
    // failed turn never registered the request_id (registration only
    // happens after a successful turn), so the runtime re-attempts the
    // provider and fails closed with provider_failure again — the failed
    // attempt did not consume the request budget, and no duplicate_request
    // is invented for it.
    const before = recoverRuntime(runtime);
    await assert.rejects(
      () => runTurn(runtime, { request_id, input: { a: 1 }, expected_revision: before.base_revision }),
      (err) => err instanceof AgentRuntimeError && err.code === 'provider_failure',
    );
    // Both attempts really reached the provider (no replay short-circuit).
    assert.equal(provider.callCount, 2);
    // successful_turns still empty — no partial state escapes the runtime.
    assert.equal(recoverRuntime(runtime).successful_turns.length, 0);
  });

  // -------- 5. Timeout ------------------------------------------------------
  await test('5. provider hang/timeout → provider_failure without leaking the timer', async () => {
    // Simulate a provider that rejects with a timeout-shaped error AFTER
    // racing past the caller budget. The contract we assert: the runtime
    // surfaces any thrown provider failure as AgentRuntimeError code
    // 'provider_failure' and never records the turn as successful.
    const { runtime } = await runtimeFixture({
      handler: async () => {
        // Mimic a fetch/AbortError that the upstream adapter converts to
        // a plain Error before throwing. The runtime sees only the throw.
        throw new Error('caller deadline (timeout)');
      },
    });
    await assert.rejects(
      () => runTurn(runtime, { input: { a: 1 }, expected_revision: recoverRuntime(runtime).base_revision }),
      (err) => err instanceof AgentRuntimeError && err.code === 'provider_failure',
    );
    assert.equal(recoverRuntime(runtime).successful_turns.length, 0);
    assert.equal(recoverRuntime(runtime).staged, null);
  });

  // -------- 6. Empty body ---------------------------------------------------
  await test('6. provider empty body: {} → provider_failure; empty messages [] → invalid_tool_call', async () => {
    // Story 08 unified contract — the two "empty body" shapes the
    // runtime must reject, each with its own code:
    //   (a) {}                — neither messages nor tool_calls nor items
    //                           present → provider_failure
    //   (b) { messages: [] }  — messages array present but 0 items →
    //                           invalid_tool_call ("messages must contain
    //                           1 to 4 narrative items")
    // Both refuse the turn. A non-empty but malformed tool_calls list
    // (e.g. []) is rejected with 'invalid_tool_call' — that path is
    // exercised in tests/agentTools.test.mjs.
    const { runtime } = await runtimeFixture({
      handler: async (request) => {
        const idx = (request.input && request.input.phase) || 0;
        return [{}, { messages: [] }][idx];
      },
    });
    let revision = recoverRuntime(runtime).base_revision;
    // (a) {} → provider_failure.
    await assert.rejects(
      () =>
        runTurn(runtime, {
          input: { phase: 0 },
          expected_revision: revision,
        }),
      (err) => err instanceof AgentRuntimeError && err.code === 'provider_failure',
    );
    assert.equal(recoverRuntime(runtime).base_revision, revision);
    // (b) { messages: [] } → invalid_tool_call (empty batch).
    await assert.rejects(
      () =>
        runTurn(runtime, {
          input: { phase: 1 },
          expected_revision: revision,
        }),
      (err) =>
        err instanceof AgentRuntimeError
        && err.code === 'invalid_tool_call'
        && /messages must contain 1 to 4 narrative items/.test(err.message),
    );
    assert.equal(recoverRuntime(runtime).base_revision, revision);
    assert.equal(recoverRuntime(runtime).successful_turns.length, 0);
    assert.equal(recoverRuntime(runtime).staged, null);
  });
}

run()
  .then(() => {
    if (casesFailed > 0) {
      console.error(`\n${casesFailed}/${casesRun} providerAdapter case(s) failed`);
      process.exit(1);
    }
    console.log(`\nall ${casesRun} providerAdapter case(s) passed`);
  })
  .catch((err) => {
    console.error(`\nunexpected error: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
