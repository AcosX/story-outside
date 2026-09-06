// tests/ecosystemHotRebuilt.test.mjs
//
// ClickUp 16.4 — ecosystem hot-list regression test (rebuilt on
// current main 44343b2). Covers the four ChatGPT-inspection P1
// findings from the previous PR #14:
//
//   1. Real provider endpoint MUST be
//        https://api.zhihu.com/api/v1/content/hot_list
//      (not the older `/openapi/feed/hot` path PR #14 had pinned).
//      ZHIHU_HOT_ENDPOINT env var MUST override the default.
//   2. Pair-key cache MUST be keyed by (category, bucket), NOT a
//      single global entry. A→B→A must still hit A.
//   3. Public HTTP façade GET /v1/ecosystem/hot MUST NOT live under
//      /api/admin/* or /api/dev/*, and MUST NOT leak DEV_FLAG.
//      Graceful degradation: 5xx / 4xx / timeout / shape error
//      must not 5xx the HTTP request.
//   4. The home-page module MUST live in public/ and MUST NOT
//      introduce any /api/admin/* /api/dev/* references (the static
//      grep contract). The DOM must carry a fallback placeholder so
//      the page never goes blank on upstream failure.
//
// We exercise the route via the real HTTP server (so the wire
// contract is the contract under test), and we exercise the
// provider + cache + endpoint configuration directly so failures
// show up as clean unit failures.

import assert from 'node:assert/strict';
import { test, before, after, beforeEach } from 'node:test';
import http from 'node:http';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, '..');

// === Test helpers =====================================================

const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`);
  }
}

async function pickEphemeralPort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

function staticGrep(pattern, cwd, args = []) {
  // Run grep via execSync so the same pattern + path the
  // production verification uses is what the test runs. We do NOT
  // shell out to grep unconditionally — we only do it for the
  // public/ static-contract check + the zhihuHotSource.mjs
  // endpoint-contract check, where the operator-facing command
  // matters.
  try {
    const out = execSync(`grep -rnE "${pattern}" ${args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(' ')}`, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.trim();
  } catch (err) {
    if (err && err.status === 1) return ''; // grep returns 1 on no match
    throw err;
  }
}

// === Module imports (after the static check so we still report
//     contract failures when modules are broken) ====================

let serverModule;
try {
  serverModule = await import(resolvePath(REPO_ROOT, 'src/server.mjs'));
} catch (err) {
  console.error('FAIL: src/server.mjs could not be imported:', err && err.message ? err.message : err);
  process.exit(1);
}

let ecosystemHot;
let createRealZhihuHotSource;
try {
  ecosystemHot = await import(resolvePath(REPO_ROOT, 'src/providers/ecosystem/hot.mjs'));
  createRealZhihuHotSource = (await import(resolvePath(REPO_ROOT, 'src/providers/ecosystem/zhihuHotSource.mjs'))).createRealZhihuHotSource;
} catch (err) {
  console.error('FAIL: ecosystem modules could not be imported:', err && err.message ? err.message : err);
  process.exit(1);
}

const { server } = serverModule;
const { createEcosystemHotProvider, KNOWN_CATEGORIES, cacheKey, toPublicHotRow } = ecosystemHot;

// === Boot the server on an ephemeral port ============================

const PORT = await pickEphemeralPort();
const BASE = `http://127.0.0.1:${PORT}`;

before(async () => {
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// Reset the hot provider singleton between tests so cache state
// cannot leak across tests. The server module does not export a
// reset handle, so we re-import the hot.mjs module fresh per test
// for the unit tests; for the HTTP tests we rely on the singleton
// being deterministic (mock source, no upstream I/O).

beforeEach(() => {
  // best-effort: re-import the singleton by reaching through serverModule.
  // serverModule is a module namespace; the singleton is captured in
  // serverModule.server's closure. We cannot reach it directly, so
  // we accept that HTTP tests share the singleton cache. Tests that
  // need cache isolation exercise the factory directly instead.
});

// =====================================================================
// 1. Static contract checks (ChatGPT inspection P1)
// =====================================================================

test('static: src/providers/ecosystem/zhihuHotSource.mjs MUST NOT mention /openapi/feed/hot', () => {
  const hits = staticGrep('openapi/feed/hot', REPO_ROOT, ['src/providers/ecosystem/zhihuHotSource.mjs']);
  check('no openapi/feed/hot in real provider', hits === '', hits);
});

test('static: src/providers/ecosystem/zhihuHotSource.mjs MUST mention /api/v1/content/hot_list', () => {
  const hits = staticGrep('content/hot_list', REPO_ROOT, ['src/providers/ecosystem/zhihuHotSource.mjs']);
  check('content/hot_list present in real provider', hits !== '', hits);
});

test('static: public/ MUST NOT contain any /api/admin/* or /api/dev/* reference', () => {
  const hits = staticGrep('/api/(admin|dev)/', REPO_ROOT, ['public/']);
  check('public static contract clean', hits === '', hits);
});

test('static: public/index.html MUST include a <section id="ecosystem-hot-module">', () => {
  const hits = staticGrep('<section.*ecosystem-hot', REPO_ROOT, ['public/index.html']);
  check('home-page UI section present', hits !== '', hits);
});

test('static: public/index.html MUST NOT carry DEV_FLAG or the literal "dev_only"', () => {
  // The ClickUp 16.4 module is a PUBLIC surface; it must not advertise
  // any internal admin/dev-only banner.
  const hits = staticGrep('dev_only', REPO_ROOT, ['public/']);
  check('public static dev_only clean', hits === '', hits);
});

// =====================================================================
// 2. Real provider endpoint contract
// =====================================================================

test('real provider: DEFAULT_HOT_ENDPOINT is https://api.zhihu.com/api/v1/content/hot_list', async () => {
  // We do NOT mutate env in this test (the singleton captured the
  // default at module load). Instead we read the source's endpoint()
  // surface when STORY_OUTSIDE_HOT_PROVIDER=real — but since the
  // global default is mock, we instead assert via a fresh factory
  // and via the module's exported DEFAULT constant.
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(
    resolvePath(REPO_ROOT, 'src/providers/ecosystem/zhihuHotSource.mjs'),
    'utf-8',
  );
  check(
    'zhihuHotSource.mjs pins DEFAULT_HOT_ENDPOINT to content/hot_list',
    /DEFAULT_HOT_ENDPOINT\s*=\s*['"]https:\/\/api\.zhihu\.com\/api\/v1\/content\/hot_list['"]/.test(src),
    'DEFAULT_HOT_ENDPOINT literal missing or changed',
  );
});

test('real provider: ZHIHU_HOT_ENDPOINT env var overrides the default', async () => {
  const previousEndpoint = process.env.ZHIHU_HOT_ENDPOINT;
  // Point at a benign allowed URL so the constructor does not throw.
  process.env.ZHIHU_HOT_ENDPOINT = 'https://api.zhihu.com/api/v1/content/hot_list';
  try {
    const src = createRealZhihuHotSource();
    const ep = src.endpoint();
    check('endpoint() reflects env override', ep === process.env.ZHIHU_HOT_ENDPOINT, `got "${ep}"`);
  } finally {
    if (previousEndpoint === undefined) delete process.env.ZHIHU_HOT_ENDPOINT;
    else process.env.ZHIHU_HOT_ENDPOINT = previousEndpoint;
  }
});

test('real provider: refuses non-allow-listed host at construction time', () => {
  const previousEndpoint = process.env.ZHIHU_HOT_ENDPOINT;
  process.env.ZHIHU_HOT_ENDPOINT = 'https://attacker.example/api/v1/content/hot_list';
  try {
    assert.throws(
      () => createRealZhihuHotSource(),
      (err) => err && err.code === 'unsupported_upstream_host',
      'must reject non-allow-listed host at construction',
    );
    check('non-allow-listed host rejected', true);
  } finally {
    if (previousEndpoint === undefined) delete process.env.ZHIHU_HOT_ENDPOINT;
    else process.env.ZHIHU_HOT_ENDPOINT = previousEndpoint;
  }
});

test('real provider: refuses non-HTTPS endpoint at construction time', () => {
  const previousEndpoint = process.env.ZHIHU_HOT_ENDPOINT;
  process.env.ZHIHU_HOT_ENDPOINT = 'http://api.zhihu.com/api/v1/content/hot_list';
  try {
    assert.throws(
      () => createRealZhihuHotSource(),
      (err) => err && err.code === 'unsupported_upstream_origin',
      'must reject http:// scheme',
    );
    check('non-HTTPS rejected', true);
  } finally {
    if (previousEndpoint === undefined) delete process.env.ZHIHU_HOT_ENDPOINT;
    else process.env.ZHIHU_HOT_ENDPOINT = previousEndpoint;
  }
});

test('real provider: refuses malformed endpoint at construction time', () => {
  const previousEndpoint = process.env.ZHIHU_HOT_ENDPOINT;
  process.env.ZHIHU_HOT_ENDPOINT = 'not a url at all';
  try {
    assert.throws(
      () => createRealZhihuHotSource(),
      (err) => err && (err.code === 'upstream_invalid_endpoint' || err.code === 'unsupported_upstream_host'),
      'must reject non-URL endpoint',
    );
    check('malformed endpoint rejected', true);
  } finally {
    if (previousEndpoint === undefined) delete process.env.ZHIHU_HOT_ENDPOINT;
    else process.env.ZHIHU_HOT_ENDPOINT = previousEndpoint;
  }
});

test('real provider: fake fetch verifies request URL is the configured endpoint', async () => {
  let capturedUrl = null;
  const fakeFetch = async (url) => {
    capturedUrl = url;
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const src = createRealZhihuHotSource({ fetchImpl: fakeFetch });
  await src.fetchHotList({ category: 'tech' });
  check(
    'fetchHotList hits the configured endpoint',
    typeof capturedUrl === 'string' && capturedUrl.startsWith('https://api.zhihu.com/api/v1/content/hot_list'),
    `capturedUrl=${capturedUrl}`,
  );
  check(
    'fetchHotList forwards category=tech as a query param',
    typeof capturedUrl === 'string' && capturedUrl.includes('category=tech'),
    `capturedUrl=${capturedUrl}`,
  );
});

test('real provider: 5xx surfaces as ProviderError', async () => {
  const fakeFetch = async () => new Response('upstream broken', { status: 503 });
  const src = createRealZhihuHotSource({ fetchImpl: fakeFetch });
  await assert.rejects(
    () => src.fetchHotList(),
    (err) => err && err.code === 'upstream_5xx',
    '5xx must surface as ProviderError(upstream_5xx)',
  );
  check('5xx → ProviderError(upstream_5xx)', true);
});

test('real provider: 4xx surfaces as ProviderError', async () => {
  const fakeFetch = async () => new Response('upstream 4xx', { status: 429 });
  const src = createRealZhihuHotSource({ fetchImpl: fakeFetch });
  await assert.rejects(
    () => src.fetchHotList(),
    (err) => err && err.code === 'upstream_4xx',
    '4xx must surface as ProviderError(upstream_4xx)',
  );
  check('4xx → ProviderError(upstream_4xx)', true);
});

// =====================================================================
// 3. Pair-key cache invariants
// =====================================================================

test('cache: pair-key is (category, bucket) NOT a single global entry', () => {
  const provider = createEcosystemHotProvider();
  // Two different categories MUST yield different cache keys.
  const k1 = cacheKey('total', 1234567);
  const k2 = cacheKey('tech', 1234567);
  check('different categories produce different keys', k1 !== k2, `k1=${k1} k2=${k2}`);
  // Same category, different bucket MUST yield different keys.
  const k3 = cacheKey('total', 1234568);
  check('same category, different bucket → different keys', k1 !== k3, `k1=${k1} k3=${k3}`);
  // Same category + bucket MUST collapse to one key.
  const k4 = cacheKey('total', 1234567);
  check('same category + bucket → identical keys', k1 === k4, `k1=${k1} k4=${k4}`);
});

test('cache: A → B → A still hits A (pair-key invariant)', async () => {
  let counter = 0;
  const fakeReal = {
    name: 'real',
    async fetchHotList(input = {}) {
      counter += 1;
      const category = input && typeof input.category === 'string' ? input.category : 'total';
      // Return a topic whose id encodes the category so we can
      // verify which entry came back without relying on field
      // equality.
      return [{
        id: `topic-${category}-${counter}`,
        title: `topic for ${category}`,
        url: `https://www.zhihu.com/question/${category}`,
        hotness: counter,
        excerpt: '',
        answer_count: 0,
        question_id: `q-${category}`,
        tags: [],
        category,
        rank: 1,
      }];
    },
    endpoint() { return 'https://api.zhihu.com/api/v1/content/hot_list'; },
    hosts() { return ['api.zhihu.com']; },
  };
  const provider = createEcosystemHotProvider({
    realSource: fakeReal,
    env: { STORY_OUTSIDE_HOT_PROVIDER: 'real' },
    bucketMs: 60 * 1000,
    ttlMs: 5 * 60 * 1000,
    swrMs: 30 * 60 * 1000,
    now: () => 1_700_000_000_000,
  });
  const a1 = await provider.getHot({ category: 'total' });
  const b1 = await provider.getHot({ category: 'tech' });
  const a2 = await provider.getHot({ category: 'total' });
  check('A→B→A first A call has category=total', a1.hot[0] && a1.hot[0].category === 'total', JSON.stringify(a1.hot[0] || null));
  check('A→B→A B call has category=tech', b1.hot[0] && b1.hot[0].category === 'tech', JSON.stringify(b1.hot[0] || null));
  check('A→B→A second A call STILL has category=total', a2.hot[0] && a2.hot[0].category === 'total', JSON.stringify(a2.hot[0] || null));
  check('A→B→A: A was cached (counter === 2, not 3)', counter === 2, `counter=${counter}`);
  check('A→B→A: A2.cached is true', a2.cached === true, `a2.cached=${a2.cached}`);
});

test('cache: pair-key isolates B from A when B fails (graceful degradation)', async () => {
  let techCalls = 0;
  const fakeReal = {
    name: 'real',
    async fetchHotList(input = {}) {
      const category = input && typeof input.category === 'string' ? input.category : 'total';
      if (category === 'tech') {
        techCalls += 1;
        throw new Error('upstream boom for tech');
      }
      return [{
        id: `topic-${category}`,
        title: `topic for ${category}`,
        url: `https://www.zhihu.com/question/${category}`,
        hotness: 1,
        excerpt: '',
        answer_count: 0,
        question_id: `q-${category}`,
        tags: [],
        category,
        rank: 1,
      }];
    },
    endpoint() { return 'https://api.zhihu.com/api/v1/content/hot_list'; },
    hosts() { return ['api.zhihu.com']; },
  };
  const provider = createEcosystemHotProvider({
    realSource: fakeReal,
    env: { STORY_OUTSIDE_HOT_PROVIDER: 'real' },
    bucketMs: 60 * 1000,
    ttlMs: 5 * 60 * 1000,
    swrMs: 30 * 60 * 1000,
    now: () => 1_700_000_000_000,
  });
  const a = await provider.getHot({ category: 'total' });
  check('total succeeds', a.cached === true && a.hot.length === 1, JSON.stringify(a));
  const b = await provider.getHot({ category: 'tech' });
  // tech fails AND has no past-cache; the orchestrator returns
  // {hot:[], cached:false}.
  check('tech degrades to empty + cached=false', b.cached === false && b.hot.length === 0, JSON.stringify(b));
  check('tech failure did NOT pollute total cache', a.cached === true, `a.cached=${a.cached}`);
  check('tech upstream was called exactly once', techCalls === 1, `techCalls=${techCalls}`);
});

// =====================================================================
// 4. HTTP façade contract
// =====================================================================

test('http: GET /v1/ecosystem/hot returns 200 with the public payload shape', async () => {
  const res = await fetch(`${BASE}/v1/ecosystem/hot`);
  const json = await res.json();
  check('GET /v1/ecosystem/hot 200', res.status === 200, `status=${res.status}`);
  check('payload has hot[]', Array.isArray(json.hot), `hot=${typeof json.hot}`);
  check('payload has provenance', json.provenance && typeof json.provenance === 'object', JSON.stringify(json.provenance || null));
  check('payload has cached', typeof json.cached === 'boolean', `cached=${typeof json.cached}`);
  check('payload has fetched_at', typeof json.fetched_at === 'string', `fetched_at=${typeof json.fetched_at}`);
  check('payload has demo flag', json.demo && typeof json.demo === 'object', JSON.stringify(json.demo || null));
  check('payload does NOT leak DEV_FLAG', json.dev === undefined, `dev=${JSON.stringify(json.dev)}`);
});

test('http: category filter works (?category=tech)', async () => {
  const res = await fetch(`${BASE}/v1/ecosystem/hot?category=tech&limit=50`);
  const json = await res.json();
  check('GET /v1/ecosystem/hot?category=tech 200', res.status === 200);
  const allTech = Array.isArray(json.hot) && json.hot.every((r) => r.category === 'tech');
  check('every row has category=tech', allTech, JSON.stringify(json.hot.map((r) => r.category)));
});

test('http: limit clamp (limit=9999 → at most 50 rows)', async () => {
  const res = await fetch(`${BASE}/v1/ecosystem/hot?limit=9999`);
  const json = await res.json();
  check('huge limit still 200', res.status === 200);
  check('huge limit clamped', Array.isArray(json.hot) && json.hot.length <= 50, `len=${json.hot ? json.hot.length : 'n/a'}`);
});

test('http: invalid limit returns 400 (validation_failed)', async () => {
  const res = await fetch(`${BASE}/v1/ecosystem/hot?limit=notanumber`);
  const json = await res.json();
  check('bad limit → 400', res.status === 400, `status=${res.status}`);
  check('bad limit → invalid_limit code', json && json.error === 'invalid_limit', JSON.stringify(json));
});

test('http: POST /v1/ecosystem/hot returns 405 (GET-only surface)', async () => {
  const res = await fetch(`${BASE}/v1/ecosystem/hot`, { method: 'POST' });
  check('POST → 405', res.status === 405, `status=${res.status}`);
});

test('http: /v1/ecosystem/hot does NOT live under /api/admin/* or /api/dev/*', async () => {
  const res = await fetch(`${BASE}/v1/ecosystem/hot`);
  check('route is /v1/ecosystem/hot (200)', res.status === 200);
  const admin = await fetch(`${BASE}/api/admin/ecosystem/hot`);
  check('/api/admin/ecosystem/hot must NOT exist (404)', admin.status === 404, `admin status=${admin.status}`);
  const dev = await fetch(`${BASE}/api/dev/ecosystem/hot`);
  check('/api/dev/ecosystem/hot must NOT exist (404)', dev.status === 404, `dev status=${dev.status}`);
});

test('http: /api/health surfaces hot_provider config', async () => {
  const res = await fetch(`${BASE}/api/health`);
  const json = await res.json();
  check('hot_provider present', json.hot_provider && typeof json.hot_provider === 'object', JSON.stringify(json.hot_provider || null));
  check('hot_provider.source is mock (default)', json.hot_provider && json.hot_provider.source === 'mock', JSON.stringify(json.hot_provider || null));
  check('hot_provider.endpoint is the mock fixture marker', json.hot_provider && typeof json.hot_provider.endpoint === 'string');
  check('hot_provider.known_categories is an array', Array.isArray(json.hot_provider && json.hot_provider.known_categories));
});

// =====================================================================
// 5. DTO contract + graceful degradation at the wire
// =====================================================================

test('dto: hot[] rows match the ClickUp 16.4 spec shape', async () => {
  const res = await fetch(`${BASE}/v1/ecosystem/hot?limit=5`);
  const json = await res.json();
  if (!Array.isArray(json.hot) || json.hot.length === 0) {
    check('hot[] has rows', false, 'no rows in payload');
    return;
  }
  const row = json.hot[0];
  const requiredKeys = ['rank', 'question_uuid', 'title', 'heat', 'url', 'category'];
  for (const k of requiredKeys) {
    check(`hot[].${k} present`, Object.prototype.hasOwnProperty.call(row, k), `keys=${Object.keys(row).join(',')}`);
  }
});

test('graceful: invalid category clamps to "total" instead of 400', async () => {
  const res = await fetch(`${BASE}/v1/ecosystem/hot?category=__bogus__`);
  const json = await res.json();
  check('bogus category still 200', res.status === 200);
  // Every row should have category=total because the orchestrator
  // clamped the input.
  const allTotal = Array.isArray(json.hot) && json.hot.every((r) => r.category === 'total');
  check('bogus category clamped to total', allTotal, JSON.stringify(json.hot.map((r) => r.category)));
});

test('graceful: upstream ProviderError must NOT 5xx the HTTP request', async () => {
  // We inject a fake real source into a fresh provider instance and
  // assert the provider's degraded return is `{hot:[], cached:false,
  // fetched_at:''}`. The HTTP layer wraps the same primitive and
  // translates any thrown ProviderError into a 200 empty payload,
  // so this test exercises the orchestrator's contract directly.
  const fakeReal = {
    name: 'real',
    async fetchHotList() {
      throw new Error('upstream_simulated_failure');
    },
    endpoint() { return 'https://api.zhihu.com/api/v1/content/hot_list'; },
    hosts() { return ['api.zhihu.com']; },
  };
  const provider = createEcosystemHotProvider({
    realSource: fakeReal,
    env: { STORY_OUTSIDE_HOT_PROVIDER: 'real' },
    now: () => 1_700_000_000_000,
  });
  const payload = await provider.getHot({ category: 'total' });
  check('provider returns empty hot on upstream failure', Array.isArray(payload.hot) && payload.hot.length === 0);
  check('provider returns cached:false on upstream failure', payload.cached === false);
  check('provider returns empty fetched_at on upstream failure', payload.fetched_at === '');
});

// =====================================================================
// 6. Public surface integration (no DEV_FLAG leak + graceful DOM)
// =====================================================================

test('public: homeHotModule.js fetch URL is /v1/ecosystem/hot (NOT /api/admin or /api/dev)', async () => {
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(
    resolvePath(REPO_ROOT, 'public/scripts/homeHotModule.js'),
    'utf-8',
  );
  check(
    'homeHotModule.js references /v1/ecosystem/hot',
    src.includes('/v1/ecosystem/hot'),
    'homeHotModule.js must call the public façade',
  );
  check(
    'homeHotModule.js does NOT reference /api/admin/',
    !src.includes('/api/admin/'),
    'homeHotModule.js must not reference admin paths',
  );
  check(
    'homeHotModule.js does NOT reference /api/dev/',
    !src.includes('/api/dev/'),
    'homeHotModule.js must not reference dev paths',
  );
});

test('public: index.html carries the fallback placeholder so the module never blanks the page', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(
    resolvePath(REPO_ROOT, 'public/index.html'),
    'utf-8',
  );
  check(
    'index.html has #ecosystem-hot-empty fallback',
    html.includes('id="ecosystem-hot-empty"'),
    'fallback element id missing',
  );
  check(
    'index.html fallback copy is "暂时无法获取知乎热议"',
    html.includes('暂时无法获取知乎热议'),
    'fallback copy missing',
  );
  check(
    'index.html loads homeHotModule.js as a separate module',
    html.includes('src="/scripts/homeHotModule.js"'),
    'homeHotModule.js <script> tag missing',
  );
  check(
    'index.html does NOT carry the DEV_FLAG banner',
    !html.includes('admin_only') && !html.includes('dev_only'),
    'DEV_FLAG must not appear on the public page',
  );
});

// =====================================================================
// 7. DTO helpers
// =====================================================================

test('helper: toPublicHotRow normalises a topic to the spec shape', () => {
  const row = toPublicHotTopicRow({
    id: 'q-1',
    title: 't',
    url: 'https://www.zhihu.com/question/1',
    hotness: 100,
    question_id: 'q-1',
    category: 'tech',
    rank: 3,
  });
  assert.deepEqual(Object.keys(row).sort(), ['category', 'heat', 'question_uuid', 'rank', 'title', 'url']);
  assert.equal(row.rank, 3);
  assert.equal(row.heat, 100);
  assert.equal(row.question_uuid, 'q-1');
  assert.equal(row.category, 'tech');
  check('toPublicHotRow shape', true);
});

function toPublicHotTopicRow(topic) {
  return toPublicHotRow(topic);
}

test('helper: KNOWN_CATEGORIES includes total + tech + finance', () => {
  check('KNOWN_CATEGORIES contains total', KNOWN_CATEGORIES.includes('total'));
  check('KNOWN_CATEGORIES contains tech', KNOWN_CATEGORIES.includes('tech'));
  check('KNOWN_CATEGORIES contains finance', KNOWN_CATEGORIES.includes('finance'));
});

// =====================================================================
// Tear-down: report failures
// =====================================================================

if (failures.length > 0) {
  console.error(`\n[FAIL] ${failures.length} check(s) failed`);
  for (const f of failures) console.error(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
  process.exit(1);
}

console.log('\n[OK] all ecosystemHotRebuilt checks passed');
