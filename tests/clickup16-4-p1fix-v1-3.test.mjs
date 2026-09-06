// tests/clickup16-4-p1fix-v1-3.test.mjs — ClickUp 16.4 P1.v1-3 fix
// regression suite (2026-09-07).
//
// What this test guards (continues PR #23 on
// fix/clickup16-4-p1-hot-relevance branch; appends on top of v1-2
// commit 33742bc):
//
//   1. P1.v1-3-1: deriveExternalCommunityProfileVersion(profile)
//      derives the EXTERNAL `community_profile_version` string used on
//      the wire contract as
//      `${generator_version}-${shortContentHash}`. The internal
//      `generator_version` field on the profile row is preserved (v1
//      schema, 13 top-level fields) — only the external identity used
//      on the HTTP boundary is content-aware.
//
//   2. P1.v1-3-2: Two-generation regression. Two profile rows with the
//      SAME `generator_version='community-profile-rules/1'` but
//      DIFFERENT content (regenerated hot_keywords / topics) have
//      DISTINCT external identity strings. A caller carrying the
//      previous generation's external version is rejected with 400
//      `community_profile_version_mismatch` instead of silently
//      observing stale relevance projections. The original P1 P1
//      blocker (silent 0-terms on data-contract mismatch) is closed
//      for the two-generation case too.
//
//   3. P1.v1-3-3: The internal `generator_version` field on the
//      profile row is preserved. The v1 schema is NOT renamed. The
//      v1 communityProfile.test.mjs invariants (top-level keys
//      allowlist, hash.content_hash shape) keep holding.
//
//   4. P1.v1-3-4: HTTP `/v1/ecosystem/hot` returns 200 attached for
//      the correct external version, 400 mismatch for a stale caller
//      carrying a previous generation's external version.
//
//   5. P1.v1-3-5: `POST /api/sessions` bootstrap response carries the
//      canonical external version (= `${rules_version}-${hash}`) so
//      the browser can re-pin the identity triple without a second
//      round-trip.

import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  attachRelevance,
  createEcosystemHotOrchestrator,
  KNOWN_CATEGORIES,
} from '../src/providers/ecosystem/hot.mjs';
// P1.v1-4 (2026-09-07): the helpers have moved to the community
// layer. hot.mjs imports them from there — there is NO private copy
// in hot.mjs anymore. The wire format lives in exactly one place.
import {
  computeProfileContentHash,
  deriveExternalCommunityProfileVersion,
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
    console.log('ClickUp 16.4 P1.v1-3 fix — content-hash-aware external community_profile_version');

    // ----- A. v1 schema is preserved (P1.v1-3-3) -----------------------------
    await check('A: src/community/profile.mjs keeps `generator_version` (v1 schema preserved)', () => {
      const src = readFileSync(resolve(ROOT, 'src/community/profile.mjs'), 'utf-8');
      assert.match(src, /generator_version/);
    });
    await check('A: src/community/profile.mjs PROFILE_TOP_LEVEL_KEYS still includes `generator_version` (13 keys)', () => {
      const src = readFileSync(resolve(ROOT, 'src/community/profile.mjs'), 'utf-8');
      // Allowlist must list the 13 v1 fields including generator_version;
      // a v1-3 refactor must NOT drop the field from the allowlist.
      assert.match(src, /PROFILE_TOP_LEVEL_KEYS[\s\S]+generator_version/);
    });
    await check('A: COMMUNITY_PROFILE_GENERATOR_VERSION.rules_version is the v1 shape', () => {
      assert.equal(COMMUNITY_PROFILE_GENERATOR_VERSION.rules_version, 'community-profile-rules/1');
    });
    await check('A: src/community/profile.mjs does NOT add a `community_profile_version` top-level shape key', () => {
      const src = readFileSync(resolve(ROOT, 'src/community/profile.mjs'), 'utf-8');
      // The v1 schema stays unchanged. The external identity string
      // lives on the WIRE contract, not as a top-level profile field.
      assert.ok(!/community_profile_version/.test(src), 'profile.mjs must not introduce a community_profile_version top-level shape');
    });
    await check('A: src/community/profile.mjs still computes hash.content_hash over the canonical fields', () => {
      const src = readFileSync(resolve(ROOT, 'src/community/profile.mjs'), 'utf-8');
      assert.match(src, /hash:\s*\{[\s\S]*content_hash:\s*canonicalSha256\(/);
    });

    // ----- B. deriveExternalCommunityProfileVersion + computeProfileContentHash
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
    await check('B: computeProfileContentHash returns a 64-char hex sha256 for a valid profile', () => {
      const h = computeProfileContentHash(cafeRainProfile);
      assert.equal(typeof h, 'string');
      assert.equal(h.length, 64);
      assert.match(h, /^[0-9a-f]{64}$/);
    });
    await check('B: computeProfileContentHash is content-only (excludes generator_version / generated_at / uuids)', () => {
      // Mutate the non-content fields and re-derive — hash MUST stay
      // identical. The internal ruleset string 'community-profile-rules/1'
      // does NOT contribute to the content hash.
      const mutated = JSON.parse(JSON.stringify(cafeRainProfile));
      mutated.generator_version = 'community-profile-rules/999';
      mutated.generated_at = '2030-01-01T00:00:00.000Z';
      mutated.profile_uuid = '11111111-2222-4333-8444-555555555555';
      const beforeHash = computeProfileContentHash(cafeRainProfile);
      const afterHash = computeProfileContentHash(mutated);
      assert.equal(afterHash, beforeHash, 'content hash MUST ignore generator_version / generated_at / profile_uuid');
    });
    await check('B: deriveExternalCommunityProfileVersion returns `${generator_version}@${shortContentHash}`', () => {
      const ev = deriveExternalCommunityProfileVersion(cafeRainProfile);
      assert.equal(typeof ev, 'string');
      // Must start with the canonical ruleset version (either
      // 'community-profile-rules/1' or the full
      // 'community-profile@community-profile-rules/1'), then a `@`,
      // then a 16-char hex content-hash short suffix. The `@`
      // separator (P1.v1-4) replaces the v1-3-era `-`; the hash
      // suffix is 16 hex chars (~64 bits of entropy) instead of 12.
      assert.match(ev, /^(?:community-profile-rules\/1|community-profile@community-profile-rules\/1)@[0-9a-f]{16}$/);
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
    void KNOWN_CATEGORIES;

    // ----- C. Determinism: same content → same external version -------------
    const profileRepoA = createInMemoryCommunityProfileRepository();
    const profileA = ensureCommunityProfile({
      repository: storyRepo,
      profileRepository: profileRepoA,
      story_version_uuid: cafeRainIds.story_version_uuid,
      story: { id: 'cafe-rain', title: '雨夜咖啡馆', hook: '凌晨的咖啡馆只剩你和她。' },
      options: {
        source: 'mock-fixture',
        seed: getCommunityFixtureSeed('cafe-rain'),
      },
    });
    // Re-import with the SAME content → the same external version.
    const profileRepoB = createInMemoryCommunityProfileRepository();
    const profileB = ensureCommunityProfile({
      repository: storyRepo,
      profileRepository: profileRepoB,
      story_version_uuid: cafeRainIds.story_version_uuid,
      story: { id: 'cafe-rain', title: '雨夜咖啡馆', hook: '凌晨的咖啡馆只剩你和她。' },
      options: {
        source: 'mock-fixture',
        seed: getCommunityFixtureSeed('cafe-rain'),
      },
    });
    await check('C: same content → same external version (deterministic across two imports)', () => {
      const evA = deriveExternalCommunityProfileVersion(profileA);
      const evB = deriveExternalCommunityProfileVersion(profileB);
      assert.equal(evA, evB, `expected same external version for same content; got ${evA} vs ${evB}`);
    });

    // ----- D. Two-generation regression: same generator_version, different content
    // Generation A (cafe-rain canonical seed) — already in profileRepoA.
    const externalVersionA = deriveExternalCommunityProfileVersion(profileA);
    // Generation B — same `story_version`, same generator_version
    // (canonical full form `community-profile@community-profile-rules/1`),
    // but DIFFERENT content (an extra hot_keyword + an extra topic), so
    // the content hash diverges and the external version must diverge.
    const profileRepoC = createInMemoryCommunityProfileRepository();
    const profileC = ensureCommunityProfile({
      repository: storyRepo,
      profileRepository: profileRepoC,
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
            // Generation B adds a NEW topic. Same ruleset version, but
            // the content has changed → external version must diverge.
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
            // Generation B adds a NEW hot_keyword. Same ruleset version,
            // but the content has changed → external version must diverge.
            { keyword: '雨声 时钟声', rationale: '原作双声学叙事的热榜匹配关键词。' },
          ],
        },
      },
    });
    const externalVersionB = deriveExternalCommunityProfileVersion(profileC);
    await check('D: same generator_version + different content → DIFFERENT external version (two-generation regression)', () => {
      assert.equal(profileA.generator_version, profileC.generator_version);
      assert.notEqual(externalVersionA, externalVersionB, `expected distinct external versions; got both ${externalVersionA}`);
      // Both external versions still start with the canonical ruleset
      // version (either bare 'community-profile-rules/1' or full
      // 'community-profile@community-profile-rules/1'). The wire
      // format (P1.v1-4) is `${generator_version}@${hash.slice(0,16)}`.
      assert.match(externalVersionA, /^(?:community-profile-rules\/1|community-profile@community-profile-rules\/1)@[0-9a-f]{16}$/);
      assert.match(externalVersionB, /^(?:community-profile-rules\/1|community-profile@community-profile-rules\/1)@[0-9a-f]{16}$/);
      // The hash suffix portion is what differs.
      const hashA = externalVersionA.split('@').pop();
      const hashB = externalVersionB.split('@').pop();
      assert.notEqual(hashA, hashB);
    });
    await check('D: both external versions share the ruleset prefix but diverge on the content hash suffix', () => {
      const prefix = (s) => s.split('@').slice(0, -1).join('@');
      assert.equal(prefix(externalVersionA), prefix(externalVersionB));
    });

    // ----- E. attachRelevance end-to-end: correct vs stale external version
    const orchestrator = createEcosystemHotOrchestrator();
    const baseResp = await orchestrator.fetchHot({ category: 'total' });

    // E1. Correct external version (matches Generation A) → attached.
    const matchedA = attachRelevance(
      JSON.parse(JSON.stringify(baseResp)),
      {
        story_uuid: cafeRainIds.story_uuid,
        story_version_uuid: cafeRainIds.story_version_uuid,
        community_profile_version: externalVersionA,
      },
      { profileRepository: profileRepoA },
    );
    await check('E: attachRelevance: Generation A external version matches → attached = true', () => {
      assert.equal(matchedA.attached, true);
      assert.equal(matchedA.reason, undefined);
    });
    await check('E: attachRelevance: matched response carries content_hash on relevant_to_story', () => {
      assert.ok(matchedA.response.relevant_to_story);
      assert.equal(typeof matchedA.response.relevant_to_story.content_hash, 'string');
      assert.equal(matchedA.response.relevant_to_story.content_hash.length, 64);
    });
    await check('E: attachRelevance: matched response echoes the canonical external version', () => {
      assert.equal(
        matchedA.response.relevant_to_story.community_profile_version,
        externalVersionA,
      );
      assert.equal(
        matchedA.response.relevant_to_story.generator_version,
        profileA.generator_version,
      );
    });

    // E2. Stale caller carrying Generation A's external version, but the
    // canonical row in the repo is Generation B → must reject with 400.
    const staleCallerResult = attachRelevance(
      JSON.parse(JSON.stringify(baseResp)),
      {
        story_uuid: cafeRainIds.story_uuid,
        story_version_uuid: cafeRainIds.story_version_uuid,
        community_profile_version: externalVersionA,
      },
      { profileRepository: profileRepoC },
    );
    await check('E: attachRelevance: STALE caller (Generation A) on canonical Generation B → reason = "mismatch"', () => {
      assert.equal(staleCallerResult.attached, false);
      assert.equal(staleCallerResult.reason, 'mismatch');
      assert.equal(staleCallerResult.expected_version, externalVersionB);
      assert.equal(staleCallerResult.actual_version, externalVersionA);
    });
    await check('E: attachRelevance: stale caller response does NOT carry relevant_to_story (no silent 0 terms)', () => {
      assert.equal(staleCallerResult.response.relevant_to_story, undefined);
      for (const e of staleCallerResult.response.hot) {
        assert.equal(e.relevant, undefined, 'stale caller must not see per-entry relevance projection');
      }
    });

    // E3. Stale caller carrying a synthetic 'wrong' version mixing the
    // ruleset prefix with a non-existent hash suffix → must reject with
    // 400 mismatch.
    const wrongMixResult = attachRelevance(
      JSON.parse(JSON.stringify(baseResp)),
      {
        story_uuid: cafeRainIds.story_uuid,
        story_version_uuid: cafeRainIds.story_version_uuid,
        community_profile_version: 'community-profile-rules/1-deadbeefdead',
      },
      { profileRepository: profileRepoA },
    );
    await check('E: attachRelevance: WRONG external version (mixed hash) → reason = "mismatch"', () => {
      assert.equal(wrongMixResult.attached, false);
      assert.equal(wrongMixResult.reason, 'mismatch');
      assert.equal(wrongMixResult.expected_version, externalVersionA);
      assert.equal(wrongMixResult.actual_version, 'community-profile-rules/1-deadbeefdead');
    });

    // E4. Generator-only version (no hash suffix) supplied on the wire →
    // no longer matches the external version; must reject with 400.
    const legacyFormatResult = attachRelevance(
      JSON.parse(JSON.stringify(baseResp)),
      {
        story_uuid: cafeRainIds.story_uuid,
        story_version_uuid: cafeRainIds.story_version_uuid,
        community_profile_version: 'community-profile-rules/1',
      },
      { profileRepository: profileRepoA },
    );
    await check('E: attachRelevance: legacy bare-ruleset string (no hash suffix) → reason = "mismatch"', () => {
      assert.equal(legacyFormatResult.attached, false);
      assert.equal(legacyFormatResult.reason, 'mismatch');
      assert.equal(legacyFormatResult.expected_version, externalVersionA);
      assert.equal(legacyFormatResult.actual_version, 'community-profile-rules/1');
    });

    // ----- F. HTTP path: two-generation regression on /v1/ecosystem/hot
    await sleep(50);
    const serverProfileRepo = /** @type {any} */ (globalThis).__storyOutsideCommunityRepoForTests;
    if (!serverProfileRepo) {
      throw new Error('server-side communityProfileRepo hook missing');
    }

    // P1.v1-4 (2026-09-07): reset the server-side repo so the
    // Generation-A row installed at startup (via seedCommunityProfiles)
    // does not pollute the F1a stale-caller assertion. v1-3 read the
    // active row only and therefore relied on the install call below
    // to overwrite Generation A; v1-4 reads by external-version index,
    // so a stale Generation A row would (correctly) resolve the
    // externalVersionA lookup to attached:true and bypass the 400
    // mismatch path. Clearing the repo up-front restores the v1-3
    // contract that the server-side canonical row for cafe-rain is
    // Generation B (and Generation A is unreachable from the server
    // side).
    serverProfileRepo._resetForTests();

    // F1. Install Generation B as the canonical row on the server-side repo.
    ensureCommunityProfile({
      repository: storyRepo,
      profileRepository: serverProfileRepo,
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
    // Read back the canonical row from the server-side repo and derive
    // its external version so the assertions below are self-validating.
    const serverCanonicalProfile = getCommunityProfile({
      profileRepository: serverProfileRepo,
      story_version_uuid: cafeRainIds.story_version_uuid,
    });
    const serverCanonicalExternal = deriveExternalCommunityProfileVersion(serverCanonicalProfile);

    // F1a. Stale caller carrying Generation A's external version → 400.
    const rMismatch = await fetch(`${baseUrl}/v1/ecosystem/hot?story_uuid=${cafeRainIds.story_uuid}&story_version_uuid=${cafeRainIds.story_version_uuid}&community_profile_version=${encodeURIComponent(externalVersionA)}`);
    const jMismatch = await rMismatch.json();
    await check('F: GET /v1/ecosystem/hot: stale external version → 400 community_profile_version_mismatch', () => {
      assert.equal(rMismatch.status, 400);
      assert.equal(jMismatch.error, 'community_profile_version_mismatch');
      assert.equal(jMismatch.expected_community_profile_version, serverCanonicalExternal);
      assert.equal(jMismatch.actual_community_profile_version, externalVersionA);
    });
    await check('F: GET /v1/ecosystem/hot: 400 mismatch carries PUBLIC_DECORATE (demo) and NO DEV_FLAG', () => {
      assert.ok(jMismatch.demo);
      assert.equal(jMismatch.dev, undefined);
    });

    // F1b. WRONG external version (mixed hash) → 400.
    const rWrong = await fetch(`${baseUrl}/v1/ecosystem/hot?story_uuid=${cafeRainIds.story_uuid}&story_version_uuid=${cafeRainIds.story_version_uuid}&community_profile_version=${encodeURIComponent('community-profile-rules/1-deadbeefdead')}`);
    const jWrong = await rWrong.json();
    await check('F: GET /v1/ecosystem/hot: WRONG external version (mixed hash) → 400 mismatch', () => {
      assert.equal(rWrong.status, 400);
      assert.equal(jWrong.error, 'community_profile_version_mismatch');
      assert.equal(jWrong.expected_community_profile_version, serverCanonicalExternal);
      assert.equal(jWrong.actual_community_profile_version, 'community-profile-rules/1-deadbeefdead');
    });

    // F1c. Correct external version (matches the canonical Generation B
    // row) → 200 with relevant_to_story.
    const rMatch = await fetch(`${baseUrl}/v1/ecosystem/hot?story_uuid=${cafeRainIds.story_uuid}&story_version_uuid=${cafeRainIds.story_version_uuid}&community_profile_version=${encodeURIComponent(serverCanonicalExternal)}`);
    const jMatch = await rMatch.json();
    await check('F: GET /v1/ecosystem/hot: canonical external version → 200 + relevant_to_story.score > 0', () => {
      assert.equal(rMatch.status, 200);
      assert.ok(jMatch.relevant_to_story);
      assert.ok(jMatch.relevant_to_story.score > 0);
    });
    await check('F: GET /v1/ecosystem/hot: relevant_to_story echoes canonical external version + content_hash', () => {
      assert.equal(jMatch.relevant_to_story.community_profile_version, serverCanonicalExternal);
      assert.equal(typeof jMatch.relevant_to_story.content_hash, 'string');
      assert.equal(jMatch.relevant_to_story.content_hash.length, 64);
    });
    await check('F: GET /v1/ecosystem/hot: at least one entry with relevant.score > 0 (Generation B keywords hit)', () => {
      const relatedCount = jMatch.hot.filter(
        (e) => e.relevant && typeof e.relevant.score === 'number' && e.relevant.score > 0,
      ).length;
      assert.ok(relatedCount > 0, `relatedCount=${relatedCount}`);
    });

    // ----- G. bootstrap /api/sessions carries the external version ----
    const bootstrapResp = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ work_id: 'cafe-rain', role_id: 'stranger' }),
    });
    assert.equal(bootstrapResp.status, 200);
    const bootstrapJson = await bootstrapResp.json();
    await check('G: POST /api/sessions response carries the EXTERNAL community_profile_version', () => {
      assert.ok(typeof bootstrapJson.community_profile_version === 'string');
      assert.match(
        bootstrapJson.community_profile_version,
        /^(?:community-profile-rules\/1|community-profile@community-profile-rules\/1)@[0-9a-f]{16}$/,
        `bootstrap version ${bootstrapJson.community_profile_version} must match the external identity shape`,
      );
      assert.equal(bootstrapJson.community_profile_version, serverCanonicalExternal);
    });

    // ----- H. static contract: public/ never references admin/dev surfaces
    let staticContractViolation = 0;
    try {
      const out = execFileSync(
        'grep',
        ['-rE', '/api/(admin|dev)/', 'public/'],
        { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      staticContractViolation = String(out).split('\n').filter((l) => l.length > 0).length;
    } catch (err) {
      staticContractViolation = 0;
    }
    await check('H: static contract: grep -rE "/api/(admin|dev)/" public/ returns 0', () => {
      assert.equal(staticContractViolation, 0);
    });

    // ----- I. grep guards from the task spec --------------------------------
    await check('I: src/community/profile.mjs keeps `generator_version` (schema preserved)', () => {
      const src = readFileSync(resolve(ROOT, 'src/community/profile.mjs'), 'utf-8');
      // 13+ hits across the file (top-level field + allowlist + builder + validator).
      const hits = (src.match(/generator_version/g) || []).length;
      assert.ok(hits >= 13, `expected >=13 generator_version hits, got ${hits}`);
    });
    await check('I: src/ references `content_hash` (external version derivation)', () => {
      const hotSrc = readFileSync(resolve(ROOT, 'src/providers/ecosystem/hot.mjs'), 'utf-8');
      assert.match(hotSrc, /content_hash/);
      assert.match(hotSrc, /computeProfileContentHash/);
    });
    await check('I: hot.mjs still reads hot_match_terms (no schema regression)', () => {
      const hotSrc = readFileSync(resolve(ROOT, 'src/providers/ecosystem/hot.mjs'), 'utf-8');
      assert.match(hotSrc, /hot_match_terms/);
    });
    await check('I: server.mjs route returns 400 community_profile_version_mismatch', () => {
      const serverSrc = readFileSync(resolve(ROOT, 'src/server.mjs'), 'utf-8');
      assert.match(serverSrc, /community_profile_version_mismatch/);
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
    console.log('\nAll ClickUp 16.4 P1.v1-3 fix checks passed.');
  },
  (err) => {
    console.log('\nclickup16-4-p1fix-v1-3 crashed:');
    console.log(err && err.stack ? err.stack : err);
    process.exit(1);
  },
);