// tests/sessionHttp.test.mjs — ClickUp 05 session HTTP integration coverage.
// The server and its seeded repository are process-local, so every session id
// here is unique and the opening cache is rebuilt explicitly before creating.

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
const sessionUuid = '00000000-0000-4000-8000-cccccccccccc';
const oldSessionUuid = '00000000-0000-4000-8000-dddddddddddd';
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
  const rebuilt = await post('/api/admin/opening-cache/rebuild', {
    story_version_uuid: fixture.story_version_uuid,
  });
  const cacheUuid = rebuilt.data?.result?.cache?.cache_uuid;
  check('rebuild cache before session creation', rebuilt.response.status === 200 && !!cacheUuid);

  const createBody = {
    session_uuid: sessionUuid,
    story_uuid: fixture.story_uuid,
    story_version_uuid: fixture.story_version_uuid,
    user_ref: 'session-http-test-user',
    role_id: 'stranger',
    model: 'mock-model',
    prompt: '从雨夜开始',
    generation_profile: { cache_uuid: cacheUuid },
  };
  const created = await post('/api/dev/sessions', createBody);
  check('create session 200', created.response.status === 200, `status=${created.response.status}`);
  check('create has pinned metadata', created.data?.pinned?.role_id === 'stranger' && created.data?.pinned?.model === 'mock-model');
  check('create starts at opening cursor/revision zero', created.data?.state === 'opening' && created.data?.cursor === 0 && created.data?.revision === 0);
  check('create carries both flags', created.data?.demo?.official_zhihu_api === false && created.data?.dev?.dev_only === true);

  const recoveredEmpty = await request(`/api/dev/sessions/${sessionUuid}`);
  check('recover session 200', recoveredEmpty.response.status === 200);
  check('recovery has pinned metadata', recoveredEmpty.data?.pinned?.user_ref === 'session-http-test-user');
  check('unplayed cache events are absent from canonical history', Array.isArray(recoveredEmpty.data?.history) && recoveredEmpty.data.history.length === 0 && recoveredEmpty.data.cursor === 0);

  const event0 = { type: 'narration', sequence: 0, text: '雨声敲着玻璃。' };
  const committed0 = await post(`/api/dev/sessions/${sessionUuid}/opening-events`, {
    cache_uuid: cacheUuid,
    event: event0,
    client_request_id: 'opening-request-0',
    expected_revision: 0,
  });
  check('commit first opening event 200', committed0.response.status === 200);
  check('commit returns cursor/revision/state', committed0.data?.cursor === 1 && committed0.data?.revision === 1 && committed0.data?.state === 'opening');
  check('commit returns canonical event', committed0.data?.event?.sequence === 0 && committed0.data?.event?.text === event0.text);

  const duplicate = await post(`/api/dev/sessions/${sessionUuid}/opening-events`, {
    cache_uuid: cacheUuid,
    event: event0,
    client_request_id: 'opening-request-0',
    expected_revision: 0,
  });
  check('duplicate request is idempotent 200', duplicate.response.status === 200);
  check('duplicate does not append or advance revision', duplicate.data?.cursor === 1 && duplicate.data?.revision === 1 && duplicate.data?.event?.created_at === committed0.data?.event?.created_at);

  const outOfOrder = await post(`/api/dev/sessions/${sessionUuid}/opening-events`, {
    cache_uuid: cacheUuid,
    event: { type: 'dialogue', sequence: 4, text: '乱序事件' },
    client_request_id: 'opening-request-out-of-order',
    expected_revision: 1,
  });
  check('out-of-order event rejected 400', outOfOrder.response.status === 400);
  check('out-of-order maps to stable validation code', outOfOrder.data?.error === 'validation_failed' && typeof outOfOrder.data?.message === 'string');

  const wrongRevision = await post(`/api/dev/sessions/${sessionUuid}/opening-events`, {
    cache_uuid: cacheUuid,
    event: { type: 'narration', sequence: 1, text: '不应写入' },
    client_request_id: 'opening-request-wrong-revision',
    expected_revision: 99,
  });
  check('revision mismatch rejected 400', wrongRevision.response.status === 400);
  check('revision mismatch has stable code', wrongRevision.data?.error === 'revision_mismatch');

  const committed1 = await post(`/api/dev/sessions/${sessionUuid}/opening-events`, {
    cache_uuid: cacheUuid,
    event: { type: 'action', sequence: 1, text: '她把杯沿推向你。' },
    client_request_id: 'opening-request-1',
    expected_revision: 1,
  });
  check('commit second opening event after rejection', committed1.response.status === 200 && committed1.data?.revision === 2);

  const interrupted = await post(`/api/dev/sessions/${sessionUuid}/interrupt`, {
    text: '我在等你。',
    client_request_id: 'interrupt-request-0',
    expected_revision: 2,
  });
  check('interrupt 200', interrupted.response.status === 200);
  check('interrupt returns player event', interrupted.data?.player_event?.type === 'player_input' && interrupted.data?.event?.sequence === 2);
  check('interrupt returns realtime transition', interrupted.data?.state === 'realtime' && interrupted.data?.realtime_transition?.state === 'realtime');

  const recovered = await request(`/api/dev/sessions/${sessionUuid}`);
  check('recover after commits 200', recovered.response.status === 200);
  check('recovery returns only committed canonical history', recovered.data?.history?.length === 3 && recovered.data.history[0].sequence === 0 && recovered.data.history[2].type === 'player_input');
  check('recovery cursor/revision match history', recovered.data?.cursor === 3 && recovered.data?.revision === 3);

  const unknown = await request('/api/dev/sessions/00000000-0000-4000-8000-eeeeeeeeeeee');
  check('unknown session is 404', unknown.response.status === 404 && unknown.data?.error === 'session_not_found');

  const invalidCache = await post('/api/dev/sessions', {
    ...createBody,
    session_uuid: '00000000-0000-4000-8000-ffffffffffff',
    generation_profile: { cache_uuid: '00000000-0000-4000-8000-000000000000' },
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
