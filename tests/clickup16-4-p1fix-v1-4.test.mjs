// tests/clickup16-4-p1fix-v1-4.test.mjs — ClickUp 16.4 P1.v1-4 fix
// regression suite (2026-09-07).
//
// What this test guards (continues PR #23 on
// fix/clickup16-4-p1-hot-relevance branch; appends on top of v1-3
// commit 4b4fd72):
//
//   1. P1.v1-4-1: the EXTERNAL `community_profile_version` derivation
//      lives in EXACTLY ONE place: `src/community/version.mjs`. The
//      wire format is `${generator_version}@${content_hash.slice(0,16)}`.
//      `hot.mjs` imports the helper but holds NO private copy. The
//      `@` separator replaces the v1-3-era `-`; the hash suffix is
//      16 hex chars (~64 bits of entropy) instead of 12.
//
//   2. P1.v1-4-2: `communityProfileRepo.findByExternalVersion(externalVersion)`
//      is the PRIMARY read path used by `attachRelevance`. The
//      lookup is GLOBAL (not story_version-scoped) so it works
//      against the wire identity string directly. The `active`
//      concept is NEVER consulted by the primary read.
//
//   3. P1.v1-4-3: when `findByExternalVersion` returns null AND no
//      canonical row exists for the caller's `story_version_uuid`,
//      `attachRelevance` returns `{ attached: false,
//      reason: 'community_profile_not_found' }` and the route layer
//      returns 400 `community_profile_not_found`. The data-contract
//      mismatch is observable; the matcher does NOT silently
//      degrade to "0 terms".
//
//   4. P1.v1-4-4: a swapped-uuid caller (carrying a valid external
//      version that points to a row bound to a DIFFERENT
//      `story_version_uuid`) is rejected as `mismatch` with the
//      canonical external version for the caller's story_version as
//      `expected_version` so the caller can re-pin.
//
//   5. P1.v1-4-5: same `story_version`, multiple generations — the
//      PRIMARY `findByExternalVersion` lookup correctly resolves
//      each generation's row from its own external version, even
//      when only one of them is "active". This is the regression
//      that the v1-3 active-row bug missed: v1-3 read the active
//      slot first and only then compared external versions, which
//      silently mis-identified the previous-generation row as the
//      caller-supplied row whenever the active slot moved.
//
//   6. P1.v1-4-6: v1 schema invariants (top-level keys allowlist,
//      `hash.content_hash` shape, `generator_version` preserved) are
//      NOT broken by v1-4.
//
//   7. P1.v1-4-7: HTTP `/v1/ecosystem/hot` returns 200 attached for
//      the correct external version, 400 `community_profile_not_found`
//      when no row matches AND no canonical exists for the caller's
//      story_version.
//
//   8. P1.v1-4-8: `POST /api/sessions` bootstrap response carries the
//      canonical external version (`${generator_version}@${hash16}`)
//      so the browser can re-pin the identity triple without a
//      second round-trip.

import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  attachRelevance,
  createEcosystemHotOrchestrator,
  KNOWN_CATEGORIES,
  resolveCanonicalExternalVersion,
  resolveProfileMatchTerms,
} from '../src/providers/ecosystem/hot.mjs';
// P1.v1-4 (2026-09-07): the helpers have moved to the community
// layer. hot.mjs imports them from there — there is NO private copy
// in hot.mjs anymore. The wire format lives in exactly one place.
import {
  computeProfileContentHash,
  deriveExternalCommunityProfileVersion,
  EXTERNAL_HASH_LENGTH,
} from '../src/community/version.mjs';
import {
  COMMUNITY_PROFILE_GENERATOR_VERSION,
  createInMemoryCommunityProfileRepository,
  ensureCommunityProfile,
  getCommunityFixtureSeed,
  getCommunityProfile,
} from '../src/community/index.mjs';
import {
  createSeededRepository,
  FIXTURE_UUIDS,
} from '../src/stories/fixture.mjs';
import { server } from '../src/server.mjs';

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

const PICK = await new Promise((resolvePort, reject) => {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolvePort(port));
  });
  probe.on('error', reject);
});

const baseUrl = `http://127.0.0.1:${PICK}`;

await new Promise((resolveListen) => server.listen(PICK, '127.0.0.1', resolveListen));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runAllChecks() {
  try {
    console.log('ClickUp 16.4 P1.v1-4 fix — community-layer helper + direct external-version lookup');

    // ----- A. Module placement (P1.v1-4-1) -----------------------------------
    await check('A: src/community/version.mjs exists (P1.v1-4-1 community-layer helper)', () => {
      try {
        const src = readFileSync(resolve(ROOT, 'src/community/version.mjs'), 'utf-8');
        assert.match(src, /export function deriveExternalCommunityProfileVersion/);
        assert.match(src, /export function computeProfileContentHash/);
        assert.match(src, /export const EXTERNAL_HASH_LENGTH/);
      } catch (err) {
        assert.fail(`src/community/version.mjs missing or invalid: ${err.message}`);
      }
    });
    await check('A: src/community/version.mjs is the ONLY place that knows the @ wire format', () => {
      const verSrc = readFileSync(resolve(ROOT, 'src/community/version.mjs'), 'utf-8');
      // The literal wire-format template literal MUST live here, not
      // anywhere else (hot.mjs / server.mjs / tests).
      assert.match(verSrc, /\$\{generatorVersion\}@\$\{shortHash\}/);
      const hotSrc = readFileSync(resolve(ROOT, 'src/providers/ecosystem/hot.mjs'), 'utf-8');
      // hot.mjs imports the helper but does NOT carry a local
      // definition of the wire-format template literal.
      assert.ok(
        !/\$\{generatorVersion\}@\$\{shortHash\}/.test(hotSrc),
        'hot.mjs MUST NOT carry a local copy of the wire-format template',
      );
    });
    await check('A: EXTERNAL_HASH_LENGTH = 16 (P1.v1-4-1 wire format)', () => {
      assert.equal(EXTERNAL_HASH_LENGTH, 16);
    });
    await check('A: hot.mjs does NOT carry a private function definition of deriveExternalCommunityProfileVersion', () => {
      const hotSrc = readFileSync(resolve(ROOT, 'src/providers/ecosystem/hot.mjs'), 'utf-8');
      // The private function definitions would be one of:
      //   function deriveExternalCommunityProfileVersion(...) {
      //   export function deriveExternalCommunityProfileVersion(...) {
      // The import statement at the top is allowed (the symbol
      // arrives via the import), but NO local definition.
      assert.ok(
        !/(?:^|\n)(?:export\s+)?function\s+deriveExternalCommunityProfileVersion\s*\(/.test(hotSrc),
        'hot.mjs MUST NOT define deriveExternalCommunityProfileVersion locally',
      );
    });
    await check('A: hot.mjs does NOT carry a private function definition of computeProfileContentHash', () => {
      const hotSrc = readFileSync(resolve(ROOT, 'src/providers/ecosystem/hot.mjs'), 'utf-8');
      assert.ok(
        !/(?:^|\n)(?:export\s+)?function\s+computeProfileContentHash\s*\(/.test(hotSrc),
        'hot.mjs MUST NOT define computeProfileContentHash locally',
      );
    });
    await check('A: hot.mjs does NOT use the v1-3 era -+12 format (EXTERNAL_CONTENT_HASH_LENGTH)', () => {
      const hotSrc = readFileSync(resolve(ROOT, 'src/providers/ecosystem/hot.mjs'), 'utf-8');
      assert.ok(
        !/EXTERNAL_CONTENT_HASH_LENGTH/.test(hotSrc),
        'hot.mjs MUST NOT use the v1-3 era EXTERNAL_CONTENT_HASH_LENGTH = 12 constant',
      );
    });

    // ----- B. Helper output (P1.v1-4-1 wire format) --------------------------
    const { repository: storyRepo } = createSeededRepository();
    const profileRepo = createInMemoryCommunityProfileRepository();
    const cafeRainIds = FIXTURE_UUIDS['cafe-rain'];
    const cafeRainProfile = ensureCommunityProfile({
      repository: storyRepo,
      profileRepository: profileRepo,
      story_version_uuid: cafeRainIds.story_version_uuid,
      story: { id: 'cafe-rain', title: '雨夜咖啡馆', hook: '凌晨的咖啡馆只剩你和她。' },
      options: {
        source: 'mock-fixture',
        seed: getCommunityFixtureSeed('cafe-rain'),
      },
    });
    await check('B: deriveExternalCommunityProfileVersion returns `${generator_version}@${16-hex}`', () => {
      const ev = deriveExternalCommunityProfileVersion(cafeRainProfile);
      assert.equal(typeof ev, 'string');
      assert.match(
        ev,
        /^(?:community-profile-rules\/1|community-profile@community-profile-rules\/1)@[0-9a-f]{16}$/,
      );
      // The hash suffix MUST be exactly 16 hex chars (not 12).
      const hashSuffix = ev.split('@').pop();
      assert.equal(hashSuffix.length, 16);
      assert.match(hashSuffix, /^[0-9a-f]{16}$/);
    });
    await check('B: deriveExternalCommunityProfileVersion is NOT the v1-3 -+12 format', () => {
      const ev = deriveExternalCommunityProfileVersion(cafeRainProfile);
      assert.ok(!/-[0-9a-f]{12}$/.test(ev), `external version ${ev} still uses the v1-3 -+12 format`);
      assert.ok(/@/.test(ev), `external version ${ev} must use the v1-4 @ separator`);
    });
    await check('B: deriveExternalCommunityProfileVersion is idempotent (same profile → same external version)', () => {
      const a = deriveExternalCommunityProfileVersion(cafeRainProfile);
      const b = deriveExternalCommunityProfileVersion(cafeRainProfile);
      assert.equal(a, b);
    });
    await check('B: deriveExternalCommunityProfileVersion throws when generator_version is missing', () => {
      const noGen = JSON.parse(JSON.stringify(cafeRainProfile));
      noGen.generator_version = '';
      assert.throws(
        () => deriveExternalCommunityProfileVersion(noGen),
        /generator_version required/,
      );
    });
    await check('B: computeProfileContentHash returns a 64-char hex sha256', () => {
      const h = computeProfileContentHash(cafeRainProfile);
      assert.equal(typeof h, 'string');
      assert.equal(h.length, 64);
      assert.match(h, /^[0-9a-f]{64}$/);
    });

    // ----- C. findByExternalVersion (P1.v1-4-2) ------------------------------
    await check('C: communityProfileRepo exposes findByExternalVersion as a function', () => {
      assert.equal(typeof profileRepo.findByExternalVersion, 'function');
    });
    const externalVersionA = deriveExternalCommunityProfileVersion(cafeRainProfile);
    await check('C: findByExternalVersion returns the matching row for a known external version', () => {
      const found = profileRepo.findByExternalVersion(externalVersionA);
      assert.ok(found);
      assert.equal(found.profile_uuid, cafeRainProfile.profile_uuid);
    });
    await check('C: findByExternalVersion returns null for a non-existent external version', () => {
      const found = profileRepo.findByExternalVersion('community-profile-rules/1-deadbeefdead');
      assert.equal(found, null);
    });
    await check('C: findByExternalVersion returns null for an empty / non-string external version', () => {
      assert.equal(profileRepo.findByExternalVersion(''), null);
      assert.equal(profileRepo.findByExternalVersion(null), null);
      assert.equal(profileRepo.findByExternalVersion(undefined), null);
    });

    // ----- D. attachRelevance uses findByExternalVersion (P1.v1-4-2) ---------
    const orchestrator = createEcosystemHotOrchestrator();
    const baseResp = await orchestrator.fetchHot({ category: 'total' });
    const matchedA = attachRelevance(
      JSON.parse(JSON.stringify(baseResp)),
      {
        story_uuid: cafeRainIds.story_uuid,
        story_version_uuid: cafeRainIds.story_version_uuid,
        community_profile_version: externalVersionA,
      },
      { profileRepository: profileRepo },
    );
    await check('D: attachRelevance: correct external version → attached = true', () => {
      assert.equal(matchedA.attached, true);
      assert.equal(matchedA.reason, undefined);
    });
    await check('D: attachRelevance: matched response echoes content_hash on relevant_to_story', () => {
      assert.ok(matchedA.response.relevant_to_story);
      assert.equal(typeof matchedA.response.relevant_to_story.content_hash, 'string');
      assert.equal(matchedA.response.relevant_to_story.content_hash.length, 64);
    });
    await check('D: attachRelevance: matched response echoes the canonical external version', () => {
      assert.equal(
        matchedA.response.relevant_to_story.community_profile_version,
        externalVersionA,
      );
      assert.equal(
        matchedA.response.relevant_to_story.generator_version,
        cafeRainProfile.generator_version,
      );
    });

    // ----- E. Multi-generation fixture (P1.v1-4-5) ----------------------------
    // Same `story_version`, two distinct generations with the same
    // ruleset version but DIFFERENT content. Each generation has its
    // own external version. The PRIMARY `findByExternalVersion` lookup
    // MUST resolve each generation from its own external version, even
    // though only one of them is "active" in the repo (the most
    // recently inserted row wins the active slot).
    const profileRepoMulti = createInMemoryCommunityProfileRepository();
    const profileGenA = ensureCommunityProfile({
      repository: storyRepo,
      profileRepository: profileRepoMulti,
      story_version_uuid: cafeRainIds.story_version_uuid,
      story: { id: 'cafe-rain', title: '雨夜咖啡馆', hook: '凌晨的咖啡馆只剩你和她。' },
      options: {
        source: 'mock-fixture',
        generator_version: 'community-profile@community-profile-rules/1',
        seed: getCommunityFixtureSeed('cafe-rain'),
      },
    });
    const externalVersionGenA = deriveExternalCommunityProfileVersion(profileGenA);
    // Generation B — same story_version, same generator_version, but
    // DIFFERENT content (a new topic + a new hot_keyword).
    const profileGenB = ensureCommunityProfile({
      repository: storyRepo,
      profileRepository: profileRepoMulti,
      story_version_uuid: cafeRainIds.story_version_uuid,
      story: { id: 'cafe-rain', title: '雨夜咖啡馆', hook: '凌晨的咖啡馆只剩你和她。' },
      options: {
        source: 'mock-fixture',
        generator_version: 'community-profile@community-profile-rules/1',
        seed: {
          topics: [
            { label: '雨夜咖啡馆的空间与孤独感', summary: '原作用雨声、玻璃窗、咖啡机的细节建立凌晨的孤独感与两个人之间的距离。' },
            { label: '「旧友」与「陌生人」的双线解读', summary: '原作在两个角色身份之间摆动，留给读者判断对方到底是旧识还是陌生的关键线索。' },
            { label: '咖啡作为关系媒介的意象', summary: '原作反复用"换一杯热咖啡"的动作传递关系温度，读者普遍讨论这种意象是否成立。' },
            // Generation B adds a NEW topic.
            { label: '雨声与时钟声的声学叙事', summary: '原作把雨声和时钟声作为叙事齿轮的咬合点，读者讨论这种双声学结构的节奏感。' },
          ],
          queries: [
            { query: '雨夜咖啡馆 故事 解读', kind: 'web' },
            { query: '雨夜咖啡馆 角色分析 旧友 陌生人', kind: 'web' },
            { query: '雨夜咖啡馆 意象 咖啡 关系', kind: 'mixed' },
            { query: '雨夜咖啡馆 极简对话 潜文本', kind: 'web' },
          ],
          knowledge_queries: [
            { query: '雨夜咖啡馆 设定 百科', kind: 'knowledge' },
            { query: '雨夜咖啡馆 主题 释义', kind: 'knowledge' },
          ],
          hot_keywords: [
            { keyword: '雨夜咖啡馆', rationale: '原作标题本身的热榜匹配关键词。' },
            { keyword: '凌晨 咖啡馆', rationale: '原作核心时空名词，常见热榜话题。' },
            { keyword: '旧友 陌生人', rationale: '原作双角色设定对应的热榜搜索热词。' },
            // Generation B adds a NEW hot_keyword.
            { keyword: '雨声 时钟声', rationale: '原作双声学叙事的热榜匹配关键词。' },
          ],
        },
      },
    });
    const externalVersionGenB = deriveExternalCommunityProfileVersion(profileGenB);
    await check('E: same story_version, two distinct content generations → distinct external versions', () => {
      assert.notEqual(externalVersionGenA, externalVersionGenB);
      assert.match(externalVersionGenA, /@[0-9a-f]{16}$/);
      assert.match(externalVersionGenB, /@[0-9a-f]{16}$/);
    });
    await check('E: both generations share the same ruleset prefix', () => {
      const prefix = (s) => s.split('@').slice(0, -1).join('@');
      assert.equal(prefix(externalVersionGenA), prefix(externalVersionGenB));
    });
    await check('E: Generation A is reachable via findByExternalVersion(externalVersionGenA)', () => {
      const found = profileRepoMulti.findByExternalVersion(externalVersionGenA);
      assert.ok(found);
      assert.equal(found.profile_uuid, profileGenA.profile_uuid);
    });
    await check('E: Generation B is reachable via findByExternalVersion(externalVersionGenB)', () => {
      const found = profileRepoMulti.findByExternalVersion(externalVersionGenB);
      assert.ok(found);
      assert.equal(found.profile_uuid, profileGenB.profile_uuid);
    });
    await check('E: active slot moved to Generation B (most recent insert), but Generation A is still findable', () => {
      const active = profileRepoMulti.findActiveByStoryVersion(cafeRainIds.story_version_uuid);
      assert.equal(active.profile_uuid, profileGenB.profile_uuid, 'active slot must hold Generation B (most recent)');
      // Crucially, findByExternalVersion is GLOBAL — it returns
      // Generation A even though Generation A is no longer active.
      const foundA = profileRepoMulti.findByExternalVersion(externalVersionGenA);
      assert.ok(foundA);
      assert.equal(foundA.profile_uuid, profileGenA.profile_uuid);
    });
    // Generation A carries the 雨声 时钟声 keyword in Generation B
    // but NOT in Generation A. The relevance projection MUST be
    // sourced from the row matching the caller-supplied external
    // version, NOT from the active slot.
    const matchedGenA = attachRelevance(
      JSON.parse(JSON.stringify(baseResp)),
      {
        story_uuid: cafeRainIds.story_uuid,
        story_version_uuid: cafeRainIds.story_version_uuid,
        community_profile_version: externalVersionGenA,
      },
      { profileRepository: profileRepoMulti },
    );
    await check('E: attachRelevance w/ Generation A external version → resolves to Generation A row (not the active slot)', () => {
      assert.equal(matchedGenA.attached, true);
      assert.equal(
        matchedGenA.response.relevant_to_story.profile_uuid,
        profileGenA.profile_uuid,
        'attachRelevance MUST use the row matching the external version, NOT the active slot',
      );
    });
    await check('E: Generation A projection does NOT include Generation B-only terms', () => {
      // The Generation B-only keyword is 雨声 时钟声. Generation A
      // does not have it. The relevance projection's `hot_match_terms`
      // MUST come from Generation A's row, NOT the active Generation B
      // row. (This is the regression the v1-3 active-row bug missed.)
      const hotMatchTerms = matchedGenA.response.relevant_to_story.hot_match_terms;
      assert.ok(
        !hotMatchTerms.includes('雨声 时钟声'),
        `Generation A projection leaked Generation B-only term '雨声 时钟声' — this is the v1-3 active-row regression`,
      );
    });

    // ----- F. community_profile_not_found (P1.v1-4-3) ------------------------
    // When the caller supplies an external version that matches NO
    // row AND there is NO canonical row for the caller's
    // story_version_uuid, attachRelevance returns
    // reason = 'community_profile_not_found'.
    const emptyRepo = createInMemoryCommunityProfileRepository();
    await check('F: attachRelevance: empty repo + unknown external version → community_profile_not_found', () => {
      const r = attachRelevance(
        JSON.parse(JSON.stringify(baseResp)),
        {
          story_uuid: cafeRainIds.story_uuid,
          story_version_uuid: cafeRainIds.story_version_uuid,
          community_profile_version: 'community-profile@community-profile-rules/1-0123456789abcdef',
        },
        { profileRepository: emptyRepo },
      );
      assert.equal(r.attached, false);
      assert.equal(r.reason, 'community_profile_not_found');
      assert.equal(r.actual_version, 'community-profile@community-profile-rules/1-0123456789abcdef');
    });
    await check('F: resolveCanonicalExternalVersion returns null when no canonical row exists', () => {
      const v = resolveCanonicalExternalVersion({
        profileRepository: emptyRepo,
        story_version_uuid: cafeRainIds.story_version_uuid,
      });
      assert.equal(v, null);
    });

    // ----- G. Cross-version external version swap (P1.v1-4-4) ----------------
    // The caller carries an external version that points to a row
    // bound to a DIFFERENT story_version. attachRelevance must reject
    // it as `mismatch` with the canonical external version for the
    // caller's story_version as `expected_version`.
    const profileRepoGenA = createInMemoryCommunityProfileRepository();
    ensureCommunityProfile({
      repository: storyRepo,
      profileRepository: profileRepoGenA,
      story_version_uuid: cafeRainIds.story_version_uuid,
      story: { id: 'cafe-rain', title: '雨夜咖啡馆', hook: '凌晨的咖啡馆只剩你和她。' },
      options: {
        source: 'mock-fixture',
        seed: getCommunityFixtureSeed('cafe-rain'),
      },
    });
    const nightShiftIds = FIXTURE_UUIDS['night-shift'];
    const profileRepoNightShift = createInMemoryCommunityProfileRepository();
    const nightShiftProfile = ensureCommunityProfile({
      repository: storyRepo,
      profileRepository: profileRepoNightShift,
      story_version_uuid: nightShiftIds.story_version_uuid,
      story: { id: 'night-shift', title: '夜班便利店', hook: '凌晨三点的便利店只有你和一个陌生顾客。' },
      options: {
        source: 'mock-fixture',
        seed: getCommunityFixtureSeed('night-shift'),
      },
    });
    const nightShiftExternal = deriveExternalCommunityProfileVersion(nightShiftProfile);
    // Merge both rows into the SAME repo so the PRIMARY lookup can
    // resolve the night-shift external version. The caller then
    // carries night-shift's external version but asks for cafe-rain's
    // story_version_uuid.
    const mergedRepo = createInMemoryCommunityProfileRepository();
    // Install cafe-rain row first (becomes active for cafe-rain).
    ensureCommunityProfile({
      repository: storyRepo,
      profileRepository: mergedRepo,
      story_version_uuid: cafeRainIds.story_version_uuid,
      story: { id: 'cafe-rain', title: '雨夜咖啡馆', hook: '凌晨的咖啡馆只剩你和她。' },
      options: {
        source: 'mock-fixture',
        seed: getCommunityFixtureSeed('cafe-rain'),
      },
    });
    // Install night-shift row (becomes active for night-shift).
    ensureCommunityProfile({
      repository: storyRepo,
      profileRepository: mergedRepo,
      story_version_uuid: nightShiftIds.story_version_uuid,
      story: { id: 'night-shift', title: '夜班便利店', hook: '凌晨三点的便利店只有你和一个陌生顾客。' },
      options: {
        source: 'mock-fixture',
        seed: getCommunityFixtureSeed('night-shift'),
      },
    });
    const canonicalCafeRainExternal = resolveCanonicalExternalVersion({
      profileRepository: mergedRepo,
      story_version_uuid: cafeRainIds.story_version_uuid,
    });
    await check('G: attachRelevance: cross-story-version external version swap → reason = "mismatch"', () => {
      const r = attachRelevance(
        JSON.parse(JSON.stringify(baseResp)),
        {
          story_uuid: cafeRainIds.story_uuid,
          story_version_uuid: cafeRainIds.story_version_uuid,
          // Valid external version, but it points to the night-shift row.
          community_profile_version: nightShiftExternal,
        },
        { profileRepository: mergedRepo },
      );
      assert.equal(r.attached, false);
      assert.equal(r.reason, 'mismatch');
      assert.equal(r.expected_version, canonicalCafeRainExternal);
      assert.equal(r.actual_version, nightShiftExternal);
    });

    // ----- H. HTTP path (P1.v1-4-7) ------------------------------------------
    await sleep(50);
    const serverProfileRepo = /** @type {any} */ (globalThis).__storyOutsideCommunityRepoForTests;
    if (!serverProfileRepo) {
      throw new Error('server-side communityProfileRepo hook missing');
    }
    // Install a single row in the server-side repo (cafe-rain).
    ensureCommunityProfile({
      repository: storyRepo,
      profileRepository: serverProfileRepo,
      story_version_uuid: cafeRainIds.story_version_uuid,
      story: { id: 'cafe-rain', title: '雨夜咖啡馆', hook: '凌晨的咖啡馆只剩你和她。' },
      options: {
        source: 'mock-fixture',
        seed: getCommunityFixtureSeed('cafe-rain'),
      },
    });
    const serverCanonicalExternal = deriveExternalCommunityProfileVersion(
      getCommunityProfile({
        profileRepository: serverProfileRepo,
        story_version_uuid: cafeRainIds.story_version_uuid,
      }),
    );

    // H1. Correct external version → 200 + relevant_to_story.
    const rMatch = await fetch(`${baseUrl}/v1/ecosystem/hot?story_uuid=${cafeRainIds.story_uuid}&story_version_uuid=${cafeRainIds.story_version_uuid}&community_profile_version=${encodeURIComponent(serverCanonicalExternal)}`);
    const jMatch = await rMatch.json();
    await check('H: GET /v1/ecosystem/hot: correct external version → 200 + relevant_to_story.score > 0', () => {
      assert.equal(rMatch.status, 200);
      assert.ok(jMatch.relevant_to_story);
      assert.ok(jMatch.relevant_to_story.score > 0);
    });
    await check('H: GET /v1/ecosystem/hot: relevant_to_story echoes v1-4 wire format (@{16-hex})', () => {
      assert.match(
        jMatch.relevant_to_story.community_profile_version,
        /^(?:community-profile-rules\/1|community-profile@community-profile-rules\/1)@[0-9a-f]{16}$/,
      );
      assert.equal(jMatch.relevant_to_story.community_profile_version, serverCanonicalExternal);
    });

    // H2. Wrong external version that DOES NOT match anything →
    // community_profile_not_found. The server-side repo has at
    // least one row for cafe-rain, so the SECONDARY canonical
    // fallback will surface a mismatch. To force
    // community_profile_not_found, we need a story_version that has
    // NO canonical row on the server side. Use a synthetic UUID.
    const fakeStoryVersionUuid = '00000000-0000-4000-8000-000000000999';
    const rNotFound = await fetch(`${baseUrl}/v1/ecosystem/hot?story_uuid=${cafeRainIds.story_uuid}&story_version_uuid=${fakeStoryVersionUuid}&community_profile_version=${encodeURIComponent('community-profile@community-profile-rules/1-0123456789abcdef')}`);
    const jNotFound = await rNotFound.json();
    await check('H: GET /v1/ecosystem/hot: wrong external version + unknown story_version → 400 community_profile_not_found', () => {
      assert.equal(rNotFound.status, 400);
      assert.equal(jNotFound.error, 'community_profile_not_found');
      assert.equal(jNotFound.story_version_uuid, fakeStoryVersionUuid);
      assert.equal(jNotFound.actual_community_profile_version, 'community-profile@community-profile-rules/1-0123456789abcdef');
    });

    // H3. POST /api/sessions bootstrap carries v1-4 wire format.
    const bootstrapResp = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ work_id: 'cafe-rain', role_id: 'stranger' }),
    });
    const bootstrapJson = await bootstrapResp.json();
    await check('H: POST /api/sessions bootstrap carries v1-4 wire format (@{16-hex})', () => {
      assert.equal(bootstrapResp.status, 200);
      assert.ok(typeof bootstrapJson.community_profile_version === 'string');
      assert.match(
        bootstrapJson.community_profile_version,
        /^(?:community-profile-rules\/1|community-profile@community-profile-rules\/1)@[0-9a-f]{16}$/,
      );
      assert.equal(bootstrapJson.community_profile_version, serverCanonicalExternal);
    });

    // ----- I. v1 schema invariants (P1.v1-4-6) -------------------------------
    await check('I: src/community/profile.mjs keeps `generator_version` (v1 schema preserved)', () => {
      const src = readFileSync(resolve(ROOT, 'src/community/profile.mjs'), 'utf-8');
      assert.match(src, /generator_version/);
      const hits = (src.match(/generator_version/g) || []).length;
      assert.ok(hits >= 13, `expected >=13 generator_version hits, got ${hits}`);
    });
    await check('I: COMMUNITY_PROFILE_GENERATOR_VERSION.rules_version is the v1 shape', () => {
      assert.equal(COMMUNITY_PROFILE_GENERATOR_VERSION.rules_version, 'community-profile-rules/1');
    });
    await check('I: src/providers/ecosystem/hot.mjs: hot_match_terms surface unchanged', () => {
      const hotSrc = readFileSync(resolve(ROOT, 'src/providers/ecosystem/hot.mjs'), 'utf-8');
      assert.match(hotSrc, /hot_match_terms/);
      assert.match(hotSrc, /hot_keywords/);
    });
    await check('I: server.mjs route returns 400 community_profile_version_mismatch (v1-3 contract preserved)', () => {
      const serverSrc = readFileSync(resolve(ROOT, 'src/server.mjs'), 'utf-8');
      assert.match(serverSrc, /community_profile_version_mismatch/);
      assert.match(serverSrc, /community_profile_not_found/);
    });

    // ----- J. Cross-version lookup robustness (no "active" concept) ----------
    let localRepo;
    let genAExternal;
    let genAProfileUuidInLocalRepo;
    await check('J: attachRelevance w/ Generation A external version → Generation A row even though Generation B is active', () => {
      // Re-verify on the server-side repo pattern: install Generation
      // A first, then Generation B. The active slot moves to B but
      // Generation A must still be reachable via its external version.
      localRepo = createInMemoryCommunityProfileRepository();
      const genAProfile = ensureCommunityProfile({
        repository: storyRepo,
        profileRepository: localRepo,
        story_version_uuid: cafeRainIds.story_version_uuid,
        story: { id: 'cafe-rain', title: '雨夜咖啡馆', hook: '凌晨的咖啡馆只剩你和她。' },
        options: {
          source: 'mock-fixture',
          generator_version: 'community-profile@community-profile-rules/1',
          seed: getCommunityFixtureSeed('cafe-rain'),
        },
      });
      genAProfileUuidInLocalRepo = genAProfile.profile_uuid;
      ensureCommunityProfile({
        repository: storyRepo,
        profileRepository: localRepo,
        story_version_uuid: cafeRainIds.story_version_uuid,
        story: { id: 'cafe-rain', title: '雨夜咖啡馆', hook: '凌晨的咖啡馆只剩你和她。' },
        options: {
          source: 'mock-fixture',
          generator_version: 'community-profile@community-profile-rules/1',
          seed: {
            topics: [
              { label: '雨夜咖啡馆的空间与孤独感', summary: '原作用雨声、玻璃窗、咖啡机的细节建立凌晨的孤独感与两个人之间的距离。' },
              { label: '「旧友」与「陌生人」的双线解读', summary: '原作在两个角色身份之间摆动，留给读者判断对方到底是旧识还是陌生的关键线索。' },
              { label: '咖啡作为关系媒介的意象', summary: '原作反复用"换一杯热咖啡"的动作传递关系温度，读者普遍讨论这种意象是否成立。' },
              { label: '雨声与时钟声的声学叙事', summary: '原作把雨声和时钟声作为叙事齿轮的咬合点，读者讨论这种双声学结构的节奏感。' },
            ],
            queries: [
              { query: '雨夜咖啡馆 故事 解读', kind: 'web' },
              { query: '雨夜咖啡馆 角色分析 旧友 陌生人', kind: 'web' },
              { query: '雨夜咖啡馆 意象 咖啡 关系', kind: 'mixed' },
              { query: '雨夜咖啡馆 极简对话 潜文本', kind: 'web' },
            ],
            knowledge_queries: [
              { query: '雨夜咖啡馆 设定 百科', kind: 'knowledge' },
              { query: '雨夜咖啡馆 主题 释义', kind: 'knowledge' },
            ],
            hot_keywords: [
              { keyword: '雨夜咖啡馆', rationale: '原作标题本身的热榜匹配关键词。' },
              { keyword: '凌晨 咖啡馆', rationale: '原作核心时空名词，常见热榜话题。' },
              { keyword: '旧友 陌生人', rationale: '原作双角色设定对应的热榜搜索热词。' },
              { keyword: '雨声 时钟声', rationale: '原作双声学叙事的热榜匹配关键词。' },
            ],
          },
        },
      });
      // Generation A's external version: derive from the row we
      // captured at insertion time.
      genAExternal = deriveExternalCommunityProfileVersion(genAProfile);
      const r = attachRelevance(
        JSON.parse(JSON.stringify(baseResp)),
        {
          story_uuid: cafeRainIds.story_uuid,
          story_version_uuid: cafeRainIds.story_version_uuid,
          community_profile_version: genAExternal,
        },
        { profileRepository: localRepo },
      );
      assert.equal(r.attached, true);
      assert.equal(
        r.response.relevant_to_story.profile_uuid,
        genAProfileUuidInLocalRepo,
        'attachRelevance MUST resolve the row by external version, ignoring the active slot',
      );
    });
    await check('J: resolveProfileMatchTerms carries profileStoryVersionUuid for cross-version defense', () => {
      assert.ok(localRepo);
      const r = resolveProfileMatchTerms({
        profileRepository: localRepo,
        story_version_uuid: cafeRainIds.story_version_uuid,
        community_profile_version: genAExternal,
      });
      assert.ok(r.profileUuid);
      assert.equal(r.profileStoryVersionUuid, cafeRainIds.story_version_uuid);
    });

    // ----- K. Grep guards (task spec) ---------------------------------------
    await check('K: grep deriveExternalCommunityProfileVersion src/providers/ecosystem/hot.mjs → no PRIVATE definition', () => {
      const hotSrc = readFileSync(resolve(ROOT, 'src/providers/ecosystem/hot.mjs'), 'utf-8');
      // The symbol may appear (imported + used + commented) but there
      // must be NO local function definition.
      assert.ok(
        !/(?:^|\n)(?:export\s+)?function\s+deriveExternalCommunityProfileVersion\s*\(/.test(hotSrc),
        'hot.mjs must not define deriveExternalCommunityProfileVersion locally',
      );
    });
    await check('K: grep import.*deriveExternalCommunityProfileVersion src/providers/ecosystem/hot.mjs → hits (import present)', () => {
      const hotSrc = readFileSync(resolve(ROOT, 'src/providers/ecosystem/hot.mjs'), 'utf-8');
      const lines = hotSrc.split('\n').filter((l) =>
        /import\s.*deriveExternalCommunityProfileVersion/.test(l),
      );
      assert.ok(
        lines.length >= 1,
        'hot.mjs must import the public helper from the community layer',
      );
    });
    await check('K: grep findByExternalVersion src/providers/ecosystem/hot.mjs → hits (used by attachRelevance)', () => {
      const hotSrc = readFileSync(resolve(ROOT, 'src/providers/ecosystem/hot.mjs'), 'utf-8');
      const lines = hotSrc.split('\n').filter((l) =>
        /findByExternalVersion/.test(l),
      );
      assert.ok(
        lines.length >= 1,
        'hot.mjs must reference findByExternalVersion (PRIMARY read path)',
      );
    });

  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

runAllChecks().then(
  () => {
    if (failures > 0) {
      console.log(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log('\nAll ClickUp 16.4 P1.v1-4 fix checks passed.');
  },
  (err) => {
    console.log('\nclickup16-4-p1fix-v1-4 crashed:');
    console.log(err && err.stack ? err.stack : err);
    process.exit(1);
  },
);