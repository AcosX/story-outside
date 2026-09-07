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

  // Wrong version (v1-2 / immutable lookup contract): a
  // community_profile_version that does NOT match any row's canonical
  // version string returns community_profile_not_found — NOT
  // community_profile_version_mismatch. v2 #28 returned
  // community_profile_version_mismatch because it walked only the
  // activeByStoryVersion index and compared the requested string
  // against the LATEST row's canonical version. v1-2 closes that
  // bug: a wrong version is a lookup miss, not a mismatch against
  // the latest.
  const wrongV = repo.findCanonicalByIdentity({
    story_uuid: UUID_A,
    story_version_uuid: UUID_B,
    community_profile_version: '0.0.0-fake',
  });
  check('repo.findCanonicalByIdentity wrong version → community_profile_not_found (immutable lookup miss)',
    wrongV && wrongV.ok === false && wrongV.code === 'community_profile_not_found');

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

    // P1.v2 (v1-2 / immutable lookup): fake community_profile_version
    // (one that doesn't match any row's canonical version string)
    // → community_profile_not_found. v2 #28 returned
    // community_profile_version_mismatch here because of the
    // "pick-latest-then-compare" bug; v1-2 closes that bug.
    const fakeVersion = await postJson('/v1/ecosystem/discussions', {
      story_uuid: session.story_uuid,
      story_version_uuid: session.story_version_uuid,
      community_profile_version: '0.0.0-fake',
    });
    check('wire: fake community_profile_version → 400 community_profile_not_found',
      fakeVersion.response.status === 400
      && fakeVersion.data?.error === 'community_profile_not_found');

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

// ---------------------------------------------------------------------
// 7) IMMUTABLE LOOKUP regression (v1-2 / 2026-09-07 04:21 主人巡检
//    修复): `findCanonicalByIdentity` MUST resolve an OLD
//    `community_profile_version` (one that has been SUPERSEDED by a
//    newer row in the same `story_version_uuid`). v2 #28 walked only
//    the `activeByStoryVersion` index (which points at the latest
//    row per (story_version_uuid, generator_version)), so a pinned
//    session asking for an old version got
//    `community_profile_version_mismatch` instead of the OLD row.
//
//    The fix walks `state.profiles` (every row ever written), and
//    matches the version string byte-for-byte. This block exercises
//    that with a multi-generation fixture: three rows for the SAME
//    story_version_uuid, only the LAST is `active`; the earlier two
//    must still be resolvable.
// ---------------------------------------------------------------------
async function runImmutableLookupRegression() {
  const repo = createInMemoryCommunityProfileRepository();
  const STORY_UUID = 'aaaaaaaa-1111-2222-3333-444444444444';
  const STORY_VERSION_UUID = 'bbbbbbbb-1111-2222-3333-444444444444';

  function makeProfile({
    profileUuid, contentHash, generator = 'community-profile@community-profile-rules/1',
    queriesTag = 'gen',
  }) {
    return {
      profile_uuid: profileUuid,
      story_uuid: STORY_UUID,
      story_version_uuid: STORY_VERSION_UUID,
      story_version_checksum: 'cafe-rain-fixture',
      generator_version: generator,
      generated_at: new Date(0).toISOString(),
      source: 'mock-fixture',
      locale: 'zh-CN',
      topics: [
        { id: 'topic-x', label: 'topic A', summary: 'summary A' },
        { id: 'topic-y', label: 'topic B', summary: 'summary B' },
        { id: 'topic-z', label: 'topic C', summary: 'summary C' },
      ],
      queries: [
        { id: `qA-${queriesTag}`, query: `咖啡馆 查询 ${queriesTag} A`, kind: 'web' },
        { id: `qB-${queriesTag}`, query: `咖啡馆 查询 ${queriesTag} B`, kind: 'web' },
        { id: `qC-${queriesTag}`, query: `咖啡馆 查询 ${queriesTag} C`, kind: 'mixed' },
      ],
      knowledge_queries: [
        { id: `kq1-${queriesTag}`, query: `咖啡馆 知识 ${queriesTag}`, kind: 'knowledge' },
        { id: `kq2-${queriesTag}`, query: `咖啡馆 释义 ${queriesTag}`, kind: 'knowledge' },
      ],
      hot_keywords: [
        { id: `hk1-${queriesTag}`, keyword: `咖啡馆 ${queriesTag}`, rationale: 'title' },
        { id: `hk2-${queriesTag}`, keyword: `雨夜 ${queriesTag}`, rationale: 'theme' },
      ],
      hash: { content_hash: contentHash },
    };
  }

  // Generation 1 (oldest): will be superseded.
  const gen1 = makeProfile({
    profileUuid: '11111111-aaaa-bbbb-cccc-dddddddddddd',
    contentHash: '1111111111111111111111111111111111111111111111111111111111111111',
    queriesTag: 'gen1',
  });
  repo.setCommunityProfile(gen1);
  const cpv1 = buildCanonicalCommunityProfileVersion(gen1);

  // Generation 2 (middle): will be superseded by gen3.
  const gen2 = makeProfile({
    profileUuid: '22222222-aaaa-bbbb-cccc-dddddddddddd',
    contentHash: '2222222222222222222222222222222222222222222222222222222222222222',
    queriesTag: 'gen2',
  });
  repo.setCommunityProfile(gen2);
  const cpv2 = buildCanonicalCommunityProfileVersion(gen2);

  // Generation 3 (newest, ACTIVE).
  const gen3 = makeProfile({
    profileUuid: '33333333-aaaa-bbbb-cccc-dddddddddddd',
    contentHash: '3333333333333333333333333333333333333333333333333333333333333333',
    queriesTag: 'gen3',
  });
  repo.setCommunityProfile(gen3);
  const cpv3 = buildCanonicalCommunityProfileVersion(gen3);

  // Sanity: store retains all three rows.
  check('immutable: store retains all 3 generations (state.profiles.size === 3)',
    repo.stats().profile_count === 3);

  // The three version strings MUST be distinct.
  check('immutable: cpv1 !== cpv2 !== cpv3 (distinct content_hashes)',
    cpv1 !== cpv2 && cpv2 !== cpv3 && cpv1 !== cpv3);

  // RESOLVE the newest (active) version.
  const r3 = repo.findCanonicalByIdentity({
    story_uuid: STORY_UUID,
    story_version_uuid: STORY_VERSION_UUID,
    community_profile_version: cpv3,
  });
  check('immutable: resolve ACTIVE generation (gen3) → ok=true, profile_uuid=gen3',
    r3 && r3.ok === true && r3.profile && r3.profile.profile_uuid === gen3.profile_uuid);

  // RESOLVE the OLDEST (gen1) — this is the regression that v2 #28
  // broke. Must succeed and return the gen1 row.
  const r1 = repo.findCanonicalByIdentity({
    story_uuid: STORY_UUID,
    story_version_uuid: STORY_VERSION_UUID,
    community_profile_version: cpv1,
  });
  check('immutable: resolve OLD generation (gen1, superseded) → ok=true, profile_uuid=gen1',
    r1 && r1.ok === true && r1.profile && r1.profile.profile_uuid === gen1.profile_uuid);
  check('immutable: gen1 resolved.queries[] is gen1-flavoured (NOT gen3)',
    r1.ok && Array.isArray(r1.profile.queries) && r1.profile.queries[0].id === 'qA-gen1');
  check('immutable: gen1 resolved.hash.content_hash === gen1 hash',
    r1.ok && r1.profile.hash.content_hash === gen1.hash.content_hash);

  // RESOLVE the middle (gen2).
  const r2 = repo.findCanonicalByIdentity({
    story_uuid: STORY_UUID,
    story_version_uuid: STORY_VERSION_UUID,
    community_profile_version: cpv2,
  });
  check('immutable: resolve MIDDLE generation (gen2, superseded) → ok=true, profile_uuid=gen2',
    r2 && r2.ok === true && r2.profile && r2.profile.profile_uuid === gen2.profile_uuid);

  // NEGATIVE: a version string that does not exist anywhere in the
  // store → community_profile_not_found. MUST NOT degrade to the
  // "latest" (gen3) row silently.
  const rBogus = repo.findCanonicalByIdentity({
    story_uuid: STORY_UUID,
    story_version_uuid: STORY_VERSION_UUID,
    community_profile_version: '0.0.0-does-not-exist',
  });
  check('immutable: unknown version → community_profile_not_found (NOT silent fallback)',
    rBogus && rBogus.ok === false && rBogus.code === 'community_profile_not_found');

  // NEGATIVE: wrong story_uuid on a row-bound story_version →
  // story_version_mismatch. (Even though gen3 is the active row,
  // the check still walks every row and detects the cross-story
  // binding.)
  const rStoryMismatch = repo.findCanonicalByIdentity({
    story_uuid: 'ffffffff-1111-2222-3333-444444444444', // wrong
    story_version_uuid: STORY_VERSION_UUID,
    community_profile_version: cpv1, // any of them would do
  });
  check('immutable: wrong story_uuid → story_version_mismatch',
    rStoryMismatch && rStoryMismatch.ok === false && rStoryMismatch.code === 'story_version_mismatch');

  // NEGATIVE: unknown story_version_uuid (no rows bound at all) →
  // community_profile_not_found.
  const rUnknownSv = repo.findCanonicalByIdentity({
    story_uuid: STORY_UUID,
    story_version_uuid: 'cccccccc-1111-2222-3333-444444444444', // no rows
    community_profile_version: cpv1,
  });
  check('immutable: unknown story_version_uuid → community_profile_not_found',
    rUnknownSv && rUnknownSv.ok === false && rUnknownSv.code === 'community_profile_not_found');

  // NEGATIVE: bad input shape → community_profile_not_found.
  const rBadInput = repo.findCanonicalByIdentity(null);
  check('immutable: null input → community_profile_not_found',
    rBadInput && rBadInput.ok === false && rBadInput.code === 'community_profile_not_found');
}
await runImmutableLookupRegression();

// ---------------------------------------------------------------------
// 8) WIRE regression (v1-2 / 2026-09-07 04:21 主人巡检修复): spin up
//    the server, build a multi-generation fixture via
//    `setCommunityProfile`, and exercise the full
//    POST /v1/ecosystem/discussions route with the OLD
//    community_profile_version. The route MUST 200 and return
//    results[] keyed by the OLD profile.queries[] (NOT silently
//    fallback to the LATEST).
// ---------------------------------------------------------------------
async function runImmutableLookupWireRegression() {
  const { server, communityProfileRepo } = await import('../src/server.mjs');
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
    // Build a multi-generation fixture on a single story_version
    // that the import-hook layer has NOT seeded (so we control the
    // version strings exactly). We pick UUIDs that the production
    // seed doesn't use, then re-use the repo via the module's
    // exported handle.
    const STORY_UUID = 'aaaa1111-aaaa-1111-aaaa-111111111111';
    const STORY_VERSION_UUID = 'bbbb1111-bbbb-1111-bbbb-111111111111';
    function makeRow({ profileUuid, contentHash, tag }) {
      return {
        profile_uuid: profileUuid,
        story_uuid: STORY_UUID,
        story_version_uuid: STORY_VERSION_UUID,
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
          { id: `qA-${tag}`, query: `雨夜咖啡馆 查询 ${tag} A`, kind: 'web' },
          { id: `qB-${tag}`, query: `雨夜咖啡馆 查询 ${tag} B`, kind: 'mixed' },
          { id: `qC-${tag}`, query: `雨夜咖啡馆 查询 ${tag} C`, kind: 'knowledge' },
        ],
        knowledge_queries: [
          { id: `kq1-${tag}`, query: `雨夜咖啡馆 知识 ${tag}`, kind: 'knowledge' },
          { id: `kq2-${tag}`, query: `雨夜咖啡馆 释义 ${tag}`, kind: 'knowledge' },
        ],
        hot_keywords: [
          { id: `hk1-${tag}`, keyword: `雨夜咖啡馆 ${tag}`, rationale: 'title' },
          { id: `hk2-${tag}`, keyword: `雨夜 ${tag}`, rationale: 'theme' },
        ],
        hash: { content_hash: contentHash },
      };
    }
    const oldRow = makeRow({
      profileUuid: 'dddd1111-dddd-1111-dddd-111111111111',
      contentHash: '111111111111111111111111111111111111111111111111111111111111aaaa',
      tag: 'wire-old',
    });
    const newRow = makeRow({
      profileUuid: 'eeee1111-eeee-1111-eeee-111111111111',
      contentHash: '222222222222222222222222222222222222222222222222222222222222bbbb',
      tag: 'wire-new',
    });
    communityProfileRepo.setCommunityProfile(oldRow);
    communityProfileRepo.setCommunityProfile(newRow);
    const oldCpv = buildCanonicalCommunityProfileVersion(oldRow);
    const newCpv = buildCanonicalCommunityProfileVersion(newRow);

    check('immutable-wire: oldCpv !== newCpv', oldCpv !== newCpv);

    // POST with the OLD version — must succeed, results[] keyed by
    // oldRow.queries[].id.
    const rOld = await postJson('/v1/ecosystem/discussions', {
      story_uuid: STORY_UUID,
      story_version_uuid: STORY_VERSION_UUID,
      community_profile_version: oldCpv,
    });
    check('immutable-wire: POST old community_profile_version → 200',
      rOld.response.status === 200);
    check('immutable-wire: old response results[] keyed by oldRow.queries[].id',
      rOld.data?.results?.[0]?.id === 'qA-wire-old'
      && rOld.data?.results?.[1]?.id === 'qB-wire-old');
    check('immutable-wire: old response queries match oldRow.queries[].query',
      rOld.data?.results?.[0]?.query === '雨夜咖啡馆 查询 wire-old A');

    // POST with the NEW version — must succeed, results[] keyed by
    // newRow.queries[].id.
    const rNew = await postJson('/v1/ecosystem/discussions', {
      story_uuid: STORY_UUID,
      story_version_uuid: STORY_VERSION_UUID,
      community_profile_version: newCpv,
    });
    check('immutable-wire: POST new community_profile_version → 200',
      rNew.response.status === 200);
    check('immutable-wire: new response results[] keyed by newRow.queries[].id',
      rNew.data?.results?.[0]?.id === 'qA-wire-new'
      && rNew.data?.results?.[1]?.id === 'qB-wire-new');

    // POST with a non-existent version — must 400
    // community_profile_not_found (NOT 200 silently using newRow).
    const rBogus = await postJson('/v1/ecosystem/discussions', {
      story_uuid: STORY_UUID,
      story_version_uuid: STORY_VERSION_UUID,
      community_profile_version: '0.0.0-does-not-exist',
    });
    check('immutable-wire: POST bogus community_profile_version → 400 community_profile_not_found',
      rBogus.response.status === 400
      && rBogus.data?.error === 'community_profile_not_found');
  } finally {
    await new Promise((res) => server.close(res));
  }
}
await runImmutableLookupWireRegression();

if (failures > 0) {
  console.error(`\nFAILURES=${failures}`);
  process.exit(1);
} else {
  console.log('\nALL_OK clickup16-2-p1fix-v2.test.mjs');
}
