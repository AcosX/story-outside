import assert from 'node:assert/strict';
import { createSeededRepository, FIXTURE_UUIDS } from '../src/stories/fixture.mjs';
import { ensureOpeningCache, defaultGenerationProfile } from '../src/stories/storyService.mjs';
import { createSession, interruptWithPlayerInput } from '../src/stories/sessionService.mjs';
import { AgentRuntimeError, createAgentRuntime, createMockAgentProvider, recoverRuntime, resumeTurn, runTurn } from '../src/agent/runtime.mjs';

async function setup() {
  const seeded = createSeededRepository();
  const repository = seeded.repository;
  const story = repository.findStoryByUuid(FIXTURE_UUIDS['cafe-rain'].story_uuid);
  const version = repository.findVersion(FIXTURE_UUIDS['cafe-rain'].story_version_uuid);
  const role = version.roles_payload[0];
  const cacheResult = await ensureOpeningCache({ repository, story_version_uuid: version.version_uuid, options: { profile: defaultGenerationProfile() } });
  const cache = cacheResult.cache;
  const session_uuid = '11111111-1111-4111-8111-111111111111';
  createSession({
    repository,
    session_uuid,
    story_uuid: story.story_uuid,
    story_version_uuid: version.version_uuid,
    user_ref: 'user-1',
    role_id: role.id,
    model: 'gpt-test',
    prompt: 'prompt',
    generation_profile: { identifier: cache.generation_profile.identifier, rules_version: cache.generation_profile.rules_version, cache_uuid: cache.cache_uuid, generation_hash: cache.generation_hash },
  });
  return { repository, session_uuid, story, version, role, cache };
}

async function buildRuntime(provider) {
  const { repository, session_uuid, story, version, cache } = await setup();
  return createAgentRuntime({
    repository,
    session_uuid,
    provider,
    system_prompt: { kind: 'system', text: 'sys' },
    tool_definitions: [{ name: 'ask_player_choice' }, { name: 'finish_story' }],
    expected_story_version_uuid: version.version_uuid,
    expected_story_version_checksum: version.checksum,
    expected_model: 'gpt-test',
    expected_generation_profile: { identifier: cache.generation_profile.identifier, rules_version: cache.generation_profile.rules_version, cache_uuid: cache.cache_uuid, generation_hash: cache.generation_hash },
  });
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

await test('createAgentRuntime pins session and rejects missing provider.complete', async () => {
  const { repository, session_uuid, story, version, cache } = await setup();
  assert.throws(() => createAgentRuntime({ repository, session_uuid, provider: {}, system_prompt: {}, tool_definitions: [], expected_story_version_uuid: version.version_uuid, expected_story_version_checksum: version.checksum, expected_model: 'gpt-test', expected_generation_profile: { identifier: cache.generation_profile.identifier, rules_version: cache.generation_profile.rules_version, cache_uuid: cache.cache_uuid, generation_hash: cache.generation_hash } }), (error) => error instanceof AgentRuntimeError && error.code === 'invalid_input');
  assert.throws(() => createAgentRuntime({ repository, session_uuid, provider: createMockAgentProvider(), system_prompt: {}, tool_definitions: [], expected_story_version_uuid: version.version_uuid, expected_story_version_checksum: 'bad', expected_model: 'gpt-test', expected_generation_profile: { identifier: 'profile', rules_version: '1', cache_uuid: cache.cache_uuid } }), (error) => error instanceof AgentRuntimeError && error.code === 'pin_mismatch');
  assert.throws(() => createAgentRuntime({ repository, session_uuid, provider: createMockAgentProvider(), system_prompt: {}, tool_definitions: [], expected_story_version_uuid: version.version_uuid, expected_story_version_checksum: version.checksum, expected_model: 'gpt-test', expected_generation_profile: { identifier: 'profile', rules_version: '1', cache_uuid: cache.cache_uuid, nan: Number.NaN } }), (error) => error instanceof AgentRuntimeError && error.code === 'invalid_input');
});

await test('runTurn supports async providers and records audit fields', async () => {
  const provider = createMockAgentProvider({ handler: async (request) => {
    assert.equal(request.session.session_uuid, '11111111-1111-4111-8111-111111111111');
    return { messages: [{ role: 'assistant', content: 'hello' }] };
  } });
  const runtime = await buildRuntime(provider);
  const state = recoverRuntime(runtime);
  const result = await runTurn(runtime, { request_id: 'req-1', input: { a: 1 }, expected_revision: state.base_revision });
  assert.equal(result.kind, 'narrative');
  assert.match(result.turn_id, /^[0-9a-f-]{36}$/);
  assert.equal(result.request_id, 'req-1');
  assert.equal(result.base_revision, state.base_revision);
  assert.equal(result.base_cursor, state.base_cursor);
  assert.deepEqual(result.messages, [{ role: 'assistant', content: 'hello' }]);
  assert.deepEqual(result.tool_calls, []);
  assert.equal(result.pending, false);
  assert.equal(provider.callCount, 1);
  const repeat = await runTurn(runtime, { request_id: 'req-1', input: { a: 1 }, expected_revision: state.base_revision });
  assert.deepEqual(repeat, result);
  assert.equal(provider.callCount, 1);
});

await test('revision mismatch fails closed before provider call', async () => {
  const provider = createMockAgentProvider({ responses: [{ messages: [{ role: 'assistant', content: 'first' }] }] });
  const runtime = await buildRuntime(provider);
  const state = recoverRuntime(runtime);
  await assert.rejects(() => runTurn(runtime, { input: { a: 1 }, expected_revision: state.base_revision - 1 }), (error) => error instanceof AgentRuntimeError && error.code === 'revision_mismatch');
  assert.equal(provider.callCount, 0);
});

await test('external session revision advance fails closed and provider is not called', async () => {
  const provider = createMockAgentProvider({ responses: [{ messages: [{ role: 'assistant', content: 'first' }] }, { messages: [{ role: 'assistant', content: 'second' }] }] });
  const runtime = await buildRuntime(provider);
  const before = recoverRuntime(runtime);
  await runTurn(runtime, { input: { a: 1 }, expected_revision: before.base_revision });
  const repo = runtime[Object.getOwnPropertySymbols(runtime)[0]].repository;
  interruptWithPlayerInput({ repository: repo, session_uuid: before.session_uuid, text: 'advance', expected_revision: before.base_revision });
  await assert.rejects(() => runTurn(runtime, { input: { a: 2 }, expected_revision: before.base_revision }), (error) => error instanceof AgentRuntimeError && error.code === 'revision_mismatch');
  assert.equal(provider.callCount, 1);
});

await test('tool calls validate options, summary, and classify as tool_call', async () => {
  const provider = createMockAgentProvider({ responses: [{ tool_calls: [{ name: 'ask_player_choice', arguments: { options: [{ id: 'a', label: 'A' }, { id: 'b', text: 'B' }] } }] }] });
  const runtime = await buildRuntime(provider);
  const result = await runTurn(runtime, { input: { a: 1 }, expected_revision: recoverRuntime(runtime).base_revision });
  assert.equal(result.kind, 'tool_call');
  assert.equal(result.pending, true);
  assert.equal(result.tool_calls.length, 1);
  assert.equal(provider.callCount, 1);
  const badRuntime = await buildRuntime(createMockAgentProvider({ responses: [{ tool_calls: [{ name: 'ask_player_choice', arguments: { options: [{ id: 'a' }] } }] }] }));
  await assert.rejects(() => runTurn(badRuntime, { input: { a: 1 }, expected_revision: recoverRuntime(badRuntime).base_revision }), (error) => error instanceof AgentRuntimeError && error.code === 'invalid_tool_call');
});

await test('provider results reject empty, mixed, multi-tool, unknown, and bad payloads', async () => {
  const cases = [
    [{ messages: [] }, 'provider_failure'],
    [{ messages: [{ role: 'assistant', content: 'hi' }], tool_calls: [{ name: 'finish_story', arguments: { summary: 'done' } }] }, 'invalid_tool_call'],
    [{ tool_calls: [{ name: 'ask_player_choice', arguments: { options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } }, { name: 'finish_story', arguments: { summary: 'done' } }] }, 'invalid_tool_call'],
    [{ tool_calls: [{ name: 'unknown', arguments: {} }] }, 'unknown_tool'],
    [{ tool_calls: [{ name: 'finish_story', arguments: { summary: '' } }] }, 'invalid_tool_call'],
  ];
  for (const [response, code] of cases) {
    const runtime = await buildRuntime(createMockAgentProvider({ responses: [response] }));
    await assert.rejects(() => runTurn(runtime, { input: { a: 1 }, expected_revision: recoverRuntime(runtime).base_revision }), (error) => error instanceof AgentRuntimeError && error.code === code);
  }
});

await test('sensitive keys are rejected recursively and provider rejects are sanitized and retryable', async () => {
  const provider = createMockAgentProvider({ handler: async () => { throw new Error('secret token=abc password=def'); } });
  const runtime = await buildRuntime(provider);
  await assert.rejects(() => runTurn(runtime, { input: { auth: { access_token: 'x' } }, expected_revision: recoverRuntime(runtime).base_revision }), (error) => error instanceof AgentRuntimeError && error.code === 'invalid_input');
  const before = recoverRuntime(runtime);
  await assert.rejects(() => runTurn(runtime, { input: { ok: true }, expected_revision: before.base_revision }), (error) => error instanceof AgentRuntimeError && error.code === 'provider_failure');
  assert.equal(provider.callCount, 1);
  await assert.rejects(() => runTurn(runtime, { input: { ok: true }, expected_revision: before.base_revision }), (error) => error instanceof AgentRuntimeError && error.code === 'provider_failure');
  assert.equal(provider.callCount, 2);
});

await test('system_prompt and tool_definitions reject sensitive keys and camelCase accessToken', async () => {
  const base = await setup();
  assert.throws(() => createAgentRuntime({
    repository: base.repository,
    session_uuid: base.session_uuid,
    provider: createMockAgentProvider(),
    system_prompt: { kind: 'system', secrets: { accessToken: 'x' } },
    tool_definitions: [{ name: 'ask_player_choice' }],
    expected_story_version_uuid: base.version.version_uuid,
    expected_story_version_checksum: base.version.checksum,
    expected_model: 'gpt-test',
    expected_generation_profile: { identifier: base.cache.generation_profile.identifier, rules_version: base.cache.generation_profile.rules_version, cache_uuid: base.cache.cache_uuid, generation_hash: base.cache.generation_hash },
  }), (error) => error instanceof AgentRuntimeError && error.code === 'invalid_input');

  assert.throws(() => createAgentRuntime({
    repository: base.repository,
    session_uuid: base.session_uuid,
    provider: createMockAgentProvider(),
    system_prompt: { kind: 'system', text: 'sys' },
    tool_definitions: [{ name: 'ask_player_choice', headers: { accept: 'x' } }],
    expected_story_version_uuid: base.version.version_uuid,
    expected_story_version_checksum: base.version.checksum,
    expected_model: 'gpt-test',
    expected_generation_profile: { identifier: base.cache.generation_profile.identifier, rules_version: base.cache.generation_profile.rules_version, cache_uuid: base.cache.cache_uuid, generation_hash: base.cache.generation_hash },
  }), (error) => error instanceof AgentRuntimeError && error.code === 'invalid_input');
});

await test('turn_id is a valid UUID', async () => {
  const runtime = await buildRuntime(createMockAgentProvider({ responses: [{ messages: [{ role: 'assistant', content: 'hello' }] }] }));
  const result = await runTurn(runtime, { input: { a: 1 }, expected_revision: recoverRuntime(runtime).base_revision });
  assert.match(result.turn_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

await test('resumeTurn without args is read-only and deep-cloned', async () => {
  const provider = createMockAgentProvider({ responses: [{ messages: [{ role: 'assistant', content: 'hello' }] }] });
  const runtime = await buildRuntime(provider);
  const snapshot = await resumeTurn(runtime);
  assert.equal(provider.callCount, 0);
  assert.ok(snapshot.session_uuid);
  snapshot.pinned.model = 'mutated';
  assert.notEqual(recoverRuntime(runtime).pinned.model, 'mutated');
});

await test('runtime does not alter canonical history', async () => {
  const provider = createMockAgentProvider({ responses: [{ messages: [{ role: 'assistant', content: 'hello' }] }] });
  const runtime = await buildRuntime(provider);
  const before = recoverRuntime(runtime);
  await runTurn(runtime, { input: { a: 1 }, expected_revision: before.base_revision });
  const after = recoverRuntime(runtime);
  assert.deepEqual(after.canonical_history, before.canonical_history);
});
