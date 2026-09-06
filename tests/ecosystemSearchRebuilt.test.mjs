// tests/ecosystemSearchRebuilt.test.mjs — ClickUp 16.2 知乎搜索重建
// （on new main 44343b2）。
//
// What this test verifies:
//
//   1. happy path POST /v1/ecosystem/discussions → 200 with the
//      documented response shape.
//   2. empty query → 400 with code 'empty_query'.
//   3. forbidden key (e.g. session_uuid, role_id) → 400 with
//      code 'forbidden_field'.
//   4. upstream 5xx / forbidden redirect → graceful degradation
//      (ecosystem_status='unavailable'), core /api/sessions still
//      answers 200.
//   5. cache pair-key: A→B→A returns A's cached row, never B's.
//   6. cache TTL + SWR: fresh cache returns cached=true; expired
//      cache triggers a refresh.
//   7. public contract guard: 0 references to /api/admin/ or
//      /api/dev/ anywhere under public/.
//   8. public contract guard: POST /v1/ecosystem/discussions response
//      carries NO demo / DEV_FLAG banner.
//   9. unit: buildEcosystemSearchCacheKey is pair-key — different
//      (story_version_uuid, community_profile_version) inputs produce
//      different keys.
//  10. real adapter host allowlist rejects non-allowlisted bases.

import assert_ from 'node:assert/strict';
import http from 'node:http';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

import {
  buildEcosystemSearchCacheKey,
  createInMemoryEcosystemSearchCacheRepository,
  createMockZhihuSearchSource,
  createRealZhihuSearchSource,
  EcosystemUpstreamError,
  ECOSYSTEM_SEARCH_DEFAULT_LIMIT,
  hasRealSearchCredentials,
  isAllowedZhihuUpstreamBaseUrl,
  normaliseDiscussionsRequest,
  searchEcosystemDiscussions,
} from '../src/providers/ecosystem/index.mjs';

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

// ---------------------------------------------------------------------
// 1) Static guards.
// ---------------------------------------------------------------------
{
  const cmd = `grep -rE "/api/(admin|dev)/" ${REPO_ROOT}/public --include="*.js" || true`;
  const out = execSync(cmd, { encoding: 'utf8' });
  check(
    'static guard: public/**/*.js does NOT reference /api/admin/ or /api/dev/',
    out.trim() === '',
    `unexpected matches:\n${out}`,
  );
}

{
  // Read the route handler block. Must NOT mention DEV_FLAG inside the
  // v1/ecosystem route (the route lives in the public surface).
  const serverSrc = readFileSync(resolvePath(REPO_ROOT, 'src/server.mjs'), 'utf8');
  // Find the route block by index, then scan within it.
  const startMarker = 'ClickUp 16.2 — ecosystem search façade';
  const idx = serverSrc.indexOf(startMarker);
  check('server.mjs contains ecosystem route block', idx >= 0);
  if (idx >= 0) {
    const endMarker = 'Root → static';
    const endIdx = serverSrc.indexOf(endMarker, idx);
    const block = serverSrc.slice(idx, endIdx >= 0 ? endIdx : idx + 4000);
    check(
      'v1/ecosystem route block does NOT mention DEV_FLAG',
      !/DEV_FLAG/.test(block),
    );
    check(
      'v1/ecosystem route block does NOT mention admin/dev paths',
      !/\/api\/(admin|dev)\//.test(block),
    );
  }
}

// ---------------------------------------------------------------------
// 2) DTO + cache-key unit tests (pure).
// ---------------------------------------------------------------------
{
  const r1 = normaliseDiscussionsRequest({ query: '  hello world  ' });
  check('normaliseDiscussionsRequest trims + accepts simple query',
    r1.ok && r1.value.query === 'hello world' && r1.value.limit === ECOSYSTEM_SEARCH_DEFAULT_LIMIT);

  const r2 = normaliseDiscussionsRequest({ query: '' });
  check('empty query → ok=false code=empty_query',
    !r2.ok && r2.code === 'empty_query' && r2.field === 'query');

  const r3 = normaliseDiscussionsRequest({ query: 'x', session_uuid: 'leak' });
  check('forbidden key session_uuid → ok=false code=forbidden_field',
    !r3.ok && r3.code === 'forbidden_field' && r3.field === 'session_uuid');

  const r4 = normaliseDiscussionsRequest({ query: 'x', role_id: 'leak' });
  check('forbidden key role_id → ok=false',
    !r4.ok && r4.code === 'forbidden_field');

  const r5 = normaliseDiscussionsRequest({ query: 'x', limit: 99 });
  check('limit out of range → ok=false',
    !r5.ok && r5.code === 'limit_out_of_range');

  const r6 = normaliseDiscussionsRequest({ query: 'x', story_uuid: 'not-a-uuid' });
  check('bad story_uuid → ok=false',
    !r6.ok && r6.code === 'invalid_story_uuid');

  const k1 = buildEcosystemSearchCacheKey({ query: 'foo', story_version_uuid: '11111111-2222-3333-4444-555555555555', community_profile_version: 'v1' });
  const k2 = buildEcosystemSearchCacheKey({ query: 'foo', story_version_uuid: '11111111-2222-3333-4444-555555555555', community_profile_version: 'v2' });
  const k3 = buildEcosystemSearchCacheKey({ query: 'foo', story_version_uuid: '22222222-3333-4444-5555-666666666666', community_profile_version: 'v1' });
  const k4 = buildEcosystemSearchCacheKey({ query: 'bar', story_version_uuid: '11111111-2222-3333-4444-555555555555', community_profile_version: 'v1' });
  const k5 = buildEcosystemSearchCacheKey({ query: 'foo' });
  check('pair-key differs by community_profile_version', k1 !== k2);
  check('pair-key differs by story_version_uuid', k1 !== k3);
  check('pair-key differs by query', k1 !== k4);
  check('pair-key differs by query when both pair parts missing', k5 !== k1);
}

// ---------------------------------------------------------------------
// 3) Real adapter host allowlist unit tests.
// ---------------------------------------------------------------------
{
  check('allowlist accepts https://api.zhihu.com', isAllowedZhihuUpstreamBaseUrl('https://api.zhihu.com'));
  check('allowlist accepts https://api.zhihu.com/', isAllowedZhihuUpstreamBaseUrl('https://api.zhihu.com/'));
  check('allowlist rejects https://api.zhihu.com.attacker.example',
    !isAllowedZhihuUpstreamBaseUrl('https://api.zhihu.com.attacker.example'));
  check('allowlist rejects http://api.zhihu.com (downgrade)', !isAllowedZhihuUpstreamBaseUrl('http://api.zhihu.com'));
  check('allowlist rejects https://api.zhihu.com:8080 (port)', !isAllowedZhihuUpstreamBaseUrl('https://api.zhihu.com:8080'));
  check('allowlist rejects https://api.zhihu.cn (homograph)', !isAllowedZhihuUpstreamBaseUrl('https://api.zhihu.cn'));
}

// ---------------------------------------------------------------------
// 4) Real adapter constructor guards against bad base.
// ---------------------------------------------------------------------
{
  let threw = null;
  try { createRealZhihuSearchSource({ baseUrl: 'https://attacker.example' }); }
  catch (e) { threw = e; }
  check('createRealZhihuSearchSource refuses non-allowlisted base', threw instanceof EcosystemUpstreamError);
}

// ---------------------------------------------------------------------
// 5) Real adapter behaviour with fake fetch (happy / 5xx / redirect).
// ---------------------------------------------------------------------
async function* fakeStream(text) { yield new TextEncoder().encode(text); }

async function runRealAdapterTests() {
  // Happy path
  {
    const fakeFetch = async (url, opts) => ({
      status: 200, headers: { get: () => null },
      body: fakeStream(JSON.stringify({
        data: [
          { id: '11111111-2222-3333-4444-555555555555', title: 'A', excerpt: 'snip A', url: 'https://www.zhihu.com/question/1', score: 10 },
          { id: '22222222-3333-4444-5555-666666666666', title: 'B', excerpt: 'snip B', url: 'https://zhihu.com/question/2', score: 5 },
          { bad: 'no url' },
        ],
      })),
    });
    const real = createRealZhihuSearchSource({ fetcher: fakeFetch, credentials: { app_key: 'k', access_secret: 's' } });
    const r = await real.search({ query: 'foo', limit: 5 });
    check('real adapter: happy path returns normalised DTOs', r.discussions.length === 2 && r.source === 'zhihu');
    check('real adapter: filters out malformed entries', r.discussions.every((d) => d.url && d.title));
  }
  // 5xx
  {
    const fakeFetch = async () => ({ status: 503, headers: { get: () => null }, body: null });
    const real = createRealZhihuSearchSource({ fetcher: fakeFetch });
    let threw = null;
    try { await real.search({ query: 'foo' }); } catch (e) { threw = e; }
    check('real adapter: 5xx throws EcosystemUpstreamError(code=upstream_status)', threw instanceof EcosystemUpstreamError && threw.code === 'upstream_status');
  }
  // Forbidden redirect
  {
    const fakeFetch = async () => ({ status: 302, headers: { get: (k) => k === 'location' ? 'https://attacker.example/x' : null }, body: null });
    const real = createRealZhihuSearchSource({ fetcher: fakeFetch });
    let threw = null;
    try { await real.search({ query: 'foo' }); } catch (e) { threw = e; }
    check('real adapter: redirect to disallowed host throws forbidden_redirect', threw instanceof EcosystemUpstreamError && threw.code === 'forbidden_redirect');
  }
  // Empty query
  {
    const real = createRealZhihuSearchSource({ fetcher: async () => ({ status: 200, headers: { get: () => null }, body: fakeStream('{"data":[]}') }) });
    let threw = null;
    try { await real.search({ query: '' }); } catch (e) { threw = e; }
    check('real adapter: empty query throws empty_query', threw instanceof EcosystemUpstreamError && threw.code === 'empty_query');
  }
  // Control char
  {
    const real = createRealZhihuSearchSource({ fetcher: async () => ({ status: 200, headers: { get: () => null }, body: fakeStream('{"data":[]}') }) });
    let threw = null;
    try { await real.search({ query: 'foo\x00bar' }); } catch (e) { threw = e; }
    check('real adapter: control char throws forbidden_char', threw instanceof EcosystemUpstreamError && threw.code === 'forbidden_char');
  }
}
await runRealAdapterTests();

// ---------------------------------------------------------------------
// 6) Mock adapter — deterministic + pair-isolated.
// ---------------------------------------------------------------------
{
  const adapter = createMockZhihuSearchSource();
  const a = await adapter.search({ query: 'foo', community_profile_version: 'v1', story_version_uuid: '11111111-2222-3333-4444-555555555555', limit: 3 });
  const a2 = await adapter.search({ query: 'foo', community_profile_version: 'v1', story_version_uuid: '11111111-2222-3333-4444-555555555555', limit: 3 });
  const b = await adapter.search({ query: 'foo', community_profile_version: 'v2', story_version_uuid: '11111111-2222-3333-4444-555555555555', limit: 3 });
  check('mock adapter: deterministic for same pair', JSON.stringify(a.discussions) === JSON.stringify(a2.discussions));
  check('mock adapter: pair-isolated (v1 ≠ v2)', JSON.stringify(a.discussions) !== JSON.stringify(b.discussions));
  check('mock adapter: source=mock', a.source === 'mock' && b.source === 'mock');
  check('mock adapter: never has isReal=true', adapter.isReal === false);
}

// ---------------------------------------------------------------------
// 7) Cache + SWR + pair-key orchestrator.
// ---------------------------------------------------------------------
async function runOrchestratorTests() {
  // Pair-key A→B→A returns A's row.
  {
    const cache = createInMemoryEcosystemSearchCacheRepository();
    const adapter = createMockZhihuSearchSource();
    const base = { cache, adapter, limit: 3, query: 'foo', story_version_uuid: '11111111-2222-3333-4444-555555555555' };
    const rA1 = await searchEcosystemDiscussions({ ...base, community_profile_version: 'v1' });
    const rB = await searchEcosystemDiscussions({ ...base, community_profile_version: 'v2' });
    const rA2 = await searchEcosystemDiscussions({ ...base, community_profile_version: 'v1' });
    check('orchestrator: A first call → provenance=live, cached=false', rA1.provenance === 'live' && rA1.cached === false);
    check('orchestrator: B first call → provenance=live', rB.provenance === 'live' && rB.cached === false);
    check('orchestrator: A second call → provenance=cache, cached=true', rA2.provenance === 'cache' && rA2.cached === true);
    check('orchestrator: A row was NOT polluted by B row',
      JSON.stringify(rA1.discussions) === JSON.stringify(rA2.discussions));
  }
  // TTL + SWR
  {
    // swrMs must be >= ttlMs in the cache repo. We pick ttlMs=40,
    // swrMs=80 so the SWR window is 40ms (the background refresh on
    // the mock adapter resolves in <1ms, so by t=80 the row has
    // already been refreshed and the next call sees fresh+cache).
    // To still observe the "expired → live" path, we use a slow
    // adapter wrapper that takes 30ms; the call at t=120ms finds the
    // row past swrExpiresAt and forces a fresh upstream call.
    const cache = createInMemoryEcosystemSearchCacheRepository({ ttlMs: 40, swrMs: 80 });
    const baseAdapter = createMockZhihuSearchSource();
    const adapter = {
      search: async (input) => {
        await new Promise((r) => setTimeout(r, 30));
        return baseAdapter.search(input);
      },
    };
    const base = { cache, adapter, limit: 3, query: 'bar', story_version_uuid: '22222222-3333-4444-5555-666666666666', community_profile_version: 'v1' };
    await searchEcosystemDiscussions(base); // populate (sync, ~30ms)
    await new Promise((r) => setTimeout(r, 20)); // t≈20+30=50ms: within SWR
    const rStale = await searchEcosystemDiscussions(base);
    check('orchestrator: stale row returns cached=true, provenance=cache', rStale.cached === true && rStale.provenance === 'cache');
    await new Promise((r) => setTimeout(r, 200)); // well beyond swrExpiresAt
    const rExpired = await searchEcosystemDiscussions(base);
    check('orchestrator: expired row refreshes, provenance=live, cached=false', rExpired.provenance === 'live' && rExpired.cached === false);
  }
  // Graceful degradation: real adapter throws
  {
    const cache = createInMemoryEcosystemSearchCacheRepository();
    const fakeFetch = async () => ({ status: 500, headers: { get: () => null }, body: null });
    const adapter = createRealZhihuSearchSource({ fetcher: fakeFetch });
    const r = await searchEcosystemDiscussions({ cache, adapter, query: 'foo', story_version_uuid: '33333333-4444-5555-6666-777777777777', community_profile_version: 'v1' });
    check('orchestrator: upstream 5xx → ecosystem_status=unavailable', r.ecosystem_status === 'unavailable');
    check('orchestrator: upstream 5xx → provenance=unavailable', r.provenance === 'unavailable');
    check('orchestrator: upstream 5xx → empty discussions', Array.isArray(r.discussions) && r.discussions.length === 0);
    check('orchestrator: upstream 5xx → never throws', true);
  }
  // Empty query graceful
  {
    const cache = createInMemoryEcosystemSearchCacheRepository();
    const adapter = createMockZhihuSearchSource();
    const r = await searchEcosystemDiscussions({ cache, adapter, query: '' });
    check('orchestrator: empty query → graceful unavailable', r.ecosystem_status === 'unavailable' && r.error && r.error.code === 'empty_query');
  }
  // Public response never carries DEV_FLAG / demo
  {
    const cache = createInMemoryEcosystemSearchCacheRepository();
    const adapter = createMockZhihuSearchSource();
    const r = await searchEcosystemDiscussions({ cache, adapter, query: 'foo', story_version_uuid: '44444444-5555-6666-7777-888888888888', community_profile_version: 'v1' });
    check('orchestrator: public response has no `dev` key', !('dev' in r));
    check('orchestrator: public response has no `demo` key', !('demo' in r));
    check('orchestrator: public response has no DEV_FLAG marker', JSON.stringify(r).indexOf('DEV_FLAG') === -1);
  }
}
await runOrchestratorTests();

// ---------------------------------------------------------------------
// 8) Wire test: spin up the real server, POST /v1/ecosystem/discussions.
// ---------------------------------------------------------------------
async function runWireTests() {
  const { server } = await import('../src/server.mjs');
  const probe = http.createServer();
  await new Promise((res, rej) => probe.listen(0, '127.0.0.1', res));
  const port = probe.address().port;
  await new Promise((res) => probe.close(res));
  await new Promise((res) => server.listen(port, '127.0.0.1', res));
  const baseUrl = `http://127.0.0.1:${port}`;
  async function post(path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    let data = null; try { data = await res.json(); } catch {}
    return { response: res, data };
  }
  async function get(path) {
    const res = await fetch(`${baseUrl}${path}`);
    let data = null; try { data = await res.json(); } catch {}
    return { response: res, data };
  }
  try {
    // Happy path
    {
      const r = await post('/v1/ecosystem/discussions', { query: 'foo bar', story_version_uuid: '11111111-2222-3333-4444-555555555555', community_profile_version: 'v1', limit: 3 });
      check('wire: POST /v1/ecosystem/discussions → 200', r.response.status === 200);
      check('wire: response has discussions[]', Array.isArray(r.data?.discussions));
      check('wire: response has provenance', typeof r.data?.provenance === 'string');
      check('wire: response has cached flag', typeof r.data?.cached === 'boolean');
      check('wire: response has ecosystem_status', typeof r.data?.ecosystem_status === 'string');
      check('wire: response does NOT carry `demo` key', r.data && !('demo' in r.data));
      check('wire: response does NOT carry `dev` key', r.data && !('dev' in r.data));
      check('wire: response does NOT carry DEV_FLAG', JSON.stringify(r.data || {}).indexOf('DEV_FLAG') === -1);
    }
    // Empty query
    {
      const r = await post('/v1/ecosystem/discussions', { query: '' });
      check('wire: empty query → 400', r.response.status === 400);
      check('wire: empty query code=empty_query', r.data?.error === 'empty_query');
    }
    // Forbidden key
    {
      const r = await post('/v1/ecosystem/discussions', { query: 'foo', session_uuid: 'leak' });
      check('wire: forbidden key → 400', r.response.status === 400);
      check('wire: forbidden key code=forbidden_field', r.data?.error === 'forbidden_field');
    }
    // GET → 405
    {
      const r = await get('/v1/ecosystem/discussions');
      check('wire: GET → 405 method_not_allowed', r.response.status === 405 && r.data?.error === 'method_not_allowed');
      check('wire: 405 sets Allow header', r.response.headers.get('allow') === 'POST');
    }
    // Cache: second call is cached=true
    {
      const r1 = await post('/v1/ecosystem/discussions', { query: 'cache-test-1', story_version_uuid: '55555555-6666-7777-8888-999999999999', community_profile_version: 'v1', limit: 3 });
      const r2 = await post('/v1/ecosystem/discussions', { query: 'cache-test-1', story_version_uuid: '55555555-6666-7777-8888-999999999999', community_profile_version: 'v1', limit: 3 });
      check('wire: first call → cached=false', r1.data?.cached === false);
      check('wire: second call → cached=true', r2.data?.cached === true);
    }
    // Core /api/sessions still works (graceful degradation contract).
    {
      const r = await post('/api/sessions', { work_id: 'cafe-rain', role_id: 'stranger' });
      check('wire: core /api/sessions 200 alongside ecosystem', r.response.status === 200);
    }
  } finally {
    await new Promise((res) => server.close(res));
  }
}
await runWireTests();

// ---------------------------------------------------------------------
// 9) hasRealSearchCredentials helper.
// ---------------------------------------------------------------------
{
  check('hasRealSearchCredentials: empty env → false', hasRealSearchCredentials({}) === false);
  check('hasRealSearchCredentials: full creds → true',
    hasRealSearchCredentials({ ZHIHU_OAUTH_APP_KEY: 'k', ZHIHU_ACCESS_SECRET: 's' }) === true);
  check('hasRealSearchCredentials: only app_key → false',
    hasRealSearchCredentials({ ZHIHU_OAUTH_APP_KEY: 'k' }) === false);
}

if (failures > 0) {
  console.error(`\nFAILURES=${failures}`);
  process.exit(1);
} else {
  console.log('\nALL_OK ecosystemSearchRebuilt.test.mjs');
}
