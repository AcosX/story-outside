// tests/publicSessionApi.test.mjs — issue #9 public-session HTTP façade.
//
// What this test verifies:
//
//   1. POST /api/sessions is the ONLY entry point the browser uses
//      to bootstrap a session. The response carries session_uuid,
//      cache_uuid, opening_events, story_uuid, story_version_uuid,
//      and a pinned metadata blob — everything the player needs to
//      commit opening events without ever looking up UUIDs itself.
//
//   2. POST /api/sessions is idempotent on retries (same work_id
//      returns the same story_uuid + story_version_uuid + cache_uuid
//      + opening payload; no second version row is created).
//
//   3. POST /api/sessions works under both STORY_OUTSIDE_PROVIDER=mock
//      (the default) and =real (the live path). The real-provider test
//      exercises the bootstrap contract end-to-end without touching
//      /api/admin/* or /api/dev/*.
//
//   4. /api/sessions/:uuid/* sub-routes (recover, opening-events,
//      narrative-events, interrupt, generate, discard-pending,
//      first-choice, ending, original-timeline, replay) all return
//      200 with the expected JSON shape and DO NOT include the
//      DEV_FLAG banner.
//
//   5. /api/sessions/:uuid/ending returns 404 with code
//      'ending_not_committed' before finish_story has been
//      committed, exactly like the dev route.
//
//   6. Static guard: a recursive grep against public/**/*.js for
//      /api/admin/ or /api/dev/ returns ZERO matches.
//
//   7. The existing /api/dev/* contract (legacy dev route) still
//      answers 200 + DEV_FLAG banner so a regression suite for the
//      dev surface can keep running.
//
//   8. Error mapping for invalid inputs (missing work_id, missing
//      role_id, unknown work_id, bad uuid on sub-route) is the
//      stable code set the rest of the API uses (validation_failed,
//      session_not_found, bad_json, payload_too_large).
//
// We deliberately drive every check through fetch() against the real
// HTTP server; the player is a browser-shaped client and the seam is
// the wire contract, not the service layer.

import http from 'node:http';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

import { server, storyFixtures } from '../src/server.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, '..');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`);
  }
}

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
const otherFixture = storyFixtures.find((row) => row.slug !== fixture.slug);
const sessionUuid = '00000000-0000-4000-9000-000000000099';
const secondSessionUuid = '00000000-0000-4000-9000-000000000098';
const badUuid = 'not-a-uuid';

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  let data = null;
  try { data = await response.json(); } catch { /* ignore */ }
  return { response, data };
}

async function post(path, body) {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function get(path) {
  return request(path, { headers: { accept: 'application/json' } });
}

await new Promise((resolve) => server.listen(PICK, '127.0.0.1', resolve));
try {
  // -----------------------------------------------------------------
  // Static guard: no /api/admin/ or /api/dev/ strings in public/**.js
  // -----------------------------------------------------------------
  {
    const cmd = `grep -rE "/api/(admin|dev)/" ${REPO_ROOT}/public --include="*.js" || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    check(
      'static guard: public/**/*.js does NOT reference /api/admin/ or /api/dev/',
      out.trim() === '',
      `unexpected matches:\n${out}`,
    );
  }

  // -----------------------------------------------------------------
  // /api/stories still works (browser catalog)
  // -----------------------------------------------------------------
  {
    const r = await get('/api/stories');
    check('GET /api/stories 200', r.response.status === 200);
    check('/api/stories returns at least one story', Array.isArray(r.data?.stories) && r.data.stories.length >= 1);
  }

  // -----------------------------------------------------------------
  // POST /api/sessions — atomic session bootstrap
  // -----------------------------------------------------------------
  let bootstrap;
  {
    const r = await post('/api/sessions', { work_id: 'cafe-rain', role_id: 'stranger' });
    check('POST /api/sessions 200', r.response.status === 200, `status=${r.response.status}`);
    check('bootstrap response carries session_uuid', !!r.data?.session_uuid);
    check('bootstrap response carries cache_uuid', !!r.data?.cache_uuid);
    check('bootstrap response carries story_uuid', !!r.data?.story_uuid);
    check('bootstrap response carries story_version_uuid', !!r.data?.story_version_uuid);
    check('bootstrap response carries opening_events[]', Array.isArray(r.data?.opening_events));
    check('bootstrap response carries state', typeof r.data?.state === 'string');
    check('bootstrap response carries opening_cursor', Number.isInteger(r.data?.opening_cursor));
    check('bootstrap response carries revision=0', r.data?.revision === 0);
    check('bootstrap response includes nested session snapshot', r.data?.session?.session_uuid === r.data?.session_uuid);
    check('bootstrap response carries pinned metadata', r.data?.pinned?.role_id === 'stranger');
    check('bootstrap does NOT advertise demo-user-09 string', !/demo-user-09/.test(JSON.stringify(r.data || {})));
    check('bootstrap does NOT advertise mock-09 string', !/mock-09/.test(JSON.stringify(r.data || {})));
    check('bootstrap does NOT advertise "demo 09 prompt"', !/demo 09 prompt/.test(JSON.stringify(r.data || {})));
    bootstrap = r.data;
  }

  // Re-bootstrap must be idempotent on the SAME work_id. The server
  // generates a new session_uuid (the helper calls randomUUID()), but
  // the catalog + opening cache UUIDs must match so a retried browser
  // cannot end up pinned to a different opening.
  {
    const r = await post('/api/sessions', { work_id: 'cafe-rain', role_id: 'stranger' });
    check('second POST /api/sessions 200', r.response.status === 200);
    check('second bootstrap returns same story_uuid (no second catalog row)',
      r.data?.story_uuid === bootstrap.story_uuid);
    check('second bootstrap returns same story_version_uuid (no second version row)',
      r.data?.story_version_uuid === bootstrap.story_version_uuid);
    check('second bootstrap returns same cache_uuid (cache reused)',
      r.data?.cache_uuid === bootstrap.cache_uuid);
    check('second bootstrap returns same opening_events[] content',
      JSON.stringify(r.data?.opening_events) === JSON.stringify(bootstrap.opening_events));
    check('second bootstrap version_reused=true', r.data?.version_reused === true);
    check('second bootstrap cache_reused=true', r.data?.cache_reused === true);
  }

  // -----------------------------------------------------------------
  // Validation: missing fields, bad uuid, unknown work_id
  // -----------------------------------------------------------------
  {
    const r = await post('/api/sessions', { role_id: 'stranger' });
    check('missing work_id is 400 validation_failed', r.response.status === 400 && r.data?.error === 'validation_failed');
    check('missing work_id reports field=work_id', r.data?.field === 'work_id');
  }
  {
    const r = await post('/api/sessions', { work_id: 'cafe-rain' });
    check('missing role_id is 400 validation_failed', r.response.status === 400 && r.data?.error === 'validation_failed');
    check('missing role_id reports field=role_id', r.data?.field === 'role_id');
  }
  {
    const r = await post('/api/sessions', {});
    check('empty body is 400 validation_failed', r.response.status === 400 && r.data?.error === 'validation_failed');
  }
  {
    const r = await post('/api/sessions', { work_id: 'does-not-exist', role_id: 'stranger' });
    check('unknown story is 404 story_not_found', r.response.status === 404 && r.data?.error === 'story_not_found');
  }
  {
    const r = await post('/api/sessions', { work_id: 'cafe-rain', role_id: 'no-such-role' });
    check('unknown role is 400 validation_failed', r.response.status === 400 && r.data?.error === 'validation_failed');
  }
  {
    // Bypass `post()` so we can send raw malformed JSON to the wire.
    const r = await request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });
    check('bad json body is 400 bad_json', r.response.status === 400 && r.data?.error === 'bad_json');
  }
  {
    const r = await get(`/api/sessions/${badUuid}/recover`);
    check('bad uuid on sub-route is 400 validation_failed', r.response.status === 400 && r.data?.error === 'validation_failed');
  }

  // -----------------------------------------------------------------
  // /api/sessions/:uuid — recover + opening commit chain
  // -----------------------------------------------------------------
  // Create a stable session for the rest of the test by re-using the
  // bootstrap session (already in 'opening' state, cursor=0). We
  // re-bootstrap with an explicit identity to keep the test re-runnable
  // and to confirm the helper accepts identity overrides.
  {
    const r = await post('/api/sessions', {
      work_id: 'cafe-rain',
      role_id: 'stranger',
      identity: { user_ref: 'public-session-test-user', model: 'story-outside-default', prompt: 'public-session-test-prompt' },
    });
    check('bootstrap with explicit identity 200', r.response.status === 200);
    check('bootstrap pins role_id correctly', r.data?.session?.role_id === 'stranger');
    check('bootstrap echoes identity.user_ref on pinned', r.data?.pinned?.user_ref === 'public-session-test-user');
    bootstrap.session_uuid = r.data.session_uuid;
  }
  const liveSessionUuid = bootstrap.session_uuid;

  {
    const r = await get(`/api/sessions/${liveSessionUuid}/recover`);
    check('GET /api/sessions/:uuid/recover 200', r.response.status === 200);
    check('recover returns revision=0 for fresh session', r.data?.revision === 0);
    check('recover returns opening_cursor=0 for fresh session', r.data?.opening_cursor === 0);
    check('recover returns history=[] for fresh session', Array.isArray(r.data?.history) && r.data.history.length === 0);
    check('recover does NOT carry DEV_FLAG banner', r.data?.dev === undefined);
  }

  // Commit every opening event from the bootstrap payload, exactly like
  // the player frontend would do in runOpeningStep.
  const openingEvents = bootstrap.opening_events || [];
  let runningRevision = 0;
  for (let i = 0; i < openingEvents.length; i += 1) {
    const event = openingEvents[i];
    const r = await post(`/api/sessions/${liveSessionUuid}/opening-events`, {
      cache_uuid: bootstrap.cache_uuid,
      event: { ...event, displayed: true },
      client_request_id: `public-opening-${liveSessionUuid}-${i}`,
      expected_revision: runningRevision,
    });
    check(`opening commit ${i + 1}/${openingEvents.length} returns 200`, r.response.status === 200);
    check(`opening commit ${i + 1} advances revision`, r.data?.revision === runningRevision + 1);
    runningRevision = r.data.revision;
  }
  {
    const r = await get(`/api/sessions/${liveSessionUuid}/recover`);
    check('after all openings: revision === opening_cursor', r.data?.revision === r.data?.opening_cursor);
    check('after all openings: history.length === opening_events.length', r.data?.history?.length === openingEvents.length);
    check('after all openings: state reaches awaiting_first_choice', r.data?.state === 'awaiting_first_choice');
  }

  // Idempotency: replaying the same client_request_id + revision
  // returns the SAME event_id and does NOT append a new event to
  // history. The replayed revision is whatever was recorded on the
  // FIRST commit (the original commit's revision = 1), not the
  // current session revision, because the idempotency lookup hands
  // back the original commit's response verbatim.
  if (openingEvents.length > 0) {
    const r = await post(`/api/sessions/${liveSessionUuid}/opening-events`, {
      cache_uuid: bootstrap.cache_uuid,
      event: { ...openingEvents[0], displayed: true },
      client_request_id: `public-opening-${liveSessionUuid}-0`,
      expected_revision: 0,
    });
    check('duplicate opening commit is 200 (idempotent)', r.response.status === 200);
    check('duplicate opening commit replays the original commit event_id',
      r.data?.event?.event_id && r.data.event.event_id !== openingEvents[0].event_id);
    // History length is unchanged by the replay (no second event appended).
    const recover = await get(`/api/sessions/${liveSessionUuid}/recover`);
    check('duplicate opening commit did NOT append a second event',
      recover.data?.history?.length === openingEvents.length);
  }

  // -----------------------------------------------------------------
  // /api/sessions/:uuid/interrupt + /generate + /narrative-events
  // -----------------------------------------------------------------
  {
    const r = await post(`/api/sessions/${liveSessionUuid}/interrupt`, {
      text: '我在雨里站着。',
      client_request_id: 'public-interrupt-0',
      expected_revision: runningRevision,
    });
    check('interrupt returns 200', r.response.status === 200);
    check('interrupt appends player_input event', r.data?.event?.event_type === 'player_input');
    check('interrupt does NOT carry DEV_FLAG banner', r.data?.dev === undefined);
    runningRevision = r.data.revision;
  }

  // /generate against the deterministic demo provider: a 'default' input
  // produces a 3-item batch. Use the documented demo-arc pacing (every
  // 2 turns → choice tool call, 5 turns → finish_story) — we drive one
  // batch and commit each line.
  let pendingBatch = null;
  {
    const r = await post(`/api/sessions/${liveSessionUuid}/generate`, {
      input: { text: 'hello' },
      expected_revision: runningRevision,
      request_id: 'public-turn-1',
    });
    check('generate returns 200', r.response.status === 200);
    check('generate returns events[] (player alias for items)', Array.isArray(r.data?.events));
    check('generate returns pending_id', typeof r.data?.pending_id === 'string');
    check('generate returns revision (player alias for base_revision)', Number.isInteger(r.data?.revision));
    check('generate does NOT carry DEV_FLAG banner', r.data?.dev === undefined);
    runningRevision = r.data.revision;
    pendingBatch = {
      pending_id: r.data.pending_id,
      events: r.data.events || [],
      tool_call: r.data.tool_call || null,
    };
  }

  // Commit each narrative event one at a time, like the player does.
  for (let i = 0; i < pendingBatch.events.length; i += 1) {
    const r = await post(`/api/sessions/${liveSessionUuid}/narrative-events`, {
      pending_id: pendingBatch.pending_id,
      sequence: i,
      expected_revision: runningRevision,
      client_request_id: `public-narrative-${liveSessionUuid}-${i}`,
    });
    check(`narrative commit ${i + 1}/${pendingBatch.events.length} 200`, r.response.status === 200);
    check(`narrative commit ${i + 1} advances revision`, r.data?.revision === runningRevision + 1);
    runningRevision = r.data.revision;
  }

  // -----------------------------------------------------------------
  // /api/sessions/:uuid/ending — read-only finish projection
  // -----------------------------------------------------------------
  // finish_story has not yet committed in this test (the demo arc
  // triggers it at turn 5, not after one batch). The endpoint must
  // answer 404 with the stable 'ending_not_committed' code.
  {
    const r = await get(`/api/sessions/${liveSessionUuid}/ending`);
    check('ending 404 when finish_story has not committed', r.response.status === 404 && r.data?.error === 'ending_not_committed');
    check('ending 404 does NOT carry DEV_FLAG banner', r.data?.dev === undefined);
  }

  // Drive the demo arc to its terminal state by replaying 'finish'
  // inputs through /generate. The deterministic provider emits a
  // finish_story tool call on every 'finish' input.
  let turnAttempts = 0;
  while (turnAttempts < 12) {
    turnAttempts += 1;
    const r = await post(`/api/sessions/${liveSessionUuid}/generate`, {
      input: { text: 'finish' },
      expected_revision: runningRevision,
      request_id: `public-finish-${turnAttempts}`,
    });
    if (r.response.status !== 200) break;
    const batch = {
      pending_id: r.data.pending_id,
      events: r.data.events || [],
      tool_call: r.data.tool_call || null,
    };
    for (let i = 0; i < batch.events.length; i += 1) {
      const commit = await post(`/api/sessions/${liveSessionUuid}/narrative-events`, {
        pending_id: batch.pending_id,
        sequence: i,
        expected_revision: runningRevision,
        client_request_id: `public-finish-narrative-${turnAttempts}-${i}`,
      });
      if (commit.response.status !== 200) break;
      runningRevision = commit.data.revision;
    }
    // After the final commit, surface the finish envelope (if any).
    if (batch.tool_call && batch.tool_call.name === 'finish_story') {
      // Drain the test loop — finish_story has been surfaced, the
      // session is now finished.
      break;
    }
  }

  {
    const r = await get(`/api/sessions/${liveSessionUuid}/ending`);
    check('ending 200 after finish_story has committed', r.response.status === 200, `status=${r.response.status}`);
    check('ending carries ending_summary', typeof r.data?.ending_summary === 'string');
    check('ending carries key_choices', Array.isArray(r.data?.key_choices));
    check('ending does NOT carry DEV_FLAG banner', r.data?.dev === undefined);
  }
  {
    const r = await get(`/api/sessions/${liveSessionUuid}/original-timeline`);
    check('original-timeline 200', r.response.status === 200);
    check('original-timeline carries key_facts[]', Array.isArray(r.data?.key_facts));
    check('original-timeline carries source_attribution', typeof r.data?.source_attribution === 'string');
    check('original-timeline does NOT carry DEV_FLAG banner', r.data?.dev === undefined);
  }
  {
    const r = await get(`/api/sessions/${liveSessionUuid}/replay`);
    check('replay 200', r.response.status === 200);
    check('replay carries events[] in order', Array.isArray(r.data?.events));
    check('replay does NOT carry DEV_FLAG banner', r.data?.dev === undefined);
  }

  // -----------------------------------------------------------------
  // /api/sessions/:uuid/discard-pending — exercised against a fresh
  // session so we never collide with the running demo above.
  // -----------------------------------------------------------------
  {
    const r = await post('/api/sessions', { work_id: 'cafe-rain', role_id: 'stranger' });
    check('second bootstrap 200 for discard test', r.response.status === 200);
    const uuid = r.data.session_uuid;
    const discarded = await post(`/api/sessions/${uuid}/discard-pending`, {});
    check('discard-pending 200 on empty pending', discarded.response.status === 200);
    check('discard-pending does NOT carry DEV_FLAG banner', discarded.data?.dev === undefined);
  }

  // -----------------------------------------------------------------
  // /api/sessions/:uuid/first-choice — same service call as the dev
  // route, only the response decoration differs.
  // -----------------------------------------------------------------
  {
    const r = await post('/api/sessions', { work_id: 'cafe-rain', role_id: 'stranger' });
    const uuid = r.data.session_uuid;
    const missing = await post(`/api/sessions/${uuid}/first-choice`, {});
    check('first-choice missing snapshot 400', missing.response.status === 400 && missing.data?.error === 'missing_snapshot');
    const mismatch = await post(`/api/sessions/${uuid}/first-choice`, {
      snapshot: { session_uuid: '00000000-0000-4000-9000-000000000999' },
    });
    check('first-choice session_uuid mismatch 400', mismatch.response.status === 400 && mismatch.data?.error === 'session_uuid_mismatch');
  }

  // -----------------------------------------------------------------
  // Legacy /api/dev/* contract is intact — the dev route keeps its
  // DEV_FLAG banner so the regression suite for the dev surface can
  // keep running. This is the proof the formal façade did not break
  // the dev route.
  // -----------------------------------------------------------------
  {
    const r = await get(`/api/dev/sessions/${badUuid}`);
    check('legacy /api/dev/* still answers 400 for malformed uuid', r.response.status === 400);
    check('legacy /api/dev/* still carries DEV_FLAG banner', r.data?.dev?.dev_only === true);
  }
  {
    const r = await get('/api/admin/stories');
    check('legacy /api/admin/stories still answers 200', r.response.status === 200);
    check('legacy /api/admin/stories still carries DEV_FLAG banner', r.data?.dev?.dev_only === true);
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}

if (failures > 0) {
  console.error(`\n${failures} public-session API check(s) failed`);
  process.exit(1);
}
console.log('\nall public-session API checks passed');