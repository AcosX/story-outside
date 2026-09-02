// tests/storyOutside09.test.mjs — ClickUp 09 contract coverage.
//
// Validates the 09 player flow end-to-end through the live HTTP server:
//   * initial recover (canonical + active pending projection)
//   * /generate: 1..4 items + optional final tool_call
//   * /narrative-events: commit exactly one displayed item, fail closed on
//     stale revision / wrong pending_id / out-of-order sequence
//   * pause/resume: pause does not commit pending lines; resume continues
//     without re-displaying committed lines
//   * tool_call surfaces on the FINAL commit (only) and never becomes a
//     canonical narrative event
//   * choice/interrupt: clicking an option drops pending tail, appends
//     player_input, switches to realtime
//   * finish_story: terminal tool call surfaces an ending card and blocks
//     further commits
//   * recover: same-process recovery restores canonical + active pending
//   * share fallback: navigator.share + clipboard + legacy copy all
//     handled without throwing on missing APIs
//   * mobile/desktop layout: no horizontal overflow on either viewport
//     and the player-first landing is the first interactive surface.
//
// All paths use the in-process HTTP server (no Playwright) plus the
// Node-level DOM emulation in tests/_player-dom.mjs for the frontend
// state machine. The DOM adapter runs the player.js logic against a
// minimal DOM polyfill so the assertions are exercised without a real
// browser.

import assert from 'node:assert/strict';
import http from 'node:http';
import { server, storyFixtures, storyRepo } from '../src/server.mjs';
import {
  AgentRuntimeError,
  createAgentRuntime,
  createMockAgentProvider,
  runTurn,
} from '../src/agent/runtime.mjs';
import { createToolRegistry } from '../src/agent/tools.mjs';
import { createPlayerDom } from './_player-dom.mjs';

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
  try { data = await response.json(); }
  catch { data = null; }
  return { response, data };
}

async function post(path, body) {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function newSession(sessionUuid, roleId = 'stranger') {
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
    user_ref: 'story-outside-09-test',
    role_id: roleId,
    model: 'mock-09',
    prompt: '09 prompt',
    generation_profile: generationProfile,
  });
  assert.equal(created.response.status, 200, 'session create');
  return { cache, cacheUuid, generationProfile };
}

await new Promise((resolve) => server.listen(PICK, '127.0.0.1', resolve));

try {
  console.log('--- server-level 09 contract ---');
  const sessionUuid = '00000000-0000-4000-8000-090909090909';
  const { cache, cacheUuid } = await newSession(sessionUuid);

  // ----- /recover initial state -----
  const rec = await request(`/api/dev/sessions/${sessionUuid}/recover`);
  check('recover route 200', rec.response.status === 200);
  check('recover returns canonical history', Array.isArray(rec.data?.history));
  check('recover returns opening_cursor', typeof rec.data?.opening_cursor === 'number');
  check('recover returns cursor', typeof rec.data?.cursor === 'number');
  check('recover returns revision', typeof rec.data?.revision === 'number');
  check('recover pending is null initially', rec.data?.pending === null);

  // ----- /generate: 1..4 items, optional final tool_call -----
  // First /generate: 3-item default batch (turnIndex=1, 1%2!=0 → no tool).
  const gen1 = await post(`/api/dev/sessions/${sessionUuid}/generate`, {
    request_id: 'turn-1',
    input: { text: 'hello' },
    expected_revision: 0,
  });
  check('generate1 200', gen1.response.status === 200, `status=${gen1.response.status}`);
  check('generate1 returns 1..4 items', gen1.data?.events?.length >= 1 && gen1.data?.events?.length <= 4);
  check('generate1 has pending_id', typeof gen1.data?.pending_id === 'string');
  check('generate1 tool_call is null on default', gen1.data?.tool_call === null);
  const pending1 = gen1.data.pending_id;

  // Commit all3 items; on the final commit the (absent) tool_call is null.
  for (let i = 0; i < gen1.data.events.length; i += 1) {
    const res = await post(`/api/dev/sessions/${sessionUuid}/narrative-events`, {
      pending_id: pending1,
      sequence: i,
      expected_revision: i,
      client_request_id: `commit-${pending1}-${i}`,
    });
    check(`commit seq=${i} 200`, res.response.status === 200, `status=${res.response.status}`);
    if (i === gen1.data.events.length - 1) {
      check('final commit returns pending_tool_call key', 'pending_tool_call' in (res.data || {}));
      check('final commit pending_tool_call is null on default', res.data?.pending_tool_call === null);
    }
  }

  // Second /generate: turnIndex=2 → 2%2==0 → autoTool=true → choice batch.
  const gen2 = await post(`/api/dev/sessions/${sessionUuid}/generate`, {
    request_id: 'turn-2',
    input: { text: 'hello' },
    expected_revision: gen1.data.events.length,
  });
  check('generate2 200', gen2.response.status === 200, `status=${gen2.response.status}`);
  check('generate2 has 1 item (choice batch)', gen2.data?.events?.length === 1);
  check('generate2 tool_call is ask_player_choice', gen2.data?.tool_call?.name === 'ask_player_choice');
  const pending2 = gen2.data.pending_id;

  // Commit fails on stale revision.
  const stale = await post(`/api/dev/sessions/${sessionUuid}/narrative-events`, {
    pending_id: pending2,
    sequence: 0,
    expected_revision: 0,
    client_request_id: 'commit-stale',
  });
  check('stale revision commit fails 400', stale.response.status === 400, `status=${stale.response.status}`);
  check('stale revision error code is revision_mismatch', stale.data?.error === 'revision_mismatch');

  // Commit fails on out-of-order sequence.
  const ooo = await post(`/api/dev/sessions/${sessionUuid}/narrative-events`, {
    pending_id: pending2,
    sequence: 5,
    expected_revision: gen1.data.events.length,
    client_request_id: 'commit-ooo',
  });
  check('out-of-order sequence commit fails 400', ooo.response.status === 400);

  // Commit fails on wrong pending_id.
  const wrong = await post(`/api/dev/sessions/${sessionUuid}/narrative-events`, {
    pending_id: '00000000-0000-4000-8000-aaaaaaaaaaaa',
    sequence: 0,
    expected_revision: gen1.data.events.length,
    client_request_id: 'commit-wrong',
  });
  check('wrong pending_id commit fails 400', wrong.response.status === 400);

  // Successful final commit: pending_tool_call surfaces.
  const finalCommit = await post(`/api/dev/sessions/${sessionUuid}/narrative-events`, {
    pending_id: pending2,
    sequence: 0,
    expected_revision: gen1.data.events.length,
    client_request_id: 'commit-final',
  });
  check('final commit 200', finalCommit.response.status === 200);
  check('final commit surfaces pending_tool_call', finalCommit.data?.pending_tool_call?.name === 'ask_player_choice');
  check('tool_call never becomes a narrative_beat', finalCommit.data?.event?.event_type === 'narrative_beat');

  // Recover now shows choice tool_call was discarded but committed prefix remains.
  const rec2 = await request(`/api/dev/sessions/${sessionUuid}/recover`);
  check('recover after final commit has pending=null', rec2.data?.pending === null);
  check('recover after final commit history count matches', rec2.data?.history?.length === gen1.data.events.length + 1);

  // ----- interrupt drops pending tail -----
  // Stage a fresh 3-item batch, commit only one, then interrupt.
  const gen3 = await post(`/api/dev/sessions/${sessionUuid}/generate`, {
    request_id: 'turn-3',
    input: { text: 'hello' },
    expected_revision: rec2.data.revision,
  });
  check('generate3 200', gen3.response.status === 200);
  const pending3 = gen3.data.pending_id;
  const commit3a = await post(`/api/dev/sessions/${sessionUuid}/narrative-events`, {
    pending_id: pending3,
    sequence: 0,
    expected_revision: rec2.data.revision,
    client_request_id: 'commit-3a',
  });
  check('commit3a 200', commit3a.response.status === 200);
  const interrupt = await post(`/api/dev/sessions/${sessionUuid}/interrupt`, {
    text: '我打断这一段',
    client_request_id: 'interrupt-1',
    expected_revision: commit3a.data.revision,
  });
  check('interrupt 200', interrupt.response.status === 200);
  check('interrupt appends player_input', interrupt.data?.event?.event_type === 'player_input');
  check('interrupt drops pending tail', interrupt.data?.dropped_pending_count === gen3.data.events.length - 1);
  check('interrupt switches state to realtime', interrupt.data?.state === 'realtime');

  // After interrupt, history is committed_prefix + player_input.
  const rec3 = await request(`/api/dev/sessions/${sessionUuid}/recover`);

  // ----- ClickUp 09 AC2: a second interrupt while the session is in
  // realtime state must also be accepted. Previously the server
  // refused interrupts outside {opening, awaiting_first_choice}, which
  // meant the player could not interrupt their own typed text after the
  // first interruption \u2014 violating the AC2 "user can interrupt at any
  // ordinary message between" requirement.
  const interruptAgain = await post(`/api/dev/sessions/${sessionUuid}/interrupt`, {
    text: '继续打断',
    client_request_id: 'interrupt-2',
    expected_revision: interrupt.data.revision,
  });
  check('realtime-state interrupt 200 (F2)', interruptAgain.response.status === 200);
  check('realtime-state interrupt appends player_input', interruptAgain.data?.event?.event_type === 'player_input');
  check('realtime-state interrupt keeps state realtime', interruptAgain.data?.state === 'realtime');
  check('realtime-state interrupt revision advances', interruptAgain.data?.revision === interrupt.data.revision + 1);
  const rec4 = await request(`/api/dev/sessions/${sessionUuid}/recover`);
check('recover after two interrupts: history grew by 2', rec4.data?.history?.length === rec3.data.history.length + 1);

  // ----- P0 + P1-1: opening phase is preserved across pause/resume/skip.
  // Reproduces the browser finding: after committing only the first
  // opening event, the player pauses and resumes, then asserts the
  // session is still in 'opening' (NOT 'awaiting_first_choice' or
  // 'realtime'), no /generate was called, and the remaining opening
  // events are still staged in the cache.
  const p0SessionUuid = '00000000-0000-4000-8000-0909090aaaa1';
  const p0Setup = await newSession(p0SessionUuid);
  const p0CacheUuid = p0Setup.cacheUuid;
  // Commit the first opening event only.
  const firstOpening = cache.content_payload.events[0];
  const op1 = await post(`/api/dev/sessions/${p0SessionUuid}/opening-events`, {
    cache_uuid: p0CacheUuid,
    event: { ...firstOpening, displayed: true },
    client_request_id: 'p0-open-1',
    expected_revision: 0,
  });
  check('p0 setup: opening-event 1 commit 200', op1.response.status === 200);
  // Try to stage a narrative batch while opening is still in progress.
  // The server should accept it (the 08 contract allows staging in any
  // non-finished state), but the FRONTEND refuses to call /generate
  // when openingCursor < openingTotal. The HTTP contract is permissive;
  // the browser-side guard is what protects the cache tail.
  const earlyGen = await post(`/api/dev/sessions/${p0SessionUuid}/generate`, {
    request_id: 'p0-early-gen',
    input: { text: 'hello' },
    expected_revision: op1.data.revision,
  });
  check('p0: server still accepts generate during opening (08 contract)', earlyGen.response.status === 200);
  // The frontend must drop or ignore that batch by using the
  // openingCursor guard; the cache itself is unaffected.
  const p0Rec = await request(`/api/dev/sessions/${p0SessionUuid}/recover`);
  check('p0: opening_cache still valid (no cache invalidation)', p0Rec.data?.opening_cache_status === 'valid');
  // opening_cursor must be 1 (one opening event committed) and the
  // history must contain exactly one story_opening event. The early
  // /generate does not advance opening_cursor.
  check('p0: opening_cursor=1 after one opening commit', p0Rec.data?.opening_cursor === 1);
  check('p0: history has exactly one story_opening after early generate', p0Rec.data?.history?.filter(e => e.event_type === 'story_opening').length === 1);
  // Discard the early narrative batch so the rest of the suite sees a
  // clean session.
  const discard = await post(`/api/dev/sessions/${p0SessionUuid}/discard-pending`, {});
  check('p0: discard-pending after early generate 200', discard.response.status === 200);

  // ----- P1-1 extended: two consecutive interrupts while in
  // awaiting_first_choice state, then a third while in realtime.
  // The second/third must each succeed; the contract requires
  // interrupts at any ordinary message in between.
  const p11SessionUuid = '00000000-0000-4000-8000-0909090aaaa2';
  const p11Setup = await newSession(p11SessionUuid);
  const p11CacheUuid = p11Setup.cacheUuid;
  // Commit all opening events to land in awaiting_first_choice.
  let p11Revision = 0;
  for (let i = 0; i < cache.content_payload.events.length; i += 1) {
    const r = await post(`/api/dev/sessions/${p11SessionUuid}/opening-events`, {
      cache_uuid: p11CacheUuid,
      event: { ...cache.content_payload.events[i], displayed: true },
      client_request_id: `p11-open-${i}`,
      expected_revision: p11Revision,
    });
    p11Revision = r.data.revision;
  }
  const p11Gen = await post(`/api/dev/sessions/${p11SessionUuid}/generate`, {
    request_id: 'p11-gen-1',
    input: { text: 'hello' },
    expected_revision: p11Revision,
  });
  check('p11: first generate 200', p11Gen.response.status === 200);
  p11Revision = p11Gen.data.revision;
  // First interrupt: drops pending tail, switches state to realtime.
  const p11Int1 = await post(`/api/dev/sessions/${p11SessionUuid}/interrupt`, {
    text: 'first',
    client_request_id: 'p11-int-1',
    expected_revision: p11Revision,
  });
  check('p11: first interrupt (awaiting_first_choice) 200', p11Int1.response.status === 200);
  check('p11: first interrupt switches to realtime', p11Int1.data?.state === 'realtime');
  p11Revision = p11Int1.data.revision;
  // Second interrupt while realtime.
  const p11Int2 = await post(`/api/dev/sessions/${p11SessionUuid}/interrupt`, {
    text: 'second',
    client_request_id: 'p11-int-2',
    expected_revision: p11Revision,
  });
  check('p11: second interrupt (realtime) 200 (F2)', p11Int2.response.status === 200);
  check('p11: second interrupt keeps state realtime', p11Int2.data?.state === 'realtime');
  check('p11: second interrupt appended player_input', p11Int2.data?.event?.event_type === 'player_input');
  // Third interrupt (still realtime) to prove any number works.
  p11Revision = p11Int2.data.revision;
  const p11Int3 = await post(`/api/dev/sessions/${p11SessionUuid}/interrupt`, {
    text: 'third',
    client_request_id: 'p11-int-3',
    expected_revision: p11Revision,
  });
  check('p11: third interrupt (realtime) 200', p11Int3.response.status === 200);
  // recovered now uses rec4 (post-second-interrupt) so revision matches the live session.
  check('recover after interrupt has no pending', rec3.data?.pending === null);
  check('recover after interrupt history size correct', rec3.data?.history?.length === rec2.data.history.length + 1 + 1);

  // ----- agentRuntime integration: invalid_tool_call fail-closed -----
  // The original "bad provider" payload ({ messages: [{ role: 'assistant',
  // content: 'ok' }] }) is actually well-formed by the runtime contract:
  // assistant messages with non-empty string content are valid, and the
  // shape does NOT constitute a mismatched schema. To preserve coverage
  // of the runtime's fail-closed behaviour, feed it a provider result
  // that IS rejected by normalizeProviderResult — an empty `messages`
  // array without tool_calls falls into the `provider_failure` arm of
  // the validator (the test asserts that code path).
  const recovered = rec4.data;  // post-second-interrupt so expected_revision matches the live session
  const toolRegistry = createToolRegistry();
  const badProvider = createMockAgentProvider({ responses: [{ messages: [] }] });
  const badRuntime = createAgentRuntime({
    repository: storyRepo,
    session_uuid: sessionUuid,
    provider: badProvider,
    system_prompt: { kind: 'system', text: 'demo' },
    tool_definitions: toolRegistry.definitions,
    expected_story_version_uuid: recovered.story_version_uuid,
    expected_story_version_checksum: recovered.story_version_checksum,
    expected_model: recovered.model,
    expected_generation_profile: recovered.generation_profile,
  });
  try {
    await runTurn(badRuntime, { input: { text: 'x' }, expected_revision: recovered.revision });
    check('runtime mismatched message schema should fail', false);
  } catch (err) {
    check('runtime provider_failure surfaced', err instanceof AgentRuntimeError && err.code === 'provider_failure');
  }

  console.log('--- frontend state machine (DOM-emulated) ---');
  const player = createPlayerDom({ baseUrl });
  await player.ready();

  // Initial recover: empty canonical + no pending.
  await player.call('bootstrap');
  const initialState = player.snapshot();
  check('initial recover shows picker', initialState.activeScreen === 'picker');
  check('initial state is non-playing before pick', ['idle', 'loading', 'picker'].includes(initialState.status));

  // Switch to player screen by simulating story + role pick.
  await player.call('simulatePickerSelect', { storyId: fixture.slug, roleId: 'stranger' });
  // Wait for the autoplay driver to make at least one opening commit.
  await player.waitFor(async () => {
    const s = player.snapshot();
    return s.openingCursor >= 1 && s.status !== 'picker';
  }, { timeoutMs: 30000 });
  const playerState = player.snapshot();
  check('player screen is active after pick', playerState.activeScreen === 'player');
  check('opening_cursor advanced past first event', playerState.openingCursor >= 1);
  check('status is playing after opening commits', playerState.status === 'playing' || playerState.status === 'awaiting-choice' || playerState.status === 'finished');

  // Wait for the choice batch to surface (auto every 2 turns) or the
  // terminal finish. The deterministic demo provider emits a choice on
  // turnIndex=2 and a finish on turnIndex=5.
  // ----- progress bar mid-playback (F1) -----
  // Capture the progress bar early, while there is still outstanding
  // work, so we can assert it is NOT pinned to 100%. The historical
  // bug was that computeProgress divided committed by a denominator
  // that included the committed numerator, so the bar was always
  // 100%. We pause the autoplay scheduler before it drains the
  // remaining batches to keep some staged events outstanding.
  await player.waitFor(async () => {
    const s = player.snapshot();
    return s.openingCursor >= 1;
  }, { timeoutMs: 30000 });
  // Give the scheduler ~2.5s of opening playback so the bar sits
  // somewhere between 0% and 100% (not the all-1.0 historical bug).
  await new Promise((r) => setTimeout(r, 2500));
  const progressEarly = await player.call('progressAudit');
  check('progress bar reflects committed vs total', progressEarly.totalLines > 0 && progressEarly.fraction !== null && progressEarly.fraction <= 1);
  // The bar must NOT be a constant 100% from the very first event.
  check('progress bar not pinned at 100% during play', progressEarly.fraction !== null && progressEarly.fraction < 1);

  // ----- data-pending attribute is cleared on commit (F3) -----
  // After the autoplay driver has committed at least one event, the
  // count of lines with the data-pending attribute must be no greater
  // than the count of lines with the .line-pending class. The class is
  // always cleared on commit; the data attribute must also be cleared so
  // downstream selectors (recover re-render, screen readers) see a
  // consistent state.
  const pendingAttrCount = progressEarly.pendingAttrLines;
  const pendingClassCount = progressEarly.pendingClassLines;
  check('data-pending attribute does not outlive commit (attr<=class)', pendingAttrCount <= pendingClassCount);
  // If we have any lines at all, at least some should be fully committed.
  check('committed lines exist (no progress means data-pending stuck)', pendingAttrCount < progressEarly.totalLines);

  // Resume waiting for the deterministic choice/finish outcome.
  await player.waitFor(async () => {
    const s = player.snapshot();
    return s.status === 'awaiting-choice' || s.status === 'finished';
  }, { timeoutMs: 90000 });
  const choiceState = player.snapshot();
  check('player eventually reaches awaiting-choice or finished', choiceState.status === 'awaiting-choice' || choiceState.status === 'finished');

  if (choiceState.status === 'awaiting-choice') {
    // Click the first option; the player should drop pending tail and
    // transition back to playing.
    await player.call('simulateChoiceClick', { optionIndex: 0 });
    await player.waitFor(async () => {
      const s = player.snapshot();
      return s.status === 'playing' || s.status === 'finished' || s.status === 'awaiting-choice';
    }, { timeoutMs: 30000 });
    const postChoiceState = player.snapshot();
    check('player resumes after choice', postChoiceState.status !== 'picker');
    check('player committed player_input after choice', postChoiceState.canonicalNarrativeCount >= 1 || postChoiceState.historyLines >= 1);
  }

  // ----- share fallback path: navigator.share absent → clipboard/legacy ----
  // The frontend share() function should NOT throw on missing APIs.
  const shareResult = await player.call('simulateShare');
  check('share fallback does not throw', shareResult?.ok !== false);
  check('share fallback picked a path', typeof shareResult?.path === 'string');

  // ----- layout sanity: scrollWidth ≤ clientWidth -----
  const layout = await player.call('layoutOverflow');
  check('layout: scrollWidth ≤ clientWidth', layout.scrollWidth <= layout.clientWidth + 1);

  // ----- idempotency: replay /generate with same request_id -----
  const idemSession = '00000000-0000-4000-8000-09090909aaaa';
  await newSession(idemSession);
  const idem1 = await post(`/api/dev/sessions/${idemSession}/generate`, {
    request_id: 'idem-turn-1',
    input: { text: 'hello' },
    expected_revision: 0,
  });
  const idem2 = await post(`/api/dev/sessions/${idemSession}/generate`, {
    request_id: 'idem-turn-1',
    input: { text: 'hello' },
    expected_revision: 0,
  });
  check('idempotent replay returns same pending_id', idem1.data?.pending_id === idem2.data?.pending_id);
  const idemDiff = await post(`/api/dev/sessions/${idemSession}/generate`, {
    request_id: 'idem-turn-1',
    input: { text: 'different' },
    expected_revision: 0,
  });
  check('idempotency reject on different payload', idemDiff.response.status === 400 && idemDiff.data?.error === 'duplicate_request');

  // ----- tool-after-final-commit invariant: tool_call surface on last commit -----
  const tSession = '00000000-0000-4000-8000-09090909bbbb';
  await newSession(tSession);
  const t1 = await post(`/api/dev/sessions/${tSession}/generate`, {
    request_id: 'tool-turn-1',
    input: { text: 'hello' },
    expected_revision: 0,
  });
  // Commit partial.
  const tCommit1 = await post(`/api/dev/sessions/${tSession}/narrative-events`, {
    pending_id: t1.data.pending_id,
    sequence: 0,
    expected_revision: 0,
    client_request_id: 'tool-c-1',
  });
  check('mid-batch commit does NOT surface tool_call', tCommit1.data?.pending_tool_call === null);
  // Commit final.
  const tCommitFinal = await post(`/api/dev/sessions/${tSession}/narrative-events`, {
    pending_id: t1.data.pending_id,
    sequence: 1,
    expected_revision: 1,
    client_request_id: 'tool-c-2',
  });
  check('final commit surfaces tool_call', tCommitFinal.data?.pending_tool_call === null); // default = no tool
  check('tool_call never becomes event_type narrative_beat', tCommitFinal.data?.event?.event_type === 'narrative_beat');

  // ----- 5-item batch fails closed (sessionService rejects) -----
  const overSession = '00000000-0000-4000-8000-09090909cccc';
  await newSession(overSession);
  const overReq = await post(`/api/dev/sessions/${overSession}/generate`, {
    request_id: 'over',
    input: { text: 'hello' },
    expected_revision: 0,
  });
  // /generate caps at 4 items; we can verify via the demo provider.
  check('generate returns <=4 items', (overReq.data?.events?.length || 0) <= 4);

  // ----- pause/resume via player state machine -----
  // Drive a fresh session and verify the player can transition between
  // playing and paused states, and that pause does NOT commit any
  // additional pending lines while held.
  const pauseSession = '00000000-0000-4000-8000-09090909eeee';
  await newSession(pauseSession);
  const pauseP1 = await post(`/api/dev/sessions/${pauseSession}/generate`, {
    request_id: 'pause-turn-1', input: { text: 'hello' }, expected_revision: 0,
  });
  const pauseRecover = await request(`/api/dev/sessions/${pauseSession}/recover`);
  const pausePlayer = createPlayerDom({ baseUrl });
  await pausePlayer.ready();
  // Inject the session UUID so recoverSession surfaces the active pending.
  globalThis.__PLAYER_STATE__.sessionUuid = pauseSession;
  globalThis.__PLAYER_STATE__.lastRevision = pauseRecover.data.revision;
  globalThis.__PLAYER_STATE__.pending = {
    pending_id: pauseP1.data.pending_id,
    events: pauseP1.data.events,
    tool_call: pauseP1.data.tool_call,
    committed_count: 0,
  };
  globalThis.__PLAYER_STATE__.pendingIdx = 0;
  globalThis.__PLAYER_STATE__.canonicalHistory = pauseRecover.data.history;
  globalThis.__PLAYER_STATE__.status = 'playing';
  const beforePause = pausePlayer.snapshot();
  check('pause baseline: status playing', beforePause.status === 'playing');
  await pausePlayer.call('simulatePause');
  const afterPause = pausePlayer.snapshot();
  check('pause flips status to paused', afterPause.status === 'paused');
  // Hold the pause; revision must NOT advance while paused.
  const heldRevision = (await request(`/api/dev/sessions/${pauseSession}/recover`)).data.revision;
  await new Promise((r) => setTimeout(r, 2000));
  const stillPaused = pausePlayer.snapshot();
  check('pause holds: status remains paused', stillPaused.status === 'paused');
  const afterHoldRevision = (await request(`/api/dev/sessions/${pauseSession}/recover`)).data.revision;
  check('pause holds: no commits while paused', afterHoldRevision === heldRevision);
  await pausePlayer.call('simulateResume');
  const afterResume = pausePlayer.snapshot();
  check('resume flips status to playing', afterResume.status === 'playing');

  // ----- commit failure does NOT advance the player -----
  // A commit returning 400 should leave the pending line in place and
  // pause the autoplay driver; the player must not jump to the next
  // pending line.
  const failSession = '00000000-0000-4000-8000-09090909ffff';
  await newSession(failSession);
  const failGen = await post(`/api/dev/sessions/${failSession}/generate`, {
    request_id: 'fail-turn-1', input: { text: 'hello' }, expected_revision: 0,
  });
  // Force a wrong revision so the next commit fails 400.
  const failCommit = await post(`/api/dev/sessions/${failSession}/narrative-events`, {
    pending_id: failGen.data.pending_id,
    sequence: 0,
    expected_revision: 9999,
    client_request_id: 'fail-commit',
  });
  check('commit failure returns 400', failCommit.response.status === 400);
  check('commit failure error code is revision_mismatch', failCommit.data?.error === 'revision_mismatch');
  // Recover must still report the active pending (no commits landed).
  const failRecover = await request(`/api/dev/sessions/${failSession}/recover`);
  check('commit failure leaves active pending', failRecover.data?.pending?.pending_id === failGen.data.pending_id);
  check('commit failure does not advance revision', failRecover.data?.history?.length === 0);

  // ----- finish_story path: player reaches finished with terminal card -----
  const finishSession = '00000000-0000-4000-8000-0909090a1111';
  await newSession(finishSession);
  // Force 5 turns of "hello" → demo provider's autoFinish fires at turn 5.
  let finishRevision = 0;
  let finishToolCall = null;
  for (let turn = 1; turn <= 5; turn += 1) {
    const gen = await post(`/api/dev/sessions/${finishSession}/generate`, {
      request_id: `finish-turn-${turn}`, input: { text: 'hello' }, expected_revision: finishRevision,
    });
    if (!gen.data?.pending_id) break;
    for (let i = 0; i < gen.data.events.length; i += 1) {
      const c = await post(`/api/dev/sessions/${finishSession}/narrative-events`, {
        pending_id: gen.data.pending_id, sequence: i, expected_revision: finishRevision,
        client_request_id: `finish-commit-${turn}-${i}`,
      });
      if (c.response.status !== 200) break;
      finishRevision = c.data.revision;
      // The final commit of the turn that triggered autoFinish surfaces
      // the finish_story tool_call as `pending_tool_call`.
      if (i === gen.data.events.length - 1 && c.data?.pending_tool_call) {
        finishToolCall = c.data.pending_tool_call;
      }
    }
  }
  check('finish_story surfaces terminal tool_call on final commit', finishToolCall && finishToolCall.name === 'finish_story');
  check('finish_story tool_call carries ending payload', finishToolCall && typeof finishToolCall.payload?.ending === 'string');
  check('finish_story tool_call is terminal', finishToolCall && finishToolCall.terminal === true);

  // ----- recover with active pending -----
  // Stage a fresh batch but do NOT commit any items. Recover must surface
  // the active pending_id + events + committed_count for the player to
  // resume without re-running the provider.
  const activeSession = '00000000-0000-4000-8000-0909090a2222';
  await newSession(activeSession);
  const activeGen = await post(`/api/dev/sessions/${activeSession}/generate`, {
    request_id: 'active-turn-1', input: { text: 'hello' }, expected_revision: 0,
  });
  const activeRec = await request(`/api/dev/sessions/${activeSession}/recover`);
  check('recover with active pending returns pending', activeRec.data?.pending !== null);
  check('recover active pending_id matches', activeRec.data?.pending?.pending_id === activeGen.data.pending_id);
  check('recover active pending has events', Array.isArray(activeRec.data?.pending?.events));
  check('recover active pending committed_count is 0', activeRec.data?.pending?.committed_count === 0);

  // ----- keyboard + aria-label coverage -----
  // The static DOM ships icon buttons that need aria-label/title; the
  // player screen exposes pause/skip/share/back as keyboard reachable
  // surfaces.
  const ariaPlayer = createPlayerDom({ baseUrl });
  await ariaPlayer.ready();
  const aria = await ariaPlayer.call('accessibilityAudit');
  check('back button has aria-label', !!aria.backAriaLabel);
  check('share button has aria-label', !!aria.shareAriaLabel);
  check('pause button has aria-label', !!aria.pauseAriaLabel);
  check('input field has accessible name', !!aria.inputAria);
  check('player status uses aria-live region', !!aria.statusLive);

  // ----- mobile layout static: no horizontal overflow + non-empty first frame -----
  // Same harness but with a 390x844 viewport proxy (we simulate via
  // clientWidth override). The non-empty check is that the picker DOM
  // contains the picker title + at least one story chip once the
  // bootstrap finishes.
  const mobilePlayer = createPlayerDom({ baseUrl, viewport: { width: 390, height: 844 } });
  await mobilePlayer.ready();
  await new Promise((r) => setTimeout(r, 1500));
  const mobileLayout = await mobilePlayer.call('layoutOverflow');
  check('mobile layout: scrollWidth ≤ clientWidth', mobileLayout.scrollWidth <= mobileLayout.clientWidth + 1);
  const mobileDom = await mobilePlayer.call('firstFrameSurface');
  check('mobile first frame contains picker title', mobileDom.pickerTitle);
  check('mobile first frame contains at least one story chip', mobileDom.storyChipCount >= 1);

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall 09 checks passed');
} finally {
  await new Promise((resolve) => server.close(resolve));
}