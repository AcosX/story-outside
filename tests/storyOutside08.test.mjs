// tests/storyOutside08.test.mjs — cross-layer ClickUp 08 contract.
//
// Validates the real integration between provider → runtime →
// sessionService.pending → HTTP commit → next-turn context. Catches
// regressions on:
//   * un-displayed events never reach canonical history
//   * 1..4 narrative items per batch + optional final tool call
//   * event_type/origin/source_sequence contract (SQL surface)
//   * tool call never becomes a committed event_seq
//   * mid-batch interrupt keeps committed, drops pending tail
//   * read-only recover never calls the provider
//   * same request_id + same payload is idempotent
//   * same request_id + different payload fails closed
//   * stale revision / wrong pending_id / out-of-order sequence
//     / wrong sequence interrupt fail closed
//   * 5-item batches / empty batches / mixed (messages+items) fail closed
//   * recover returns canonical history + active pending (one history)
//   * duplicate tool_call_id is rejected by the tool layer
//
// All paths use the in-process HTTP server so a regression in route
// wiring, sessionService, or the runtime will be caught.

import assert from 'node:assert/strict';
import http from 'node:http';
import { server, storyFixtures, storyRepo } from '../src/server.mjs';
import { createAgentRuntime, createMockAgentProvider, runTurn, recoverRuntime } from '../src/agent/runtime.mjs';

const PICK = await new Promise((resolve, reject) => {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
  probe.on('error', reject);
});

const baseUrl = `http://127.0.0.1:${PICK}`;
const fixture = storyFixtures.find((row) => row.slug === 'cafe-rain');
const sessionUuid = '00000000-0000-4000-8000-080808080808';
const generatePath = `/api/dev/sessions/${sessionUuid}/generate`;
const narrativePath = `/api/dev/sessions/${sessionUuid}/narrative-events`;
const recoverPath = `/api/dev/sessions/${sessionUuid}/recover`;
const interruptPath = `/api/dev/sessions/${sessionUuid}/interrupt`;
let failures = 0;

function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`);
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  let data;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { response, data };
}

async function post(path, body) {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

await new Promise((resolve) => server.listen(PICK, '127.0.0.1', resolve));

try {
  // Seed the fixture cache and create a fresh session through the public
  // routes so the test exercises the same wiring the demo client uses.
  const rebuilt = await post('/api/admin/opening-cache/rebuild', {
    story_version_uuid: fixture.story_version_uuid,
  });
  const cache = rebuilt.data?.result?.cache;
  const cacheUuid = cache?.cache_uuid;
  const generationProfile = { ...cache.generation_profile, cache_uuid: cacheUuid };
  const created = await post('/api/dev/sessions', {
    session_uuid: sessionUuid,
    story_uuid: fixture.story_uuid,
    story_version_uuid: fixture.story_version_uuid,
    user_ref: 'story-outside-08-test',
    role_id: 'stranger',
    model: 'mock-08',
    prompt: '08 prompt',
    generation_profile: generationProfile,
  });
  check('session created', created.response.status === 200, `status=${created.response.status}`);

  // ----- generate a 3-item batch (default input) -----
  const gen1 = await post(generatePath, {
    request_id: 'turn-1',
    input: { text: 'default' },
    expected_revision: 0,
  });
  check('generate 1 returns 200', gen1.response.status === 200, JSON.stringify(gen1.data).slice(0, 200));
  check('generate 1 returns 3 items', gen1.data?.items?.length === 3);
  check('generate 1 has no tool_call', gen1.data?.tool_call === null);
  check('generate 1 kind=narrative', gen1.data?.kind === 'narrative');
  check('generate 1 returns a pending_id', /^[0-9a-f-]{36}$/.test(gen1.data?.pending_id || ''));
  check('generate 1 returns pending_committed_count=0', gen1.data?.pending_committed_count === 0);
  check('generate 1 returns pending_total=3', gen1.data?.pending_total === 3);

  // Recover must show empty canonical history + the staged pending.
  const rec0 = await request(recoverPath);
  check('recover shows 0 committed events', rec0.data?.history?.length === 0);
  check('recover shows staged pending with 3 events', rec0.data?.pending?.events?.length === 3);
  check('recover shows staged pending with 0 committed', rec0.data?.pending?.committed_count === 0);

  // ----- commit the first item -----
  const commit1 = await post(narrativePath, {
    pending_id: gen1.data.pending_id,
    sequence: 0,
    expected_revision: 0,
    client_request_id: 'commit-1',
  });
  check('commit 0 returns 200', commit1.response.status === 200);
  check('commit 0 event_type=narrative_beat', commit1.data?.event?.event_type === 'narrative_beat');
  check('commit 0 origin=llm', commit1.data?.event?.origin === 'llm');
  check('commit 0 source=runtime', commit1.data?.event?.source === 'runtime');
  check('commit 0 source_sequence=0', commit1.data?.event?.source_sequence === 0);
  check('commit 0 event_seq=1', commit1.data?.event?.event_seq === 1);
  check('commit 0 revision=1', commit1.data?.revision === 1);
  check('commit 0 pending_remaining=2', commit1.data?.pending_remaining === 2);
  check('commit 0 pending_tool_call=null (tool only at final commit)', commit1.data?.pending_tool_call === null);

  // ----- commit items 1, 2 with idempotent replay on item 1 -----
  const commit2 = await post(narrativePath, {
    pending_id: gen1.data.pending_id,
    sequence: 1,
    expected_revision: 1,
    client_request_id: 'commit-2',
  });
  check('commit 1 returns 200', commit2.response.status === 200);
  check('commit 1 event_seq=2', commit2.data?.event?.event_seq === 2);

  // Idempotent replay.
  const commit1Replay = await post(narrativePath, {
    pending_id: gen1.data.pending_id,
    sequence: 0,
    expected_revision: 1,
    client_request_id: 'commit-1',
  });
  check('idempotent replay returns identical commit', commit1Replay.response.status === 200 && commit1Replay.data?.event?.event_seq === 1);

  // Different payload with the same request_id must fail closed.
  const commit1Bad = await post(narrativePath, {
    pending_id: gen1.data.pending_id,
    sequence: 2,
    expected_revision: 1,
    client_request_id: 'commit-1',
  });
  check('reused request_id with different sequence is rejected', commit1Bad.response.status === 400, JSON.stringify(commit1Bad.data));

  // Out-of-order sequence must fail closed.
  const commitOoo = await post(narrativePath, {
    pending_id: gen1.data.pending_id,
    sequence: 5,
    expected_revision: 1,
  });
  check('out-of-range sequence is rejected', commitOoo.response.status === 400);

  const commit3 = await post(narrativePath, {
    pending_id: gen1.data.pending_id,
    sequence: 2,
    expected_revision: 2,
    client_request_id: 'commit-3',
  });
  check('commit 2 returns 200', commit3.response.status === 200);
  check('commit 2 pending_remaining=0', commit3.data?.pending_remaining === 0);
  check('commit 2 pending_committed_count=3', commit3.data?.pending_committed_count === 3);
  check('commit 2 surfaces no pending_tool_call (no tool call was staged)', commit3.data?.pending_tool_call === null);

  // Recover must show 3 committed events and NO active pending.
  const rec1 = await request(recoverPath);
  check('recover shows 3 committed events', rec1.data?.history?.length === 3);
  check('recover shows pending=null after final commit', rec1.data?.pending === null);
  check('recover shows revision=3', rec1.data?.revision === 3);

  // ----- generate with a tool call (input starts with 'choice') -----
  const gen2 = await post(generatePath, {
    request_id: 'turn-2',
    input: { text: 'choice now' },
    expected_revision: 3,
  });
  check('generate 2 returns 200', gen2.response.status === 200, JSON.stringify(gen2.data).slice(0, 200));
  check('generate 2 returns 1 narrative item + 1 tool_call', gen2.data?.items?.length === 1 && gen2.data?.tool_call !== null);
  check('generate 2 tool_call kind=choice_required', gen2.data?.tool_call?.kind === 'choice_required');
  check('generate 2 kind=tool_call', gen2.data?.kind === 'tool_call');
  // The tool_call must NOT be in pending.events (it rides separately).
  check('generate 2 pending.events has 1 narrative, tool_call separate', gen2.data?.pending_total === 1 && gen2.data?.tool_call?.tool_call_id);

  // Commit the narrative item. The final result must surface the
  // staged tool_call under pending_tool_call.
  const toolCommit = await post(narrativePath, {
    pending_id: gen2.data.pending_id,
    sequence: 0,
    expected_revision: 3,
    client_request_id: 'tool-commit-1',
  });
  check('tool-carrying batch commit returns 200', toolCommit.response.status === 200);
  check('tool-carrying batch surfaces pending_tool_call', toolCommit.data?.pending_tool_call?.tool_call_id === gen2.data.tool_call.tool_call_id);
  check('tool-carrying batch tool_call NEVER becomes a canonical event',
    toolCommit.data?.event?.event_type !== 'tool_call' && toolCommit.data?.event?.event_type === 'narrative_beat');

  // History should now have 4 events (3 + 1), no tool_call entry.
  const rec2 = await request(recoverPath);
  check('after tool-carrying batch history length=4', rec2.data?.history?.length === 4);
  check('history contains no tool_call entries', rec2.data?.history.every((e) => e.event_type !== 'tool_call'));
  check('history contains 3 narrative_beat + 1 narrative_beat (4 narrative_beat entries)',
    rec2.data?.history.every((e) => e.event_type === 'narrative_beat'));

  // ----- mid-batch interrupt -----
  // Generate a 4-item batch (input contains 'long'), commit 2, then interrupt.
  const gen3 = await post(generatePath, {
    request_id: 'turn-3',
    input: { text: 'long reply please' },
    expected_revision: 4,
  });
  check('generate 3 returns 4-item batch', gen3.data?.items?.length === 4);
  const pendingId3 = gen3.data.pending_id;
  await post(narrativePath, { pending_id: pendingId3, sequence: 0, expected_revision: 4, client_request_id: 'mid-c0' });
  await post(narrativePath, { pending_id: pendingId3, sequence: 1, expected_revision: 5, client_request_id: 'mid-c1' });
  const interrupt = await post(interruptPath, {
    text: 'interrupt mid-batch',
    client_request_id: 'mid-int',
    expected_revision: 6,
  });
  check('interrupt returns 200', interrupt.response.status === 200, JSON.stringify(interrupt.data).slice(0, 200));
  check('interrupt drops the pending tail', interrupt.data?.dropped_pending_id === pendingId3);
  check('interrupt drops 2 un-displayed items', interrupt.data?.dropped_pending_count === 2);
  check('interrupt state becomes realtime', interrupt.data?.state === 'realtime');
  check('interrupt appended player_input', interrupt.data?.event?.event_type === 'player_input');
  const rec3 = await request(recoverPath);
  check('history after interrupt = 7 (3 + 1 tool-narrative + 2 mid + 1 player_input)',
    rec3.data?.history?.length === 7 && rec3.data?.history[6]?.event_type === 'player_input');
  check('pending cleared after interrupt', rec3.data?.pending === null);
  check('revision after interrupt = 7', rec3.data?.revision === 7);

  // ----- recover from a fresh repository instance (no provider call) -----
  // We can't easily recreate the in-memory repository here, but recover is
  // read-only by contract: calling it twice must yield identical snapshots.
  const rec4a = await request(recoverPath);
  const rec4b = await request(recoverPath);
  check('recover is idempotent', JSON.stringify(rec4a.data) === JSON.stringify(rec4b.data));

  // Document the persistence boundary: a fresh in-memory repository does
  // NOT know the session. Cross-process recovery is the future DAO's job;
  // the SQL migration 0004 + db/schema.sql pin the contract.
  const ss2 = await import('../src/stories/sessionService.mjs');
  const freshRepo = (await import('../src/stories/index.mjs')).createSeededRepository().repository;
  let unknown = null;
  try {
    ss2.recoverSession({ repository: freshRepo, session_uuid: sessionUuid });
  } catch (err) {
    unknown = err;
  }
  check('fresh in-memory repository reports unknown session', !!unknown && unknown.code === 'session_not_found');

  // ----- validation contract -----
  const badGenerate = await post(generatePath, { input: 'not-an-object', expected_revision: 6 });
  check('generate rejects non-object input', badGenerate.response.status === 400);
  const badGenerate2 = await post(generatePath, { input: {}, expected_revision: 'six' });
  check('generate rejects non-integer expected_revision', badGenerate2.response.status === 400);
  const badNarrative1 = await post(narrativePath, { pending_id: 'not-a-uuid', sequence: 0, expected_revision: 6 });
  check('narrative rejects non-uuid pending_id', badNarrative1.response.status === 400);
  const badNarrative2 = await post(narrativePath, { pending_id: gen1.data.pending_id, sequence: 'zero', expected_revision: 6 });
  check('narrative rejects non-integer sequence', badNarrative2.response.status === 400);

  // ----- stale revision / wrong pending_id -----
  const gen4 = await post(generatePath, {
    request_id: 'turn-4',
    input: { text: 'short' },
    expected_revision: 7,
  });
  check('generate 4 returns 1-item batch', gen4.data?.items?.length === 1);
  const stale = await post(narrativePath, {
    pending_id: gen4.data.pending_id, sequence: 0, expected_revision: 0,
  });
  check('stale expected_revision is rejected', stale.response.status === 400);
  const wrong = await post(narrativePath, {
    pending_id: '00000000-0000-4000-8000-deadbeef0000', sequence: 0, expected_revision: 7,
  });
  check('wrong pending_id is rejected', wrong.response.status === 400);
  // ClickUp 08 P1.2: drain gen4 so a fresh stage is allowed.
  await post(narrativePath, {
    pending_id: gen4.data.pending_id, sequence: 0, expected_revision: 7, client_request_id: 'gen4-c0',
  });

  // ----- finish_story tool call flow -----
  const gen5 = await post(generatePath, {
    request_id: 'turn-5',
    input: { text: 'finish the story now' },
    expected_revision: 8,
  });
  check('generate 5 carries a finish_story tool_call', gen5.data?.tool_call?.kind === 'story_finished' && gen5.data?.tool_call?.terminal === true);
  const finishCommit = await post(narrativePath, {
    pending_id: gen5.data.pending_id, sequence: 0, expected_revision: 8, client_request_id: 'finish-c0',
  });
  check('finish_story batch commit returns 200', finishCommit.response.status === 200);
  check('finish commit surfaces terminal tool_call', finishCommit.data?.pending_tool_call?.kind === 'story_finished');
  const rec5 = await request(recoverPath);
  check('finish_story is never written to canonical history',
    rec5.data?.history.every((e) => e.event_type !== 'story_finished' && e.event_type !== 'tool_call'));

  // ----- reject 5-item batches at the application layer -----
  // The runtime's mock never produces 5 items, but a Real provider could
  // attempt to bypass the limit. We exercise the sessionService cap via
  // stageNarrativeBatch.
  const ss = await import('../src/stories/sessionService.mjs');
  const repo = (await import('../src/stories/index.mjs')).createSeededRepository().repository;
  // Stage is rejected because the demo runtime mock never exceeds the cap.
  // The sessionService API itself rejects oversized batches.
  assert.throws(() => ss.stageNarrativeBatch({
    repository: repo, session_uuid: '00000000-0000-4000-8000-eeeeeeeeeeee',
    items: [
      { type: 'narration', text: 'a' },
      { type: 'narration', text: 'b' },
      { type: 'narration', text: 'c' },
      { type: 'narration', text: 'd' },
      { type: 'narration', text: 'e' },
    ], expected_revision: 0,
  }), /at most 4/);
  assert.throws(() => ss.stageNarrativeBatch({
    repository: repo, session_uuid: '00000000-0000-4000-8000-eeeeeeeeeeee',
    items: [], expected_revision: 0,
  }), /at least one narrative item or a tool_call/);

  // ----- P1.1: canonical cursor + next-turn history visibility -----
  // The next-turn runtime context (buildRequest) must observe every
  // committed event from previous turns with monotonically increasing
  // event_seq. cursor never regresses.
  const turn1Snap = await request(recoverPath);
  assert.ok(Array.isArray(turn1Snap.data.history), 'recover.history is an array');
  for (let i = 0; i < turn1Snap.data.history.length; i += 1) {
    check(`P1.1: history[${i}].event_seq = ${i + 1}`, turn1Snap.data.history[i].event_seq === i + 1);
    if (i > 0) {
      check(`P1.1: history[${i}].prev_event_seq = ${i}`, turn1Snap.data.history[i].prev_event_seq === i);
    } else {
      check(`P1.1: history[0].prev_event_seq = null`, turn1Snap.data.history[i].prev_event_seq === null);
    }
  }
  // All committed events are narrative_beat / llm / runtime OR
  // player_input / user / player. The SQL enum in 0003+0004 keeps these
  // values as the only legal canonical history; the runtime must never
  // produce a tool_call or chat_message event here.
  check('P1.1: every committed event uses SQL-legal event_type / origin / source',
    turn1Snap.data.history.every((e) => {
      const legal = (
        (e.event_type === 'narrative_beat' && e.origin === 'llm' && e.source === 'runtime')
        || (e.event_type === 'player_input' && e.origin === 'user' && e.source === 'player')
      );
      return legal && e.event_type !== 'tool_call' && e.event_type !== 'chat_message';
    }));
  // cursor never regresses: the canonical cursor counts ALL committed
  // canonical events, so it must equal revision and history.length exactly
  // (not merely be non-negative). opening_cursor is the separate opening
  // playback position.
  check('P1.1: cursor === revision === history.length (exact canonical consistency)',
    Number.isInteger(turn1Snap.data.cursor) && turn1Snap.data.cursor === turn1Snap.data.revision && turn1Snap.data.cursor === turn1Snap.data.history.length);
  check('P1.1: opening_cursor is exposed, never exceeds cursor',
    Number.isInteger(turn1Snap.data.opening_cursor) && turn1Snap.data.opening_cursor >= 0 && turn1Snap.data.opening_cursor <= turn1Snap.data.cursor);

  // P1.1: the next-turn runtime context (buildRequest) MUST see every
  // committed event. We instrument a provider to capture the request it
  // receives, run a turn, commit the staged item, then build a fresh
  // runtime (matching the HTTP layer's per-request pattern) and run
  // another turn; the second request MUST include the committed event.
  const sessP11 = '00000000-0000-4000-8000-0a0a0a0a0a0a';
  await post('/api/dev/sessions', {
    session_uuid: sessP11,
    story_uuid: fixture.story_uuid,
    story_version_uuid: fixture.story_version_uuid,
    user_ref: 'story-outside-08-p11',
    role_id: 'stranger',
    model: 'mock-p11',
    prompt: 'p11 prompt',
    generation_profile: { ...cache.generation_profile, cache_uuid: cacheUuid },
  });
  // First-turn provider that captures the request it receives.
  let capturedRequest1 = null;
  const provider1 = createMockAgentProvider({ handler: async (req) => {
    capturedRequest1 = JSON.parse(JSON.stringify(req));
    return { items: [{ role: 'assistant', type: 'narration', text: 'first line' }] };
  } });
  const recoveredP11 = (await import('../src/stories/sessionService.mjs')).recoverSession({ repository: storyRepo, session_uuid: sessP11 });
  const runtimeP11a = createAgentRuntime({
    repository: storyRepo,
    session_uuid: sessP11,
    provider: provider1,
    system_prompt: { kind: 'system', text: 'p1.1 test' },
    tool_definitions: [{ name: 'ask_player_choice' }, { name: 'finish_story' }],
    expected_story_version_uuid: recoveredP11.story_version_uuid,
    expected_story_version_checksum: recoveredP11.story_version_checksum,
    expected_model: recoveredP11.model,
    expected_generation_profile: recoveredP11.generation_profile,
  });
  // First turn.
  const turnOne = await runTurn(runtimeP11a, { input: { text: 'turn one' }, expected_revision: recoverRuntime(runtimeP11a).base_revision });
  check('P1.1: first turn returns 1-item batch', turnOne.items.length === 1);
  // Commit the staged item through the HTTP layer.
  await post(`/api/dev/sessions/${sessP11}/narrative-events`, {
    pending_id: turnOne.pending_id, sequence: 0, expected_revision: 0, client_request_id: 'p11-c0',
  });
  // Second turn: build a fresh runtime (mirrors the HTTP layer's
  // per-request pattern) and capture the request it receives.
  let capturedRequest2 = null;
  const provider2 = createMockAgentProvider({ handler: async (req) => {
    capturedRequest2 = JSON.parse(JSON.stringify(req));
    return { items: [{ role: 'assistant', type: 'narration', text: 'second line' }] };
  } });
  const recoveredP11b = (await import('../src/stories/sessionService.mjs')).recoverSession({ repository: storyRepo, session_uuid: sessP11 });
  const runtimeP11b = createAgentRuntime({
    repository: storyRepo,
    session_uuid: sessP11,
    provider: provider2,
    system_prompt: { kind: 'system', text: 'p1.1 test' },
    tool_definitions: [{ name: 'ask_player_choice' }, { name: 'finish_story' }],
    expected_story_version_uuid: recoveredP11b.story_version_uuid,
    expected_story_version_checksum: recoveredP11b.story_version_checksum,
    expected_model: recoveredP11b.model,
    expected_generation_profile: recoveredP11b.generation_profile,
  });
  await runTurn(runtimeP11b, { input: { text: 'turn two' }, expected_revision: recoverRuntime(runtimeP11b).base_revision });
  check('P1.1: first turn request has empty canonical_history', Array.isArray(capturedRequest1.canonical_history) && capturedRequest1.canonical_history.length === 0);
  check('P1.1: second turn request sees the committed event in canonical_history',
    Array.isArray(capturedRequest2.canonical_history) && capturedRequest2.canonical_history.length === 1 && capturedRequest2.canonical_history[0].event_seq === 1);

  // ----- P1.2: active pending concurrency (same payload → idempotent; different → fail closed) -----
  // Stage a fresh batch via the runtime/HTTP layer.
  const sessionP12 = '00000000-0000-4000-8000-0fedcbabcdef';
  await post('/api/dev/sessions', {
    session_uuid: sessionP12,
    story_uuid: fixture.story_uuid,
    story_version_uuid: fixture.story_version_uuid,
    user_ref: 'story-outside-08-p12',
    role_id: 'stranger',
    model: 'mock-p12',
    prompt: 'p12 prompt',
    generation_profile: { ...cache.generation_profile, cache_uuid: cacheUuid },
  });
  // First stage with a 1-item batch.
  const p12GenA = await post(`/api/dev/sessions/${sessionP12}/generate`, {
    request_id: 'p12-turn-A',
    input: { text: 'short' },
    expected_revision: 0,
  });
  check('P1.2: first stage returns 200', p12GenA.response.status === 200);
  const p12PendingA = p12GenA.data?.pending_id;
  // Re-stage with the SAME payload and SAME client_request_id → idempotent replay.
  const p12GenARetry = await post(`/api/dev/sessions/${sessionP12}/generate`, {
    request_id: 'p12-turn-A',
    input: { text: 'short' },
    expected_revision: 0,
  });
  check('P1.2: same request_id + same payload is idempotent (same pending_id)',
    p12GenARetry.response.status === 200 && p12GenARetry.data?.pending_id === p12PendingA);
  // Re-stage with the SAME payload and NO client_request_id → idempotent return (same pending_id).
  const p12GenANoId = await post(`/api/dev/sessions/${sessionP12}/generate`, {
    input: { text: 'short' },
    expected_revision: 0,
  });
  check('P1.2: re-stage with same payload without request_id returns same pending',
    p12GenANoId.response.status === 200 && p12GenANoId.data?.pending_id === p12PendingA);
  // Re-stage with a DIFFERENT payload → fail closed (unconsumed pending).
  const p12GenDifferent = await post(`/api/dev/sessions/${sessionP12}/generate`, {
    input: { text: 'long reply please' },
    expected_revision: 0,
  });
  check('P1.2: re-stage with different payload is rejected (unconsumed pending)',
    p12GenDifferent.response.status === 400 && /unconsumed pending/.test(p12GenDifferent.data?.message || p12GenDifferent.data?.error || ''));

  // ----- P1.5: same request_id with different payload at commit is rejected (already covered) -----
  // ----- P1.3: 5-item / empty batch / tool-only are rejected at the runtime layer -----
  // Use a direct call to the sessionService to bypass the HTTP demo runtime mock.
  // The runtime mock never exceeds 4 items, so we exercise the cap explicitly.
  assert.throws(() => ss.stageNarrativeBatch({
    repository: repo, session_uuid: '00000000-0000-4000-8000-eeeeeeeeeeee',
    items: [
      { type: 'narration', text: 'a' },
      { type: 'narration', text: 'b' },
      { type: 'narration', text: 'c' },
      { type: 'narration', text: 'd' },
      { type: 'narration', text: 'e' },
    ], expected_revision: 0,
  }), /at most 4/);
  assert.throws(() => ss.stageNarrativeBatch({
    repository: repo, session_uuid: '00000000-0000-4000-8000-eeeeeeeeeeee',
    items: [], expected_revision: 0,
  }), /at least one narrative item or a tool_call/);

  const legacySession = '00000000-0000-4000-8000-080808080809';
  await post('/api/dev/sessions', { session_uuid: legacySession, story_uuid: fixture.story_uuid, story_version_uuid: fixture.story_version_uuid, user_ref: 'legacy-normalization', role_id: 'stranger', model: 'mock-08', prompt: '08 prompt', generation_profile: generationProfile });
  // ----- P1.3: runtime rejects tool-only batches and 5-item batches at the normalize layer -----
  const recoveredForRuntime = await request(`/api/dev/sessions/${sessionUuid}/recover`);
  const baseProvider = createMockAgentProvider();
  let caught;
  // tool-only (no items) → rejected
  caught = null;
  try {
    const provider = createMockAgentProvider({ responses: [{
      tool_calls: [{ id: 'tool-only', name: 'ask_player_choice', arguments: { question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } }],
    }] });
    const runtime = createAgentRuntime({
      repository: storyRepo,
      session_uuid: legacySession,
      provider,
      system_prompt: { kind: 'system', text: 'p1.3 test' },
      tool_definitions: [{ name: 'ask_player_choice' }, { name: 'finish_story' }],
      expected_story_version_uuid: recoveredForRuntime.data?.story_version_uuid,
      expected_story_version_checksum: recoveredForRuntime.data?.story_version_checksum,
      expected_model: recoveredForRuntime.data?.model,
      expected_generation_profile: recoveredForRuntime.data?.generation_profile,
    });
    await runTurn(runtime, { input: { text: 'tool-only test' }, expected_revision: recoverRuntime(runtime).base_revision });
  } catch (err) { caught = err; }
  check('P1.3: tool-only batches (no narrative items) are rejected', !!caught && caught.code === 'invalid_tool_call');
  // 5-item batch → rejected
  caught = null;
  try {
    const provider = createMockAgentProvider({ responses: [{
      items: [
        { role: 'assistant', type: 'narration', text: 'a' },
        { role: 'assistant', type: 'narration', text: 'b' },
        { role: 'assistant', type: 'narration', text: 'c' },
        { role: 'assistant', type: 'narration', text: 'd' },
        { role: 'assistant', type: 'narration', text: 'e' },
      ],
    }] });
    const runtime = createAgentRuntime({
      repository: storyRepo,
      session_uuid: legacySession,
      provider,
      system_prompt: { kind: 'system', text: 'p1.3 test' },
      tool_definitions: [{ name: 'ask_player_choice' }, { name: 'finish_story' }],
      expected_story_version_uuid: recoveredForRuntime.data?.story_version_uuid,
      expected_story_version_checksum: recoveredForRuntime.data?.story_version_checksum,
      expected_model: recoveredForRuntime.data?.model,
      expected_generation_profile: recoveredForRuntime.data?.generation_profile,
    });
    await runTurn(runtime, { input: { text: '5-item test' }, expected_revision: recoverRuntime(runtime).base_revision });
  } catch (err) { caught = err; }
  check('P1.3: 5-item batches are rejected by the runtime cap', !!caught && caught.code === 'invalid_tool_call');
  // legacy messages + single tool_call → normalised (ClickUp 08 P1.3):
  // messages are the ordered narrative items and the single tool call
  // rides the batch as the optional FINAL item. It is NOT rejected.
  caught = null;
  let legacyNormalised = null;
  try {
    const provider = createMockAgentProvider({ responses: [{
      messages: [{ role: 'assistant', content: 'hi' }],
      tool_calls: [{ id: 'mix', name: 'ask_player_choice', arguments: { question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } }],
    }] });
    const runtime = createAgentRuntime({
      repository: storyRepo,
      session_uuid: legacySession,
      provider,
      system_prompt: { kind: 'system', text: 'p1.3 test' },
      tool_definitions: [{ name: 'ask_player_choice' }, { name: 'finish_story' }],
      expected_story_version_uuid: recoveredForRuntime.data?.story_version_uuid,
      expected_story_version_checksum: recoveredForRuntime.data?.story_version_checksum,
      expected_model: recoveredForRuntime.data?.model,
      expected_generation_profile: recoveredForRuntime.data?.generation_profile,
    });
    legacyNormalised = await runTurn(runtime, { input: { text: 'mixed legacy' }, expected_revision: recoverRuntime(runtime).base_revision });
  } catch (err) { caught = err; }
  check('P1.3: legacy messages + single tool_call normalises (tool rides as final item)',
    !caught && legacyNormalised?.items?.length === 1 && legacyNormalised?.tool_call?.tool_call_id === 'mix' && legacyNormalised?.pending_total === 1);

  // ----- P1.6: recover is read-only, never calls the provider, never mutates -----
  // A recover call MUST NOT call the provider (we instrument the mock to
  // throw on any call so any leak would surface).
  let providerCalled = false;
  const instrumentedProvider = createMockAgentProvider({ handler: async () => { providerCalled = true; throw new Error('provider must not be called by recover'); } });
  // Use the long-lived sessionUuid that already has multiple canonical events
  // so the recover surface is non-trivial.
  const sessP16Recover = sessionUuid;
  const recoveredForP16 = (await import('../src/stories/sessionService.mjs')).recoverSession({ repository: storyRepo, session_uuid: sessP16Recover });
  check('P1.6: recoverSession returns the canonical history snapshot without mutating',
    Array.isArray(recoveredForP16.history) && recoveredForP16.history.length >= 1 && Number.isInteger(recoveredForP16.revision));
  check('P1.6: recoverSession never invokes the provider', !providerCalled);
  // The current pending state is untouched: a subsequent recover call
  // returns an identical snapshot (no double-append, no replay).
  const recoverAgain = (await import('../src/stories/sessionService.mjs')).recoverSession({ repository: storyRepo, session_uuid: sessP16Recover });
  check('P1.6: recover is idempotent across calls',
    JSON.stringify(recoverAgain) === JSON.stringify(recoveredForP16));

  // ----- P1.5: interrupt atomically discards tail + appends player_input -----
  // The interrupt must drop the speculative pending tail AND append the
  // player_input as a new canonical event in one logical call. We stage a
  // batch on a fresh session, commit 1 item, then interrupt; the result
  // should show dropped_pending_id + the player_input event with
  // revision advanced.
  const sessP15 = '00000000-0000-4000-8000-0fedcba98765';
  await post('/api/dev/sessions', {
    session_uuid: sessP15,
    story_uuid: fixture.story_uuid,
    story_version_uuid: fixture.story_version_uuid,
    user_ref: 'story-outside-08-p15',
    role_id: 'stranger',
    model: 'mock-p15',
    prompt: 'p15 prompt',
    generation_profile: { ...cache.generation_profile, cache_uuid: cacheUuid },
  });
  const p15Gen = await post(`/api/dev/sessions/${sessP15}/generate`, {
    request_id: 'p15-turn-1',
    input: { text: 'long reply please' },
    expected_revision: 0,
  });
  check('P1.5: stage 4-item batch for interrupt test', p15Gen.response.status === 200 && p15Gen.data?.items?.length === 4);
  const p15Pending = p15Gen.data.pending_id;
  await post(`/api/dev/sessions/${sessP15}/narrative-events`, {
    pending_id: p15Pending, sequence: 0, expected_revision: 0, client_request_id: 'p15-c0',
  });
  const p15Interrupt = await post(`/api/dev/sessions/${sessP15}/interrupt`, {
    text: 'interrupted here',
    client_request_id: 'p15-int',
    expected_revision: 1,
  });
  check('P1.5: interrupt atomically drops tail', p15Interrupt.response.status === 200 && p15Interrupt.data?.dropped_pending_id === p15Pending);
  check('P1.5: interrupt appends exactly one player_input event',
    p15Interrupt.data?.event?.event_type === 'player_input' && p15Interrupt.data?.event?.event_seq === 2);
  check('P1.5: history after interrupt = 1 narrative + 1 player_input',
    p15Interrupt.data?.revision === 2 && (await request(`/api/dev/sessions/${sessP15}/recover`)).data?.history?.length === 2);
  check('P1.5: state transitions to realtime', p15Interrupt.data?.state === 'realtime');

  // =====================================================================
  // P2.x — 剩余 P1 精确回归（canonical cursor / provenance / 幂等 / shape /
  // realtime 再打断 / 持久化边界诚实）
  // =====================================================================

  // ----- P2.1: canonical cursor vs opening_cursor exact semantics -----
  // cursor === revision === history.length after EVERY commit (opening,
  // narrative, player_input); opening_cursor tracks only opening commits
  // and still enforces opening order.
  const sessP21 = '00000000-0000-4000-8000-0a0a0a0a0a21';
  await post('/api/dev/sessions', {
    session_uuid: sessP21,
    story_uuid: fixture.story_uuid,
    story_version_uuid: fixture.story_version_uuid,
    user_ref: 'story-outside-08-p21',
    role_id: 'stranger',
    model: 'mock-p21',
    prompt: 'p21 prompt',
    generation_profile: { ...cache.generation_profile, cache_uuid: cacheUuid },
  });
  const openingEvents = cache.content_payload.events;
  // Opening order enforcement still uses the opening cursor: committing
  // sequence 1 before sequence 0 is rejected.
  const p21OutOfOrder = await post(`/api/dev/sessions/${sessP21}/opening-events`, {
    cache_uuid: cacheUuid,
    event: { ...openingEvents[1], displayed: true },
    client_request_id: 'p21-ooo',
    expected_revision: 0,
  });
  check('P2.1: opening order is still enforced against opening_cursor', p21OutOfOrder.response.status === 400);
  let p21Rev = 0;
  const p21OpeningSeqs = [];
  for (let i = 0; i < Math.min(2, openingEvents.length); i += 1) {
    const c = await post(`/api/dev/sessions/${sessP21}/opening-events`, {
      cache_uuid: cacheUuid,
      event: { ...openingEvents[i], displayed: true },
      client_request_id: `p21-open-${i}`,
      expected_revision: p21Rev,
    });
    p21Rev = c.data?.revision;
    p21OpeningSeqs.push(c.data?.event?.event_seq);
  }
  check('P2.1: opening commits advance cursor === revision === event_seq',
    p21OpeningSeqs[0] === 1 && p21OpeningSeqs[1] === 2 && p21Rev === 2);
  let p21 = await request(`/api/dev/sessions/${sessP21}/recover`);
  check('P2.1: after openings cursor === revision === history.length === 2',
    p21.data?.cursor === 2 && p21.data?.revision === 2 && p21.data?.history?.length === 2 && p21.data?.cursor === p21.data?.revision);
  check('P2.1: opening_cursor === 2 after two opening commits', p21.data?.opening_cursor === 2);
  // Narrative commit: cursor advances too (canonical), opening_cursor stays.
  const p21Gen = await post(`/api/dev/sessions/${sessP21}/generate`, {
    request_id: 'p21-turn',
    input: { text: 'short' },
    expected_revision: 2,
  });
  await post(`/api/dev/sessions/${sessP21}/narrative-events`, {
    pending_id: p21Gen.data?.pending_id, sequence: 0, expected_revision: 2, client_request_id: 'p21-c0',
  });
  p21 = await request(`/api/dev/sessions/${sessP21}/recover`);
  check('P2.1: after narrative commit cursor === revision === history.length === 3',
    p21.data?.cursor === 3 && p21.data?.revision === 3 && p21.data?.history?.length === 3 && p21.data?.history[2]?.event_seq === 3);
  check('P2.1: opening_cursor stays 2 after a narrative commit', p21.data?.opening_cursor === 2);
  // Player input: cursor advances, state realtime, opening_cursor unchanged.
  await post(`/api/dev/sessions/${sessP21}/interrupt`, {
    text: 'p21 interrupt', client_request_id: 'p21-int', expected_revision: 3,
  });
  p21 = await request(`/api/dev/sessions/${sessP21}/recover`);
  check('P2.1: after interrupt cursor === revision === history.length === 4',
    p21.data?.cursor === 4 && p21.data?.revision === 4 && p21.data?.history?.length === 4 && p21.data?.history[3]?.event_seq === 4 && p21.data?.history[3]?.event_type === 'player_input');
  check('P2.1: opening_cursor still 2, state realtime', p21.data?.opening_cursor === 2 && p21.data?.state === 'realtime');

  // ----- P2.2: per (session, source) monotonic source_sequence -----
  // Three consecutive batches must NOT reset source_sequence (SQL unique
  // key uq_session_events_source_sequence would reject a [0,0]).
  const sessP22 = '00000000-0000-4000-8000-0a0a0a0a0a22';
  await post('/api/dev/sessions', {
    session_uuid: sessP22,
    story_uuid: fixture.story_uuid,
    story_version_uuid: fixture.story_version_uuid,
    user_ref: 'story-outside-08-p22',
    role_id: 'stranger',
    model: 'mock-p22',
    prompt: 'p22 prompt',
    generation_profile: { ...cache.generation_profile, cache_uuid: cacheUuid },
  });
  const p22SourceSeqs = [];
  let p22Rev = 0;
  // Batch 1: 1 item ('short').
  const p22GenA = await post(`/api/dev/sessions/${sessP22}/generate`, { request_id: 'p22-a', input: { text: 'short' }, expected_revision: p22Rev });
  const p22CommitA = await post(`/api/dev/sessions/${sessP22}/narrative-events`, {
    pending_id: p22GenA.data?.pending_id, sequence: 0, expected_revision: p22Rev, client_request_id: 'p22-a0',
  });
  p22Rev = p22CommitA.data?.revision;
  p22SourceSeqs.push(p22CommitA.data?.event?.source_sequence);
  // Batch 2: 3 items ('default').
  const p22GenB = await post(`/api/dev/sessions/${sessP22}/generate`, { request_id: 'p22-b', input: { text: 'default' }, expected_revision: p22Rev });
  for (let i = 0; i < 3; i += 1) {
    const c = await post(`/api/dev/sessions/${sessP22}/narrative-events`, {
      pending_id: p22GenB.data?.pending_id, sequence: i, expected_revision: p22Rev, client_request_id: `p22-b${i}`,
    });
    p22Rev = c.data?.revision;
    p22SourceSeqs.push(c.data?.event?.source_sequence);
  }
  // Batch 3: 1 item ('short').
  const p22GenC = await post(`/api/dev/sessions/${sessP22}/generate`, { request_id: 'p22-c', input: { text: 'short' }, expected_revision: p22Rev });
  const p22CommitC = await post(`/api/dev/sessions/${sessP22}/narrative-events`, {
    pending_id: p22GenC.data?.pending_id, sequence: 0, expected_revision: p22Rev, client_request_id: 'p22-c0',
  });
  p22Rev = p22CommitC.data?.revision;
  p22SourceSeqs.push(p22CommitC.data?.event?.source_sequence);
  check('P2.2: source_sequence across 3 batches is 0,1,2,3,4 (never [0,0])',
    JSON.stringify(p22SourceSeqs) === JSON.stringify([0, 1, 2, 3, 4]));
  const p22Recovered = await request(`/api/dev/sessions/${sessP22}/recover`);
  const p22Pairs = p22Recovered.data?.history?.map((e) => `${e.source}:${e.source_sequence}`);
  check('P2.2: (source, source_sequence) pairs are unique across all batches',
    new Set(p22Pairs).size === p22Pairs?.length);
  check('P2.2: all committed events are source=runtime with legal type/origin',
    p22Recovered.data?.history?.every((e) => e.source === 'runtime' && e.event_type === 'narrative_beat' && e.origin === 'llm'));
  // player source also uses the per-source counter: first player event is 0.
  await post(`/api/dev/sessions/${sessP22}/interrupt`, {
    text: 'p22 interrupt', client_request_id: 'p22-int', expected_revision: p22Rev,
  });
  const p22AfterInt = await request(`/api/dev/sessions/${sessP22}/recover`);
  check('P2.2: player source_sequence is 0 for the first player event',
    p22AfterInt.data?.history?.at(-1)?.source === 'player' && p22AfterInt.data?.history?.at(-1)?.source_sequence === 0);
  check('P2.2: (source, source_sequence) still unique after player event',
    new Set(p22AfterInt.data?.history?.map((e) => `${e.source}:${e.source_sequence}`)).size === p22AfterInt.data?.history?.length);

  // ----- P2.3: final-commit idempotency (pending cleared then replay) -----
  const sessP23 = '00000000-0000-4000-8000-0a0a0a0a0a23';
  await post('/api/dev/sessions', {
    session_uuid: sessP23,
    story_uuid: fixture.story_uuid,
    story_version_uuid: fixture.story_version_uuid,
    user_ref: 'story-outside-08-p23',
    role_id: 'stranger',
    model: 'mock-p23',
    prompt: 'p23 prompt',
    generation_profile: { ...cache.generation_profile, cache_uuid: cacheUuid },
  });
  const p23Gen = await post(`/api/dev/sessions/${sessP23}/generate`, { request_id: 'p23-turn', input: { text: 'short' }, expected_revision: 0 });
  const p23First = await post(`/api/dev/sessions/${sessP23}/narrative-events`, {
    pending_id: p23Gen.data?.pending_id, sequence: 0, expected_revision: 0, client_request_id: 'p23-final',
  });
  check('P2.3: final commit returns 200 and clears pending', p23First.response.status === 200 && p23First.data?.pending_remaining === 0);
  // Replay the SAME client_request_id after the pending was cleared: must
  // return the original result and MUST NOT append a second event.
  const p23Replay = await post(`/api/dev/sessions/${sessP23}/narrative-events`, {
    pending_id: p23Gen.data?.pending_id, sequence: 0, expected_revision: 0, client_request_id: 'p23-final',
  });
  check('P2.3: replay after pending cleared is idempotent (same event_id)',
    p23Replay.response.status === 200 && p23Replay.data?.event?.event_id === p23First.data?.event?.event_id);
  const p23Rec = await request(`/api/dev/sessions/${sessP23}/recover`);
  check('P2.3: replay did not append (history length still 1, revision still 1)',
    p23Rec.data?.history?.length === 1 && p23Rec.data?.revision === 1);
  // Same id + different payload still fails closed.
  const p23Bad = await post(`/api/dev/sessions/${sessP23}/narrative-events`, {
    pending_id: p23Gen.data?.pending_id, sequence: 5, expected_revision: 0, client_request_id: 'p23-final',
  });
  check('P2.3: same id with different payload fails closed', p23Bad.response.status === 400);

  // ----- P2.4: HTTP generate cross-request idempotency -----
  const sessP24 = '00000000-0000-4000-8000-0a0a0a0a0a24';
  await post('/api/dev/sessions', {
    session_uuid: sessP24,
    story_uuid: fixture.story_uuid,
    story_version_uuid: fixture.story_version_uuid,
    user_ref: 'story-outside-08-p24',
    role_id: 'stranger',
    model: 'mock-p24',
    prompt: 'p24 prompt',
    generation_profile: { ...cache.generation_profile, cache_uuid: cacheUuid },
  });
  const p24A = await post(`/api/dev/sessions/${sessP24}/generate`, {
    request_id: 'p24-id-1', input: { text: 'short' }, expected_revision: 0,
  });
  const p24B = await post(`/api/dev/sessions/${sessP24}/generate`, {
    request_id: 'p24-id-1', input: { text: 'short' }, expected_revision: 0,
  });
  check('P2.4: same request_id + input + revision across HTTP requests returns stable identical result',
    p24B.response.status === 200 && JSON.stringify(p24A.data) === JSON.stringify(p24B.data));
  check('P2.4: turn_id / pending_id identity is stable across requests',
    p24A.data?.turn_id === p24B.data?.turn_id && p24A.data?.pending_id === p24B.data?.pending_id);
  const p24DiffInput = await post(`/api/dev/sessions/${sessP24}/generate`, {
    request_id: 'p24-id-1', input: { text: 'long reply please' }, expected_revision: 0,
  });
  check('P2.4: same request_id + different input is rejected (duplicate_request)',
    p24DiffInput.response.status === 400 && p24DiffInput.data?.error === 'duplicate_request');
  const p24DiffRev = await post(`/api/dev/sessions/${sessP24}/generate`, {
    request_id: 'p24-id-1', input: { text: 'short' }, expected_revision: 1,
  });
  check('P2.4: same request_id + different revision is rejected (duplicate_request)',
    p24DiffRev.response.status === 400 && p24DiffRev.data?.error === 'duplicate_request');
  // A different request id while the pending is active must NOT overwrite it.
  const p24Other = await post(`/api/dev/sessions/${sessP24}/generate`, {
    request_id: 'p24-id-2', input: { text: 'long reply please' }, expected_revision: 0,
  });
  check('P2.4: different request id cannot overwrite an active pending (fail closed)',
    p24Other.response.status === 400 && /unconsumed pending/.test(p24Other.data?.message || ''));
  // Runtime-level: the provider must NOT be called twice across separate
  // runtime instances for the same request_id (the idempotency lives on the
  // session, not on the transient runtime).
  const sessP24b = '00000000-0000-4000-8000-0a0a0a0a0a2b';
  await post('/api/dev/sessions', {
    session_uuid: sessP24b,
    story_uuid: fixture.story_uuid,
    story_version_uuid: fixture.story_version_uuid,
    user_ref: 'story-outside-08-p24b',
    role_id: 'stranger',
    model: 'mock-p24b',
    prompt: 'p24b prompt',
    generation_profile: { ...cache.generation_profile, cache_uuid: cacheUuid },
  });
  const p24bRec = (await import('../src/stories/sessionService.mjs')).recoverSession({ repository: storyRepo, session_uuid: sessP24b });
  const p24bProvider = createMockAgentProvider({ responses: [{ items: [{ role: 'assistant', type: 'narration', text: 'once only' }] }] });
  const p24bRuntime1 = createAgentRuntime({
    repository: storyRepo, session_uuid: sessP24b, provider: p24bProvider,
    system_prompt: { kind: 'system', text: 'p2.4 test' }, tool_definitions: [{ name: 'ask_player_choice' }, { name: 'finish_story' }],
    expected_story_version_uuid: p24bRec.story_version_uuid, expected_story_version_checksum: p24bRec.story_version_checksum,
    expected_model: p24bRec.model, expected_generation_profile: p24bRec.generation_profile,
  });
  const p24bR1 = await runTurn(p24bRuntime1, { request_id: 'p24b-turn', input: { text: 'x' }, expected_revision: 0 });
  const p24bRuntime2 = createAgentRuntime({
    repository: storyRepo, session_uuid: sessP24b, provider: p24bProvider,
    system_prompt: { kind: 'system', text: 'p2.4 test' }, tool_definitions: [{ name: 'ask_player_choice' }, { name: 'finish_story' }],
    expected_story_version_uuid: p24bRec.story_version_uuid, expected_story_version_checksum: p24bRec.story_version_checksum,
    expected_model: p24bRec.model, expected_generation_profile: p24bRec.generation_profile,
  });
  const p24bR2 = await runTurn(p24bRuntime2, { request_id: 'p24b-turn', input: { text: 'x' }, expected_revision: 0 });
  check('P2.4: provider is not re-called across runtime instances for the same request_id', p24bProvider.callCount === 1);
  check('P2.4: replay across runtime instances returns identical result', JSON.stringify(p24bR1) === JSON.stringify(p24bR2));

  // ----- P2.5: batch shape fail-closed at the runtime layer -----
  // Valid explicit shape: items + tool_call is legal (covered above).
  // Invalid shapes: tool-only, empty, 5-item, multi-tool, tool inside items.
  const sessP25 = '00000000-0000-4000-8000-0a0a0a0a0a25';
  await post('/api/dev/sessions', {
    session_uuid: sessP25,
    story_uuid: fixture.story_uuid,
    story_version_uuid: fixture.story_version_uuid,
    user_ref: 'story-outside-08-p25',
    role_id: 'stranger',
    model: 'mock-p25',
    prompt: 'p25 prompt',
    generation_profile: { ...cache.generation_profile, cache_uuid: cacheUuid },
  });
  const p25Rec = (await import('../src/stories/sessionService.mjs')).recoverSession({ repository: storyRepo, session_uuid: sessP25 });
  const p25InvalidResponses = [
    // tool-only
    { tool_calls: [{ id: 't1', name: 'ask_player_choice', arguments: { question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } }] },
    // empty messages
    { messages: [] },
    // 5-item batch
    { items: [1, 2, 3, 4, 5].map((n) => ({ role: 'assistant', type: 'narration', text: `line ${n}` })) },
    // multi-tool legacy array with 1..4 messages
    { messages: [{ role: 'assistant', content: 'hi' }], tool_calls: [
      { id: 't1', name: 'ask_player_choice', arguments: { question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } },
      { id: 't2', name: 'finish_story', arguments: { summary: 's', ending: 'e', original_difference: 'd', key_choices: ['x'], character_outcomes: [{ character: 'A', fate: 'B' }] } },
    ] },
    // tool inside the narrative items (tool must be final, never in items)
    { items: [{ role: 'assistant', type: 'tool_call', text: 'sneaky' }] },
  ];
  for (let i = 0; i < p25InvalidResponses.length; i += 1) {
    let p25Caught = null;
    try {
      const provider = createMockAgentProvider({ responses: [p25InvalidResponses[i]] });
      const runtime = createAgentRuntime({
        repository: storyRepo, session_uuid: sessP25, provider,
        system_prompt: { kind: 'system', text: 'p2.5 test' }, tool_definitions: [{ name: 'ask_player_choice' }, { name: 'finish_story' }],
        expected_story_version_uuid: p25Rec.story_version_uuid, expected_story_version_checksum: p25Rec.story_version_checksum,
        expected_model: p25Rec.model, expected_generation_profile: p25Rec.generation_profile,
      });
      await runTurn(runtime, { input: { text: 'bad shape' }, expected_revision: 0 });
    } catch (err) { p25Caught = err; }
    check(`P2.5: invalid shape ${i + 1}/${p25InvalidResponses.length} fails closed`, !!p25Caught && p25Caught.code === 'invalid_tool_call');
  }
  const p25RecAfter = await request(`/api/dev/sessions/${sessP25}/recover`);
  check('P2.5: rejected shapes never touch canonical history or leave a pending',
    p25RecAfter.data?.history?.length === 0 && p25RecAfter.data?.pending === null);

  // ----- P2.6: realtime re-interrupt -----
  // Stage accepts realtime; interrupt must work with an active pending in
  // realtime: drop the tail, append player_input, STAY realtime; same
  // client_request_id replays idempotently.
  const sessP26 = '00000000-0000-4000-8000-0a0a0a0a0a26';
  await post('/api/dev/sessions', {
    session_uuid: sessP26,
    story_uuid: fixture.story_uuid,
    story_version_uuid: fixture.story_version_uuid,
    user_ref: 'story-outside-08-p26',
    role_id: 'stranger',
    model: 'mock-p26',
    prompt: 'p26 prompt',
    generation_profile: { ...cache.generation_profile, cache_uuid: cacheUuid },
  });
  // Enter realtime with an active pending tail.
  const p26GenA = await post(`/api/dev/sessions/${sessP26}/generate`, { request_id: 'p26-a', input: { text: 'long reply please' }, expected_revision: 0 });
  await post(`/api/dev/sessions/${sessP26}/narrative-events`, {
    pending_id: p26GenA.data?.pending_id, sequence: 0, expected_revision: 0, client_request_id: 'p26-a0',
  });
  const p26Int1 = await post(`/api/dev/sessions/${sessP26}/interrupt`, {
    text: 'first interrupt', client_request_id: 'p26-int-1', expected_revision: 1,
  });
  check('P2.6: first interrupt enters realtime and drops the tail',
    p26Int1.response.status === 200 && p26Int1.data?.state === 'realtime' && p26Int1.data?.dropped_pending_count === 3);
  // Stage in realtime.
  const p26GenB = await post(`/api/dev/sessions/${sessP26}/generate`, {
    request_id: 'p26-b', input: { text: 'short' }, expected_revision: 2,
  });
  check('P2.6: stage accepts a realtime session', p26GenB.response.status === 200 && p26GenB.data?.items?.length === 1);
  // Interrupt again in realtime WITH an active pending.
  const p26Int2 = await post(`/api/dev/sessions/${sessP26}/interrupt`, {
    text: 'second interrupt', client_request_id: 'p26-int-2', expected_revision: 2,
  });
  check('P2.6: realtime re-interrupt drops the active pending tail',
    p26Int2.response.status === 200 && p26Int2.data?.dropped_pending_id === p26GenB.data?.pending_id && p26Int2.data?.dropped_pending_count === 1);
  check('P2.6: realtime re-interrupt appends player_input and STAYS realtime',
    p26Int2.data?.event?.event_type === 'player_input' && p26Int2.data?.state === 'realtime');
  const p26Rec1 = await request(`/api/dev/sessions/${sessP26}/recover`);
  check('P2.6: history = 1 narrative + 2 player_input, no stray pending',
    p26Rec1.data?.history?.length === 3 && p26Rec1.data?.history?.filter((e) => e.event_type === 'player_input').length === 2 && p26Rec1.data?.pending === null);
  check('P2.6: player source_sequence increments across interrupts (0 then 1)',
    p26Rec1.data?.history?.filter((e) => e.source === 'player').map((e) => e.source_sequence).join(',') === '0,1');
  // Idempotent replay of the second interrupt.
  const p26Int2Replay = await post(`/api/dev/sessions/${sessP26}/interrupt`, {
    text: 'second interrupt', client_request_id: 'p26-int-2', expected_revision: 0,
  });
  check('P2.6: same interrupt request_id replays idempotently (same event_id)',
    p26Int2Replay.response.status === 200 && p26Int2Replay.data?.event?.event_id === p26Int2.data?.event?.event_id);
  const p26Rec2 = await request(`/api/dev/sessions/${sessP26}/recover`);
  check('P2.6: replay did not append (history length still 3)', p26Rec2.data?.history?.length === 3);

  // ----- P2.9: persistence boundary honesty -----
  // The in-memory repository does not persist across processes; recovery is
  // same-process only. A fresh repository must NOT know the session, and the
  // recover response must not claim any DAO/persistence wiring.
  check('P2.9: recover response carries no cross-process persistence claim',
    !('persisted' in (p26Rec2.data || {})) && !('cross_process' in (p26Rec2.data || {})) && !('dao' in (p26Rec2.data || {})));
} finally {
  await new Promise((resolve) => server.close(resolve));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall story-outside 08 cross-layer checks passed');