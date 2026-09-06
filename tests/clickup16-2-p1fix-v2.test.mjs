// tests/clickup16-2-p1fix-v2.test.mjs — ClickUp 16.2 P1.v2 fix regression
// (主人 + ChatGPT 2026-09-07 02:23 巡检)。
//
// P1.v2 blocker closed:
//   POST /v1/ecosystem/discussions is now SERVER-AUTHORITATIVE.
//   The body MUST NOT carry `search_queries` (or any client-controlled
//   query source). The handler resolves the canonical
//   `StoryCommunityProfile` via
//   `communityProfileRepo.findCanonicalByIdentity(...)` and walks the
//   canonical `profile.queries[]` to run upstream search. Identity
//   mismatch failure modes map to distinct 4xx codes:
//
//     * community_profile_not_found
//     * community_profile_version_mismatch
//     * story_version_mismatch
//
//   The handler refuses any non-allowlisted body key with
//   `forbidden_field` so a future regression cannot smuggle a
//   client-controlled query back in.

import assert_ from 'node:assert/strict';
import http from 'node:http';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

import {
  buildCanonicalCommunityProfileVersion,
  createInMemoryCommunityProfileRepository,
} from '../src/community/index.mjs';

import {
  ECOSYSTEM_ALLOWED_BODY_KEYS,
  ECOSYSTEM_FORBIDDEN_KEYS,
  buildEcosystemSearchCacheKey,
  createInMemoryEcosystemSearchCacheRepository,
  createMockZhihuSearchSource,
  normaliseCanonicalSearchQueries,
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

const UUID_A = '11111111-2222-3333-4444-555555555555';
const UUID_B = '22222222-3333-4444-5555-666666666666';
const UUID_C = '33333333-4444-5555-6666-777777777777';
const UUID_D = '44444444-5555-6666-7777-888888888888';

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
  // Critical: handler in src/server.mjs MUST NOT reference
  // `body.search_queries` (server-authoritative seam).
  const out = execSync(`grep -nE "body\\.search_queries" ${REPO_ROOT}/src/server.mjs || true`, { encoding: 'utf8' });
  check(
    'static guard: server.mjs does NOT read body.search_queries (server-authoritative)',
    out.trim() === '',
    `unexpected matches:\n${out}`,
  );
}
{
  // Critical: server.mjs calls findCanonicalByIdentity.
  const serverSrc = readFileSync(resolvePath(REPO_ROOT, 'src/server.mjs'), 'utf8');
  check(
    'server.mjs handler calls communityProfileRepo.findCanonicalByIdentity',
    /communityProfileRepo\.findCanonicalByIdentity/.test(serverSrc),
  );
  // Critical: forbidden_field literal in server.mjs.
  check(
    'server.mjs references forbidden_field',
    /forbidden_field/.test(serverSrc),
  );
  // Critical: distinct 4xx codes in server.mjs.
  check(
    'server.mjs references community_profile_not_found',
    /community_profile_not_found/.test(serverSrc),
  );
  check(
    'server.mjs references community_profile_version_mismatch',
    /community_profile_version_mismatch/.test(serverSrc),
  );
  check(
    'server.mjs references story_version_mismatch',
    /story_version_mismatch/.test(serverSrc),
  );
  // Critical: profile.search_queries reference (alias) in search.mjs.
  const searchSrc = readFileSync(resolvePath(REPO_ROOT, 'src/providers/ecosystem/search.mjs'), 'utf8');
  check(
    'search.mjs references profile.search_queries (alias to profile.queries)',
    /profile\.search_queries/.test(searchSrc),
  );
}
{
  // player.js / endingPage.js / index.html surface the canonical
  // identity so the deep-link path also works.
  const playerSrc = readFileSync(resolvePath(REPO_ROOT, 'public/scripts/player.js'), 'utf8');
  check(
    'player.js forwards communityProfileVersion into sessionMeta',
    /communityProfileVersion/.test(playerSrc),
  );
  check(
    'player.js forwards communityProfileQueries into sessionMeta',
    /communityProfileQueries/.test(playerSrc),
  );
  const endingSrc = readFileSync(resolvePath(REPO_ROOT, 'public/scripts/endingPage.js'), 'utf8');
  check(
    'endingPage.js api() forwards POST body (options.body)',
    /async\s+function\s+api\s*\(\s*path\s*,\s*options\s*=\s*\{\s*\}\s*\)/.test(endingSrc)
      && /fetchOpts\.body/.test(endingSrc),
  );
  check(
    'endingPage.js fetchEcosystemDiscussions submits identity triple (no search_queries)',
    /communityProfileVersion/.test(endingSrc)
      && /communityProfileQueries/.test(endingSrc)
      && /\/v1\/ecosystem\/discussions/.test(endingSrc)
      && !/search_queries\s*:\s*\[/.test(endingSrc),
  );
  const indexSrc = readFileSync(resolvePath(REPO_ROOT, 'public/index.html'), 'utf8');
  check(
    'index.html exposes window.STORY_OUTSIDE_COMMUNITY_PROFILE_VERSION',
    /window\.STORY_OUTSIDE_COMMUNITY_PROFILE_VERSION/.test(indexSrc),
  );
}

// ---------------------------------------------------------------------
// 2) DTO unit tests (pure) — body must reject every non-allowlisted key.
// ---------------------------------------------------------------------
{
  // v2: search_queries is FORBIDDEN (the whole point of P1.v2).
  const r = normaliseDiscussionsRequest({
    search_queries: [{ id: 'q1', query: 'foo', kind: 'web' }],
    story_uuid: UUID_A,
    story_version_uuid: UUID_B,
    community_profile_version: 'v1',
  });
  check('v2 body.search_queries is forbidden_field', !r.ok && r.code === 'forbidden_field' && r.field === 'search_queries');
}
{
  const r = normaliseDiscussionsRequest({
    query: 'foo',
    story_uuid: UUID_A,
    story_version_uuid: UUID_B,
    community_profile_version: 'v1',
  });
  check('v2 body.query (legacy single-string) is forbidden_field', !r.ok && r.code === 'forbidden_field' && r.field === 'query');
}
{
  const r = normaliseDiscussionsRequest({
    ending_title: 'AI leak',
    story_uuid: UUID_A,
    story_version_uuid: UUID_B,
    community_profile_version: 'v1',
  });
  check('v2 body.ending_title is forbidden_field', !r.ok && r.code === 'forbidden_field' && r.field === 'ending_title');
}
{
  const r = normaliseDiscussionsRequest({
    key_choices: ['a', 'b'],
    story_uuid: UUID_A,
    story_version_uuid: UUID_B,
    community_profile_version: 'v1',
  });
  check('v2 body.key_choices is forbidden_field', !r.ok && r.code === 'forbidden_field' && r.field === 'key_choices');
}
{
  const r = normaliseDiscussionsRequest({
    outcome: 'AI leak',
    story_uuid: UUID_A,
    story_version_uuid: UUID_B,
    community_profile_version: 'v1',
  });
  check('v2 body.outcome is forbidden_field', !r.ok && r.code === 'forbidden_field' && r.field === 'outcome');
}
{
  const r = normaliseDiscussionsRequest({
    character_outcomes: ['a'],
    story_uuid: UUID_A,
    story_version_uuid: UUID_B,
    community_profile_version: 'v1',
  });
  check('v2 body.character_outcomes is forbidden_field', !r.ok && r.code === 'forbidden_field' && r.field === 'character_outcomes');
}
{
  // identity (PR #24 leak vector) is also forbidden — server is the
  // only authority for the canonical identity resolution.
  const r = normaliseDiscussionsRequest({
    identity: { story_uuid: UUID_A, story_version_uuid: UUID_B },
    story_uuid: UUID_A,
    story_version_uuid: UUID_B,
    community_profile_version: 'v1',
  });
  check('v2 body.identity is forbidden_field', !r.ok && r.code === 'forbidden_field' && r.field === 'identity');
}
{
  // Unknown key with no special meaning — still forbidden by allowlist.
  const r = normaliseDiscussionsRequest({
    random_extra: 'value',
    story_uuid: UUID_A,
    story_version_uuid: UUID_B,
    community_profile_version: 'v1',
  });
  check('v2 unknown body key is forbidden_field', !r.ok && r.code === 'forbidden_field' && r.field === 'random_extra');
}
{
  // Missing story_uuid → community_profile_not_found (identity must be
  // resolvable end-to-end; missing UUID is just a not-found).
  const r = normaliseDiscussionsRequest({
    story_version_uuid: UUID_B,
    community_profile_version: 'v1',
  });
  check('v2 missing story_uuid → community_profile_not_found',
    !r.ok && r.code === 'community_profile_not_found' && r.field === 'story_uuid');
}
{
  const r = normaliseDiscussionsRequest({
    story_uuid: 'not-a-uuid',
    story_version_uuid: UUID_B,
    community_profile_version: 'v1',
  });
  check('v2 bad story_uuid → community_profile_not_found',
    !r.ok && r.code === 'community_profile_not_found' && r.field === 'story_uuid');
}
{
  const r = normaliseDiscussionsRequest({
    story_uuid: UUID_A,
    story_version_uuid: UUID_B,
    community_profile_version: '', // empty string
  });
  check('v2 empty community_profile_version → community_profile_version_mismatch',
    !r.ok && r.code === 'community_profile_version_mismatch' && r.field === 'community_profile_version');
}
{
  // Limit out of range.
  const r = normaliseDiscussionsRequest({
    story_uuid: UUID_A,
    story_version_uuid: UUID_B,
    community_profile_version: 'v1',
    limit: 99,
  });
  check('v2 limit out of range → limit_out_of_range',
    !r.ok && r.code === 'limit_out_of_range' && r.field === 'limit');
}
{
  // Happy path on the DTO.
  const r = normaliseDiscussionsRequest({
    story_uuid: UUID_A,
    story_version_uuid: UUID_B,
    community_profile_version: 'v1',
    limit: 4,
  });
  check('v2 happy DTO shape', r.ok && r.value.story_uuid === UUID_A && r.value.limit === 4);
}

// ECOSYSTEM_FORBIDDEN_KEYS / ECOSYSTEM_ALLOWED_BODY_KEYS lists must
// cover the regression vectors so a future caller cannot silently
// widen the surface.
check('v2 ECOSYSTEM_FORBIDDEN_KEYS includes search_queries',
  ECOSYSTEM_FORBIDDEN_KEYS.includes('search_queries'));
check('v2 ECOSYSTEM_FORBIDDEN_KEYS includes query (legacy)',
  ECOSYSTEM_FORBIDDEN_KEYS.includes('query'));
check('v2 ECOSYSTEM_FORBIDDEN_KEYS includes ending_title',
  ECOSYSTEM_FORBIDDEN_KEYS.includes('ending_title'));
check('v2 ECOSYSTEM_FORBIDDEN_KEYS includes key_choices',
  ECOSYSTEM_FORBIDDEN_KEYS.includes('key_choices'));
check('v2 ECOSYSTEM_FORBIDDEN_KEYS includes outcome',
  ECOSYSTEM_FORBIDDEN_KEYS.includes('outcome'));
check('v2 ECOSYSTEM_FORBIDDEN_KEYS includes character_outcomes',
  ECOSYSTEM_FORBIDDEN_KEYS.includes('character_outcomes'));
check('v2 ECOSYSTEM_ALLOWED_BODY_KEYS has exactly 4 entries',
  ECOSYSTEM_ALLOWED_BODY_KEYS.length === 4);
check('v2 ECOSYSTEM_ALLOWED_BODY_KEYS includes story_uuid',
  ECOSYSTEM_ALLOWED_BODY_KEYS.includes('story_uuid'));
check('v2 ECOSYSTEM_ALLOWED_BODY_KEYS includes story_version_uuid',
  ECOSYSTEM_ALLOWED_BODY_KEYS.includes('story_version_uuid'));
check('v2 ECOSYSTEM_ALLOWED_BODY_KEYS includes community_profile_version',
  ECOSYSTEM_ALLOWED_BODY_KEYS.includes('community_profile_version'));
check('v2 ECOSYSTEM_ALLOWED_BODY_KEYS includes limit',
  ECOSYSTEM_ALLOWED_BODY_KEYS.includes('limit'));

// ---------------------------------------------------------------------
// 3) Repo unit: findCanonicalByIdentity.
// ---------------------------------------------------------------------
{
  const repo = createInMemoryCommunityProfileRepository();
  // Set up a canonical profile row bound to (UUID_B, UUID_A, generator).
  const profile = {
    profile_uuid: UUID_D,
    story_uuid: UUID_A,
    story_version_uuid: UUID_B,
    story_version_checksum: 'cafe-rain-fixture',
    generator_version: 'community-profile@community-profile-rules/1',
    generated_at: new Date(0).toISOString(),
    source: 'mock-fixture',
    locale: 'zh-CN',
    topics: [
      { id: 'topic-x', label: 'topic A', summary: 'summary A' },
      { id: 'topic-y', label: 'topic B', summary: 'summary B' },
      { id: 'topic-z', label: 'topic C', summary: 'summary C' },
    ],
    queries: [
      { id: 'qA', query: '雨夜咖啡馆 故事 解读', kind: 'web' },
      { id: 'qB', query: '雨夜咖啡馆 角色分析 旧友 陌生人', kind: 'web' },
      { id: 'qC', query: '雨夜咖啡馆 意象 咖啡 关系', kind: 'mixed' },
    ],
    knowledge_queries: [
      { id: 'kq1', query: '雨夜咖啡馆 设定 百科', kind: 'knowledge' },
      { id: 'kq2', query: '雨夜咖啡馆 主题 释义', kind: 'knowledge' },
    ],
    hot_keywords: [
      { id: 'hk1', keyword: '雨夜咖啡馆', rationale: 'title' },
      { id: 'hk2', keyword: '凌晨 咖啡馆', rationale: 'time+place' },
    ],
    hash: { content_hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' },
  };
  repo.setCommunityProfile(profile);
  const cpv = buildCanonicalCommunityProfileVersion(profile);
  check('repo.buildCanonicalCommunityProfileVersion shape', typeof cpv === 'string' && cpv.includes('@'));

  // Happy path.
  const ok = repo.findCanonicalByIdentity({
    story_uuid: UUID_A,
    story_version_uuid: UUID_B,
    community_profile_version: cpv,
  });
  check('repo.findCanonicalByIdentity happy → ok=true',
    ok && ok.ok === true && ok.profile && ok.profile.profile_uuid === UUID_D);

  // Wrong version → community_profile_version_mismatch.
  const wrongV = repo.findCanonicalByIdentity({
    story_uuid: UUID_A,
    story_version_uuid: UUID_B,
    community_profile_version: '0.0.0-fake',
  });
  check('repo.findCanonicalByIdentity wrong version → community_profile_version_mismatch',
    wrongV && wrongV.ok === false && wrongV.code === 'community_profile_version_mismatch');

  // Wrong story_uuid → story_version_mismatch (when a row IS bound
  // to the story_version_uuid). The row's profile.story_uuid is
  // UUID_A, so passing UUID_C must surface story_version_mismatch.
  const wrongS = repo.findCanonicalByIdentity({
    story_uuid: UUID_C,
    story_version_uuid: UUID_B,
    community_profile_version: cpv,
  });
  check('repo.findCanonicalByIdentity wrong story_uuid → story_version_mismatch',
    wrongS && wrongS.ok === false && wrongS.code === 'story_version_mismatch');

  // Unknown story_version_uuid → community_profile_not_found.
  const unknown = repo.findCanonicalByIdentity({
    story_uuid: UUID_A,
    story_version_uuid: UUID_D, // no row bound here
    community_profile_version: cpv,
  });
  check('repo.findCanonicalByIdentity unknown story_version_uuid → community_profile_not_found',
    unknown && unknown.ok === false && unknown.code === 'community_profile_not_found');
}

// ---------------------------------------------------------------------
// 4) Orchestrator: server-authoritative path.
// ---------------------------------------------------------------------
async function runOrchestratorTests() {
  // The orchestrator walks `profile.queries[]`. Profile is resolved
  // by the route layer; the orchestrator itself does NOT accept a
  // client-controlled `search_queries` array.
  const profile = {
    profile_uuid: UUID_D,
    story_uuid: UUID_A,
    story_version_uuid: UUID_B,
    generator_version: 'community-profile@community-profile-rules/1',
    generated_at: new Date(0).toISOString(),
    source: 'mock-fixture',
    locale: 'zh-CN',
    topics: [
      { id: 'topic-x', label: 'topic A', summary: 'summary A' },
      { id: 'topic-y', label: 'topic B', summary: 'summary B' },
      { id: 'topic-z', label: 'topic C', summary: 'summary C' },
    ],
    queries: [
      { id: 'qA', query: '雨夜咖啡馆 故事 解读', kind: 'web' },
      { id: 'qB', query: '雨夜咖啡馆 角色分析 旧友 陌生人', kind: 'web' },
      { id: 'qC', query: '雨夜咖啡馆 意象 咖啡 关系', kind: 'mixed' },
    ],
    knowledge_queries: [
      { id: 'kq1', query: '雨夜咖啡馆 设定 百科', kind: 'knowledge' },
      { id: 'kq2', query: '雨夜咖啡馆 主题 释义', kind: 'knowledge' },
    ],
    hot_keywords: [
      { id: 'hk1', keyword: '雨夜咖啡馆', rationale: 'title' },
      { id: 'hk2', keyword: '凌晨 咖啡馆', rationale: 'time+place' },
    ],
    hash: { content_hash: 'cafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafe' },
  };
  const cpv = buildCanonicalCommunityProfileVersion(profile);

  // Happy path with profile.
  {
    const cache = createInMemoryEcosystemSearchCacheRepository();
    const adapter = createMockZhihuSearchSource();
    const r = await searchEcosystemDiscussions({
      cache,
      adapter,
      profile,
      story_uuid: UUID_A,
      story_version_uuid: UUID_B,
      community_profile_version: cpv,
      limit: 2,
    });
    check('orchestrator: happy returns 200-equivalent (results[] present)',
      Array.isArray(r.results) && r.results.length === 3);
    check('orchestrator: results keyed by canonical profile.queries[].id',
      r.results[0].id === 'qA' && r.results[1].id === 'qB' && r.results[2].id === 'qC');
    check('orchestrator: each result.query matches profile.queries[].query',
      r.results[0].query === '雨夜咖啡馆 故事 解读'
        && r.results[1].query === '雨夜咖啡馆 角色分析 旧友 陌生人'
        && r.results[2].query === '雨夜咖啡馆 意象 咖啡 关系');
    check('orchestrator: each result has its own discussions[]',
      r.results.every((row) => Array.isArray(row.discussions)));
    check('orchestrator: top-level ecosystem_status=ok',
      r.ecosystem_status === 'ok');
  }
  // Profile with empty queries[] → unavailable.
  {
    const emptyProfile = Object.assign({}, profile, { queries: [] });
    const cache = createInMemoryEcosystemSearchCacheRepository();
    const adapter = createMockZhihuSearchSource();
    const r = await searchEcosystemDiscussions({
      cache,
      adapter,
      profile: emptyProfile,
      story_uuid: UUID_A,
      story_version_uuid: UUID_B,
      community_profile_version: cpv,
    });
    check('orchestrator: empty profile.queries → ecosystem_status=unavailable',
      r.ecosystem_status === 'unavailable');
  }
  // Missing profile → unavailable, not 200.
  {
    const cache = createInMemoryEcosystemSearchCacheRepository();
    const adapter = createMockZhihuSearchSource();
    const r = await searchEcosystemDiscussions({
      cache,
      adapter,
      story_uuid: UUID_A,
      story_version_uuid: UUID_B,
      community_profile_version: cpv,
    });
    check('orchestrator: missing profile → ecosystem_status=unavailable',
      r.ecosystem_status === 'unavailable');
  }
  // Client tries to pass a fake `search_queries` arg — orchestrator
  // ignores it (it walks profile.queries[] not input.search_queries).
  {
    const cache = createInMemoryEcosystemSearchCacheRepository();
    const adapter = createMockZhihuSearchSource();
    const r = await searchEcosystemDiscussions({
      cache,
      adapter,
      profile,
      search_queries: [{ id: 'fake', query: 'ATTACKER', kind: 'web' }], // ignored
      story_uuid: UUID_A,
      story_version_uuid: UUID_B,
      community_profile_version: cpv,
    });
    check('orchestrator: ignores caller-supplied search_queries (uses profile.queries)',
      r.results.every((row) => row.query !== 'ATTACKER'));
  }
  // Cache-key isolation per (story_version_uuid, community_profile_version).
  {
    const cache = createInMemoryEcosystemSearchCacheRepository();
    const adapter = createMockZhihuSearchSource();
    const k1 = buildEcosystemSearchCacheKey({
      query: 'foo',
      story_version_uuid: UUID_B,
      community_profile_version: cpv,
      query_id: 'q1',
    });
    const k2 = buildEcosystemSearchCacheKey({
      query: 'foo',
      story_version_uuid: UUID_B,
      community_profile_version: cpv + 'x', // different version
      query_id: 'q1',
    });
    check('cache key: different community_profile_version → different key',
      k1 !== k2);
  }
  // normaliseCanonicalSearchQueries dedupes ids.
  {
    const r = normaliseCanonicalSearchQueries([
      { id: 'q1', query: 'foo', kind: 'web' },
      { id: 'q1', query: 'bar', kind: 'web' },
    ]);
    check('normaliseCanonicalSearchQueries rejects duplicate ids',
      !r.ok && r.code === 'community_profile_not_found');
  }
}
await runOrchestratorTests();

// ---------------------------------------------------------------------
// 5) Wire tests: spin up server, exercise the route + /api/sessions.
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
    // Bootstrap a session.
    const sessionRes = await postJson('/api/sessions', { work_id: 'cafe-rain', role_id: 'stranger' });
    check('wire: /api/sessions → 200', sessionRes.response.status === 200);
    const session = sessionRes.data || {};
    check('wire: /api/sessions exposes community_profile_version',
      typeof session.community_profile_version === 'string' && session.community_profile_version.length > 0);
    check('wire: /api/sessions exposes community_profile_queries[]',
      Array.isArray(session.community_profile_queries) && session.community_profile_queries.length > 0);
    check('wire: /api/sessions queries[] carries id+query+kind',
      session.community_profile_queries[0].id
      && session.community_profile_queries[0].query
      && session.community_profile_queries[0].kind);
    check('wire: /api/sessions queries[] does NOT echo ending_title/key_choices/outcome',
      session.community_profile_queries.every((q) =>
        !('ending_title' in q) && !('key_choices' in q) && !('outcome' in q)));

    const uuid = session.session_uuid;

    // GET /api/sessions/:uuid also exposes profile identity.
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

    // P1.v2 — body.search_queries → 400 forbidden_field (NOT upstream).
    const searchQueriesLeak = await postJson('/v1/ecosystem/discussions', {
      search_queries: [{ id: 'q1', query: 'anything', kind: 'fake' }],
      story_uuid: session.story_uuid,
      story_version_uuid: session.story_version_uuid,
      community_profile_version: session.community_profile_version,
    });
    check('wire: body.search_queries → 400 forbidden_field (NOT upstream)',
      searchQueriesLeak.response.status === 400
      && searchQueriesLeak.data?.error === 'forbidden_field'
      && searchQueriesLeak.data?.field === 'search_queries');

    // P1.v2 — fake community_profile_version → community_profile_version_mismatch.
    const fakeVersion = await postJson('/v1/ecosystem/discussions', {
      story_uuid: session.story_uuid,
      story_version_uuid: session.story_version_uuid,
      community_profile_version: '0.0.0-fake',
    });
    check('wire: fake community_profile_version → 400 community_profile_version_mismatch',
      fakeVersion.response.status === 400
      && fakeVersion.data?.error === 'community_profile_version_mismatch');

    // P1.v2 — wrong story_uuid → story_version_mismatch (profile is
    // bound to a different story_uuid).
    const wrongStory = await postJson('/v1/ecosystem/discussions', {
      story_uuid: UUID_C, // wrong
      story_version_uuid: session.story_version_uuid,
      community_profile_version: session.community_profile_version,
    });
    check('wire: wrong story_uuid → 400 story_version_mismatch',
      wrongStory.response.status === 400
      && wrongStory.data?.error === 'story_version_mismatch');

    // P1.v2 — unknown story_uuid → community_profile_not_found.
    const unknownStory = await postJson('/v1/ecosystem/discussions', {
      story_uuid: UUID_D, // not used by any seeded profile
      story_version_uuid: UUID_B, // also unknown
      community_profile_version: 'v1',
    });
    check('wire: unknown identity → 400 community_profile_not_found',
      unknownStory.response.status === 400
      && unknownStory.data?.error === 'community_profile_not_found');

    // P1.v2 — happy path: identity-only body → 200, discussions from
    // CANONICAL profile.queries[] (NOT from any client-picked query).
    const happy = await postJson('/v1/ecosystem/discussions', {
      story_uuid: session.story_uuid,
      story_version_uuid: session.story_version_uuid,
      community_profile_version: session.community_profile_version,
      limit: 2,
    });
    check('wire: identity-only happy → 200',
      happy.response.status === 200);
    check('wire: happy results.length matches canonical profile.queries[].length',
      happy.data?.results?.length === session.community_profile_queries.length);
    check('wire: happy results are keyed by canonical profile.queries[].id',
      happy.data?.results?.every((r, i) => r.id === session.community_profile_queries[i].id));
    check('wire: happy result.query matches canonical profile.queries[].query',
      happy.data?.results?.every((r, i) => r.query === session.community_profile_queries[i].query));
    check('wire: happy top-level ecosystem_status=ok',
      happy.data?.ecosystem_status === 'ok');

    // P1.v2 — second call cached=true for every row.
    const cached = await postJson('/v1/ecosystem/discussions', {
      story_uuid: session.story_uuid,
      story_version_uuid: session.story_version_uuid,
      community_profile_version: session.community_profile_version,
      limit: 2,
    });
    check('wire: second call cached=true for all rows',
      cached.data?.results?.every((r) => r.cached === true));

    // P1.v2 — ending_title / key_choices / outcome / character_outcomes
    // all 400 forbidden_field (defence in depth on top of search_queries).
    const aiLeak = await postJson('/v1/ecosystem/discussions', {
      ending_title: 'AI',
      story_uuid: session.story_uuid,
      story_version_uuid: session.story_version_uuid,
      community_profile_version: session.community_profile_version,
    });
    check('wire: ending_title → 400 forbidden_field',
      aiLeak.response.status === 400 && aiLeak.data?.error === 'forbidden_field'
      && aiLeak.data?.field === 'ending_title');

    const kcLeak = await postJson('/v1/ecosystem/discussions', {
      key_choices: ['a', 'b'],
      story_uuid: session.story_uuid,
      story_version_uuid: session.story_version_uuid,
      community_profile_version: session.community_profile_version,
    });
    check('wire: key_choices → 400 forbidden_field',
      kcLeak.response.status === 400 && kcLeak.data?.error === 'forbidden_field'
      && kcLeak.data?.field === 'key_choices');

    // P1.v2 — GET → 405 still works.
    const get405 = await getJson('/v1/ecosystem/discussions');
    check('wire: GET → 405 method_not_allowed',
      get405.response.status === 405 && get405.data?.error === 'method_not_allowed');

    // P1.v2 — public response carries NO dev/demo/DEV_FLAG.
    check('wire: public response has no `dev` key', !('dev' in (happy.data || {})));
    check('wire: public response has no `demo` key', !('demo' in (happy.data || {})));
    check('wire: public response has no DEV_FLAG marker',
      JSON.stringify(happy.data || {}).indexOf('DEV_FLAG') === -1);
  } finally {
    await new Promise((res) => server.close(res));
  }
}
await runWireTests();

// ---------------------------------------------------------------------
// 6) End-to-end cafe_rain_story regression: identity → canonical
//    profile → discussions all from profile.queries[].
// ---------------------------------------------------------------------
async function runCafeRainRegression() {
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
  try {
    // Boot a fresh session against cafe_rain_story (cafe-rain fixture).
    const sessionRes = await postJson('/api/sessions', { work_id: 'cafe-rain', role_id: 'stranger' });
    const session = sessionRes.data;
    check('cafe_rain_story: /api/sessions → 200', sessionRes.response.status === 200);
    check('cafe_rain_story: community_profile_version present',
      typeof session.community_profile_version === 'string' && session.community_profile_version.length > 0);
    check('cafe_rain_story: community_profile_queries[] length >= 3',
      Array.isArray(session.community_profile_queries) && session.community_profile_queries.length >= 3);
    // Sanity: every query should be 雨夜咖啡馆-themed (canonical seed).
    check('cafe_rain_story: every query is canonical cafe-rain-themed',
      session.community_profile_queries.every((q) => typeof q.query === 'string' && q.query.indexOf('雨夜咖啡馆') >= 0));

    // Submit /v1/ecosystem/discussions with identity only.
    const r = await postJson('/v1/ecosystem/discussions', {
      story_uuid: session.story_uuid,
      story_version_uuid: session.story_version_uuid,
      community_profile_version: session.community_profile_version,
      limit: 3,
    });
    check('cafe_rain_story: /v1/ecosystem/discussions → 200',
      r.response.status === 200 && r.data?.ecosystem_status === 'ok');
    // Discussions come from canonical profile.queries[], NOT from any
    // client-picked query string.
    check('cafe_rain_story: results.length === profile.queries.length',
      r.data?.results?.length === session.community_profile_queries.length);
    check('cafe_rain_story: result.query matches canonical profile.queries[i].query',
      r.data?.results?.every((row, i) => row.query === session.community_profile_queries[i].query));
    // Each row carries at least one discussion from the upstream mock.
    check('cafe_rain_story: every result has discussions[]',
      r.data?.results?.every((row) => Array.isArray(row.discussions) && row.discussions.length >= 1));
  } finally {
    await new Promise((res) => server.close(res));
  }
}
await runCafeRainRegression();

if (failures > 0) {
  console.error(`\nFAILURES=${failures}`);
  process.exit(1);
} else {
  console.log('\nALL_OK clickup16-2-p1fix-v2.test.mjs');
}
