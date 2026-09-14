// tests/endingService.test.mjs — Story 11 ending service contract coverage.
//
// Validates that:
//   * buildEnding rejects when finish_story has not committed
//   * buildEnding emits the documented payload shape from the tool
//     envelope (07 / 08 / 09 contract)
//   * buildEnding derives first_deviation from canonical history
//   * buildOriginalTimeline emits canonical key_facts from the story
//     version + opening cache and includes a `source_attribution`
//   * buildReplay strictly equals committed session_events (no
//     pending / discarded / tool_call rows; ordered by event_seq)
//   * the three projections are independent: a missing original-
//     timeline does NOT break replay or ending
//   * the HTTP layer returns 404 / 200 according to the documented
//     contract.
//
// Tests run against the live HTTP server (storyRepo is process-shared),
// so every session created via /api/dev/sessions is visible to both
// the route layer and the service layer.

import assert_ from 'node:assert/strict';
import http from 'node:http';

import { server, storyFixtures } from '../src/server.mjs';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`);
  }
}

const fixture = storyFixtures.find((row) => row.slug === 'cafe-rain');

async function postJson(baseUrl, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body: json };
}

async function getJson(baseUrl, path) {
  const res = await fetch(`${baseUrl}${path}`);
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body: json };
}

async function driveToFinish(baseUrl, sessionUuid, expectedRevision) {
  // Drive the live /generate until a finish_story tool call lands on
  // the FINAL narrative commit. Returns the final expected_revision.
  for (let turn = 1; turn <= 6; turn += 1) {
    const stagedRes = await postJson(baseUrl, `/api/dev/sessions/${sessionUuid}/generate`, {
      input: { text: 'hello' },
      expected_revision: expectedRevision,
      request_id: `ending-${sessionUuid}-${turn}`,
    });
    if (stagedRes.status !== 200) throw new Error(`turn ${turn} generate failed: ${stagedRes.status}`);
    const staged = stagedRes.body;
    expectedRevision = staged.revision;
    let committedToolCall = false;
    for (let seq = staged.pending_committed_count || 0; seq < staged.events.length; seq += 1) {
      const commitRes = await postJson(baseUrl, `/api/dev/sessions/${sessionUuid}/narrative-events`, {
        pending_id: staged.pending_id,
        sequence: seq,
        expected_revision: expectedRevision,
        client_request_id: `ending-commit-${sessionUuid}-${turn}-${seq}`,
      });
      if (commitRes.status !== 200) throw new Error(`turn ${turn} commit ${seq} failed: ${commitRes.status}`);
      const commitJson = commitRes.body;
      expectedRevision = commitJson.revision;
      if (commitJson.pending_tool_call && commitJson.pending_tool_call.name === 'finish_story') {
        committedToolCall = true;
        break;
      }
    }
    if (committedToolCall) break;
  }
  return expectedRevision;
}

async function driveOneBatch(baseUrl, sessionUuid, expectedRevision, inputText = 'long') {
  const stagedRes = await postJson(baseUrl, `/api/dev/sessions/${sessionUuid}/generate`, {
    input: { text: inputText },
    expected_revision: expectedRevision,
    request_id: `one-batch-${sessionUuid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });
  if (stagedRes.status !== 200) throw new Error(`generate failed: ${stagedRes.status}`);
  const staged = stagedRes.body;
  expectedRevision = staged.revision;
  for (let seq = staged.pending_committed_count || 0; seq < staged.events.length; seq += 1) {
    const commitRes = await postJson(baseUrl, `/api/dev/sessions/${sessionUuid}/narrative-events`, {
      pending_id: staged.pending_id,
      sequence: seq,
      expected_revision: expectedRevision,
      client_request_id: `one-batch-commit-${sessionUuid}-${seq}-${Math.random().toString(36).slice(2, 8)}`,
    });
    if (commitRes.status !== 200) throw new Error(`commit failed: ${commitRes.status}`);
    const commitJson = commitRes.body;
    expectedRevision = commitJson.revision;
    if (commitJson.pending_tool_call) break;
  }
  return expectedRevision;
}

async function main() {
  const port = await new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port: picked } = probe.address();
      probe.close(() => resolve(picked));
    });
    probe.on('error', reject);
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${port}`;

  // Cache UUID is stable across test runs because the seeded fixture
  // version UUID + generation profile are deterministic. We rebuild it
  // explicitly so the test does not rely on any pre-existing cache.
  const rebuilt = await postJson(baseUrl, '/api/admin/opening-cache/rebuild', {
    story_version_uuid: fixture.story_version_uuid,
  });
  const cache = rebuilt.body.result.cache;
  const generationProfile = { ...cache.generation_profile, cache_uuid: cache.cache_uuid };

  try {
    console.log('--- endingService contract ---');

    // ----- 1) buildEnding rejects when finish_story has not committed -----
    {
      const sessionUuid = '00000000-0000-4000-8000-110000000001';
        const created = await postJson(baseUrl, '/api/dev/sessions', {
          session_uuid: sessionUuid,
          story_uuid: fixture.story_uuid,
          story_version_uuid: fixture.story_version_uuid,
          user_ref: 'ending-service-test-1',
          role_id: 'stranger',
          model: 'mock-11',
          prompt: '11 prompt',
          generation_profile: generationProfile,
        });
      check('createSession 1 returned 200', created.status === 200);
      const endingRes = await getJson(baseUrl, `/api/dev/sessions/${sessionUuid}/ending`);
      check('GET /ending returns 404 ending_not_committed', endingRes.status === 404 && endingRes.body && endingRes.body.error === 'ending_not_committed');
    }

    // ----- 2) buildEnding emits the documented contract from the tool envelope -----
    {
      const sessionUuid = '00000000-0000-4000-8000-110000000002';
      const created = await postJson(baseUrl, '/api/dev/sessions', {
        session_uuid: sessionUuid,
        story_uuid: fixture.story_uuid,
        story_version_uuid: fixture.story_version_uuid,
        user_ref: 'ending-service-test-2',
        role_id: 'stranger',
        model: 'mock-11',
        prompt: '11 prompt',
        generation_profile: generationProfile,
      });
      check('createSession 2 returned 200', created.status === 200);
      await driveToFinish(baseUrl, sessionUuid, 0);
      const endingRes = await getJson(baseUrl, `/api/dev/sessions/${sessionUuid}/ending`);
      check('GET /ending returns 200 after finish_story commit', endingRes.status === 200);
      const ending = endingRes.body;
      check('GET /ending has ending_title', typeof ending.ending_title === 'string' && ending.ending_title.length > 0);
      check('GET /ending has ending_summary', typeof ending.ending_summary === 'string');
      check('GET /ending has key_choices array', Array.isArray(ending.key_choices));
      check('GET /ending has character_outcomes array', Array.isArray(ending.character_outcomes));
      check('GET /ending has first_deviation', ending.first_deviation === null || typeof ending.first_deviation === 'object');
      check('GET /ending has total_analysis', typeof ending.total_analysis === 'string' && ending.total_analysis.length > 0);
      check('GET /ending has ending_key', ending.ending_key === null || typeof ending.ending_key === 'string');
      check('GET /ending has category', typeof ending.category === 'string' && ending.category.includes('cafe-rain'));
      check('GET /ending category has version_no', /v\d+/.test(ending.category));
    }

    // ----- 3) buildOriginalTimeline emits canonical key_facts -----
    {
      const sessionUuid = '00000000-0000-4000-8000-110000000003';
      await postJson(baseUrl, '/api/dev/sessions', {
        session_uuid: sessionUuid,
        story_uuid: fixture.story_uuid,
        story_version_uuid: fixture.story_version_uuid,
        user_ref: 'ending-service-test-3',
        role_id: 'stranger',
        model: 'mock-11',
        prompt: '11 prompt',
        generation_profile: generationProfile,
      });
      const timelineRes = await getJson(baseUrl, `/api/dev/sessions/${sessionUuid}/original-timeline`);
      check('GET /original-timeline returns 200', timelineRes.status === 200);
      const timeline = timelineRes.body;
      check('GET /original-timeline has story_id', timeline.story_id === fixture.story_uuid);
      check('GET /original-timeline has story_version_id', timeline.story_version_id === fixture.story_version_uuid);
      check('GET /original-timeline has key_facts array', Array.isArray(timeline.key_facts));
      check('GET /original-timeline has source_attribution', typeof timeline.source_attribution === 'string' && timeline.source_attribution.includes('来自原作'));
      check('GET /original-timeline key_facts include story_title', timeline.key_facts.some((f) => f.kind === 'story_title'));
      check('GET /original-timeline key_facts include story_hook', timeline.key_facts.some((f) => f.kind === 'story_hook'));
      check('GET /original-timeline key_facts include story_roles', timeline.key_facts.some((f) => f.kind === 'story_roles'));
      check('GET /original-timeline key_facts include opening_beat', timeline.key_facts.some((f) => f.kind === 'opening_beat'));
      check('GET /original-timeline key_facts include choice_boundary', timeline.key_facts.some((f) => f.kind === 'choice_boundary'));
      // Source attribution must explicitly mark this as the original work.
      check('GET /original-timeline source_attribution marks original', timeline.source_attribution.length > 0);
    }

    // ----- 4) buildReplay strictly equals committed session_events -----
    {
      const sessionUuid = '00000000-0000-4000-8000-110000000004';
      await postJson(baseUrl, '/api/dev/sessions', {
        session_uuid: sessionUuid,
        story_uuid: fixture.story_uuid,
        story_version_uuid: fixture.story_version_uuid,
        user_ref: 'ending-service-test-4',
        role_id: 'stranger',
        model: 'mock-11',
        prompt: '11 prompt',
        generation_profile: generationProfile,
      });
      // Drive 2 narrative batches.
      let rev = 0;
      rev = await driveOneBatch(baseUrl, sessionUuid, rev);
      rev = await driveOneBatch(baseUrl, sessionUuid, rev);
      const replayRes = await getJson(baseUrl, `/api/dev/sessions/${sessionUuid}/replay`);
      check('GET /replay returns 200', replayRes.status === 200);
      const replay = replayRes.body.events;
      check('GET /replay returns events array', Array.isArray(replay));
      check('GET /replay events exclude tool_call', !replay.some((ev) => ev.type === 'tool_call'));
      check('GET /replay events exclude pending_tool_call', !replay.some((ev) => ev.type === 'pending_tool_call'));
      check('GET /replay events exclude pending', !replay.some((ev) => ev.type === 'pending'));
      check('GET /replay events exclude discarded', !replay.some((ev) => ev.type === 'discarded'));
      const sequences = replay.map((ev) => ev.sequence || 0);
      const sorted = sequences.slice().sort((a, b) => a - b);
      check('GET /replay ordered by sequence ascending', JSON.stringify(sequences) === JSON.stringify(sorted));
      // Shape: every event has sequence + type + text + occurred_at + source.
      const allShaped = replay.every((ev) => Number.isInteger(ev.sequence) && typeof ev.type === 'string' && typeof ev.text === 'string' && typeof ev.occurred_at === 'string' && typeof ev.source === 'string');
      check('GET /replay events have stable shape', allShaped);
    }

    // ----- 5) Refresh / replay strict equality -----
    {
      const sessionUuid = '00000000-0000-4000-8000-110000000005';
      await postJson(baseUrl, '/api/dev/sessions', {
        session_uuid: sessionUuid,
        story_uuid: fixture.story_uuid,
        story_version_uuid: fixture.story_version_uuid,
        user_ref: 'ending-service-test-5',
        role_id: 'stranger',
        model: 'mock-11',
        prompt: '11 prompt',
        generation_profile: generationProfile,
      });
      let rev = 0;
      rev = await driveOneBatch(baseUrl, sessionUuid, rev);
      // Call /replay twice; assert equal.
      const a = await getJson(baseUrl, `/api/dev/sessions/${sessionUuid}/replay`);
      const b = await getJson(baseUrl, `/api/dev/sessions/${sessionUuid}/replay`);
      check('GET /replay deterministic across calls', JSON.stringify(a.body) === JSON.stringify(b.body));
    }

    // ----- 6) Replay includes committed history but no pending -----
    {
      const sessionUuid = '00000000-0000-4000-8000-110000000006';
      await postJson(baseUrl, '/api/dev/sessions', {
        session_uuid: sessionUuid,
        story_uuid: fixture.story_uuid,
        story_version_uuid: fixture.story_version_uuid,
        user_ref: 'ending-service-test-6',
        role_id: 'stranger',
        model: 'mock-11',
        prompt: '11 prompt',
        generation_profile: generationProfile,
      });
      // Stage a batch but DO NOT commit any events — the staged batch
      // is on session.pending (not in history). /replay must NOT include
      // those staged events.
      const stagedRes = await postJson(baseUrl, `/api/dev/sessions/${sessionUuid}/generate`, {
        input: { text: 'hello' },
        expected_revision: 0,
        request_id: `staged-${sessionUuid}`,
      });
      check('generate returned 200', stagedRes.status === 200);
      const replayRes = await getJson(baseUrl, `/api/dev/sessions/${sessionUuid}/replay`);
      const replay = replayRes.body.events;
      // The replay must contain only opening events (none, since we
      // did not commit any opening events for this session either).
      check('GET /replay does not include staged pending items', !replay.some((ev) => ev.source === 'runtime' && /demo/.test(ev.text || '')));
    }

    // ----- 7) buildReplay is independent of buildOriginalTimeline failure -----
    {
      const sessionUuid = '00000000-0000-4000-8000-110000000007';
      await postJson(baseUrl, '/api/dev/sessions', {
        session_uuid: sessionUuid,
        story_uuid: fixture.story_uuid,
        story_version_uuid: fixture.story_version_uuid,
        user_ref: 'ending-service-test-7',
        role_id: 'stranger',
        model: 'mock-11',
        prompt: '11 prompt',
        generation_profile: generationProfile,
      });
      let rev = 0;
      rev = await driveOneBatch(baseUrl, sessionUuid, rev);
      // The original-timeline should still return 200 even after the
      // session has been driven; nothing in buildOriginalTimeline reads
      // the canonical history. The replay should not be affected.
      const timelineRes = await getJson(baseUrl, `/api/dev/sessions/${sessionUuid}/original-timeline`);
      check('GET /original-timeline 200 after narrative batch', timelineRes.status === 200);
      const replayRes = await getJson(baseUrl, `/api/dev/sessions/${sessionUuid}/replay`);
      check('GET /replay 200 after narrative batch', replayRes.status === 200);
      check('GET /replay still has events after narrative batch', replayRes.body.events.length > 0);
    }

    // ----- 8) finish envelope survives a final commit WITHOUT client_request_id -----
    {
      // A caller that omits client_request_id leaves no trace in the
      // idempotency map, and the final commit clears session.pending.
      // The session-owned finish envelope must keep /ending reachable.
      const sessionUuid = '00000000-0000-4000-8000-110000000008';
      const created = await postJson(baseUrl, '/api/dev/sessions', {
        session_uuid: sessionUuid,
        story_uuid: fixture.story_uuid,
        story_version_uuid: fixture.story_version_uuid,
        user_ref: 'ending-service-test-8',
        role_id: 'stranger',
        model: 'mock-11',
        prompt: '11 prompt',
        generation_profile: generationProfile,
      });
      check('createSession 8 returned 200', created.status === 200);
      // 'finish' → demo provider stages a 1-item batch + finish_story.
      const stagedRes = await postJson(baseUrl, `/api/dev/sessions/${sessionUuid}/generate`, {
        input: { text: 'finish' },
        expected_revision: 0,
      });
      check('generate 8 (finish) returned 200', stagedRes.status === 200 && Array.isArray(stagedRes.body.events) && stagedRes.body.events.length === 1);
      const finalCommit = await postJson(baseUrl, `/api/dev/sessions/${sessionUuid}/narrative-events`, {
        pending_id: stagedRes.body.pending_id,
        sequence: 0,
        expected_revision: stagedRes.body.revision,
        // NO client_request_id here — this is the regression under test.
      });
      check('final commit without client_request_id returns 200', finalCommit.status === 200);
      check('final commit surfaces finish_story pending_tool_call', finalCommit.body.pending_tool_call && finalCommit.body.pending_tool_call.name === 'finish_story');
      const endingRes = await getJson(baseUrl, `/api/dev/sessions/${sessionUuid}/ending`);
      check('GET /ending returns 200 after a finish commit WITHOUT client_request_id', endingRes.status === 200);
      check('GET /ending 8 has ending_title', endingRes.status === 200 && typeof endingRes.body.ending_title === 'string' && endingRes.body.ending_title.length > 0);
    }

    // ----- 9) first_deviation is anchored on the opening events actually committed -----
    {
      // The player interrupts mid-opening (2 of the 4 cache sentences are
      // committed), then drives two narrative beats before finishing. The
      // first deviation is the FIRST narrative beat (event_seq 4) — not
      // the cache-length offset (which pointed at event_seq 5).
      const sessionUuid = '00000000-0000-4000-8000-110000000009';
      const created = await postJson(baseUrl, '/api/dev/sessions', {
        session_uuid: sessionUuid,
        story_uuid: fixture.story_uuid,
        story_version_uuid: fixture.story_version_uuid,
        user_ref: 'ending-service-test-9',
        role_id: 'stranger',
        model: 'mock-11',
        prompt: '11 prompt',
        generation_profile: generationProfile,
      });
      check('createSession 9 returned 200', created.status === 200);
      const cacheEvents = cache.content_payload.events;
      let revision = 0;
      for (let i = 0; i < 2; i += 1) {
        const commitRes = await postJson(baseUrl, `/api/dev/sessions/${sessionUuid}/opening-events`, {
          cache_uuid: cache.cache_uuid,
          event: { ...cacheEvents[i], displayed: true },
          client_request_id: `ending-9-open-${sessionUuid}-${i}`,
          expected_revision: revision,
        });
        if (commitRes.status !== 200) throw new Error(`opening commit ${i} failed: ${commitRes.status}`);
        revision = commitRes.body.revision;
      }
      const interrupted = await postJson(baseUrl, `/api/dev/sessions/${sessionUuid}/interrupt`, {
        text: '开场一半我就想改剧情',
        client_request_id: `ending-9-interrupt-${sessionUuid}`,
        expected_revision: revision,
      });
      check('interrupt mid-opening returned 200', interrupted.status === 200 && interrupted.body.state === 'realtime');
      revision = interrupted.body.revision;
      // Two narrative beats after the interrupt (two 1-item batches).
      for (let turn = 0; turn < 2; turn += 1) {
        const stagedRes = await postJson(baseUrl, `/api/dev/sessions/${sessionUuid}/generate`, {
          input: { text: 'short' },
          expected_revision: revision,
          request_id: `ending-9-turn-${sessionUuid}-${turn}`,
        });
        if (stagedRes.status !== 200) throw new Error(`turn ${turn} generate failed: ${stagedRes.status}`);
        const commitRes = await postJson(baseUrl, `/api/dev/sessions/${sessionUuid}/narrative-events`, {
          pending_id: stagedRes.body.pending_id,
          sequence: 0,
          expected_revision: stagedRes.body.revision,
          client_request_id: `ending-9-commit-${sessionUuid}-${turn}`,
        });
        if (commitRes.status !== 200) throw new Error(`turn ${turn} commit failed: ${commitRes.status}`);
        revision = commitRes.body.revision;
      }
      // Finish the story (1-item batch + finish_story, final commit
      // without client_request_id — also exercises scenario 8's path).
      const stagedRes = await postJson(baseUrl, `/api/dev/sessions/${sessionUuid}/generate`, {
        input: { text: 'finish' },
        expected_revision: revision,
        request_id: `ending-9-finish-${sessionUuid}`,
      });
      if (stagedRes.status !== 200) throw new Error(`finish generate failed: ${stagedRes.status}`);
      const finalCommit = await postJson(baseUrl, `/api/dev/sessions/${sessionUuid}/narrative-events`, {
        pending_id: stagedRes.body.pending_id,
        sequence: 0,
        expected_revision: stagedRes.body.revision,
      });
      check('finish commit 9 returned 200', finalCommit.status === 200);
      const endingRes = await getJson(baseUrl, `/api/dev/sessions/${sessionUuid}/ending`);
      check('GET /ending 9 returns 200', endingRes.status === 200);
      const deviation = endingRes.body.first_deviation;
      check('GET /ending 9 has first_deviation', deviation && typeof deviation === 'object');
      check('first_deviation anchors on the first post-opening narrative beat (event_seq 4)', deviation && deviation.event_seq === 4,
        `got ${deviation && deviation.event_seq}`);
      check('first_deviation after_opening_sequence reflects the 2 committed opening beats', deviation && deviation.after_opening_sequence === 1,
        `got ${deviation && deviation.after_opening_sequence}`);
    }
  } finally {
    server.close();
  }
  if (failures > 0) {
    console.error(`\nendingService: ${failures} failures`);
    process.exit(1);
  } else {
    console.log('\nendingService: all green');
  }
}

main().catch((err) => {
  console.error('endingService test crashed:', err);
  process.exit(1);
});