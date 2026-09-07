// tests/clickup16-4-p1fix-v1-5.test.mjs — ClickUp 16.4 P1.v1-5 fix
// regression suite (2026-09-07).
//
// What this test guards (continues PR #23 on
// fix/clickup16-4-p1-hot-relevance branch; appends on top of v1-4
// commit f1a19c3):
//
//   1. P1.v1-5-1: `computeProfileContentHash` INCLUDES
//      `story_uuid` + `story_version_uuid` (and `generator_version`,
//      and `themes`). Two profiles with IDENTICAL community content
//      but bound to DIFFERENT `story_version_uuid` MUST produce
//      DIFFERENT content hashes, hence DIFFERENT external versions.
//
//   2. P1.v1-5-1: `communityProfileRepo.byExternalVersion` is no
//      longer a GLOBAL `Map<externalVersion, profile_uuid>`. The
//      index key is now
//          `${story_version_uuid}::${externalVersion}`
//      so two profiles with the same external version but different
//      `story_version_uuid` cannot collide on the index. The lookup
//      function signature changed from
//          findByExternalVersion(externalVersion)
//      to
//          findByExternalVersion(story_version_uuid, externalVersion)
//      so the caller MUST scope the lookup.
//
//   3. P1.v1-5-1: `attachRelevance` now passes the caller's
//      `story_version_uuid` to `findByExternalVersion`. The v1-4
//      swapped-uuid defense (check `profileStoryVersionUuid` against
//      the caller) is still present as defence-in-depth, but the
//      PRIMARY miss path now also catches swapped-uuid callers
//      because the scoped lookup never matches.
//
//   4. P1.v1-5-2: regression — two profiles with different
//      `story_version_uuid` but IDENTICAL community content produce
//      DIFFERENT external versions, the repo index holds BOTH rows
//      without overwriting, and a (story_version_uuid, externalVersion)
//      lookup resolves to the correct row for each. This is the
//      regression v1-4's content-only hash allowed: two stories with
//      the same topics/queries/knowledge_queries/hot_keywords
//      produced the same external version, and the global Map
//      collapsed the second insert onto the first.
//
//   5. P1.v1-5-3: the canonical helper remains the SINGLE place
//      that knows the wire format. `hot.mjs` imports the helper but
//      carries no local reimplementation. The v1-4 contract (16-hex
//      hash suffix, `@` separator, scoped to `community-layer`)
//      still holds.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  attachRelevance,
  createEcosystemHotOrchestrator,
  resolveCanonicalExternalVersion,
  resolveProfileMatchTerms,
} from '../src/providers/ecosystem/hot.mjs';
import {
  computeProfileContentHash,
  deriveExternalCommunityProfileVersion,
  EXTERNAL_HASH_LENGTH,
} from '../src/community/version.mjs';
import {
  createInMemoryCommunityProfileRepository,
  externalVersionKey,
} from '../src/community/index.mjs';
import {
  ensureCommunityProfile,
  getCommunityFixtureSeed,
} from '../src/community/index.mjs';
import {
  createSeededRepository,
  FIXTURE_UUIDS,
} from '../src/stories/fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

let failures = 0;
async function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      await r;
    }
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    const msg = err && err.message ? err.message : err;
    const stack = err && err.stack ? err.stack : '';
    console.log(`    ${msg}`);
    if (stack) console.log(`    ${stack.split('\n').slice(0, 4).join('\n    ')}`);
  }
}

async function runAllChecks() {
  try {
    console.log('ClickUp 16.4 P1.v1-5 fix — story-scoped content hash + scoped external-version Map');

    // ----- A. Module placement (P1.v1-5-3) -----------------------------------
    await check('A: src/community/version.mjs exists (P1.v1-5-3 community-layer helper)', () => {
      const src = readFileSync(resolve(ROOT, 'src/community/version.mjs'), 'utf-8');
      assert.match(src, /export function deriveExternalCommunityProfileVersion/);
      assert.match(src, /export function computeProfileContentHash/);
      assert.match(src, /export const EXTERNAL_HASH_LENGTH/);
    });
    await check('A: src/community/version.mjs is the ONLY place that knows the @ wire format', () => {
      const verSrc = readFileSync(resolve(ROOT, 'src/community/version.mjs'), 'utf-8');
      assert.match(verSrc, /\$\{generatorVersion\}@\$\{shortHash\}/);
      const hotSrc = readFileSync(resolve(ROOT, 'src/providers/ecosystem/hot.mjs'), 'utf-8');
      assert.ok(
        !/\$\{generatorVersion\}@\$\{shortHash\}/.test(hotSrc),
        'hot.mjs MUST NOT carry a local copy of the wire-format template',
      );
    });
    await check('A: hot.mjs does NOT define deriveExternalCommunityProfileVersion locally', () => {
      const hotSrc = readFileSync(resolve(ROOT, 'src/providers/ecosystem/hot.mjs'), 'utf-8');
      assert.ok(
        !/(?:^|\n)(?:export\s+)?function\s+deriveExternalCommunityProfileVersion\s*\(/.test(hotSrc),
        'hot.mjs MUST NOT define deriveExternalCommunityProfileVersion locally',
      );
    });
    await check('A: hot.mjs does NOT define computeProfileContentHash locally', () => {
      const hotSrc = readFileSync(resolve(ROOT, 'src/providers/ecosystem/hot.mjs'), 'utf-8');
      assert.ok(
        !/(?:^|\n)(?:export\s+)?function\s+computeProfileContentHash\s*\(/.test(hotSrc),
        'hot.mjs MUST NOT define computeProfileContentHash locally',
      );
    });

    // ----- B. Content hash is story-scoped (P1.v1-5-1) -----------------------
    // Two profiles with identical community content but different
    // story_uuid + story_version_uuid MUST produce DIFFERENT content
    // hashes (and therefore DIFFERENT external versions).
    const { repository: storyRepo } = createSeededRepository();
    const profileRepo = createInMemoryCommunityProfileRepository();

    // Profile A — cafe-rain (existing fixture).
    const cafeRainIds = FIXTURE_UUIDS['cafe-rain'];
    const profileA = ensureCommunityProfile({
      repository: storyRepo,
      profileRepository: profileRepo,
      story_version_uuid: cafeRainIds.story_version_uuid,
      story: { id: 'cafe-rain', title: '雨夜咖啡馆', hook: '凌晨的咖啡馆只剩你和她。' },
      options: {
        source: 'mock-fixture',
        seed: getCommunityFixtureSeed('cafe-rain'),
      },
    });
    await check('B: computeProfileContentHash input INCLUDES story_uuid + story_version_uuid', () => {
      const src = readFileSync(resolve(ROOT, 'src/community/version.mjs'), 'utf-8');
      // The hash function must reference story_uuid AND story_version_uuid.
      assert.match(
        src,
        /story_uuid:\s*typeof profile\.story_uuid === 'string'/,
        'computeProfileContentHash must read profile.story_uuid',
      );
      assert.match(
        src,
        /story_version_uuid:\s*typeof profile\.story_version_uuid === 'string'/,
        'computeProfileContentHash must read profile.story_version_uuid',
      );
      // And it must NOT exclude them by name in the comment.
      const hashBlock = src.slice(src.indexOf('export function computeProfileContentHash'));
      const hashBlockEnd = hashBlock.indexOf('export function deriveExternalCommunityProfileVersion');
      const block = hashBlock.slice(0, hashBlockEnd);
      assert.ok(
        !/EXCLUDES[^]*story_uuid[^]*story_version_uuid/m.test(block),
        'computeProfileContentHash docstring must not list story_uuid/story_version_uuid in the EXCLUDES set',
      );
    });
    await check('B: deriveExternalCommunityProfileVersion returns 16-hex suffix wire format', () => {
      const ev = deriveExternalCommunityProfileVersion(profileA);
      assert.equal(typeof ev, 'string');
      assert.match(
        ev,
        /^(?:community-profile-rules\/1|community-profile@community-profile-rules\/1)@[0-9a-f]{16}$/,
      );
      const hashSuffix = ev.split('@').pop();
      assert.equal(hashSuffix.length, 16);
      assert.match(hashSuffix, /^[0-9a-f]{16}$/);
      assert.equal(EXTERNAL_HASH_LENGTH, 16);
    });

    // ----- C. externalVersionKey (P1.v1-5-1) ---------------------------------
    await check('C: externalVersionKey joins story_version_uuid and externalVersion with "::"', () => {
      const k = externalVersionKey('sv-1', 'gv1@0123456789abcdef');
      assert.equal(k, 'sv-1::gv1@0123456789abcdef');
    });
    await check('C: externalVersionKey keeps two different story_version_uuid keys distinct for the same externalVersion', () => {
      const k1 = externalVersionKey('sv-1', 'gv1@0123456789abcdef');
      const k2 = externalVersionKey('sv-2', 'gv1@0123456789abcdef');
      assert.notEqual(k1, k2, 'two different story_version_uuid keys MUST differ for the same externalVersion');
    });

    // ----- D. Same community content + different story_version = distinct cpv (P1.v1-5-2) ---
    // Fixture A: cafe-rain story_version_uuid. community content = default seed.
    // Fixture B: a SYNTHETIC story_version_uuid with community content
    // crafted to be byte-identical to fixture A's community content.
    // Because P1.v1-5 includes story_uuid + story_version_uuid in the
    // hash, the external versions MUST differ.

    // Clone A's community content into a brand-new profile bound to
    // a different story_version_uuid. We do this by copying
    // top-level content fields and re-deriving the hash.
    const profileBInput = JSON.parse(JSON.stringify(profileA));
    // Re-key the identity triple to a synthetic story_version_uuid.
    // (The shape validator allows story_uuid + story_version_uuid as
    // long as they are valid UUIDs.)
    profileBInput.story_uuid = '99999999-9999-4999-8999-999999999999';
    profileBInput.story_version_uuid = '88888888-8888-4888-8888-888888888888';
    profileBInput.profile_uuid = '77777777-7777-4777-8777-777777777777';
    profileBInput.hash = { content_hash: '' }; // shape validator will reset
    profileBInput.story_version_checksum = 'synthetic-checksum-B';

    const profileRepoTwo = createInMemoryCommunityProfileRepository();
    // Insert A.
    ensureCommunityProfile({
      repository: storyRepo,
      profileRepository: profileRepoTwo,
      story_version_uuid: cafeRainIds.story_version_uuid,
      story: { id: 'cafe-rain', title: '雨夜咖啡馆', hook: '凌晨的咖啡馆只剩你和她。' },
      options: {
        source: 'mock-fixture',
        seed: getCommunityFixtureSeed('cafe-rain'),
      },
    });
    // Insert B directly via setCommunityProfile (synthetic UUIDs).
    const profileRepoTwo2 = profileRepoTwo;
    const { setCommunityProfile } = await import('../src/community/service.mjs');
    // Synthetic B profile — community content is byte-identical to
    // A's content (topics, queries, knowledge_queries, hot_keywords
    // all the same); only story_uuid + story_version_uuid differ.
    const profileB = setCommunityProfile({
      profileRepository: profileRepoTwo2,
      profile: {
        ...profileBInput,
        // generator_version MUST match for a fair cross-story test
        // (otherwise the ruleset bump path would also diverge the cpv).
        generator_version: profileA.generator_version,
        // Reuse the same community content.
        topics: JSON.parse(JSON.stringify(profileA.topics)),
        queries: JSON.parse(JSON.stringify(profileA.queries)),
        knowledge_queries: JSON.parse(JSON.stringify(profileA.knowledge_queries)),
        hot_keywords: JSON.parse(JSON.stringify(profileA.hot_keywords)),
        generated_at: profileA.generated_at,
        source: profileA.source,
        locale: profileA.locale,
      },
    });

    const cpvA = deriveExternalCommunityProfileVersion(
      profileRepoTwo2.findActiveByStoryVersion(cafeRainIds.story_version_uuid),
    );
    const cpvB = deriveExternalCommunityProfileVersion(profileB);

    await check('D: two profiles with same community content but different story_version_uuid produce DIFFERENT external versions', () => {
      assert.notEqual(cpvA, cpvB, `cpv collision: cpvA=${cpvA} cpvB=${cpvB}`);
    });
    await check('D: hash difference traces to story_uuid + story_version_uuid, not to the community content', () => {
      // The hash SUFFIX differs; the ruleset prefix (the part before @) is identical
      // (same generator_version).
      const prefixA = cpvA.split('@').slice(0, -1).join('@');
      const prefixB = cpvB.split('@').slice(0, -1).join('@');
      assert.equal(prefixA, prefixB, 'ruleset prefix MUST be identical (same generator_version)');
      const hashA = cpvA.split('@').pop();
      const hashB = cpvB.split('@').pop();
      assert.notEqual(hashA, hashB, 'hash suffix MUST differ across story_versions');
    });

    // ----- E. Map scope (P1.v1-5-1) ------------------------------------------
    await check('E: findByExternalVersion signature now takes (story_version_uuid, externalVersion)', () => {
      const hotSrc = readFileSync(resolve(ROOT, 'src/providers/ecosystem/hot.mjs'), 'utf-8');
      assert.match(
        hotSrc,
        /profileRepository\.findByExternalVersion\(\s*story_version_uuid\s*,\s*community_profile_version\s*,?\s*\)/,
        'hot.mjs MUST pass story_version_uuid to findByExternalVersion',
      );
    });
    await check('E: byExternalVersion is keyed by ${story_version_uuid}::${externalVersion}', () => {
      const repoSrc = readFileSync(resolve(ROOT, 'src/community/repository.mjs'), 'utf-8');
      assert.match(
        repoSrc,
        /\$\{story_version_uuid\}::\$\{externalVersion\}/,
        'repository.mjs MUST use ${story_version_uuid}::${externalVersion} as the scoped key',
      );
      // Confirm the index is NOT a bare externalVersion map.
      const scopedBlock = repoSrc.slice(repoSrc.indexOf('byExternalVersion'));
      assert.ok(
        !scopedBlock.match(/byExternalVersion\.set\(\s*externalVersion\s*,/),
        'byExternalVersion.set must NOT take a bare externalVersion — it MUST be scoped via externalVersionKey',
      );
    });
    await check('E: findByExternalVersion returns A when called with A\'s story_version_uuid + A\'s cpv', () => {
      const found = profileRepoTwo2.findByExternalVersion(cafeRainIds.story_version_uuid, cpvA);
      assert.ok(found, 'A lookup must hit A row');
      assert.equal(found.story_version_uuid, cafeRainIds.story_version_uuid);
    });
    await check('E: findByExternalVersion returns B when called with B\'s story_version_uuid + B\'s cpv', () => {
      const found = profileRepoTwo2.findByExternalVersion(
        '88888888-8888-4888-8888-888888888888',
        cpvB,
      );
      assert.ok(found, 'B lookup must hit B row');
      assert.equal(found.story_version_uuid, '88888888-8888-4888-8888-888888888888');
    });
    await check('E: findByExternalVersion does NOT cross-collide: A.story_version + B.cpv → null', () => {
      const found = profileRepoTwo2.findByExternalVersion(
        cafeRainIds.story_version_uuid,
        cpvB,
      );
      assert.equal(found, null, 'A.story_version + B.cpv MUST miss — B is bound to a different story_version');
    });
    await check('E: findByExternalVersion does NOT cross-collide: B.story_version + A.cpv → null', () => {
      const found = profileRepoTwo2.findByExternalVersion(
        '88888888-8888-4888-8888-888888888888',
        cpvA,
      );
      assert.equal(found, null, 'B.story_version + A.cpv MUST miss — A is bound to a different story_version');
    });
    await check('E: findByExternalVersion does NOT require a global key (old v1-4 API returns null)', () => {
      // v1-4 callers passing only the externalVersion must NOT hit
      // any row. The new signature requires story_version_uuid as
      // the first argument; passing only the externalVersion is a
      // type-confusion and the repo returns null.
      const found = profileRepoTwo2.findByExternalVersion(undefined, cpvA);
      assert.equal(found, null);
      const found2 = profileRepoTwo2.findByExternalVersion('', cpvA);
      assert.equal(found2, null);
      const found3 = profileRepoTwo2.findByExternalVersion(null, cpvA);
      assert.equal(found3, null);
    });

    // ----- F. Two different story fixture regression (P1.v1-5-2) -------------
    // The literal fixture the task spec asks for: two different
    // story_version_uuid but the SAME community content. We use the
    // bundled cafe-rain and night-shift stories; they have
    // DIFFERENT default seeds (so this checks the trivial
    // non-collision path). Then we craft a synthetic third row
    // with cafe-rain's seed for night-shift's story_version_uuid
    // and prove that even when content is identical, the cpv
    // differs and the Map scope holds.
    const profileRepoCross = createInMemoryCommunityProfileRepository();
    const profileNightShift = ensureCommunityProfile({
      repository: storyRepo,
      profileRepository: profileRepoCross,
      story_version_uuid: FIXTURE_UUIDS['night-shift'].story_version_uuid,
      story: { id: 'night-shift', title: '夜班便利店', hook: '凌晨三点的便利店只有你和一个陌生顾客。' },
      options: {
        source: 'mock-fixture',
        seed: getCommunityFixtureSeed('night-shift'),
      },
    });
    const profileCafeRain = ensureCommunityProfile({
      repository: storyRepo,
      profileRepository: profileRepoCross,
      story_version_uuid: FIXTURE_UUIDS['cafe-rain'].story_version_uuid,
      story: { id: 'cafe-rain', title: '雨夜咖啡馆', hook: '凌晨的咖啡馆只剩你和她。' },
      options: {
        source: 'mock-fixture',
        seed: getCommunityFixtureSeed('cafe-rain'),
      },
    });
    const cpvCafeRain = deriveExternalCommunityProfileVersion(profileCafeRain);
    const cpvNightShift = deriveExternalCommunityProfileVersion(profileNightShift);

    await check('F: distinct default seeds across stories produce distinct external versions', () => {
      assert.notEqual(cpvCafeRain, cpvNightShift);
    });
    await check('F: repo holds BOTH rows without overwriting (later insert does not clobber earlier one)', () => {
      const lookupA = profileRepoCross.findByExternalVersion(
        FIXTURE_UUIDS['cafe-rain'].story_version_uuid,
        cpvCafeRain,
      );
      const lookupB = profileRepoCross.findByExternalVersion(
        FIXTURE_UUIDS['night-shift'].story_version_uuid,
        cpvNightShift,
      );
      assert.ok(lookupA);
      assert.ok(lookupB);
      assert.equal(lookupA.profile_uuid, profileCafeRain.profile_uuid);
      assert.equal(lookupB.profile_uuid, profileNightShift.profile_uuid);
    });

    // ----- G. attachRelevance + cross-story safety (P1.v1-5-1) --------------
    const orchestrator = createEcosystemHotOrchestrator();
    const baseResp = await orchestrator.fetchHot({ category: 'total' });

    await check('G: attachRelevance with night-shift external version + cafe-rain story_version → mismatch', () => {
      const r = attachRelevance(
        JSON.parse(JSON.stringify(baseResp)),
        {
          story_uuid: FIXTURE_UUIDS['cafe-rain'].story_uuid,
          story_version_uuid: FIXTURE_UUIDS['cafe-rain'].story_version_uuid,
          // Valid night-shift cpv, but caller's story_version is cafe-rain.
          community_profile_version: cpvNightShift,
        },
        { profileRepository: profileRepoCross },
      );
      assert.equal(r.attached, false);
      // The scoped lookup MUST miss, and since cafe-rain has a
      // canonical row in this repo, the SECONDARY read surfaces
      // mismatch.
      assert.equal(r.reason, 'mismatch');
      assert.equal(r.actual_version, cpvNightShift);
      assert.equal(r.expected_version, cpvCafeRain);
    });
    await check('G: attachRelevance with cafe-rain external version + night-shift story_version → mismatch', () => {
      const r = attachRelevance(
        JSON.parse(JSON.stringify(baseResp)),
        {
          story_uuid: FIXTURE_UUIDS['night-shift'].story_uuid,
          story_version_uuid: FIXTURE_UUIDS['night-shift'].story_version_uuid,
          community_profile_version: cpvCafeRain,
        },
        { profileRepository: profileRepoCross },
      );
      assert.equal(r.attached, false);
      assert.equal(r.reason, 'mismatch');
      assert.equal(r.actual_version, cpvCafeRain);
      assert.equal(r.expected_version, cpvNightShift);
    });
    await check('G: attachRelevance with correct triple → attached=true (cafe-rain path)', () => {
      const r = attachRelevance(
        JSON.parse(JSON.stringify(baseResp)),
        {
          story_uuid: FIXTURE_UUIDS['cafe-rain'].story_uuid,
          story_version_uuid: FIXTURE_UUIDS['cafe-rain'].story_version_uuid,
          community_profile_version: cpvCafeRain,
        },
        { profileRepository: profileRepoCross },
      );
      assert.equal(r.attached, true);
    });
    await check('G: attachRelevance with correct triple → attached=true (night-shift path)', () => {
      const r = attachRelevance(
        JSON.parse(JSON.stringify(baseResp)),
        {
          story_uuid: FIXTURE_UUIDS['night-shift'].story_uuid,
          story_version_uuid: FIXTURE_UUIDS['night-shift'].story_version_uuid,
          community_profile_version: cpvNightShift,
        },
        { profileRepository: profileRepoCross },
      );
      assert.equal(r.attached, true);
    });

    // ----- H. resolveProfileMatchTerms + content_hash echoes (P1.v1-5-1) -----
    await check('H: resolveProfileMatchTerms returns the scoped row when called with matching story_version_uuid', () => {
      const r = resolveProfileMatchTerms({
        profileRepository: profileRepoCross,
        story_version_uuid: FIXTURE_UUIDS['cafe-rain'].story_version_uuid,
        community_profile_version: cpvCafeRain,
      });
      assert.equal(r.profileUuid, profileCafeRain.profile_uuid);
      assert.equal(r.profileStoryVersionUuid, FIXTURE_UUIDS['cafe-rain'].story_version_uuid);
    });
    await check('H: resolveProfileMatchTerms returns null profile when called with mismatched story_version_uuid', () => {
      const r = resolveProfileMatchTerms({
        profileRepository: profileRepoCross,
        story_version_uuid: FIXTURE_UUIDS['night-shift'].story_version_uuid,
        community_profile_version: cpvCafeRain,
      });
      assert.equal(r.profileUuid, null);
    });

    // ----- I. resolveCanonicalExternalVersion stays scoped (P1.v1-5-1) ------
    await check('I: resolveCanonicalExternalVersion returns the correct external version per story_version_uuid', () => {
      const a = resolveCanonicalExternalVersion({
        profileRepository: profileRepoCross,
        story_version_uuid: FIXTURE_UUIDS['cafe-rain'].story_version_uuid,
      });
      const b = resolveCanonicalExternalVersion({
        profileRepository: profileRepoCross,
        story_version_uuid: FIXTURE_UUIDS['night-shift'].story_version_uuid,
      });
      assert.equal(a, cpvCafeRain);
      assert.equal(b, cpvNightShift);
      assert.notEqual(a, b);
    });

    // ----- J. Idempotent content_hash (P1.v1-5-1) ----------------------------
    await check('J: computeProfileContentHash is idempotent for the same profile', () => {
      const h1 = computeProfileContentHash(profileA);
      const h2 = computeProfileContentHash(profileA);
      assert.equal(h1, h2);
    });
    await check('J: computeProfileContentHash is content-and-story-scoped (same content, different story_version → different hash)', () => {
      // Two profiles that share topics/queries/knowledge_queries/hot_keywords
      // but differ in story_uuid + story_version_uuid MUST hash differently.
      const cloned = JSON.parse(JSON.stringify(profileA));
      cloned.story_uuid = '00000000-0000-4000-8000-000000000aaa';
      cloned.story_version_uuid = '00000000-0000-4000-8000-000000000bbb';
      const hA = computeProfileContentHash(profileA);
      const hCloned = computeProfileContentHash(cloned);
      assert.notEqual(hA, hCloned, 'hash must differ when story_uuid + story_version_uuid differ');
    });
    await check('J: computeProfileContentHash is generator_version-aware (same story + content, different generator_version → different hash)', () => {
      const cloned = JSON.parse(JSON.stringify(profileA));
      cloned.generator_version = 'community-profile@community-profile-rules/2';
      const hA = computeProfileContentHash(profileA);
      const hCloned = computeProfileContentHash(cloned);
      assert.notEqual(hA, hCloned, 'hash must differ when generator_version differs');
    });

    // ----- K. v1 schema invariants (P1.v1-5-3) --------------------------------
    await check('K: v1 schema — src/community/profile.mjs keeps generator_version (13+ hits)', () => {
      const src = readFileSync(resolve(ROOT, 'src/community/profile.mjs'), 'utf-8');
      const hits = (src.match(/generator_version/g) || []).length;
      assert.ok(hits >= 13, `expected >=13 generator_version hits, got ${hits}`);
    });

    console.log('');
    if (failures === 0) {
      console.log('All ClickUp 16.4 P1.v1-5 fix checks passed.');
    } else {
      console.log(`FAILED: ${failures} check(s)`);
      process.exit(1);
    }
  } catch (err) {
    console.error('FATAL:', err && err.stack ? err.stack : err);
    process.exit(2);
  }
}

await runAllChecks();