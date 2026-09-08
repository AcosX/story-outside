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
  assert.deepEqual(result.items, [{ type: 'narration', text: 'hello' }]);
  assert.equal(result.tool_call, null);
  assert.equal(result.pending, false);
  assert.match(result.pending_id, /^[0-9a-f-]{36}$/);
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
  // ClickUp 08 P1.3: a tool_call MUST ride on a batch that already
  // carries at least one narrative item. The runtime normalises the
  // explicit items + tool_call shape into the same wire form as a
  // batched narrative turn.
  const provider = createMockAgentProvider({ responses: [{
    items: [{ role: 'assistant', type: 'narration', text: 'line 1' }],
    tool_call: { id: 'tool-123', name: 'ask_player_choice', arguments: { question: 'choose', options: [{ id: 'a', label: 'A' }, { id: 'b', text: 'B' }] } },
  }] });
  const runtime = await buildRuntime(provider);
  const result = await runTurn(runtime, { input: { a: 1 }, expected_revision: recoverRuntime(runtime).base_revision });
  assert.equal(result.kind, 'tool_call');
  assert.equal(result.pending, true);
  assert.equal(result.tool_call.tool_call_id, 'tool-123');
  assert.equal(result.tool_call.kind, 'choice_required');
  assert.equal(result.tool_result.kind, 'choice_required');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].text, 'line 1');
  assert.equal(provider.callCount, 1);
});

await test('tool envelope carries session turn and revision metadata', async () => {
  // ClickUp 08 P1.3: tool_call rides on a batch with at least one
  // narrative item.
  const provider = createMockAgentProvider({ responses: [{
    items: [{ role: 'assistant', type: 'narration', text: 'closing line' }],
    tool_call: { id: 'tool-meta', name: 'finish_story', arguments: { summary: 'done', ending: 'ending', original_difference: 'diff', key_choices: ['x'], character_outcomes: [{ character: 'A', fate: 'B' }] } },
  }] });
  const runtime = await buildRuntime(provider);
  const state = recoverRuntime(runtime);
  const result = await runTurn(runtime, { input: { a: 1 }, expected_revision: state.base_revision });
  assert.match(result.turn_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(result.tool_envelope.session_uuid, state.session_uuid);
  assert.equal(result.tool_envelope.base_revision, state.base_revision);
  assert.equal(result.tool_envelope.turn_id, result.turn_id);
  assert.equal(result.tool_envelope.tool_call_id, 'tool-meta');
  assert.equal(result.tool_result.session_uuid, state.session_uuid);
  assert.equal(result.tool_result.turn_id, result.turn_id);
  assert.equal(result.tool_result.base_revision, state.base_revision);
});

await test('provider tool calls reject unknown fields, duplicates, and missing ids', async () => {
  // ClickUp 08 P1.3: a tool_call must ride on a batch with at least one
  // narrative item, so each case below ships a minimal items[] alongside
  // the bad tool_call envelope.
  const narrative = [{ role: 'assistant', type: 'narration', text: 'before tool' }];
  const cases = [
    [{ items: narrative, tool_call: { id: 'tool-err', name: 'ask_player_choice', arguments: { question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], extra: true } } }, 'invalid_tool_call'],
    [{ items: narrative, tool_call: { id: 'tool-dup', name: 'ask_player_choice', arguments: { question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] } } }, 'invalid_tool_call'],
    [{ items: narrative, tool_call: { name: 'ask_player_choice', arguments: { question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } } }, 'invalid_tool_call'],
  ];
  for (const [response, code] of cases) {
    const runtime = await buildRuntime(createMockAgentProvider({ responses: [response] }));
    let caught = null;
    try {
      await runTurn(runtime, { input: { a: 1 }, expected_revision: recoverRuntime(runtime).base_revision });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof AgentRuntimeError);
    assert.equal(caught.code, code);
  }
});

await test('provider results reject empty, mixed, multi-tool, unknown, and bad payloads', async () => {
  // ClickUp 08 P1.3: tool-only batches (tool_calls without messages/items)
  // are explicitly rejected. The legacy messages + tool_calls mixed shape
  // is also rejected; the legacy multi-tool_calls array is rejected;
  // unknown tool names / bad payloads fail closed; a 5-item batch is
  // rejected by the explicit cap.
  const cases = [
    [{ messages: [] }, 'invalid_tool_call'],
    // Legacy multi-tool_calls array (2 entries) is rejected even when 1..4
    // messages are present: the batch contract allows exactly one OPTIONAL
    // FINAL tool call.
    [{ messages: [{ role: 'assistant', content: 'hi' }], tool_calls: [{ name: 'ask_player_choice', arguments: { question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } }, { name: 'finish_story', arguments: { summary: 'done', ending: 'e', original_difference: 'd', key_choices: ['x'], character_outcomes: [{ character: 'A', fate: 'B' }] } }] }, 'invalid_tool_call'],
    [{ tool_calls: [{ name: 'ask_player_choice', arguments: { options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } }, { name: 'finish_story', arguments: { summary: 'done' } }] }, 'invalid_tool_call'],
    [{ tool_calls: [{ name: 'unknown', arguments: {} }] }, 'invalid_tool_call'],
    [{ tool_calls: [{ name: 'finish_story', arguments: { summary: '' } }] }, 'invalid_tool_call'],
    [{ items: [{ role: 'assistant', type: 'narration', text: 'hi' }, { role: 'assistant', type: 'narration', text: 'hi 2' }, { role: 'assistant', type: 'narration', text: 'hi 3' }, { role: 'assistant', type: 'narration', text: 'hi 4' }, { role: 'assistant', type: 'narration', text: 'hi 5' }] }, 'invalid_tool_call'],
  ];
  for (const [response, code] of cases) {
    const runtime = await buildRuntime(createMockAgentProvider({ responses: [response] }));
    await assert.rejects(() => runTurn(runtime, { input: { a: 1 }, expected_revision: recoverRuntime(runtime).base_revision }), (error) => error instanceof AgentRuntimeError && error.code === code);
  }
});

await test('provider tool calls reject empty optional fields', async () => {
  // ClickUp 08 P1.3: tool_call rides on a batch with at least one
  // narrative item.
  const badProvider = createMockAgentProvider({ responses: [{
    items: [{ role: 'assistant', type: 'narration', text: 'closing' }],
    tool_call: { id: 'tool-empty', name: 'finish_story', arguments: { summary: 'done', ending: 'ending', original_difference: 'diff', key_choices: ['x'], character_outcomes: [{ character: 'A', fate: 'B', change: '' }] } },
  }] });
  const runtime = await buildRuntime(badProvider);
  await assert.rejects(() => runTurn(runtime, { input: { a: 1 }, expected_revision: recoverRuntime(runtime).base_revision }), (error) => error instanceof AgentRuntimeError && error.code === 'invalid_tool_call');
});

await test('legacy messages + single tool_call normalises unambiguously to items + final tool', async () => {
  // ClickUp 08 P1.3: the legacy { messages: 1..4, tool_calls: [<one>] }
  // shape is unambiguous — messages are the ordered narrative items and
  // the single tool call rides the batch as the optional FINAL item.
  const provider = createMockAgentProvider({ responses: [{
    messages: [{ role: 'assistant', content: 'beat one' }, { role: 'assistant', content: 'beat two' }],
    tool_calls: [{ id: 'legacy-tool', name: 'ask_player_choice', arguments: { question: 'choose', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } }],
  }] });
  const runtime = await buildRuntime(provider);
  const result = await runTurn(runtime, { input: { a: 1 }, expected_revision: recoverRuntime(runtime).base_revision });
  assert.equal(result.kind, 'tool_call');
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].text, 'beat one');
  assert.equal(result.items[1].text, 'beat two');
  assert.equal(result.tool_call.tool_call_id, 'legacy-tool');
  assert.equal(result.tool_call.kind, 'choice_required');
  // The tool is NOT part of pending.events; it rides separately.
  assert.equal(result.pending_total, 2);
  assert.equal(provider.callCount, 1);
});

await test('tool_call-like entry inside items is rejected (tool must be final, never in narrative)', async () => {
  // A tool may never hide inside the narrative items array.
  const badProvider = createMockAgentProvider({ responses: [{
    items: [{ role: 'assistant', type: 'tool_call', text: 'sneaky tool' }],
  }] });
  const runtime = await buildRuntime(badProvider);
  await assert.rejects(() => runTurn(runtime, { input: { a: 1 }, expected_revision: recoverRuntime(runtime).base_revision }), (error) => error instanceof AgentRuntimeError && error.code === 'invalid_tool_call');
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

await test('tool envelopes carry normalized tool results and preserve canonical history', async () => {
  // ClickUp 08 P1.3: tool_call rides on a batch with at least one narrative item.
  const provider = createMockAgentProvider({ responses: [{
    items: [{ role: 'assistant', type: 'narration', text: 'preamble' }],
    tool_call: { id: 'tool-123', name: 'ask_player_choice', arguments: { question: 'choose', options: [{ id: 'a', label: 'A' }, { id: 'b', text: 'B' }] } },
  }] });
  const runtime = await buildRuntime(provider);
  const before = recoverRuntime(runtime);
  const result = await runTurn(runtime, { input: { a: 1 }, expected_revision: before.base_revision });
  assert.equal(result.kind, 'tool_call');
  assert.equal(result.pending, true);
  assert.equal(result.tool_call.tool_call_id, 'tool-123');
  assert.equal(result.tool_result.kind, 'choice_required');
  assert.equal(result.tool_envelope.terminal, false);
  const after = recoverRuntime(runtime);
  assert.deepEqual(after.canonical_history, before.canonical_history);
});

await test('tool calls reject unknown fields and duplicate ids through runtime', async () => {
  // ClickUp 08 P1.3: tool_call rides on a batch with at least one narrative item.
  const badProvider = createMockAgentProvider({ responses: [{
    items: [{ role: 'assistant', type: 'narration', text: 'bad prelude' }],
    tool_call: { name: 'ask_player_choice', arguments: { question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }], extra: 1 } },
  }] });
  const runtime = await buildRuntime(badProvider);
  await assert.rejects(() => runTurn(runtime, { input: { a: 1 }, expected_revision: recoverRuntime(runtime).base_revision }), (error) => error instanceof AgentRuntimeError && error.code === 'invalid_tool_call');
});

await test('finish_story tool result marks terminal', async () => {
  // ClickUp 08 P1.3: tool_call rides on a batch with at least one narrative item.
  const provider = createMockAgentProvider({ responses: [{
    items: [{ role: 'assistant', type: 'narration', text: 'final beat' }],
    tool_call: { id: 'tool-finish', name: 'finish_story', arguments: { summary: 'done', ending: 'ending', original_difference: 'diff', key_choices: ['x'], character_outcomes: [{ character: 'A', fate: 'B' }] } },
  }] });
  const runtime = await buildRuntime(provider);
  const result = await runTurn(runtime, { input: { a: 1 }, expected_revision: recoverRuntime(runtime).base_revision });
  assert.equal(result.tool_result.kind, 'story_finished');
  assert.equal(result.tool_envelope.terminal, true);
});

await test('concurrent same-request turns share one paid provider call; competing input fails before provider', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const provider = createMockAgentProvider({ handler: async () => { await gate; return {items:[{text:'并发叙事'}]}; } });
  const runtime = await buildRuntime(provider);
  const revision = recoverRuntime(runtime).base_revision;
  const args={request_id:'same-concurrent',input:{text:'继续'},expected_revision:revision};
  const first=runTurn(runtime,args);
  const second=runTurn(runtime,args);
  await assert.rejects(runTurn(runtime,{...args,input:{text:'另一个选择'}}), error=>error.code==='pending_conflict');
  release();
  const [a,b]=await Promise.all([first,second]);
  assert.equal(provider.callCount,1);
  assert.equal(a.turn_id,b.turn_id);
  assert.equal(a.pending_id,b.pending_id);
});

await test('interrupt starts new revision while old generation finishes; stale result cannot clear the new single-flight lock', async () => {
  let releaseOld, releaseNew;
  const oldGate = new Promise(resolve => { releaseOld=resolve; });
  const newGate = new Promise(resolve => { releaseNew=resolve; });
  const oldProvider=createMockAgentProvider({handler:async()=>{await oldGate;return {items:[{text:'应丢弃的旧叙事'}]};}});
  const oldRuntime=await buildRuntime(oldProvider);
  const recovered=recoverRuntime(oldRuntime);
  const oldTurn=runTurn(oldRuntime,{request_id:'before-interrupt',input:{text:'继续'},expected_revision:recovered.base_revision});
  const oldRejected=assert.rejects(oldTurn,error=>error.code==='revision_mismatch');
  const interrupted=interruptWithPlayerInput({repository:oldRuntime.repository,session_uuid:recovered.session_uuid,text:'我决定转身离开',client_request_id:'during-ai',expected_revision:recovered.base_revision});
  const provider=createMockAgentProvider({handler:async()=>{await newGate;return {items:[{text:'玩家离开后的新叙事'}]};}});
  const buildNext=()=>createAgentRuntime({repository:oldRuntime.repository,session_uuid:recovered.session_uuid,provider,system_prompt:{text:'sys'},tool_definitions:[],expected_story_version_uuid:recovered.pinned.story_version_uuid,expected_story_version_checksum:recovered.pinned.story_version_checksum,expected_model:recovered.pinned.model,expected_generation_profile:recovered.pinned.generation_profile});
  const nextArgs={request_id:'after-interrupt',input:{text:'我决定转身离开'},expected_revision:interrupted.revision};
  const next=runTurn(buildNext(),nextArgs);
  assert.equal(provider.callCount,1);
  releaseOld();await oldRejected;
  const duplicate=runTurn(buildNext(),nextArgs);
  assert.equal(provider.callCount,1);
  releaseNew();
  const [a,b]=await Promise.all([next,duplicate]);
  assert.equal(a.turn_id,b.turn_id);
  assert.equal(a.items[0].text,'玩家离开后的新叙事');
  assert.equal(provider.callCount,1);
});
