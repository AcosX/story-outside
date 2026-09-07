// tests/clickup16-5-p1-v1-6-unify.test.mjs
//
// ClickUp 16.5 P1 v1-6 regression — unify
// `deriveExternalCommunityProfileVersion` to a SINGLE source of truth
// (src/community/version.mjs, main's verified soft-null delegate impl)
// and re-establish historical-session pin exact lookup.
//
// ChatGPT review 5130773278 (2026-09-07) flagged that PR #25 landed
// with TWO definitions of `deriveExternalCommunityProfileVersion`
// (throw in profile.mjs, throw in version.mjs — the latter had been
// mutated away from main's verified soft-null delegate) and the route
// layer / bootstrap / hot / knowledge / discussions callers imported
// from the wrong module. v1-6 fixes:
//   * Deletes the duplicate in src/community/profile.mjs so the wire
//     format lives in exactly ONE module.
//   * Restores src/community/version.mjs to origin/main's byte-for-byte
//     soft-null delegate (null on bad input → falls through to
//     buildCanonicalCommunityProfileVersion → defensive bare
//     generator_version fallback → null).
//   * Redirects every caller (knowledge.mjs, storyService.mjs,
//     server.mjs, hot.mjs) to import from src/community/version.mjs.
//
// This file pins down three regression surfaces:
//   P1.v1-6-1 — unique derive authority (source-level grep).
//   P1.v1-6-2 — byte-identical community_profile_version across the
//               four public-surface entry points.
//   P1.v1-6-3 — historical profile exact lookup: an OLD external
//               version still resolves to the OLD row even when a
//               newer row has taken the active slot for the same
//               (story_version_uuid, generator_version) scope.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

import {
  buildCommunityProfileFromSeed,
  createInMemoryCommunityProfileRepository,
  deriveExternalCommunityProfileVersion,
} from '../src/community/index.mjs';
import { deriveExternalCommunityProfileVersion as deriveFromVersion } from '../src/community/version.mjs';
import { createSeededRepository, FIXTURE_UUIDS } from '../src/stories/fixture.mjs';

// ----- helpers ----------------------------------------------------------

/**
 * Build two preserved community profiles A and B for the same
 * `story_version` + same `generator_version` + different content_hash
 * (the canonical historical-pin fixture). Inserts them into a fresh
 * in-memory repo so the test is independent of any seeded fixture
 * state.
 *
 * @returns {{
 *   repo: ReturnType<typeof createInMemoryCommunityProfileRepository>,
 *   story_version_uuid: string,
 *   generator_version: string,
 *   profileA: ReturnType<typeof buildCommunityProfileFromSeed>,
 *   profileB: ReturnType<typeof buildCommunityProfileFromSeed>,
 * }}
 */
function installTwoGenerationsFixture() {
  const { repository } = createSeededRepository();
  const sv = FIXTURE_UUIDS['cafe-rain'].story_version_uuid;
  const version = repository.findVersion(sv);
  const generator_version = 'community-profile@community-profile-rules/1';

  const seedA = {
    topics: [
      { label: 'A 主题一', summary: 'A 的主题一描述。' },
      { label: 'A 主题二', summary: 'A 的主题二描述。' },
      { label: 'A 主题三', summary: 'A 的主题三描述。' },
    ],
    queries: [
      { query: 'A 查询一', kind: 'web' },
      { query: 'A 查询二', kind: 'mixed' },
      { query: 'A 查询三', kind: 'web' },
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
      { query: 'B 查询一', kind: 'web' },
      { query: 'B 查询二', kind: 'mixed' },
      { query: 'B 查询三', kind: 'web' },
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
  // Precondition: same generator_version + different content_hash so
  // the two profiles carry different external versions.
  assert.equal(profileA.generator_version, profileB.generator_version);
  assert.notEqual(profileA.hash.content_hash, profileB.hash.content_hash);

  const repo = createInMemoryCommunityProfileRepository();
  // OLD first (A), then NEW (B). B becomes the active row, but A is
  // preserved in state.profiles — that is the historical-pin fixture.
  repo.setCommunityProfile(profileA);
  repo.setCommunityProfile(profileB);

  return {
    repo,
    story_version_uuid: version.version_uuid,
    generator_version,
    profileA,
    profileB,
  };
}

// ----- 1. unique derive authority (source-level) ------------------------

test('deriveExternalCommunityProfileVersion: single source of truth (only version.mjs exports it)', () => {
  // ChatGPT review 5130773278: PR #25 had two definitions
  // (profile.mjs + version.mjs). v1-6 deletes the profile.mjs
  // duplicate so the wire format lives in exactly ONE module.
  const out = execFileSync('grep', [
    '-rn',
    '--include=*.mjs',
    'export function deriveExternalCommunityProfileVersion',
    'src/',
  ]).toString().trim().split('\n').filter(Boolean);
  assert.equal(
    out.length,
    1,
    `expected 1 export, got ${out.length}: ${out.join(', ')}`,
  );
  assert.match(out[0], /src\/community\/version\.mjs/);
});

// ----- 2. byte-identical community_profile_version across 4 callers ----

test('deriveExternalCommunityProfileVersion: byte-identical across bootstrap / hot / knowledge / discussions callers', async () => {
  // ChatGPT review 5130773278: the four public-surface entry points
  // must produce IDENTICAL `community_profile_version` strings from
  // the SAME canonical profile row. If any path re-derives locally
  // (e.g. a different hash slice length or delimiter), the bytes
  // diverge and the wire contract breaks.
  const { profileA } = installTwoGenerationsFixture();

  // The wire format is `<generator_version>@<content_hash_prefix>`
  // where the prefix is the first 16 hex chars of the canonical
  // `hash.content_hash`. Assert against the explicit format string
  // so a future format bump that lands in version.mjs without
  // updating this test fails loudly.
  const expected = `${profileA.generator_version}@${profileA.hash.content_hash.slice(0, 16)}`;
  assert.equal(deriveExternalCommunityProfileVersion(profileA), expected);
  assert.equal(deriveFromVersion(profileA), expected);

  // The four public-surface entry points are:
  //   * bootstrap: server.mjs (storyService.mjs dynamic import)
  //   * hot:       src/providers/ecosystem/hot.mjs
  //   * knowledge: src/providers/ecosystem/knowledge.mjs
  //   * discussions: server.mjs (/v1/ecosystem/discussions route)
  //
  // After v1-6 they all import the SAME function reference from
  // src/community/version.mjs. Verify by identity check via the
  // community-layer barrel (src/community/index.mjs), which
  // re-exports from version.mjs.
  const versionModule = await import('../src/community/version.mjs');
  const indexModule = await import('../src/community/index.mjs');
  assert.strictEqual(
    indexModule.deriveExternalCommunityProfileVersion,
    versionModule.deriveExternalCommunityProfileVersion,
    'index.mjs must re-export the SAME function reference from version.mjs',
  );

  // soft-null delegate semantics (main's verified contract):
  //   * null profile / non-object → null
  //   * empty object → null
  //   * partial row (only generator_version) → bare generator_version
  //     (defensive fallback so the route layer can still emit SOMETHING)
  //   * partial row with empty hash → bare generator_version
  assert.equal(deriveFromVersion(null), null);
  assert.equal(deriveFromVersion(undefined), null);
  assert.equal(deriveFromVersion({}), null);
  assert.equal(
    deriveFromVersion({ generator_version: 'partial@1.0.0' }),
    'partial@1.0.0',
  );
  assert.equal(
    deriveFromVersion({ generator_version: 'partial@1.0.0', hash: {} }),
    'partial@1.0.0',
  );
});

// ----- 3. historical profile exact lookup -------------------------------

test('repository.findByExternalVersion(story_version_uuid, external): historical session pin resolves OLD row even when newer row is active', () => {
  // ChatGPT review 5130773278: the route + bootstrap + hot + knowledge
  // surfaces call `findByExternalVersion` to resolve the row whose
  // external version EXACTLY matches the supplied string, even when
  // a newer row has taken the active slot for the same
  // (story_version_uuid, generator_version) scope. v1-6 keeps the
  // historical regression guarantee: an OLD session that pinned the
  // OLD external version MUST resolve to the OLD row (NOT the active
  // NEW row, NOT null).
  const { repo, story_version_uuid, profileA, profileB } = installTwoGenerationsFixture();
  const externalA = deriveExternalCommunityProfileVersion(profileA);
  const externalB = deriveExternalCommunityProfileVersion(profileB);
  // Sanity: A and B have DIFFERENT external versions (different
  // content_hash) — otherwise the test cannot demonstrate the
  // historical pin.
  assert.notEqual(externalA, externalB);

  // New session pinned to B's external version → B (the active row).
  assert.strictEqual(
    repo.findByExternalVersion(story_version_uuid, externalB),
    profileB,
  );

  // OLD session pinned to A's external version → A (the preserved row,
  // NOT B, NOT null). This is the historical regression fix that
  // ChatGPT review 5130773278 demanded.
  assert.strictEqual(
    repo.findByExternalVersion(story_version_uuid, externalA),
    profileA,
  );

  // Bogus external version → null (no silent fallback to active row).
  assert.strictEqual(
    repo.findByExternalVersion(
      story_version_uuid,
      '999.0.0@deadbeefcafebabe',
    ),
    null,
  );

  // Bogus story_version_uuid → null (the index is scoped).
  assert.strictEqual(
    repo.findByExternalVersion(
      '00000000-0000-0000-0000-000000000000',
      externalA,
    ),
    null,
  );
});
