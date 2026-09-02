// tests/sessionHttp.test.mjs — HTTP contract coverage for ClickUp 05 session playback.
// The server and its seeded repository are process-local. Cache events are read
// from the rebuild response so this test never depends on fixture prose.

import http from 'node:http';

import { server, storyFixtures } from '../src/server.mjs';

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
const sessionUuid = '00000000-0000-4000-8000-cccccccccccc';
const sharedSessionUuid = '00000000-0000-4000-8000-aaaaaaaaaaaa';
const oldSessionUuid = '00000000-0000-4000-8000-dddddddddddd';
const crossCacheSessionUuid = '00000000-0000-4000-8000-bbbbbbbbbbbb';
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

function commitBody(cacheUuid, event, requestId, revision, overrides = {}) {
  return {
    cache_uuid: cacheUuid,
    event: { ...event, displayed: true },
    client_request_id: requestId,
    expected_revision: revision,
    ...overrides,
  };
}

await new Promise((resolve) => server.listen(PICK, '127.0.0.1', resolve));
try {
  const rebuilt = await post('/api/admin/opening-cache/rebuild', {
    story_version_uuid: fixture.story_version_uuid,
  });
  const cache = rebuilt.data?.result?.cache;
  const cacheUuid = cache?.cache_uuid;
  const cacheEvents = cache?.content_payload?.events;
  const cacheProfile = cache?.generation_profile;
  check('rebuild cache before session creation', rebuilt.response.status === 200 && !!cacheUuid);
  check('test uses actual cache payload events', Array.isArray(cacheEvents) && cacheEvents.length === cache.content_payload.event_count);
  check('cache profile has pinned generation dimensions', !!cacheProfile?.identifier && !!cacheProfile?.rules_version && !!cacheProfile?.locale && !!cacheProfile?.variant);

  // The full profile is deliberately pinned to this exact cache/version tuple.
  const generationProfile = { ...cacheProfile, cache_uuid: cacheUuid };
  const createBody = {
    session_uuid: sessionUuid,
    story_uuid: fixture.story_uuid,
    story_version_uuid: fixture.story_version_uuid,
    user_ref: 'session-http-test-user',
    role_id: 'stranger',
    model: 'mock-model',
    prompt: '从雨夜开始',
    generation_profile: generationProfile,
  };
  const created = await post('/api/dev/sessions', createBody);
  check('create session 200', created.response.status === 200, `status=${created.response.status}`);
  check('create has pinned metadata', created.data?.pinned?.role_id === 'stranger' && created.data?.pinned?.model === 'mock-model');
  check('create preserves complete generation profile',
    created.data?.generation_profile?.identifier === generationProfile.identifier &&
    created.data?.generation_profile?.rules_version === generationProfile.rules_version &&
    created.data?.generation_profile?.locale === generationProfile.locale &&
    created.data?.generation_profile?.variant === generationProfile.variant &&
    created.data?.generation_profile?.cache_uuid === cacheUuid);
  check('create starts at opening cursor/revision zero', created.data?.state === 'opening' && created.data?.cursor === 0 && created.data?.revision === 0);
  check('create carries both flags', created.data?.demo?.official_zhihu_api === false && created.data?.dev?.dev_only === true);

  const recoveredEmpty = await request(`/api/dev/sessions/${sessionUuid}`);
  check('recover empty session 200', recoveredEmpty.response.status === 200);
  check('recovery has pinned metadata', recoveredEmpty.data?.pinned?.user_ref === 'session-http-test-user');
  check('empty history excludes unplayed cache events',
    Array.isArray(recoveredEmpty.data?.history) && recoveredEmpty.data.history.length === 0 &&
    recoveredEmpty.data.cursor === 0 && recoveredEmpty.data.revision === 0);

  const event0 = cacheEvents[0];
  const committed0 = await post(`/api/dev/sessions/${sessionUuid}/opening-events`, commitBody(cacheUuid, event0, 'opening-request-0', 0));
  const canonical0 = committed0.data?.event;
  check('commit first actual cache event 200', committed0.response.status === 200);
  check('commit returns cursor/revision/state', committed0.data?.cursor === 1 && committed0.data?.revision === 1 && committed0.data?.state === 'opening');
  check('opening event maps to canonical fields',
    !!canonical0?.event_id && canonical0.event_id !== event0.event_id &&
    canonical0?.event_seq === 1 && canonical0?.event_type === 'story_opening' &&
    canonical0?.origin === 'imported' && canonical0?.source === 'opening_cache' &&
    canonical0?.source_sequence === event0.sequence);
  const expectedPayload0 = { ...event0 };
  delete expectedPayload0.sequence;
  check('canonical opening payload comes from cache event', JSON.stringify(canonical0?.payload) === JSON.stringify(expectedPayload0));

  const duplicate = await post(`/api/dev/sessions/${sessionUuid}/opening-events`, commitBody(cacheUuid, event0, 'opening-request-0', 0));
  check('duplicate opening request is idempotent 200', duplicate.response.status === 200);
  check('duplicate does not append or advance revision', duplicate.data?.cursor === 1 && duplicate.data?.revision === 1 && duplicate.data?.event?.event_id === canonical0?.event_id);

  const missingDisplayed = await post(`/api/dev/sessions/${sessionUuid}/opening-events`, {
    cache_uuid: cacheUuid,
    event: event0,
    client_request_id: 'opening-request-not-displayed',
    expected_revision: 1,
  });
  check('event without explicit displayed marker rejected 400', missingDisplayed.response.status === 400 && missingDisplayed.data?.error === 'validation_failed');

  const outOfOrder = await post(`/api/dev/sessions/${sessionUuid}/opening-events`, commitBody(cacheUuid, cacheEvents[2], 'opening-request-out-of-order', 1));
  check('out-of-order event rejected 400', outOfOrder.response.status === 400);
  check('out-of-order maps to stable validation code', outOfOrder.data?.error === 'validation_failed' && typeof outOfOrder.data?.message === 'string');

  const wrongRevision = await post(`/api/dev/sessions/${sessionUuid}/opening-events`, commitBody(cacheUuid, cacheEvents[1], 'opening-request-wrong-revision', 99));
  check('revision mismatch rejected 400', wrongRevision.response.status === 400);
  check('revision mismatch has stable code', wrongRevision.data?.error === 'revision_mismatch');

  const choice = await post(`/api/dev/sessions/${sessionUuid}/opening-events`, commitBody(cacheUuid, {
    type: 'ask_player_choice', sequence: 1, text: 'choice marker',
  }, 'opening-request-choice', 1));
  check('choice event rejected 400', choice.response.status === 400 && choice.data?.error === 'validation_failed');

  const committed1 = await post(`/api/dev/sessions/${sessionUuid}/opening-events`, commitBody(cacheUuid, cacheEvents[1], 'opening-request-1', 1));
  check('commit next actual cache event after rejections', committed1.response.status === 200 && committed1.data?.revision === 2 && committed1.data?.cursor === 2);

  let revision = committed1.data.revision;
  for (let index = 2; index < cacheEvents.length; index += 1) {
    const committed = await post(`/api/dev/sessions/${sessionUuid}/opening-events`, commitBody(cacheUuid, cacheEvents[index], `opening-request-${index}`, revision));
    revision = committed.data?.revision;
    check(`commit actual cache event ${index + 1}/${cacheEvents.length}`, committed.response.status === 200 && committed.data?.cursor === index + 1 && committed.data?.revision === index + 1);
  }
  check('completion reaches first-choice boundary',
    revision === cacheEvents.length && (await request(`/api/dev/sessions/${sessionUuid}`)).data?.state === 'awaiting_first_choice');

  const interrupted = await post(`/api/dev/sessions/${sessionUuid}/interrupt`, {
    text: '我在等你。',
    client_request_id: 'interrupt-request-0',
    expected_revision: revision,
  });
  check('interrupt appends player input and returns 200', interrupted.response.status === 200);
  check('interrupt maps player event fields',
    interrupted.data?.player_event?.event_type === 'player_input' &&
    interrupted.data?.player_event?.origin === 'user' &&
    interrupted.data?.player_event?.source === 'player' &&
    interrupted.data?.player_event?.event_seq === revision + 1 &&
    // player source_sequence is the per-(session, source) counter: first
    // player event of this session → 0 (never mirrors event_seq).
    interrupted.data?.player_event?.source_sequence === 0);
  check('interrupt returns realtime transition', interrupted.data?.state === 'realtime' && interrupted.data?.realtime_transition?.state === 'realtime');
  const duplicateInterrupt = await post(`/api/dev/sessions/${sessionUuid}/interrupt`, {
    text: '我在等你。', client_request_id: 'interrupt-request-0', expected_revision: 0,
  });
  check('duplicate interrupt request is idempotent 200', duplicateInterrupt.response.status === 200 && duplicateInterrupt.data?.event?.event_id === interrupted.data?.event?.event_id);

  const recovered = await request(`/api/dev/sessions/${sessionUuid}`);
  check('recover after commits 200', recovered.response.status === 200);
  check('recovery returns only committed canonical history',
    recovered.data?.history?.length === cacheEvents.length + 1 &&
    recovered.data.history[0].event_type === 'story_opening' &&
    recovered.data.history.at(-1).event_type === 'player_input');
  // Canonical cursor counts ALL committed events (openings + player_input).
  check('recovery cursor/revision match displayed openings and history',
    recovered.data?.cursor === cacheEvents.length + 1 &&
    recovered.data?.revision === cacheEvents.length + 1 &&
    recovered.data?.opening_cursor === cacheEvents.length);
  check('recovery is read-only and cache remains valid',
    recovered.data?.opening_cache_status === 'valid' &&
    (await request(`/api/dev/sessions/${sessionUuid}`)).data?.history?.length === recovered.data.history.length);

  // A second session may safely reuse the same cache. This also exercises the
  // route's cache-pinned defaulting path for omitted profile dimensions.
  const shared = await post('/api/dev/sessions', {
    ...createBody,
    session_uuid: sharedSessionUuid,
    user_ref: 'shared-cache-user',
    generation_profile: { cache_uuid: cacheUuid },
  });
  check('shared cache can create another session', shared.response.status === 200 && shared.data?.cache_uuid === cacheUuid);
  check('cache-only profile defaults from pinned cache',
    shared.data?.generation_profile?.identifier === cacheProfile.identifier &&
    shared.data?.generation_profile?.rules_version === cacheProfile.rules_version &&
    shared.data?.generation_profile?.locale === cacheProfile.locale &&
    shared.data?.generation_profile?.variant === cacheProfile.variant);
  const sharedRecovered = await request(`/api/dev/sessions/${sharedSessionUuid}`);
  check('shared-cache session starts with empty canonical history', sharedRecovered.response.status === 200 && sharedRecovered.data?.history?.length === 0);
  const cacheStillValid = await post('/api/admin/opening-cache/rebuild', { story_version_uuid: fixture.story_version_uuid });
  check('shared cache remains valid after interrupt and recovery', cacheStillValid.data?.result?.cache?.cache_uuid === cacheUuid && cacheStillValid.data?.result?.cache?.status === 'valid');

  const otherRebuilt = await post('/api/admin/opening-cache/rebuild', { story_version_uuid: otherFixture.story_version_uuid });
  const otherCacheUuid = otherRebuilt.data?.result?.cache?.cache_uuid;
  const crossCache = await post('/api/dev/sessions', {
    ...createBody,
    session_uuid: crossCacheSessionUuid,
    generation_profile: { ...otherRebuilt.data.result.cache.generation_profile, cache_uuid: otherCacheUuid },
  });
  check('valid cache from another version is rejected', crossCache.response.status === 400 && crossCache.data?.error === 'invalid_cache');

  const unknown = await request('/api/dev/sessions/00000000-0000-4000-8000-eeeeeeeeeeee');
  check('unknown session is 404', unknown.response.status === 404 && unknown.data?.error === 'session_not_found');
  const invalidCache = await post('/api/dev/sessions', {
    ...createBody,
    session_uuid: '00000000-0000-4000-8000-ffffffffffff',
    generation_profile: { ...generationProfile, cache_uuid: '00000000-0000-4000-8000-000000000000' },
  });
  check('invalid cache is 400', invalidCache.response.status === 400 && invalidCache.data?.error === 'invalid_cache');
  const duplicateSession = await post('/api/dev/sessions', createBody);
  check('duplicate session is 400', duplicateSession.response.status === 400 && duplicateSession.data?.error === 'duplicate_session');

  const oldRoute = await post('/api/dev/sessions', {
    session_uuid: oldSessionUuid,
    story_uuid: fixture.story_uuid,
    story_version_uuid: fixture.story_version_uuid,
    user_ref: 'legacy-user',
    role_id: 'old-friend',
  });
  check('old Phase 4 session snapshot route remains 200', oldRoute.response.status === 200);
  check('old route still returns snapshot shape', oldRoute.data?.snapshot?.session_uuid === oldSessionUuid && oldRoute.data?.snapshot?.opening_cache_uuid === cacheUuid);
  const oldHealth = await request('/api/health');
  check('old health route remains 200', oldHealth.response.status === 200 && oldHealth.data?.phase === 4);
  const oldStories = await request('/api/stories');
  check('old stories route remains 200', oldStories.response.status === 200 && Array.isArray(oldStories.data?.stories));
} finally {
  await new Promise((resolve) => server.close(resolve));
}

if (failures > 0) {
  console.error(`\n${failures} session HTTP check(s) failed`);
  process.exit(1);
}
console.log('\nall session HTTP checks passed');
