// tests/clickup16-2-p1fix.test.mjs — ClickUp 16.2 P1 fix regression
// (主人 + ChatGPT 2026-09-06 / 09-07 巡检)。
//
// Verifies the 4 P1 blockers from PR #19 (commit cdb4a3b) are fixed:
//
//   P1.1  search query **必须**来自 `StoryCommunityProfile.queries[]`，
//         **不**由 AI 拼 ending_title / key_choices / outcome。请求体
//         强校验 `search_queries: [{id, query, kind}][]`，AI 字段 +
//         legacy `query` 字段一律 400 'forbidden_field'。
//
//   P1.2  player 传 story/profile identity。
//         /api/sessions (POST + GET /:uuid + GET /:uuid/recover) 响应
//         必须暴露 community_profile_version + community_profile_queries。
//         player.js mountEndingPage 必须把 identity 写进 sessionMeta；
//         endingPage.js fetchEcosystemDiscussions 必须使用
//         communityProfileQueries 作为 search_queries[]，**不**用 AI
//         拼的 query。
//
//   P1.3  多 profile query 聚合。请求 search_queries 是数组，handler
//         对每个 `{id, query, kind}` 独立走 pair-key cache，response
//         按 `id` 分组返回 `results[]`。
//
//   P1.4  去掉 sentinel cache 退化。identity (story_uuid /
//         story_version_uuid / community_profile_version) 缺省一律
//         400 'missing_*'，**不**再走 `__no_story_version__` /
//         `__no_profile__` sentinel pair-key。

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
  ECOSYSTEM_FORBIDDEN_KEYS,
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

const UUID_V1 = '11111111-2222-3333-4444-555555555555';
const UUID_V2 = '22222222-3333-4444-5555-666666666666';
const UUID_V3 = '33333333-4444-5555-6666-777777777777';

// ---------------------------------------------------------------------
// 1) Static contract guards.
// ---------------------------------------------------------------------
{
  const out = execSync(`grep -rE "/api/(admin|dev)/" ${REPO_ROOT}/public --include="*.js" || true`, { encoding: 'utf8' });
  check(
    'static guard: public/**/*.js does NOT reference /api/admin/ or /api/dev/',
    out.trim() === '',
    `unexpected matches:\n${out}`,
  );
}
{
  // Critical: search.mjs must NEVER mention AI-derived fields. The
  // seam is the orchestrator; if it sneaks AI fields back in, the
  // handler-level guard is bypassed.
  const out = execSync(`grep -nE "ending_title|key_choices|outcome" ${REPO_ROOT}/src/providers/ecosystem/search.mjs || true`, { encoding: 'utf8' });
  check(
    'static guard: search.mjs does NOT reference ending_title/key_choices/outcome',
    out.trim() === '',
    `unexpected matches:\n${out}`,
  );
}
{
  // Critical: handler in src/server.mjs must accept search_queries[].
  const serverSrc = readFileSync(resolvePath(REPO_ROOT, 'src/server.mjs'), 'utf8');
  check(
    'server.mjs handler reads search_queries[]',
    /search_queries:\s*normalised\.value\.search_queries/.test(serverSrc),
  );
  check(
    'server.mjs handler accepts identity fields (story_uuid, story_version_uuid, community_profile_version)',
    /story_uuid:\s*normalised\.value\.story_uuid/.test(serverSrc)
      && /story_version_uuid:\s*normalised\.value\.story_version_uuid/.test(serverSrc)
      && /community_profile_version:\s*normalised\.value\.community_profile_version/.test(serverSrc),
  );
}
{
  // Critical: player.js must reference search_queries so the static
  // grep verifies the identity is forwarded (player.js forwards
  // profile.queries into sessionMeta; endingPage.js reshapes them
  // into the API `search_queries` field).
  const playerSrc = readFileSync(resolvePath(REPO_ROOT, 'public/scripts/player.js'), 'utf8');
  check(
    'player.js references search_queries (identity forwarded into sessionMeta)',
    /search_queries/.test(playerSrc),
  );
  check(
    'player.js mountEndingPage forwards communityProfileQueries',
    /communityProfileQueries/.test(playerSrc),
  );
  check(
    'player.js mountEndingPage forwards communityProfileVersion',
    /communityProfileVersion/.test(playerSrc),
  );
}
{
  const endingSrc = readFileSync(resolvePath(REPO_ROOT, 'public/scripts/endingPage.js'), 'utf8');
  check(
    'endingPage.js fetchEcosystemDiscussions uses search_queries (NOT AI-picked)',
    /search_queries/.test(endingSrc)
      && /communityProfileQueries/.test(endingSrc),
  );
  check(
    'endingPage.js api() forwards options (POST body carried)',
    /async\s+function\s+api\s*\(\s*path\s*,\s*options\s*=\s*\{\s*\}\s*\)/.test(endingSrc),
  );
}
{
  const indexSrc = readFileSync(resolvePath(REPO_ROOT, 'public/index.html'), 'utf8');
  check(
    'index.html exposes window.STORY_OUTSIDE_COMMUNITY_PROFILE_VERSION',
    /window\.STORY_OUTSIDE_COMMUNITY_PROFILE_VERSION/.test(indexSrc),
  );
}

// ---------------------------------------------------------------------
// 2) DTO unit tests (pure) — covers P1.1 + P1.4.
// ---------------------------------------------------------------------
{
  // P1.1: AI-derived field rejected.
  const r = normaliseDiscussionsRequest({
    search_queries: [{ id: 'q1', query: 'foo', kind: 'web' }],
    story_uuid: UUID_V1,
    story_version_uuid: UUID_V2,
    community_profile_version: 'v1',
    ending_title: 'AI leak',
  });
  check('P1.1 ending_title is forbidden_field', !r.ok && r.code === 'forbidden_field' && r.field === 'ending_title');
}
{
  const r = normaliseDiscussionsRequest({
    search_queries: [{ id: 'q1', query: 'foo', kind: 'web' }],
    story_uuid: UUID_V1,
    story_version_uuid: UUID_V2,
    community_profile_version: 'v1',
    key_choices: ['a', 'b'],
  });
  check('P1.1 key_choices is forbidden_field', !r.ok && r.code === 'forbidden_field' && r.field === 'key_choices');
}
{
  const r = normaliseDiscussionsRequest({
    search_queries: [{ id: 'q1', query: 'foo', kind: 'web' }],
    story_uuid: UUID_V1,
    story_version_uuid: UUID_V2,
    community_profile_version: 'v1',
    outcome: 'AI leak',
  });
  check('P1.1 outcome is forbidden_field', !r.ok && r.code === 'forbidden_field' && r.field === 'outcome');
}
{
  // P1.1: legacy single-string query is forbidden.
  const r = normaliseDiscussionsRequest({
    query: 'foo',
    story_uuid: UUID_V1,
    story_version_uuid: UUID_V2,
    community_profile_version: 'v1',
  });
  check('P1.1 legacy single-string query is forbidden_field', !r.ok && r.code === 'forbidden_field' && r.field === 'query');
}
{
  // P1.1: search_queries required.
  const r = normaliseDiscussionsRequest({
    story_uuid: UUID_V1,
    story_version_uuid: UUID_V2,
    community_profile_version: 'v1',
  });
  check('P1.1 missing search_queries → missing_search_queries', !r.ok && r.code === 'missing_search_queries');
}
{
  // P1.1: search_queries empty array.
  const r = normaliseDiscussionsRequest({
    search_queries: [],
    story_uuid: UUID_V1,
    story_version_uuid: UUID_V2,
    community_profile_version: 'v1',
  });
  check('P1.1 empty search_queries → empty_search_queries', !r.ok && r.code === 'empty_search_queries');
}
{
  // P1.1: search_queries item shape.
  const r = normaliseDiscussionsRequest({
    search_queries: [{ id: 'q1', query: 'foo' }], // missing kind
    story_uuid: UUID_V1,
    story_version_uuid: UUID_V2,
    community_profile_version: 'v1',
  });
  check('P1.1 search_query missing kind → invalid_search_queries_kind', !r.ok && r.code === 'invalid_search_queries_kind');
}
{
  // P1.1: search_queries duplicate id.
  const r = normaliseDiscussionsRequest({
    search_queries: [
      { id: 'q1', query: 'foo', kind: 'web' },
      { id: 'q1', query: 'bar', kind: 'knowledge' },
    ],
    story_uuid: UUID_V1,
    story_version_uuid: UUID_V2,
    community_profile_version: 'v1',
  });
  check('P1.1 duplicate search_query id → duplicate_search_query_id', !r.ok && r.code === 'duplicate_search_query_id');
}

{
  // P1.4: missing identity → 400 (NOT 200 with empty array, NOT sentinel pair).
  const r1 = normaliseDiscussionsRequest({ search_queries: [{ id: 'q1', query: 'foo', kind: 'web' }] });
  check('P1.4 missing story_uuid → missing_story_uuid', !r1.ok && r1.code === 'missing_story_uuid');
  const r2 = normaliseDiscussionsRequest({
    search_queries: [{ id: 'q1', query: 'foo', kind: 'web' }],
    story_uuid: UUID_V1,
  });
  check('P1.4 missing story_version_uuid → missing_story_version_uuid', !r2.ok && r2.code === 'missing_story_version_uuid');
  const r3 = normaliseDiscussionsRequest({
    search_queries: [{ id: 'q1', query: 'foo', kind: 'web' }],
    story_uuid: UUID_V1,
    story_version_uuid: UUID_V2,
  });
  check('P1.4 missing community_profile_version → missing_community_profile_version', !r3.ok && r3.code === 'missing_community_profile_version');
}

{
  // P1.4: cache-key builder still allows sentinel fallback for unit
  // tests (defence-in-depth), but the public DTO normaliser refuses
  // the request before reaching the orchestrator. Verify the
  // normaliser rejects, then verify cache-key isolation requires the
  // real identity pair (no `__no_*__` collision).
  const kReal = buildEcosystemSearchCacheKey({
    query: 'foo',
    story_version_uuid: UUID_V1,
    community_profile_version: 'v1',
    query_id: 'q1',
  });
  const kNoSv = buildEcosystemSearchCacheKey({
    query: 'foo',
    community_profile_version: 'v1',
    query_id: 'q1',
  });
  const kNoProfile = buildEcosystemSearchCacheKey({
    query: 'foo',
    story_version_uuid: UUID_V1,
    query_id: 'q1',
  });
  check('P1.4 cache key uses real story_version_uuid (NOT __no_story_version__)',
    !kReal.includes('__no_story_version__') && kReal.includes(UUID_V1));
  check('P1.4 cache key without story_version_uuid uses sentinel (defence-in-depth)',
    kNoSv.includes('__no_story_version__'));
  check('P1.4 cache key without community_profile_version uses sentinel',
    kNoProfile.includes('__no_profile__'));
}

// ---------------------------------------------------------------------
// 3) Orchestrator: P1.3 multi-query aggregation + P1.4 identity rejection.
// ---------------------------------------------------------------------
async function runOrchestratorTests() {
  // P1.3: 2 queries → 2 results keyed by id.
  {
    const cache = createInMemoryEcosystemSearchCacheRepository();
    const adapter = createMockZhihuSearchSource();
    const result = await searchEcosystemDiscussions({
      cache,
      adapter,
      search_queries: [
        { id: 'q1', query: 'foo', kind: 'web' },
        { id: 'q2', query: 'bar', kind: 'knowledge' },
      ],
      story_uuid: UUID_V1,
      story_version_uuid: UUID_V2,
      community_profile_version: 'v1',
      limit: 3,
    });
    check('P1.3 orchestrator: response.results is array of length 2',
      Array.isArray(result.results) && result.results.length === 2);
    check('P1.3 orchestrator: results keyed by id',
      result.results[0].id === 'q1' && result.results[1].id === 'q2');
    check('P1.3 orchestrator: each result has kind preserved',
      result.results[0].kind === 'web' && result.results[1].kind === 'knowledge');
    check('P1.3 orchestrator: each result has its own discussions[]',
      Array.isArray(result.results[0].discussions) && Array.isArray(result.results[1].discussions));
    check('P1.3 orchestrator: top-level ecosystem_status=ok',
      result.ecosystem_status === 'ok');
    check('P1.3 orchestrator: top-level provenance (live or mock)',
      result.provenance === 'live' || result.provenance === 'mock');
  }
  // P1.3: cache — second call returns cached=true per row.
  {
    const cache = createInMemoryEcosystemSearchCacheRepository();
    const adapter = createMockZhihuSearchSource();
    const input = {
      cache,
      adapter,
      search_queries: [
        { id: 'q1', query: 'foo', kind: 'web' },
        { id: 'q2', query: 'bar', kind: 'knowledge' },
      ],
      story_uuid: UUID_V1,
      story_version_uuid: UUID_V3,
      community_profile_version: 'v1',
      limit: 3,
    };
    await searchEcosystemDiscussions(input);
    const r2 = await searchEcosystemDiscussions(input);
    check('P1.3 cache: second call cached=true for both rows',
      r2.results.every((r) => r.cached === true));
    check('P1.3 cache: second call provenance=cache for both rows',
      r2.results.every((r) => r.provenance === 'cache'));
  }
  // P1.3: same query, different id → different cache row.
  {
    const cache = createInMemoryEcosystemSearchCacheRepository();
    const adapter = createMockZhihuSearchSource();
    const input = {
      cache,
      adapter,
      search_queries: [
        { id: 'qA', query: 'same', kind: 'web' },
        { id: 'qB', query: 'same', kind: 'web' },
      ],
      story_uuid: UUID_V1,
      story_version_uuid: UUID_V2,
      community_profile_version: 'v1',
      limit: 3,
    };
    const r = await searchEcosystemDiscussions(input);
    check('P1.3 same query, different ids → two separate cache rows',
      r.results.length === 2 && r.results[0].id !== r.results[1].id);
  }
  // P1.4: missing identity → unavailable, NOT sentinel pair-key.
  {
    const cache = createInMemoryEcosystemSearchCacheRepository();
    const adapter = createMockZhihuSearchSource();
    const r = await searchEcosystemDiscussions({
      cache,
      adapter,
      search_queries: [{ id: 'q1', query: 'foo', kind: 'web' }],
      // identity fields omitted on purpose.
      limit: 3,
    });
    check('P1.4 orchestrator: missing identity → ecosystem_status=unavailable',
      r.ecosystem_status === 'unavailable');
    check('P1.4 orchestrator: missing identity → error.code=missing_identity',
      r.error && r.error.code === 'missing_identity');
    check('P1.4 orchestrator: missing identity → results empty',
      Array.isArray(r.results) && r.results.length === 0);
  }
  // Forbidden keys list includes AI-derived fields.
  check('P1.1 ECOSYSTEM_FORBIDDEN_KEYS includes ending_title',
    ECOSYSTEM_FORBIDDEN_KEYS.includes('ending_title'));
  check('P1.1 ECOSYSTEM_FORBIDDEN_KEYS includes key_choices',
    ECOSYSTEM_FORBIDDEN_KEYS.includes('key_choices'));
  check('P1.1 ECOSYSTEM_FORBIDDEN_KEYS includes outcome',
    ECOSYSTEM_FORBIDDEN_KEYS.includes('outcome'));
  check('P1.1 ECOSYSTEM_FORBIDDEN_KEYS includes query (legacy)',
    ECOSYSTEM_FORBIDDEN_KEYS.includes('query'));
}
await runOrchestratorTests();

// ---------------------------------------------------------------------
// 4) Wire tests: spin up server, exercise POST + /api/sessions.
// ---------------------------------------------------------------------
async function runWireTests() {
  const { server } = await import('../src/server.mjs');
  const probe = http.createServer();
  await new Promise((res) => probe.listen(0, '127.0.0.1', res));
  const port = probe.address().port;
  await new Promise((res) => probe.close(res));
  await new Promise((res) => server.listen(port, '127.0.0.1', res));
  const baseUrl = `http://127.0.0.1:${port}`;
  async function postJson(path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    let data = null; try { data = await res.json(); } catch {}
    return { response: res, data };
  }
  async function getJson(path) {
    const res = await fetch(`${baseUrl}${path}`);
    let data = null; try { data = await res.json(); } catch {}
    return { response: res, data };
  }
  try {
    // P1.2: /api/sessions response exposes community_profile_version + queries.
    const sessionRes = await postJson('/api/sessions', { work_id: 'cafe-rain', role_id: 'stranger' });
    check('wire: /api/sessions → 200', sessionRes.response.status === 200);
    const session = sessionRes.data || {};
    check('wire: /api/sessions exposes community_profile_version',
      typeof session.community_profile_version === 'string' && session.community_profile_version.length > 0);
    check('wire: /api/sessions exposes community_profile_queries[]',
      Array.isArray(session.community_profile_queries) && session.community_profile_queries.length > 0);
    check('wire: /api/sessions queries[0] carries id+query+kind',
      session.community_profile_queries
      && session.community_profile_queries[0].id
      && session.community_profile_queries[0].query
      && session.community_profile_queries[0].kind);
    check('wire: /api/sessions does NOT echo ending_title/key_choices/outcome in queries',
      session.community_profile_queries.every((q) => !('ending_title' in q) && !('key_choices' in q) && !('outcome' in q)));

    const uuid = session.session_uuid;

    // P1.2: GET /api/sessions/:uuid also exposes profile identity.
    const recover = await getJson(`/api/sessions/${uuid}`);
    check('wire: GET /api/sessions/:uuid → 200', recover.response.status === 200);
    check('wire: GET /api/sessions/:uuid exposes community_profile_version',
      typeof recover.data?.community_profile_version === 'string');
    check('wire: GET /api/sessions/:uuid exposes community_profile_queries[]',
      Array.isArray(recover.data?.community_profile_queries));

    const recover2 = await getJson(`/api/sessions/${uuid}/recover`);
    check('wire: GET /api/sessions/:uuid/recover → 200', recover2.response.status === 200);
    check('wire: GET /api/sessions/:uuid/recover exposes community_profile_version',
      typeof recover2.data?.community_profile_version === 'string');
    check('wire: GET /api/sessions/:uuid/recover exposes community_profile_queries[]',
      Array.isArray(recover2.data?.community_profile_queries));

    // P1.1+P1.3: happy path with profile queries.
    const happy = await postJson('/v1/ecosystem/discussions', {
      search_queries: session.community_profile_queries,
      story_uuid: session.story_uuid,
      story_version_uuid: session.story_version_uuid,
      community_profile_version: session.community_profile_version,
      limit: 2,
    });
    check('wire: happy path → 200', happy.response.status === 200);
    check('wire: happy path results[] length equals queries length',
      happy.data?.results?.length === session.community_profile_queries.length);
    check('wire: happy path results are keyed by query id',
      happy.data?.results?.every((r, i) => r.id === session.community_profile_queries[i].id));
    check('wire: happy path top-level ecosystem_status=ok',
      happy.data?.ecosystem_status === 'ok');

    // P1.1: AI-derived field rejected by wire.
    const aiLeak = await postJson('/v1/ecosystem/discussions', {
      search_queries: session.community_profile_queries,
      story_uuid: session.story_uuid,
      story_version_uuid: session.story_version_uuid,
      community_profile_version: session.community_profile_version,
      ending_title: 'AI leak',
    });
    check('wire: AI-derived ending_title → 400 forbidden_field',
      aiLeak.response.status === 400 && aiLeak.data?.error === 'forbidden_field'
      && aiLeak.data?.field === 'ending_title');

    // P1.1: legacy single-string query rejected by wire.
    const legacyQuery = await postJson('/v1/ecosystem/discussions', {
      query: 'foo',
      story_uuid: session.story_uuid,
      story_version_uuid: session.story_version_uuid,
      community_profile_version: session.community_profile_version,
    });
    check('wire: legacy single-string query → 400 forbidden_field',
      legacyQuery.response.status === 400 && legacyQuery.data?.error === 'forbidden_field'
      && legacyQuery.data?.field === 'query');

    // P1.4: missing identity → 400, NOT 200 + empty.
    const noIdentity = await postJson('/v1/ecosystem/discussions', {
      search_queries: session.community_profile_queries,
    });
    check('wire: missing identity → 400 missing_story_uuid',
      noIdentity.response.status === 400 && noIdentity.data?.error === 'missing_story_uuid');

    const noStoryVersion = await postJson('/v1/ecosystem/discussions', {
      search_queries: session.community_profile_queries,
      story_uuid: session.story_uuid,
    });
    check('wire: missing story_version_uuid → 400 missing_story_version_uuid',
      noStoryVersion.response.status === 400 && noStoryVersion.data?.error === 'missing_story_version_uuid');

    const noProfileVersion = await postJson('/v1/ecosystem/discussions', {
      search_queries: session.community_profile_queries,
      story_uuid: session.story_uuid,
      story_version_uuid: session.story_version_uuid,
    });
    check('wire: missing community_profile_version → 400 missing_community_profile_version',
      noProfileVersion.response.status === 400 && noProfileVersion.data?.error === 'missing_community_profile_version');

    // GET → 405 still works.
    const get = await getJson('/v1/ecosystem/discussions');
    check('wire: GET → 405 method_not_allowed',
      get.response.status === 405 && get.data?.error === 'method_not_allowed');

    // Public response carries NO demo/dev/DEV_FLAG.
    check('wire: public response has no `dev` key', !('dev' in (happy.data || {})));
    check('wire: public response has no `demo` key', !('demo' in (happy.data || {})));
    check('wire: public response has no DEV_FLAG marker',
      JSON.stringify(happy.data || {}).indexOf('DEV_FLAG') === -1);

    // P1.3: second call cached.
    const r2 = await postJson('/v1/ecosystem/discussions', {
      search_queries: session.community_profile_queries,
      story_uuid: session.story_uuid,
      story_version_uuid: session.story_version_uuid,
      community_profile_version: session.community_profile_version,
      limit: 2,
    });
    check('wire: second call cached=true for all rows',
      r2.data?.results?.every((r) => r.cached === true));
    check('wire: second call provenance=cache for all rows',
      r2.data?.results?.every((r) => r.provenance === 'cache'));
  } finally {
    await new Promise((res) => server.close(res));
  }
}
await runWireTests();

if (failures > 0) {
  console.error(`\nFAILURES=${failures}`);
  process.exit(1);
} else {
  console.log('\nALL_OK clickup16-2-p1fix.test.mjs');
}
