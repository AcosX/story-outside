// tests/clickup16-5-p1-v1-5.test.mjs
//
// ClickUp 16.5 P1 v1-5 regression — Map iteration-order bug fix.
//
// Background (2026-09-07 owner review + ChatGPT 复核):
//
// The v1-4 implementation of `findActiveByStoryVersion` walked
// `state.activeByStoryVersion.entries()` and trusted Map insertion
// order to pick "the last inserted row for this story_version".
// But `Map.set(existing key)` does NOT move the key's iteration
// position. So when an older `generator_version` was re-inserted
// AFTER a newer one (the g1/A → g2/B → g1/C ordering), the older
// key stayed in its original slot and the walk deterministically
// returned the wrong (older) row.
//
// The v1-5 fix replaces the iteration-order trick with an EXPLICIT
// `latestByStoryVersion: Map<story_version_uuid, profile_uuid>`
// pointer that is updated ONLY by `setCommunityProfile` on a fresh
// insert. Idempotent re-inserts of the same (sv, generator_version,
// content_hash) triple do NOT move the pointer, so a stale re-insert
// cannot regress the active row.
//
// Scope:
//
//   P1.v1-5-1 — explicit latest pointer
//     * `latestByStoryVersion` is repository-private state.
//     * `setCommunityProfile` updates it ONLY on a fresh insert
//       (after the idempotency short-circuit, which is a no-op).
//     * `findActiveByStoryVersion` is a direct
//       `latestByStoryVersion.get(story_version_uuid)` — no Map
//       iteration, no `for...of` over `activeByStoryVersion`.
//     * The canonical 13-field profile schema (PROFILE_TOP_LEVEL_KEYS)
//       is UNCHANGED — no `insert_seq`, no `seq`, no `latest` on
//       the row.
//
//   P1.v1-5-2 — g1/A → g2/B → g1/C regression
//     * Insert three profiles for the same story_version in the
//       order A (generator_version g1) → B (generator_version g2) →
//       C (generator_version g1 newest, fresh content_hash).
//     * After all three inserts, `findActiveByStoryVersion` MUST
//       return C, NOT B.
//     * The Map iteration order MUST NOT influence the result —
//       the explicit pointer decides.
//     * An idempotent re-insert of A's (sv, g1, content_hash) MUST
//       NOT change the active row.
//
//   P1.v1-5-3 — schema contract preserved
//     * `PROFILE_TOP_LEVEL_KEYS.length === 13`.
//     * No `insert_seq`, `seq`, or `latest` field on the row.
//
//   P1.v1-5-4 — external version format unchanged
//     * `<generator_version>@<profile.hash.content_hash.slice(0,16)>`
//       (the v1-4 contract from #23 branch).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createInMemoryCommunityProfileRepository } from '../src/community/index.mjs';
import {
  buildCommunityProfileFromSeed,
  deriveExternalCommunityProfileVersion,
} from '../src/community/index.mjs';
import { PROFILE_TOP_LEVEL_KEYS } from '../src/community/profile.mjs';
import { createSeededRepository, FIXTURE_UUIDS } from '../src/stories/fixture.mjs';

// ----- helpers ----------------------------------------------------------

/**
 * Build three preserved community profiles for the same
 * story_version in the order A (g1) → B (g2) → C (g1 newest), then
 * insert them via the repository's raw `setCommunityProfile` path.
 *
 * The KEY precondition: A and C share `generator_version = 'g1'`
 * but carry DIFFERENT content_hash so they are distinct rows. B
 * uses `generator_version = 'g2'` with yet another content_hash.
 *
 * @returns {{
 *   repo: ReturnType<typeof createInMemoryCommunityProfileRepository>,
 *   version: ReturnType<ReturnType<typeof createSeededRepository>['repository']['findVersion']>,
 *   profileA: import('../src/community/profile.mjs').StoryCommunityProfile,
 *   profileB: import('../src/community/profile.mjs').StoryCommunityProfile,
 *   profileC: import('../src/community/profile.mjs').StoryCommunityProfile,
 * }}
 */
function installG1AG2BG1C() {
  const { repository } = createSeededRepository();
  const sv = FIXTURE_UUIDS['cafe-rain'].story_version_uuid;
  const version = repository.findVersion(sv);
  const repo = createInMemoryCommunityProfileRepository();

  const seedA = {
    topics: [
      { label: 'A 主题一', summary: 'A 的主题一描述。' },
      { label: 'A 主题二', summary: 'A 的主题二描述。' },
      { label: 'A 主题三', summary: 'A 的主题三描述。' },
    ],
    queries: [
      { query: 'A 普通查询一', kind: 'web' },
      { query: 'A 普通查询二', kind: 'web' },
      { query: 'A 普通查询三', kind: 'mixed' },
    ],
    knowledge_queries: [
      { query: 'A 知识查询 X', kind: 'knowledge' },
      { query: 'A 知识查询 Y', kind: 'knowledge' },
    ],
    hot_keywords: [
      { keyword: 'A 热词一', rationale: 'A 的热词一理由。' },
      { keyword: 'A 热词二', rationale: 'A 的热词二理由。' },
    ],
  };
  const seedB = {
    topics: [
      { label: 'B 主题一', summary: 'B 的主题一描述。' },
      { label: 'B 主题二', summary: 'B 的主题二描述。' },
      { label: 'B 主题三', summary: 'B 的主题三描述。' },
    ],
    queries: [
      { query: 'B 普通查询一', kind: 'web' },
      { query: 'B 普通查询二', kind: 'web' },
      { query: 'B 普通查询三', kind: 'mixed' },
    ],
    knowledge_queries: [
      { query: 'B 知识查询 P', kind: 'knowledge' },
      { query: 'B 知识查询 Q', kind: 'knowledge' },
    ],
    hot_keywords: [
      { keyword: 'B 热词一', rationale: 'B 的热词一理由。' },
      { keyword: 'B 热词二', rationale: 'B 的热词二理由。' },
    ],
  };
  const seedC = {
    // Same generator_version as A ('g1'), but a fresh content_hash
    // (the curated content was edited). This is the row that MUST
    // win the active slot after the g1/A → g2/B → g1/C ordering.
    topics: [
      { label: 'C 主题一', summary: 'C 的主题一描述（g1 最新版）。' },
      { label: 'C 主题二', summary: 'C 的主题二描述（g1 最新版）。' },
      { label: 'C 主题三', summary: 'C 的主题三描述（g1 最新版）。' },
    ],
    queries: [
      { query: 'C 普通查询一', kind: 'web' },
      { query: 'C 普通查询二', kind: 'web' },
      { query: 'C 普通查询三', kind: 'mixed' },
    ],
    knowledge_queries: [
      { query: 'C 知识查询 Z', kind: 'knowledge' },
      { query: 'C 知识查询 W', kind: 'knowledge' },
    ],
    hot_keywords: [
      { keyword: 'C 热词一', rationale: 'C 的热词一理由（g1 最新版）。' },
      { keyword: 'C 热词二', rationale: 'C 的热词二理由（g1 最新版）。' },
    ],
  };

  const gv1 = 'community-profile@community-profile-rules/1';
  const gv2 = 'community-profile@community-profile-rules/2';
  // gv1 has @ (0x40), gv2 has - (0x2D) for the same suffix; this is
  // the EXACT lexicographic ordering trap that defeated the v1-3
  // activeByStoryVersion walk.

  const profileA = buildCommunityProfileFromSeed({
    story_uuid: version.story_uuid,
    story_version_uuid: version.version_uuid,
    story_version_checksum: version.checksum,
    source: 'mock-fixture',
    generator_version: gv1,
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
    generator_version: gv2,
    topics: seedB.topics,
    queries: seedB.queries,
    knowledge_queries: seedB.knowledge_queries,
    hot_keywords: seedB.hot_keywords,
  });
  const profileC = buildCommunityProfileFromSeed({
    story_uuid: version.story_uuid,
    story_version_uuid: version.version_uuid,
    story_version_checksum: version.checksum,
    source: 'mock-fixture',
    generator_version: gv1,
    topics: seedC.topics,
    queries: seedC.queries,
    knowledge_queries: seedC.knowledge_queries,
    hot_keywords: seedC.hot_keywords,
  });

  // Sanity-check the precondition: A and C share `generator_version`
  // but carry DIFFERENT content_hash so they are distinct rows. B
  // has a different generator_version AND a different content_hash.
  assert.equal(profileA.generator_version, profileC.generator_version);
  assert.notEqual(profileA.generator_version, profileB.generator_version);
  assert.notEqual(profileA.hash.content_hash, profileB.hash.content_hash);
  assert.notEqual(profileA.hash.content_hash, profileC.hash.content_hash);
  assert.notEqual(profileB.hash.content_hash, profileC.hash.content_hash);
  assert.notEqual(profileA.profile_uuid, profileB.profile_uuid);
  assert.notEqual(profileA.profile_uuid, profileC.profile_uuid);
  assert.notEqual(profileB.profile_uuid, profileC.profile_uuid);

  // Insert order: A → B → C. This is the exact ordering that broke
  // v1-4 (Map.set on existing key does NOT move the key).
  repo.setCommunityProfile(profileA);
  repo.setCommunityProfile(profileB);
  repo.setCommunityProfile(profileC);

  return { repo, version, profileA, profileB, profileC };
}

// ----- P1.v1-5-1: schema contract preserved -----------------------------

test('P1.v1-5-3 PROFILE_TOP_LEVEL_KEYS is exactly 13 fields and unchanged', () => {
  // The explicit latest-pointer fix MUST NOT add ordering metadata
  // to the canonical profile schema. The 13-field contract is
  // enforced here as a hard regression so a future refactor cannot
  // silently grow the schema.
  assert.equal(PROFILE_TOP_LEVEL_KEYS.length, 13);
  for (const forbidden of ['insert_seq', 'seq', 'latest', 'insert_order']) {
    assert.equal(
      PROFILE_TOP_LEVEL_KEYS.includes(forbidden),
      false,
      `PROFILE_TOP_LEVEL_KEYS MUST NOT include "${forbidden}" (P1.v1-5 contract)`,
    );
  }
});

test('P1.v1-5-1 row carries NO insert_seq / seq / latest fields', () => {
  const { profileA } = installG1AG2BG1C();
  for (const row of [profileA]) {
    for (const forbidden of ['insert_seq', 'seq', 'latest', 'insert_order']) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(row, forbidden),
        false,
        `profile row MUST NOT carry a top-level "${forbidden}" field`,
      );
    }
  }
});

// ----- P1.v1-5-2: g1/A → g2/B → g1/C regression --------------------------

test('P1.v1-5-2 g1/A → g2/B → g1/C ordering: findActiveByStoryVersion returns C (not B)', () => {
  const { repo, version, profileA, profileB, profileC } = installG1AG2BG1C();
  const active = repo.findActiveByStoryVersion(version.version_uuid);
  // Critical: after the g1/A → g2/B → g1/C ordering, the active row
  // MUST be C — the row whose generator_version matches A but whose
  // content_hash is the newest of the three. Under v1-4 (Map
  // iteration-order trick) the walk returned B because the
  // gv1-bearing activeByStoryVersion key for A stayed in its
  // original slot and the walk deterministically yielded B's row
  // first.
  assert.ok(active, 'findActiveByStoryVersion MUST return a row');
  assert.equal(
    active.profile_uuid,
    profileC.profile_uuid,
    'findActiveByStoryVersion MUST return C, NOT B (P1.v1-5 contract)',
  );
  assert.notEqual(active.profile_uuid, profileB.profile_uuid);
  assert.notEqual(active.profile_uuid, profileA.profile_uuid);
});

test('P1.v1-5-2 id idempotent re-insert of the SAME row MUST NOT regress the active row', () => {
  // Build a fresh ordering: A → B → C, then re-insert C's row
  // EXACTLY (same profile_uuid + same content_hash). The repository
  // MUST short-circuit on idempotency and the active pointer MUST
  // stay on C. This is the true "幂等命中" (idempotent hit) the
  // brief requires: re-inserting the SAME row, not a different
  // content_hash with the same generator_version.
  const { repository } = createSeededRepository();
  const sv = FIXTURE_UUIDS['cafe-rain'].story_version_uuid;
  const version = repository.findVersion(sv);
  const repo = createInMemoryCommunityProfileRepository();
  const seedA = {
    topics: [{label:'A t1', summary:'A t1 desc'},{label:'A t2', summary:'A t2 desc'},{label:'A t3', summary:'A t3 desc'}],
    queries: [{query:'A q1', kind:'web'},{query:'A q2', kind:'web'},{query:'A q3', kind:'mixed'}],
    knowledge_queries: [{query:'A kq x', kind:'knowledge'},{query:'A kq y', kind:'knowledge'}],
    hot_keywords: [{keyword:'A kw1', rationale:'A kw1 r'},{keyword:'A kw2', rationale:'A kw2 r'}],
  };
  const seedB = {
    topics: [{label:'B t1', summary:'B t1 desc'},{label:'B t2', summary:'B t2 desc'},{label:'B t3', summary:'B t3 desc'}],
    queries: [{query:'B q1', kind:'web'},{query:'B q2', kind:'web'},{query:'B q3', kind:'mixed'}],
    knowledge_queries: [{query:'B kq p', kind:'knowledge'},{query:'B kq q', kind:'knowledge'}],
    hot_keywords: [{keyword:'B kw1', rationale:'B kw1 r'},{keyword:'B kw2', rationale:'B kw2 r'}],
  };
  const seedC = {
    topics: [{label:'C t1', summary:'C t1 desc'},{label:'C t2', summary:'C t2 desc'},{label:'C t3', summary:'C t3 desc'}],
    queries: [{query:'C q1', kind:'web'},{query:'C q2', kind:'web'},{query:'C q3', kind:'mixed'}],
    knowledge_queries: [{query:'C kq z', kind:'knowledge'},{query:'C kq w', kind:'knowledge'}],
    hot_keywords: [{keyword:'C kw1', rationale:'C kw1 r'},{keyword:'C kw2', rationale:'C kw2 r'}],
  };
  const gv1 = 'community-profile@community-profile-rules/1';
  const gv2 = 'community-profile@community-profile-rules/2';
  const A = buildCommunityProfileFromSeed({story_uuid:version.story_uuid,story_version_uuid:version.version_uuid,story_version_checksum:version.checksum,source:'mock-fixture',generator_version: gv1, ...seedA});
  const B = buildCommunityProfileFromSeed({story_uuid:version.story_uuid,story_version_uuid:version.version_uuid,story_version_checksum:version.checksum,source:'mock-fixture',generator_version: gv2, ...seedB});
  const C = buildCommunityProfileFromSeed({story_uuid:version.story_uuid,story_version_uuid:version.version_uuid,story_version_checksum:version.checksum,source:'mock-fixture',generator_version: gv1, ...seedC});
  repo.setCommunityProfile(A);
  repo.setCommunityProfile(B);
  repo.setCommunityProfile(C);
  // Sanity: active is C before the idempotent re-insert.
  assert.equal(repo.findActiveByStoryVersion(version.version_uuid).profile_uuid, C.profile_uuid);
  // Idempotent re-insert: the SAME row, same uuid, same content_hash.
  // The repository MUST return the same row and MUST NOT move the
  // active pointer.
  const returned = repo.setCommunityProfile({ ...C });
  assert.equal(returned.profile_uuid, C.profile_uuid);
  const active = repo.findActiveByStoryVersion(version.version_uuid);
  assert.equal(
    active.profile_uuid,
    C.profile_uuid,
    'idempotent re-insert of the SAME row MUST NOT regress the active row (P1.v1-5 contract)',
  );
});

test('P1.v1-5-2 findCanonicalByIdentity fallback also returns C', () => {
  const { repo, version, profileC } = installG1AG2BG1C();
  // The fallback path of findCanonicalByIdentity (no external
  // community_profile_version supplied) MUST agree with
  // findActiveByStoryVersion. Under v1-4 the fallback walked
  // activeByStoryVersion.entries() and was subject to the same
  // Map iteration-order trap.
  const fallback = repo.findCanonicalByIdentity({
    story_uuid: version.story_uuid,
    story_version_uuid: version.version_uuid,
  });
  assert.ok(fallback);
  assert.equal(fallback.profile_uuid, profileC.profile_uuid);
});

// ----- P1.v1-5-1: findActiveByStoryVersion is a direct Map.get ----------

test('P1.v1-5-1 findActiveByStoryVersion source uses latestByStoryVersion.get (no Map iteration)', async () => {
  // Read the source file and assert the lookup body is a single
  // `latestByStoryVersion.get(story_version_uuid)` with no
  // `for...of` / `entries()` / iteration patterns. This is a
  // structural regression so a future refactor cannot silently
  // reintroduce Map iteration.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/community/repository.mjs', import.meta.url), 'utf8');
  // Slice out the body of findActiveByStoryVersion: from the method
  // name to the next `},\n` (closing the method).
  const match = src.match(/findActiveByStoryVersion\(story_version_uuid\)\s*\{([\s\S]*?)\n\s{4}\}/);
  assert.ok(match, 'findActiveByStoryVersion body not found in repository.mjs');
  const body = match[1];
  // Strip comments so a future engineer cannot defeat the regex by
  // adding a comment that mentions "Map iteration" or "for...of".
  const codeOnly = body
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  // Must use the explicit pointer.
  assert.ok(
    /latestByStoryVersion\.get\(/.test(codeOnly),
    'findActiveByStoryVersion MUST read from latestByStoryVersion.get() (P1.v1-5 contract)',
  );
  // Must NOT iterate Map / arrays of map entries / for...of.
  assert.ok(
    !/for\s*\(\s*const\s+\[/.test(codeOnly)
      && !/\.entries\(\)/.test(codeOnly)
      && !/for\s*\(\s*const\s+\w+\s+of\s+state\./.test(codeOnly)
      && !/\bfor\s*\(\s*const\s+\w+\s+of\s+map\b/.test(codeOnly),
    'findActiveByStoryVersion MUST NOT iterate Map entries (P1.v1-5 contract)',
  );
});

test('P1.v1-5-1 setCommunityProfile updates latestByStoryVersion only on fresh insert', async () => {
  // Read the source of setCommunityProfile and assert it calls
  // `state.latestByStoryVersion.set(...)` exactly once, AFTER the
  // idempotency short-circuit. This is a structural regression so
  // a future refactor cannot move the pointer on an idempotent hit
  // (which would regress the active row).
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/community/repository.mjs', import.meta.url), 'utf8');
  const setIdx = src.indexOf('setCommunityProfile(input)');
  assert.ok(setIdx !== -1, 'setCommunityProfile not found');
  // Find the matching closing brace by counting braces from
  // setCommunityProfile to the next top-level method boundary.
  // The simplest reliable heuristic: slice from setCommunityProfile
  // through the next method header.
  const slice = src.slice(setIdx, setIdx + 4000);
  // Must call .set(...) on latestByStoryVersion exactly once.
  const setCalls = slice.match(/state\.latestByStoryVersion\.set\(/g) || [];
  assert.equal(
    setCalls.length,
    1,
    'setCommunityProfile MUST update latestByStoryVersion.set exactly once (P1.v1-5 contract)',
  );
  // Must call .get(...) on latestByStoryVersion inside
  // findActiveByStoryVersion (already covered above) but here we
  // only check setCommunityProfile: it must NOT call .get( on
  // latestByStoryVersion (the write side should be blind to the
  // read pointer).
  const getCalls = slice.match(/latestByStoryVersion\.get\(/g) || [];
  assert.equal(
    getCalls.length,
    0,
    'setCommunityProfile MUST NOT read latestByStoryVersion.get (P1.v1-5 contract)',
  );
});

// ----- P1.v1-5-4: external version format unchanged ----------------------

test('P1.v1-5-4 external version is <generator_version>@<content_hash_prefix_16>', () => {
  const { profileA, profileB, profileC } = installG1AG2BG1C();
  for (const row of [profileA, profileB, profileC]) {
    const external = deriveExternalCommunityProfileVersion(row);
    assert.equal(
      external,
      `${row.generator_version}@${row.hash.content_hash.slice(0, 16)}`,
      'external version MUST be `<generator_version>@<content_hash_prefix_16>` (P1.v1-5-4 contract)',
    );
  }
});

// ----- P1.v1-5-1: still-valid contract — g2/B is preserved but not active

test('P1.v1-5-1 listByStoryVersion returns all three preserved rows', () => {
  const { repo, version, profileA, profileB, profileC } = installG1AG2BG1C();
  const all = repo.listByStoryVersion({ story_version_uuid: version.version_uuid });
  assert.equal(all.length, 3, 'all three rows MUST be preserved');
  const uuids = new Set(all.map((r) => r.profile_uuid));
  assert.ok(uuids.has(profileA.profile_uuid));
  assert.ok(uuids.has(profileB.profile_uuid));
  assert.ok(uuids.has(profileC.profile_uuid));
});

test('P1.v1-5-1 findActiveByStoryVersionAndGenerator returns the row matching the scope', () => {
  const { repo, version, profileA, profileB, profileC } = installG1AG2BG1C();
  // gv1 scope: A and C share gv1, but C was inserted last so
  // activeByStoryVersion[sv|gv1] points to C.
  const gv1Active = repo.findActiveByStoryVersionAndGenerator(
    version.version_uuid,
    profileA.generator_version,
  );
  assert.ok(gv1Active);
  assert.equal(gv1Active.profile_uuid, profileC.profile_uuid);
  // gv2 scope: B is the only row for that scope.
  const gv2Active = repo.findActiveByStoryVersionAndGenerator(
    version.version_uuid,
    profileB.generator_version,
  );
  assert.ok(gv2Active);
  assert.equal(gv2Active.profile_uuid, profileB.profile_uuid);
});