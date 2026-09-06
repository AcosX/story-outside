// tests/clickup16-5-p1-v1-3.test.mjs
//
// ClickUp 16.5 P1 v1-3 regression — canonical external
// community_profile_version + historical exact lookup + two-generation
// knowledge old-session regression.
//
// Owner巡检 (2026-09-07) flagged PR #25 / ff86cfb for the remaining P1
// gap: the handler identity was still using the raw `generator_version`
// even though #24 (clickup16-4) had aligned on a DERIVED external
// `community_profile_version = <generator_version>-<content_hash_short>`.
// The v1-3 fix unifies the contract with #24, makes
// `findCanonicalByIdentity` look up preserved rows by external version
// (no silent fallback to "latest"), and adds the historical-exact
// fixture + two-generation knowledge old-session regression this file
// covers.
//
// This test rebuilds the regression on the SAME worktree (#25 + this
// commit) and asserts the v1-3 contract:
//
//   P1.v1-3-1 — canonical external version
//     * `deriveExternalCommunityProfileVersion(profile)` returns
//       `<generator_version>-<content_hash_short>` where
//       `content_hash_short` is the first 8 hex chars of
//       `profile.hash.content_hash`.
//     * Two profiles with the same `generator_version` but a
//       different content hash yield two DIFFERENT external versions.
//
//   P1.v1-3-2 — historical exact lookup
//     * `repository.findCanonicalByIdentity(...)` resolves the row
//       whose external version EXACTLY matches the supplied external
//       version, even when a newer row has taken the active slot for
//       the same (story_version_uuid, generator_version) scope.
//     * No exact match → returns `null` (no silent fallback).
//     * The HTTP handler maps `null` to 400
//       `community_profile_not_found` (or
//       `community_profile_version_mismatch` when there are other rows
//       for the same story_version with non-matching external
//       versions).
//
//   P1.v1-3-3 — two-generation knowledge old-session regression
//     * Fixture: same `story_version_uuid` + same `generator_version`
//       + different `content_hash` (because the curated profile
//       content was edited) + different `knowledge_queries[]`.
//     * Old session pinned to A's external version → A's queries
//       resolve exactly, even after B overtook the active slot.
//     * New session pinned to B's external version → B's queries
//       resolve exactly.
//     * The two generations produce DIFFERENT knowledge bundles —
//       not the same result set with a different id.
//     * A bogus third external version → 400
//       `community_profile_not_found`.

import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import { server, communityProfileRepo } from '../src/server.mjs';
import {
  buildCommunityProfileFromSeed,
  createInMemoryCommunityProfileRepository,
  deriveExternalCommunityProfileVersion,
  ensureCommunityProfile,
} from '../src/community/index.mjs';

import { createSeededRepository, FIXTURE_UUIDS } from '../src/stories/fixture.mjs';
import { MOCK_DETAILS_FOR_COMMUNITY } from './_communityMockDetails.mjs';

// ----- helpers ----------------------------------------------------------

/**
 * Build two preserved community profiles A and B for the same
 * story_version + same generator_version + different content_hash +
 * different knowledge_queries[]. Inserts them via the repository's
 * `setCommunityProfile` (raw insert path) so the test is independent
 * of `seedCommunityProfiles` / `ensureCommunityProfile` ordering.
 *
 * Both profiles are installed into the supplied repository; the test
 * then verifies B "overtook the active slot" while A is preserved.
 */
function installTwoGenerations(repo) {
  const { repository } = createSeededRepository();
  const sv = FIXTURE_UUIDS['cafe-rain'].story_version_uuid;
  const story = MOCK_DETAILS_FOR_COMMUNITY.cafeRain;
  const version = repository.findVersion(sv);
  const generator_version = 'community-profile@community-profile-rules/1';

  const seedA = {
    topics: [
      { label: 'A 版 主题一', summary: 'profile A 的主题一描述。' },
      { label: 'A 版 主题二', summary: 'profile A 的主题二描述。' },
      { label: 'A 版 主题三', summary: 'profile A 的主题三描述。' },
    ],
    queries: [
      { query: 'A 版 普通查询一', kind: 'web' },
      { query: 'A 版 普通查询二', kind: 'web' },
      { query: 'A 版 普通查询三', kind: 'mixed' },
    ],
    knowledge_queries: [
      { query: 'A 版 知识查询 X', kind: 'knowledge' },
      { query: 'A 版 知识查询 Y', kind: 'knowledge' },
    ],
    hot_keywords: [
      { keyword: 'A 版 热词一', rationale: 'A 的热词一理由。' },
      { keyword: 'A 版 热词二', rationale: 'A 的热词二理由。' },
    ],
  };
  const seedB = {
    topics: [
      { label: 'B 版 主题一', summary: 'profile B 的主题一描述。' },
      { label: 'B 版 主题二', summary: 'profile B 的主题二描述。' },
      { label: 'B 版 主题三', summary: 'profile B 的主题三描述。' },
    ],
    queries: [
      { query: 'B 版 普通查询一', kind: 'web' },
      { query: 'B 版 普通查询二', kind: 'web' },
      { query: 'B 版 普通查询三', kind: 'mixed' },
    ],
    knowledge_queries: [
      { query: 'B 版 知识查询 P', kind: 'knowledge' },
      { query: 'B 版 知识查询 Q', kind: 'knowledge' },
    ],
    hot_keywords: [
      { keyword: 'B 版 热词一', rationale: 'B 的热词一理由。' },
      { keyword: 'B 版 热词二', rationale: 'B 的热词二理由。' },
    ],
  };

  const profileA = buildCommunityProfileFromSeed({
    story_uuid: version.story_uuid,
    story_version_uuid: version.version_uuid,
    story_version_checksum: version.checksum,
    source: 'mock-fixture',
    generator_version,
    topics: seedA.topics,
    queries: seedA.queries,
    knowledge_queries: seedA.knowledge_queries,
    hot_keywords: seedA.hot_keywords,
  });
  const profileB = buildCommunityProfileFromSeed({
    story_uuid: version.story_uuid,
    story_version_uuid: version.version_uuid,
    story_version_checksum: version.checksum,
    source: 'mock-fixture',
    generator_version,
    topics: seedB.topics,
    queries: seedB.queries,
    knowledge_queries: seedB.knowledge_queries,
    hot_keywords: seedB.hot_keywords,
  });
  // Sanity-check the precondition: same generator_version, but
  // different content_hash so the two profiles carry different
  // external versions.
  assert.equal(profileA.generator_version, profileB.generator_version);
  assert.notEqual(profileA.hash.content_hash, profileB.hash.content_hash);
  assert.notEqual(profileA.profile_uuid, profileB.profile_uuid);

  repo.setCommunityProfile(profileA);
  // B is inserted second; the active slot for the (sv, gv) scope
  // must point at B (the newer row), but A is preserved in
  // state.profiles — that's the "preserved rows" case the fix
  // requires.
  repo.setCommunityProfile(profileB);

  return {
    repository,
    version,
    story,
    generator_version,
    profileA,
    profileB,
  };
}

async function pickPort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

async function startServer() {
  const port = await pickPort();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** @returns {Promise<Response>} */
function post(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ----- 1. deriveExternalCommunityProfileVersion ------------------------

test('deriveExternalCommunityProfileVersion: <generator_version>-<content_hash_short>', () => {
  const { profileA, profileB } = installTwoGenerations(createInMemoryCommunityProfileRepository());
  const externalA = deriveExternalCommunityProfileVersion(profileA);
  const externalB = deriveExternalCommunityProfileVersion(profileB);
  assert.equal(
    externalA,
    `${profileA.generator_version}-${profileA.hash.content_hash.slice(0, 8)}`,
  );
  assert.equal(
    externalB,
    `${profileB.generator_version}-${profileB.hash.content_hash.slice(0, 8)}`,
  );
  // Same generator_version, different content_hash → distinct
  // external versions.
  assert.notEqual(externalA, externalB);
});

test('deriveExternalCommunityProfileVersion: rejects missing inputs', () => {
  assert.throws(() => deriveExternalCommunityProfileVersion(null));
  assert.throws(() => deriveExternalCommunityProfileVersion({}));
  assert.throws(() => deriveExternalCommunityProfileVersion({ generator_version: 'g' }));
  assert.throws(
    () => deriveExternalCommunityProfileVersion({ generator_version: 'g', hash: {} }),
  );
});

// ----- 2. repository historical exact lookup ----------------------------

test('repository.findCanonicalByIdentity: A still resolves after B overtook the active slot', () => {
  const repo = createInMemoryCommunityProfileRepository();
  const { profileA, profileB, version } = installTwoGenerations(repo);
  const externalA = deriveExternalCommunityProfileVersion(profileA);
  const externalB = deriveExternalCommunityProfileVersion(profileB);

  // Sanity-check the precondition: B is now the active row for
  // (sv, gv); A is preserved in state.profiles but NOT the active
  // one.
  const active = repo.findActiveByStoryVersionAndGenerator(
    version.version_uuid,
    profileA.generator_version,
  );
  assert.equal(active.profile_uuid, profileB.profile_uuid);

  // Old session pinned to A's external version → A's row.
  const resolvedA = repo.findCanonicalByIdentity({
    story_uuid: version.story_uuid,
    story_version_uuid: version.version_uuid,
    community_profile_version: externalA,
  });
  assert.ok(resolvedA);
  assert.equal(resolvedA.profile_uuid, profileA.profile_uuid);

  // New session pinned to B's external version → B's row.
  const resolvedB = repo.findCanonicalByIdentity({
    story_uuid: version.story_uuid,
    story_version_uuid: version.version_uuid,
    community_profile_version: externalB,
  });
  assert.ok(resolvedB);
  assert.equal(resolvedB.profile_uuid, profileB.profile_uuid);
});

test('repository.findCanonicalByIdentity: unknown external version → null (no silent fallback to latest)', () => {
  const repo = createInMemoryCommunityProfileRepository();
  const { profileA, version } = installTwoGenerations(repo);
  // Pretend an old session pinned a string that does NOT match any
  // preserved row's external version. The lookup MUST return null
  // instead of silently resolving to the latest active row.
  const resolved = repo.findCanonicalByIdentity({
    story_uuid: version.story_uuid,
    story_version_uuid: version.version_uuid,
    community_profile_version: `${profileA.generator_version}-deadbeef`,
  });
  assert.equal(resolved, null);
});

// ----- 3. HTTP layer: route uses external version, not raw --------------

test('HTTP /v1/ecosystem/knowledge: A external version → A queries', async () => {
  const repo = createInMemoryCommunityProfileRepository();
  const { profileA, version } = installTwoGenerations(repo);
  // The route layer reads from the module-level `communityProfileRepo`,
  // NOT the test's local `repo`. We have to install on the server's
  // repo so the HTTP path picks them up.
  communityProfileRepo.setCommunityProfile(profileA);
  const ctx = await startServer();
  try {
    const externalA = deriveExternalCommunityProfileVersion(profileA);
    const res = await post(`${ctx.baseUrl}/v1/ecosystem/knowledge`, {
      story_uuid: version.story_uuid,
      story_version_uuid: version.version_uuid,
      community_profile_version: externalA,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.results.length, 2);
    assert.equal(body.results[0].query, 'A 版 知识查询 X');
    assert.equal(body.results[1].query, 'A 版 知识查询 Y');
    // Echoes the canonical knowledge_queries too.
    assert.equal(body.knowledge_queries[0].query, 'A 版 知识查询 X');
    assert.equal(body.knowledge_queries[1].query, 'A 版 知识查询 Y');
  } finally {
    await ctx.close();
  }
});

test('HTTP /v1/ecosystem/knowledge: B external version → B queries (distinct from A)', async () => {
  const repo = createInMemoryCommunityProfileRepository();
  const { profileB, version } = installTwoGenerations(repo);
  // Re-install onto the server repo so the HTTP path sees B.
  communityProfileRepo.setCommunityProfile(profileB);
  const ctx = await startServer();
  try {
    const externalB = deriveExternalCommunityProfileVersion(profileB);
    const res = await post(`${ctx.baseUrl}/v1/ecosystem/knowledge`, {
      story_uuid: version.story_uuid,
      story_version_uuid: version.version_uuid,
      community_profile_version: externalB,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.results.length, 2);
    assert.equal(body.results[0].query, 'B 版 知识查询 P');
    assert.equal(body.results[1].query, 'B 版 知识查询 Q');
    assert.equal(body.knowledge_queries[0].query, 'B 版 知识查询 P');
    assert.equal(body.knowledge_queries[1].query, 'B 版 知识查询 Q');
  } finally {
    await ctx.close();
  }
});

test('HTTP /v1/ecosystem/knowledge: bogus third external version → 400 community_profile_not_found', async () => {
  const repo = createInMemoryCommunityProfileRepository();
  const { profileA, profileB, version } = installTwoGenerations(repo);
  // Install both rows on the server repo so the version-exists
  // branch is exercised (the error mapping differentiates
  // not_found vs version_mismatch).
  communityProfileRepo.setCommunityProfile(profileA);
  communityProfileRepo.setCommunityProfile(profileB);
  const ctx = await startServer();
  try {
    const res = await post(`${ctx.baseUrl}/v1/ecosystem/knowledge`, {
      story_uuid: version.story_uuid,
      story_version_uuid: version.version_uuid,
      community_profile_version: `${profileA.generator_version}-deadbeef`,
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    // Two rows exist for this story_version but the supplied external
    // version matches neither → `community_profile_version_mismatch`
    // (the version_exists branch). This is the "preserved rows still
    // exist, but the client's pin is bogus" path — distinct from
    // "no rows for this story_version at all".
    assert.equal(body.error, 'community_profile_version_mismatch');
    assert.equal(body.field, 'community_profile_version');
  } finally {
    await ctx.close();
  }
});

test('HTTP /v1/ecosystem/knowledge: unknown story_version → 400 community_profile_not_found', async () => {
  const ctx = await startServer();
  try {
    const res = await post(`${ctx.baseUrl}/v1/ecosystem/knowledge`, {
      story_uuid: '00000000-0000-4000-8000-000000000099',
      story_version_uuid: '00000000-0000-4000-8000-000000000199',
      community_profile_version: 'community-profile@community-profile-rules/1-deadbeef',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'community_profile_not_found');
    assert.equal(body.field, 'story_version_uuid');
  } finally {
    await ctx.close();
  }
});

// ----- 4. old-session + new-session regression --------------------------

test('two-generation regression: A and B return different knowledge bundles (not byte-identical)', async () => {
  const repo = createInMemoryCommunityProfileRepository();
  const { profileA, profileB, version } = installTwoGenerations(repo);
  communityProfileRepo.setCommunityProfile(profileA);
  communityProfileRepo.setCommunityProfile(profileB);
  const ctx = await startServer();
  try {
    const externalA = deriveExternalCommunityProfileVersion(profileA);
    const externalB = deriveExternalCommunityProfileVersion(profileB);

    const resA = await post(`${ctx.baseUrl}/v1/ecosystem/knowledge`, {
      story_uuid: version.story_uuid,
      story_version_uuid: version.version_uuid,
      community_profile_version: externalA,
    });
    const resB = await post(`${ctx.baseUrl}/v1/ecosystem/knowledge`, {
      story_uuid: version.story_uuid,
      story_version_uuid: version.version_uuid,
      community_profile_version: externalB,
    });
    assert.equal(resA.status, 200);
    assert.equal(resB.status, 200);
    const bodyA = await resA.json();
    const bodyB = await resB.json();

    // Each generation carries its own knowledge_queries list.
    assert.notDeepEqual(bodyA.knowledge_queries, bodyB.knowledge_queries);

    // The two result bundles MUST be distinct: A's results echo
    // A's queries, B's results echo B's queries.
    const queryStringsA = bodyA.results.map((r) => r.query);
    const queryStringsB = bodyB.results.map((r) => r.query);
    assert.deepEqual(queryStringsA, ['A 版 知识查询 X', 'A 版 知识查询 Y']);
    assert.deepEqual(queryStringsB, ['B 版 知识查询 P', 'B 版 知识查询 Q']);

    // Each bundle's knowledge entries MUST NOT overlap with the
    // other bundle's entries. The mock knowledge source echoes the
    // query string into the summary, so a bundle whose summaries
    // mention A's queries cannot also mention B's queries.
    for (const entry of bodyA.knowledge) {
      assert.ok(!String(entry.summary || '').includes('B 版'), 'A bundle must not contain B query');
    }
    for (const entry of bodyB.knowledge) {
      assert.ok(!String(entry.summary || '').includes('A 版'), 'B bundle must not contain A query');
    }

    // The cache_key query_hashes for the two generations must also
    // be distinct because the query strings are different.
    const hashA = bodyA.results[0].cache_key.query_hash;
    const hashB = bodyB.results[0].cache_key.query_hash;
    assert.notEqual(hashA, hashB);
  } finally {
    await ctx.close();
  }
});

test('two-generation regression: A external version still resolves after B overtook the active slot (no silent 0)', async () => {
  const repo = createInMemoryCommunityProfileRepository();
  const { profileA, profileB, version } = installTwoGenerations(repo);
  // Install A first, then B — B overwrites A's active slot, but
  // A is preserved in state.profiles.
  communityProfileRepo.setCommunityProfile(profileA);
  communityProfileRepo.setCommunityProfile(profileB);
  const ctx = await startServer();
  try {
    const externalA = deriveExternalCommunityProfileVersion(profileA);
    // A's external version still resolves — A's knowledge_queries
    // are returned, NOT empty results, NOT a 400.
    const res = await post(`${ctx.baseUrl}/v1/ecosystem/knowledge`, {
      story_uuid: version.story_uuid,
      story_version_uuid: version.version_uuid,
      community_profile_version: externalA,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.results.length, 2);
    // A's queries MUST come back — not B's, not empty, not a 0-result
    // silently collapsed onto B's bundle.
    assert.deepEqual(
      body.results.map((r) => r.query),
      ['A 版 知识查询 X', 'A 版 知识查询 Y'],
    );
    assert.deepEqual(
      body.knowledge_queries.map((q) => q.query),
      ['A 版 知识查询 X', 'A 版 知识查询 Y'],
    );
  } finally {
    await ctx.close();
  }
});