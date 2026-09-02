// tests/observabilityHttp.test.mjs — HTTP-level proof that the ClickUp 14
// observability sidecar is actually wired into the route layer.
//
// sessionHttp.test.mjs covers the session contract; this file drives the
// same demo flow (rebuild cache → create session → commit → interrupt) and
// asserts the counters the /api/admin/observability endpoints expose move
// off zero — the wiring docs/observability.md §5/§7 promise.

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
const sessionUuid = '00000000-0000-4000-8000-eeeeeeeeeeee';
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
  // --- endpoint shape before any traffic ---
  const emptySummary = await request('/api/admin/observability/metrics/summary');
  check('metrics summary 200', emptySummary.response.status === 200, `status=${emptySummary.response.status}`);
  check('metrics summary exposes metrics + cache_stats',
    !!emptySummary.data?.metrics && !!emptySummary.data?.cache_stats &&
    typeof emptySummary.data.metrics.global === 'object' &&
    typeof emptySummary.data.cache_stats.global === 'object');

  const unobserved = await request(`/api/admin/observability/sessions/${sessionUuid}`);
  check('unobserved session 404 session_not_observed',
    unobserved.response.status === 404 && unobserved.data?.error === 'session_not_observed',
    `status=${unobserved.response.status}`);

  const badUuid = await request('/api/admin/observability/sessions/not-a-uuid');
  check('non-uuid session 400 or 404 (never 5xx)',
    badUuid.response.status === 400 || badUuid.response.status === 404,
    `status=${badUuid.response.status}`);

  // --- demo flow drives the counters off zero ---
  const rebuilt = await post('/api/admin/opening-cache/rebuild', {
    story_version_uuid: fixture.story_version_uuid,
  });
  const cache = rebuilt.data?.result?.cache;
  const cacheUuid = cache?.cache_uuid;
  const cacheEvents = cache?.content_payload?.events;
  check('rebuild cache 200 with events', rebuilt.response.status === 200 && !!cacheUuid && Array.isArray(cacheEvents) && cacheEvents.length > 0);

  const generationProfile = { ...cache.generation_profile, cache_uuid: cacheUuid };
  const created = await post('/api/dev/sessions', {
    session_uuid: sessionUuid,
    story_uuid: fixture.story_uuid,
    story_version_uuid: fixture.story_version_uuid,
    user_ref: 'observability-http-test-user',
    role_id: 'stranger',
    model: 'mock-model',
    prompt: '从雨夜开始',
    generation_profile: generationProfile,
  });
  check('create session 200', created.response.status === 200, `status=${created.response.status}`);

  const observed = await request(`/api/admin/observability/sessions/${sessionUuid}`);
  check('observed session 200 after create', observed.response.status === 200, `status=${observed.response.status}`);
  check('session create recorded opening cache hit', observed.data?.metrics?.openingCacheHits === 1,
    `openingCacheHits=${observed.data?.metrics?.openingCacheHits}`);
  check('session is observed in opening state', observed.data?.metrics?.firstSeenAt != null);
  check('pinned view correlates with repository', observed.data?.pinned?.cache_uuid === cacheUuid);

  const summaryAfterCreate = await request('/api/admin/observability/metrics/summary');
  check('cache_stats counts the session create as a hit',
    summaryAfterCreate.data?.cache_stats?.global?.hits >= 1 &&
    summaryAfterCreate.data?.cache_stats?.caches?.[cacheUuid]?.hits >= 1,
    `hits=${summaryAfterCreate.data?.cache_stats?.global?.hits}`);
  check('sessionsObserved counts the created session',
    summaryAfterCreate.data?.metrics?.global?.sessionsObserved >= 1,
    `sessionsObserved=${summaryAfterCreate.data?.metrics?.global?.sessionsObserved}`);

  const committed = await post(`/api/dev/sessions/${sessionUuid}/opening-events`, {
    cache_uuid: cacheUuid,
    event: { ...cacheEvents[0], displayed: true },
    client_request_id: 'observability-opening-0',
    expected_revision: 0,
  });
  check('first opening commit 200', committed.response.status === 200, `status=${committed.response.status}`);

  const observedAfterCommit = await request(`/api/admin/observability/sessions/${sessionUuid}`);
  check('commit latency recorded', observedAfterCommit.data?.metrics?.commitLatency?.count >= 1,
    `commitLatency.count=${observedAfterCommit.data?.metrics?.commitLatency?.count}`);

  const interrupted = await post(`/api/dev/sessions/${sessionUuid}/interrupt`, {
    text: '我要打断剧情',
    client_request_id: 'observability-interrupt-0',
    expected_revision: committed.data?.revision,
  });
  check('interrupt 200', interrupted.response.status === 200, `status=${interrupted.response.status}`);

  const observedAfterInterrupt = await request(`/api/admin/observability/sessions/${sessionUuid}`);
  check('realtime transition recorded', observedAfterInterrupt.data?.metrics?.realtimeTransitions === 1,
    `realtimeTransitions=${observedAfterInterrupt.data?.metrics?.realtimeTransitions}`);

  const summaryAfterInterrupt = await request('/api/admin/observability/metrics/summary');
  check('cache miss recorded on realtime fallback',
    summaryAfterInterrupt.data?.cache_stats?.global?.misses >= 1,
    `misses=${summaryAfterInterrupt.data?.cache_stats?.global?.misses}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

if (failures > 0) {
  console.log(`observability-http: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('all observability-http checks passed');
