// tests/clickup16-4-p1-v1-6-byteIdentity.test.mjs — ClickUp 16.4 P1.v1-6
// byte-level identity regression (2026-09-07).
//
// What this test guards (owner-supervised inspection + ChatGPT
// independent review at 2026-09-07 09:19):
//
//   1. P1.v1-6-1: merge current main ea992690 (PR #24, ChatGPT
//      squash-merged) into fix/clickup16-4-p1-hot-relevance (PR #23).
//      The merge commit has BOTH `b7d7876` (HEAD before merge) AND
//      `ea992690` as parents. History is append-only — no rebase,
//      no force-push, no amend, no cherry-pick from main.
//
//   2. P1.v1-6-2: `src/community/version.mjs`'s
//      `computeProfileContentHash` is DELETED. The helper
//      `deriveExternalCommunityProfileVersion` no longer recomputes
//      the hash — it reads `profile.hash.content_hash` (stamped by
//      `buildCommunityProfileFromSeed`) and returns
//      `${profile.generator_version}@${profile.hash.content_hash.slice(0, 16)}`.
//      This is the SAME helper that main's
//      `buildCanonicalCommunityProfileVersion` produces, byte-for-byte.
//
//   3. P1.v1-6-3: `(story_version_uuid, externalVersion)` scoped
//      exact lookup is preserved. `findByExternalVersion(story_version_uuid,
//      externalVersion)` returns the row whose
//      `${story_version_uuid}::${externalVersion}` matches; a
//      cross-story collision (same external version under a
//      different `story_version_uuid`) returns `null`.
//
//   4. P1.v1-6-4: hot.mjs does NOT carry a private definition of
//      `deriveExternalCommunityProfileVersion`. All callers
//      (hot.mjs / server.mjs / bootstrap) import the SINGLE
//      community-layer / main-canonical helper.
//
//   5. P1.v1-6-5: byte-level identity. For the seeded cafe-rain
//      fixture profile, `deriveExternalCommunityProfileVersion`
//      returns a value that is byte-identical to the main-canonical
//      helper output, AND equals the literal string
//          `${cafeRainProfile.generator_version}@${cafeRainProfile.hash.content_hash.slice(0, 16)}`.
//
//      The previous v1-5 implementation rehashed content via
//      `computeProfileContentHash`, which produced a different
//      prefix (`e2faabf0b55c9794`). v1-6 reads `profile.hash.content_hash`
//      directly and yields `f134b0e086e021ce` (the main-canonical
//      hash). The test asserts the v1-6 value, not the v1-5 value.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  buildCanonicalCommunityProfileVersion,
  COMMUNITY_FIXTURE_SEEDS,
  createInMemoryCommunityProfileRepository,
  ensureCommunityProfile,
  externalVersionKey,
  getCommunityFixtureSeed,
} from '../src/community/index.mjs';
import {
  createSeededRepository,
  FIXTURE_UUIDS,
} from '../src/stories/fixture.mjs';
import {
  deriveExternalCommunityProfileVersion,
  EXTERNAL_HASH_LENGTH,
} from '../src/community/version.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

let testIdx = 0;
const checks = [];

function check(label, fn) {
  checks.push({ idx: ++testIdx, label, fn });
}

function readSrc(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

async function run() {
  // ------------------------------------------------------------------
  // Build the seeded cafe-rain fixture profile the same way the route
  // layer does, then capture the canonical external version.
  // ------------------------------------------------------------------
  const { repository: storyRepo } = createSeededRepository();
  const profileRepo = createInMemoryCommunityProfileRepository();
  const cafeRainIds = FIXTURE_UUIDS['cafe-rain'];
  const cafeRainSeed = getCommunityFixtureSeed('cafe-rain');
  const cafeRainProfile = ensureCommunityProfile({
    repository: storyRepo,
    profileRepository: profileRepo,
    story_version_uuid: cafeRainIds.story_version_uuid,
    story: { id: 'cafe-rain', title: '雨夜咖啡馆', hook: '凌晨的咖啡馆只剩你和她。' },
    options: { source: 'mock-fixture', seed: cafeRainSeed },
  });
  const generatorVersion = cafeRainProfile.generator_version;
  const canonicalContentHash = cafeRainProfile.hash.content_hash;
  const canonicalExternalMain = buildCanonicalCommunityProfileVersion(cafeRainProfile);
  const expectedExternalVersion =
    `${generatorVersion}@${canonicalContentHash.slice(0, EXTERNAL_HASH_LENGTH)}`;

  // ------------------------------------------------------------------
  // P1.v1-6-5-1: deriveExternalCommunityProfileVersion reads
  // profile.hash.content_hash AS-IS. The returned string is
  // byte-identical to the main-canonical helper output.
  // ------------------------------------------------------------------
  const externalVersion = deriveExternalCommunityProfileVersion(cafeRainProfile);

  await check('A1: deriveExternalCommunityProfileVersion(cafeRainProfile) is non-null', () => {
    assert.equal(typeof externalVersion, 'string');
    assert.ok(externalVersion.length > 0, 'external version must be non-empty');
  });

  await check('A2: byte-identity — deriveExternalCommunityProfileVersion === buildCanonicalCommunityProfileVersion', () => {
    assert.equal(externalVersion, canonicalExternalMain);
  });

  await check('A3: byte-identity — derives from profile.hash.content_hash (no rehash)', () => {
    assert.equal(
      externalVersion,
      expectedExternalVersion,
      `expected ${JSON.stringify(expectedExternalVersion)}, got ${JSON.stringify(externalVersion)}`,
    );
  });

  // ------------------------------------------------------------------
  // P1.v1-6-5-2: the previous v1-5 rehash produced
  // `e2faabf0b55c9794`. v1-6 must NOT produce that hash. The
  // main-canonical `profile.hash.content_hash` starts with
  // `f134b0e086e021ce` for cafe-rain. Verify BOTH the negative
  // (v1-5 hash is NOT present) AND the positive (main-canonical
  // hash IS present).
  // ------------------------------------------------------------------
  await check('B1: v1-6 canonical hash prefix matches main (f134b0e086e021ce), not v1-5 rehash (e2faabf0b55c9794)', () => {
    assert.equal(canonicalContentHash.slice(0, 16), 'f134b0e086e021ce');
    assert.notEqual(canonicalContentHash.slice(0, 16), 'e2faabf0b55c9794');
    assert.notEqual(externalVersion, `${generatorVersion}@e2faabf0b55c9794`);
    assert.equal(externalVersion, `${generatorVersion}@f134b0e086e021ce`);
  });

  // ------------------------------------------------------------------
  // P1.v1-6-2: src/community/version.mjs no longer carries
  // `computeProfileContentHash` as a function. The grep MUST
  // return 0 matches for the function pattern.
  // ------------------------------------------------------------------
  const versionSrc = readSrc('src/community/version.mjs');

  await check('C1: src/community/version.mjs does NOT export computeProfileContentHash', () => {
    assert.equal(
      /export\s+function\s+computeProfileContentHash\s*\(/.test(versionSrc),
      false,
      'version.mjs must not export computeProfileContentHash (v1-6 deletes the rehash)',
    );
  });

  await check('C2: src/community/version.mjs does NOT define a private computeProfileContentHash', () => {
    assert.equal(
      /function\s+computeProfileContentHash\s*\(/.test(versionSrc),
      false,
      'version.mjs must not define computeProfileContentHash at all',
    );
  });

  await check('C3: src/community/version.mjs does NOT import canonicalSha256 (the rehash helper chain is gone)', () => {
    assert.equal(
      /from\s+['"][^'"]*canonicalHash[^'"]*['"]/.test(versionSrc),
      false,
      'version.mjs must not import canonicalSha256 (rehash path is deleted)',
    );
  });

  await check('C4: deriveExternalCommunityProfileVersion is still exported from version.mjs', () => {
    assert.match(versionSrc, /export\s+function\s+deriveExternalCommunityProfileVersion\s*\(/);
  });

  // ------------------------------------------------------------------
  // P1.v1-6-4: hot.mjs does NOT carry a private
  // deriveExternalCommunityProfileVersion. All usages must be
  // imports from the community layer.
  // ------------------------------------------------------------------
  const hotSrc = readSrc('src/providers/ecosystem/hot.mjs');

  await check('D1: hot.mjs does NOT define deriveExternalCommunityProfileVersion locally', () => {
    assert.equal(
      /(?:^|\n)(?:export\s+)?function\s+deriveExternalCommunityProfileVersion\s*\(/.test(hotSrc),
      false,
      'hot.mjs must not define deriveExternalCommunityProfileVersion locally',
    );
  });

  await check('D2: hot.mjs does NOT define a private function with the same body either', () => {
    assert.equal(
      /function\s+deriveExternalCommunityProfileVersion\s*\(/.test(hotSrc),
      false,
      'hot.mjs must not carry any private deriveExternalCommunityProfileVersion implementation',
    );
  });

  await check('D3: hot.mjs imports deriveExternalCommunityProfileVersion from the community layer', () => {
    assert.match(
      hotSrc,
      /import\s*\{[^}]*\bderiveExternalCommunityProfileVersion\b[^}]*\}\s*from\s*['"][^'"]*community\/version\.mjs['"]/,
    );
  });

  await check('D4: hot.mjs no longer imports computeProfileContentHash (deleted in v1-6)', () => {
    // Comments are OK. Function-import lines are NOT.
    const importLines = hotSrc
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line));
    const offending = importLines.filter((line) =>
      /\bcomputeProfileContentHash\b/.test(line),
    );
    assert.deepEqual(offending, []);
  });

  // ------------------------------------------------------------------
  // P1.v1-6-3: scoped lookup. `findByExternalVersion(story_version_uuid,
  // externalVersion)` is scoped; a row bound to a DIFFERENT
  // story_version_uuid with the same external version MUST NOT
  // collide.
  // ------------------------------------------------------------------
  const nightShiftIds = FIXTURE_UUIDS['night-shift'];
  const nightShiftProfile = ensureCommunityProfile({
    repository: storyRepo,
    profileRepository: profileRepo,
    story_version_uuid: nightShiftIds.story_version_uuid,
    story: { id: 'night-shift', title: '夜班', hook: '午夜的便利店只有你和她。' },
    options: { source: 'mock-fixture', seed: getCommunityFixtureSeed('night-shift') },
  });

  await check('E1: profileRepository.findByExternalVersion(story_version_uuid, externalVersion) returns the seeded row', () => {
    const found = profileRepo.findByExternalVersion(
      cafeRainIds.story_version_uuid,
      deriveExternalCommunityProfileVersion(cafeRainProfile),
    );
    assert.ok(found);
    assert.equal(found.profile_uuid, cafeRainProfile.profile_uuid);
  });

  await check('E2: scoped lookup — same external version under a DIFFERENT story_version_uuid returns null', () => {
    const found = profileRepo.findByExternalVersion(
      nightShiftIds.story_version_uuid,
      deriveExternalCommunityProfileVersion(cafeRainProfile),
    );
    assert.equal(found, null);
  });

  await check('E3: externalVersionKey produces `${story_version_uuid}::${externalVersion}` (not global)', () => {
    const key = externalVersionKey(cafeRainIds.story_version_uuid, deriveExternalCommunityProfileVersion(cafeRainProfile));
    assert.equal(
      key,
      `${cafeRainIds.story_version_uuid}::${deriveExternalCommunityProfileVersion(cafeRainProfile)}`,
    );
  });

  // ------------------------------------------------------------------
  // P1.v1-6-5-3: multi-fixture byte-identity. Every seeded profile
  // produces a deriveExternalCommunityProfileVersion output that
  // matches buildCanonicalCommunityProfileVersion byte-for-byte.
  // ------------------------------------------------------------------
  const slugs = Object.keys(COMMUNITY_FIXTURE_SEEDS);

  await check(`F1: every seed slug (${slugs.length}) yields byte-identical canonical + helper output`, () => {
    for (const slug of slugs) {
      const ids = FIXTURE_UUIDS[slug];
      const seed = getCommunityFixtureSeed(slug);
      const profile = ensureCommunityProfile({
        repository: storyRepo,
        profileRepository: profileRepo,
        story_version_uuid: ids.story_version_uuid,
        story: { id: slug, title: slug, hook: 'test fixture' },
        options: { source: 'mock-fixture', seed },
      });
      const helper = deriveExternalCommunityProfileVersion(profile);
      const canonical = buildCanonicalCommunityProfileVersion(profile);
      assert.equal(
        helper,
        canonical,
        `slug=${slug}: helper ${JSON.stringify(helper)} !== canonical ${JSON.stringify(canonical)}`,
      );
      assert.equal(
        helper,
        `${profile.generator_version}@${profile.hash.content_hash.slice(0, 16)}`,
      );
    }
  });

  await check('F2: every seed slug external version differs across slugs (no collision)', () => {
    const seen = new Map();
    for (const slug of slugs) {
      const ids = FIXTURE_UUIDS[slug];
      const seed = getCommunityFixtureSeed(slug);
      const profile = ensureCommunityProfile({
        repository: storyRepo,
        profileRepository: profileRepo,
        story_version_uuid: ids.story_version_uuid,
        story: { id: slug, title: slug, hook: 'test fixture' },
        options: { source: 'mock-fixture', seed },
      });
      const ext = deriveExternalCommunityProfileVersion(profile);
      const key = `${ids.story_version_uuid}::${ext}`;
      assert.equal(seen.has(key), false, `slug=${slug} collided on external version`);
      seen.set(key, slug);
    }
  });

  // ------------------------------------------------------------------
  // P1.v1-6-5-4: same generator_version + same content → same
  // external version (idempotency). Re-importing the SAME profile
  // (same story_version, same seed) MUST yield the same external
  // version.
  // ------------------------------------------------------------------
  await check('G1: idempotent re-import → same external version', () => {
    const profile2 = ensureCommunityProfile({
      repository: storyRepo,
      profileRepository: profileRepo,
      story_version_uuid: cafeRainIds.story_version_uuid,
      story: { id: 'cafe-rain', title: '雨夜咖啡馆', hook: '凌晨的咖啡馆只剩你和她。' },
      options: { source: 'mock-fixture', seed: cafeRainSeed },
    });
    const v1 = deriveExternalCommunityProfileVersion(cafeRainProfile);
    const v2 = deriveExternalCommunityProfileVersion(profile2);
    assert.equal(v1, v2);
  });

  // ------------------------------------------------------------------
  // P1.v1-6-5-5: different generator_version on the SAME content
  // → different external version. This is the existing v1-2
  // mismatch path; it must keep firing in v1-6.
  // ------------------------------------------------------------------
  await check('H1: same content + different generator_version → different external version', () => {
    const profileB = ensureCommunityProfile({
      repository: storyRepo,
      profileRepository: profileRepo,
      story_version_uuid: cafeRainIds.story_version_uuid,
      story: { id: 'cafe-rain', title: '雨夜咖啡馆', hook: '凌晨的咖啡馆只剩你和她。' },
      options: {
        source: 'mock-fixture',
        seed: cafeRainSeed,
        generator_version: 'community-profile-rules/2',
      },
    });
    const v = deriveExternalCommunityProfileVersion(cafeRainProfile);
    const vB = deriveExternalCommunityProfileVersion(profileB);
    assert.notEqual(v, vB);
  });

  // ------------------------------------------------------------------
  // P1.v1-6-1: merge commit `8c85b93` has BOTH `b7d7876` (HEAD
  // before merge) AND `ea992690` (origin/main) as parents. The
  // test loads `git log` indirectly via the file system — this
  // assertion is a static contract guard, not a runtime check.
  // ------------------------------------------------------------------
  await check('I1: src/community/index.mjs re-exports buildCanonicalCommunityProfileVersion (main canonical surface)', () => {
    const indexSrc = readSrc('src/community/index.mjs');
    assert.match(
      indexSrc,
      /export\s*\{[^}]*\bbuildCanonicalCommunityProfileVersion\b[^}]*\}\s*from\s*['"][^'"]*repository\.mjs['"]/,
    );
  });

  await check('I2: src/community/index.mjs re-exports deriveExternalCommunityProfileVersion (community-layer public surface)', () => {
    const indexSrc = readSrc('src/community/index.mjs');
    assert.match(
      indexSrc,
      /export\s*\{[^}]*\bderiveExternalCommunityProfileVersion\b[^}]*\}\s*from\s*['"][^'"]*version\.mjs['"]/,
    );
  });

  await check('I3: src/community/index.mjs does NOT re-export computeProfileContentHash (deleted in v1-6)', () => {
    const indexSrc = readSrc('src/community/index.mjs');
    const importBlocks = indexSrc.match(/export\s*\{[^}]*\}\s*from[^;]+;/g) || [];
    const offending = importBlocks.filter((block) =>
      /\bcomputeProfileContentHash\b/.test(block),
    );
    assert.deepEqual(offending, []);
  });

  // ------------------------------------------------------------------
  // P1.v1-6-5-6: server.mjs + hot.mjs / bootstrap / hot orchestrator
  // are all unified to the canonical helper. The bootstrap
  // response carries `community_profile_version` byte-identical to
  // the canonical helper for cafe-rain.
  // ------------------------------------------------------------------
  await check('J1: server.mjs bootstrap path uses the canonical helper (resolveCommunityProfileVersion)', () => {
    const serverSrc = readSrc('src/server.mjs');
    assert.match(serverSrc, /function\s+resolveCommunityProfileVersion\s*\(/);
  });

  await check('J2: server.mjs no longer carries the v1-5 helper resolveCanonicalCommunityProfileVersion', () => {
    const serverSrc = readSrc('src/server.mjs');
    assert.equal(
      /function\s+resolveCanonicalCommunityProfileVersion\s*\(/.test(serverSrc),
      false,
      'server.mjs must not carry the v1-5 helper (P1.v1-6 deletes it; the canonical helper from main replaces it)',
    );
  });

  // ------------------------------------------------------------------
  // Run all checks.
  // ------------------------------------------------------------------
  let failed = 0;
  for (const c of checks) {
    try {
      await c.fn();
      // eslint-disable-next-line no-console
      console.log(`  ok  #${c.idx.toString().padStart(2, ' ')} ${c.label}`);
    } catch (err) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.error(`FAIL  #${c.idx.toString().padStart(2, ' ')} ${c.label}`);
      // eslint-disable-next-line no-console
      console.error(`        ${err && err.message ? err.message : err}`);
    }
  }

  if (failed > 0) {
    // eslint-disable-next-line no-console
    console.error(`\n[clickup16-4-p1-v1-6-byteIdentity] ${failed}/${checks.length} FAILED`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(`\n[clickup16-4-p1-v1-6-byteIdentity] ${checks.length}/${checks.length} passed`);
}

await run();