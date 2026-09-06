// tests/clickup16-4-p1fix-v1-2.test.mjs — ClickUp 16.4 P1.v1-2 fix
// regression suite (2026-09-07).
//
// What this test guards (continues PR #23 on
// fix/clickup16-4-p1-hot-relevance branch; supersedes the v2 PR #29
// rebuild):
//
//   1. P1.v1-2-1: `homeHotModule.readActiveIdentity` no longer triggers
//      a Temporal Dead Zone ReferenceError. The function reads the
//      triple off `window.STORY_OUTSIDE_IDENTITY` with explicit
//      defaults on the INPUT parameter (no `const X = X.field`
//      self-reference). The TDZ detection is structural — we scan
//      the source for `const X = X.field` after stripping comments.
//
//   2. P1.v1-2-2: A global identity producer lives in
//      `public/scripts/identity.js`, exposes
//      `window.STORY_OUTSIDE_IDENTITY_API.setActiveIdentity(...)`,
//      and broadcasts `story:identity-changed` on `document`. Cross-
//      page reload restores the triple from sessionStorage.
//
//   3. P1.v1-2-3: The hot orchestrator's `attachRelevance` returns
//      `{ attached, reason, expected_version, actual_version, response }`
//      so the route layer can map a wrong-version call onto 400
//      `community_profile_version_mismatch`. The v1 schema
//      (`generator_version`) is the canonical field on the profile
//      row; the mismatch is detected by comparing the supplied value
//      against the active row's `generator_version`. The v2 PR #29
//      schema rename is NOT applied — the test guards the v1-2
//      contract on the existing `generator_version` field.
//
//   4. P1.v1-2-4: `GET /v1/ecosystem/hot` returns 400
//      `community_profile_version_mismatch` when the caller supplies
//      a version that does NOT match the canonical profile row.
//      `expected_community_profile_version` and
//      `actual_community_profile_version` are populated on the
//      response. The route never silently degrades to "0 terms" —
//      that path was the v1 P1 blocker.
//
//   5. P1.v1-2-5: `POST /api/sessions` carries the canonical
//      `community_profile_version` on the response so the browser can
//      publish the identity triple WITHOUT a second round-trip.
//
//   6. P1.v1-2-6: The static contract `grep -rE "/api/(admin|dev)/" public/`
//      stays at zero — the new modules never touch admin/dev
//      surfaces.

import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  attachRelevance,
  computeRelevance,
  createEcosystemHotOrchestrator,
  KNOWN_CATEGORIES,
  sortByRelevance,
} from '../src/providers/ecosystem/hot.mjs';
// P1.v1-4 (2026-09-07): the helper has moved to the community layer.
// hot.mjs no longer re-exports it (the wire format lives in exactly
// one place). Import directly from the community-layer module.
import { deriveExternalCommunityProfileVersion } from '../src/community/version.mjs';
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
    console.log('ClickUp 16.4 P1.v1-2 fix — TDZ + identity producer + 400 mismatch on fix/clickup16-4-p1-hot-relevance');

    // ----- A. v1 schema is preserved (v1-2 MUST NOT rename) --------------------
    await check('A: src/community/profile.mjs keeps `generator_version` (v1 schema preserved)', () => {
      const src = readFileSync(resolve(ROOT, 'src/community/profile.mjs'), 'utf-8');
      assert.match(src, /generator_version/);
    });
    await check('A: src/community/profile.mjs does NOT add canonical `community_profile_version` field name', () => {
      const src = readFileSync(resolve(ROOT, 'src/community/profile.mjs'), 'utf-8');
      assert.ok(!/community_profile_version/.test(src), 'schema rename MUST NOT be applied on v1-2 branch');
    });
    await check('A: COMMUNITY_PROFILE_GENERATOR_VERSION.rules_version is the v1 shape', () => {
      assert.equal(COMMUNITY_PROFILE_GENERATOR_VERSION.rules_version, 'community-profile-rules/1');
    });

    // ----- B. P1.v1-2-1: homeHotModule TDZ fix --------------------------------
    await check('B: homeHotModule.js exists at public/scripts/homeHotModule.js', () => {
      const src = readFileSync(resolve(ROOT, 'public/scripts/homeHotModule.js'), 'utf-8');
      assert.ok(src.length > 0);
    });
    await check('B: homeHotModule.js does NOT contain `const X = X.field` self-reference (TDZ)', () => {
      const src = readFileSync(resolve(ROOT, 'public/scripts/homeHotModule.js'), 'utf-8');
      // Strip comments first so the explanation text does not match.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      // Match the TDZ pattern: const|let IDENT = IDENT.field where the
      // IDENT on the right is the same as the one being declared.
      const tdz = /(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*\1\s*\./;
      assert.equal(tdz.test(code), false, 'TDZ pattern detected in homeHotModule.js');
    });
    await check('B: homeHotModule.js readActiveIdentity() function definition is present', () => {
      const src = readFileSync(resolve(ROOT, 'public/scripts/homeHotModule.js'), 'utf-8');
      assert.match(src, /function\s+readActiveIdentity\s*\(/);
    });
    await check('B: homeHotModule.js reads from window.STORY_OUTSIDE_IDENTITY (the producer global)', () => {
      const src = readFileSync(resolve(ROOT, 'public/scripts/homeHotModule.js'), 'utf-8');
      assert.match(src, /STORY_OUTSIDE_IDENTITY/);
      assert.ok(!/STORY_OUTSIDE_ACTIVE_IDENTITY/.test(src), 'legacy global key MUST NOT be present');
    });

    // ----- C. P1.v1-2-2: identity global producer + event -----------------------
    await check('C: public/scripts/identity.js exposes STORY_OUTSIDE_IDENTITY_API on window', () => {
      const src = readFileSync(resolve(ROOT, 'public/scripts/identity.js'), 'utf-8');
      assert.match(src, /STORY_OUTSIDE_IDENTITY_API/);
      assert.match(src, /setActiveIdentity/);
      assert.match(src, /getActiveIdentity/);
      assert.match(src, /clearActiveIdentity/);
    });
    await check('C: identity.js broadcasts story:identity-changed CustomEvent', () => {
      const src = readFileSync(resolve(ROOT, 'public/scripts/identity.js'), 'utf-8');
      assert.match(src, /story:identity-changed/);
      assert.match(src, /CustomEvent/);
    });
    await check('C: identity.js persists triple to sessionStorage under story-outside:active-identity', () => {
      const src = readFileSync(resolve(ROOT, 'public/scripts/identity.js'), 'utf-8');
      assert.match(src, /story-outside:active-identity/);
      assert.match(src, /sessionStorage/);
    });
    await check('C: identity.js initialises window.STORY_OUTSIDE_IDENTITY synchronously from readStorage()', () => {
      const src = readFileSync(resolve(ROOT, 'public/scripts/identity.js'), 'utf-8');
      assert.match(src, /const initial = readStorage\(\)/);
      assert.match(src, /\[GLOBAL_KEY\]\s*=\s*initial/);
    });
    await check('C: identity.js does NOT use any const X = X.field pattern (TDZ)', () => {
      const src = readFileSync(resolve(ROOT, 'public/scripts/identity.js'), 'utf-8');
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const tdz = /(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*\1\s*\./;
      assert.equal(tdz.test(code), false, 'TDZ pattern detected in identity.js');
    });
    await check('C: homeHotModule.js listens for story:identity-changed on document', () => {
      const src = readFileSync(resolve(ROOT, 'public/scripts/homeHotModule.js'), 'utf-8');
      assert.match(src, /addEventListener\s*\(\s*IDENTITY_EVENT/);
      assert.match(src, /IDENTITY_EVENT\s*=\s*'story:identity-changed'/);
    });
    await check('C: player.js calls publishIdentityIfAvailable() on pickStory + bootstrapSession', () => {
      const src = readFileSync(resolve(ROOT, 'public/scripts/player.js'), 'utf-8');
      assert.match(src, /publishIdentityIfAvailable\s*\(\s*\)/);
      assert.match(src, /STORY_OUTSIDE_IDENTITY_API/);
    });
    await check('C: endingPage.js calls publishEndingIdentity() on mount', () => {
      const src = readFileSync(resolve(ROOT, 'public/scripts/endingPage.js'), 'utf-8');
      assert.match(src, /publishEndingIdentity/);
      assert.match(src, /STORY_OUTSIDE_IDENTITY_API/);
    });

    // ----- D. P1.v1-2-3: attachRelevance returns { attached, reason, ... } -----
    // P1.v1-3 (2026-09-07) makes the wire-contract comparison target
    // CONTENT-AWARE: `community_profile_version` on the wire is now
    // `${generator_version}-${shortContentHash}`, derived via
    // `deriveExternalCommunityProfileVersion`. The internal
    // `generator_version` field on the profile row is preserved as the
    // ruleset version; only the external identity string used for the
    // mismatch comparison gains the content-hash suffix.
    const { repository: storyRepo } = createSeededRepository();
    const profileRepo = createInMemoryCommunityProfileRepository();
    const communityProfileVersion = COMMUNITY_PROFILE_GENERATOR_VERSION.rules_version;

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
    // P1.v1-3: derive the canonical EXTERNAL version via the new
    // helper so the match-path assertion supplies the right wire
    // string. Same ruleset + same content → same external version.
    const communityProfileVersionFull = deriveExternalCommunityProfileVersion(cafeRainProfile);

    const orchestrator = createEcosystemHotOrchestrator();
    const baseResp = await orchestrator.fetchHot({ category: 'total' });

    // Full identity for cafe-rain → attached = true (canonical row's
    // external version matches the supplied value, including the
    // content-hash suffix).
    const matched = attachRelevance(
      JSON.parse(JSON.stringify(baseResp)),
      {
        story_uuid: cafeRainIds.story_uuid,
        story_version_uuid: cafeRainIds.story_version_uuid,
        community_profile_version: communityProfileVersionFull,
      },
      { profileRepository: profileRepo },
    );
    await check('D: attachRelevance: result.attached = true when canonical row matches', () => {
      assert.equal(matched.attached, true);
    });
    await check('D: attachRelevance: result.response.relevant_to_story is populated on match', () => {
      assert.ok(matched.response.relevant_to_story);
      assert.equal(matched.response.relevant_to_story.story_uuid, cafeRainIds.story_uuid);
      assert.equal(matched.response.relevant_to_story.story_version_uuid, cafeRainIds.story_version_uuid);
      assert.equal(matched.response.relevant_to_story.community_profile_version, communityProfileVersionFull);
      assert.ok(matched.response.relevant_to_story.score > 0);
    });
    await check('D: attachRelevance: result.response.hot_match_terms carries profile.hot_keywords', () => {
      const r = matched.response.relevant_to_story;
      assert.ok(Array.isArray(r.hot_match_terms));
      assert.ok(r.hot_match_terms.length >= 2);
      assert.ok(r.hot_match_terms.includes('雨夜咖啡馆'));
    });
    await check('D: attachRelevance: result.response.themes carries profile.topics labels', () => {
      const r = matched.response.relevant_to_story;
      assert.ok(Array.isArray(r.themes));
      assert.ok(r.themes.length >= 3);
    });
    await check('D: attachRelevance (P1.v1-3): match path exposes content_hash on relevant_to_story', () => {
      assert.equal(typeof matched.response.relevant_to_story.content_hash, 'string');
      assert.ok(matched.response.relevant_to_story.content_hash.length >= 12);
    });

    // Mismatch path: install a row at version '9.9.9' for cafe-rain,
    // request '1.0.0' → attached: false, reason: 'mismatch'.
    // P1.v1-3: expected_version is now the EXTERNAL version derived
    // from the canonical row (ruleset '9.9.9' + content-hash suffix).
    const isolatedRepo = createInMemoryCommunityProfileRepository();
    // First import cafe-rain so the story_version_uuid resolves.
    const cafeRainStory = { id: 'cafe-rain', title: '雨夜咖啡馆', hook: '凌晨的咖啡馆只剩你和她。' };
    const isolatedProfile = ensureCommunityProfile({
      repository: storyRepo,
      profileRepository: isolatedRepo,
      story_version_uuid: cafeRainIds.story_version_uuid,
      story: cafeRainStory,
      options: {
        source: 'mock-generated',
        generator_version: '9.9.9',
        topics: [
          { label: '雨夜咖啡馆的空间与孤独感', summary: '原作用雨声、玻璃窗、咖啡机的细节建立凌晨的孤独感与两个人之间的距离。' },
        ],
        queries: [{ query: '雨夜咖啡馆 故事', kind: 'web' }],
        knowledge_queries: [{ query: '雨夜咖啡馆 设定', kind: 'knowledge' }],
        hot_keywords: [{ keyword: '雨夜咖啡馆', rationale: '原作标题本身的热榜匹配关键词。' }],
      },
    });
    const isolatedExternalVersion = deriveExternalCommunityProfileVersion(isolatedProfile);
    const mismatchResult = attachRelevance(
      JSON.parse(JSON.stringify(baseResp)),
      {
        story_uuid: cafeRainIds.story_uuid,
        story_version_uuid: cafeRainIds.story_version_uuid,
        community_profile_version: '1.0.0',
      },
      { profileRepository: isolatedRepo },
    );
    await check('D: attachRelevance: wrong-version → result.attached = false + reason = "mismatch"', () => {
      assert.equal(mismatchResult.attached, false);
      assert.equal(mismatchResult.reason, 'mismatch');
      // P1.v1-3: expected_version is the EXTERNAL identity
      // (= generator_version + content-hash suffix), not the raw
      // ruleset version.
      assert.equal(mismatchResult.expected_version, isolatedExternalVersion);
      assert.equal(mismatchResult.actual_version, '1.0.0');
    });

    // Partial identity: missing community_profile_version → reason 'identity_incomplete'
    const partialResult = attachRelevance(
      JSON.parse(JSON.stringify(baseResp)),
      {
        story_uuid: cafeRainIds.story_uuid,
        story_version_uuid: cafeRainIds.story_version_uuid,
        community_profile_version: '',
      },
      { profileRepository: profileRepo },
    );
    await check('D: attachRelevance: missing community_profile_version → reason = "identity_incomplete"', () => {
      assert.equal(partialResult.attached, false);
      assert.equal(partialResult.reason, 'identity_incomplete');
      assert.equal(partialResult.response.relevant_to_story, undefined);
    });

    // ----- E. P1.v1-2-4: HTTP façade 400 mismatch ----------------------------
    await sleep(50);

    const serverProfileRepo = /** @type {any} */ (globalThis).__storyOutsideCommunityRepoForTests;
    if (!serverProfileRepo) {
      throw new Error('server-side communityProfileRepo hook missing');
    }

    // E1. No identity → plain list, no `relevant_to_story`.
    const r1 = await fetch(`${baseUrl}/v1/ecosystem/hot`);
    assert.equal(r1.status, 200);
    const j1 = await r1.json();
    await check('E: GET /v1/ecosystem/hot: 200 + hot[] when no identity', () => {
      assert.ok(Array.isArray(j1.hot));
      assert.ok(j1.hot.length > 0);
    });
    await check('E: GET /v1/ecosystem/hot: no `relevant_to_story` when no identity', () => {
      assert.equal(j1.relevant_to_story, undefined);
    });
    await check('E: GET /v1/ecosystem/hot: entries have no `relevant` when no identity', () => {
      for (const e of j1.hot) assert.equal(e.relevant, undefined);
    });

    // E2. Bad UUID → 400 invalid_identity, no DEV_FLAG leak.
    const r3 = await fetch(`${baseUrl}/v1/ecosystem/hot?story_uuid=not-a-uuid&story_version_uuid=${cafeRainIds.story_version_uuid}&community_profile_version=${encodeURIComponent(communityProfileVersion)}`);
    assert.equal(r3.status, 400);
    const j3 = await r3.json();
    await check('E: GET /v1/ecosystem/hot: bad UUID → 400 invalid_identity (no DEV_FLAG leak)', () => {
      assert.equal(j3.error, 'invalid_identity');
      assert.equal(j3.dev, undefined);
      assert.ok(j3.demo);
    });

    // E3. Mismatch: install a row at "7.7.7" in the server-side repo,
    // request "1.0.0" → 400 community_profile_version_mismatch.
    ensureCommunityProfile({
      repository: storyRepo,
      profileRepository: serverProfileRepo,
      story_version_uuid: cafeRainIds.story_version_uuid,
      story: { id: 'cafe-rain', title: '雨夜咖啡馆', hook: '凌晨的咖啡馆只剩你和她。' },
      options: {
        source: 'mock-generated',
        generator_version: '7.7.7',
      },
    });
    // P1.v1-3: read the canonical profile back from the SERVER-SIDE
    // repo (the route reads from this repo) and derive the expected
    // EXTERNAL version. The internal ruleset '7.7.7' is preserved;
    // the external version gains the content-hash suffix.
    const serverSideProfile = getCommunityProfile({
      profileRepository: serverProfileRepo,
      story_version_uuid: cafeRainIds.story_version_uuid,
    });
    const expectedExternalVersion = deriveExternalCommunityProfileVersion(serverSideProfile);
    const r4 = await fetch(`${baseUrl}/v1/ecosystem/hot?story_uuid=${cafeRainIds.story_uuid}&story_version_uuid=${cafeRainIds.story_version_uuid}&community_profile_version=1.0.0`);
    assert.equal(r4.status, 400);
    const j4 = await r4.json();
    await check('E: GET /v1/ecosystem/hot: P1.v1-2-4 wrong-version → 400 community_profile_version_mismatch', () => {
      assert.equal(j4.error, 'community_profile_version_mismatch');
      // P1.v1-3: expected_community_profile_version is the EXTERNAL
      // identity (ruleset + content-hash suffix), not the raw ruleset.
      assert.equal(j4.expected_community_profile_version, expectedExternalVersion);
      assert.equal(j4.actual_community_profile_version, '1.0.0');
    });
    await check('E: GET /v1/ecosystem/hot: 400 mismatch carries PUBLIC_DECORATE (demo) and NO DEV_FLAG', () => {
      assert.ok(j4.demo);
      assert.equal(j4.dev, undefined);
    });

    // ----- F. P1.v1-2-5: bootstrap response carries community_profile_version ----
    // Restore canonical row first so the bootstrap resolves cleanly.
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
    const bootstrapResp = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ work_id: 'cafe-rain', role_id: 'stranger' }),
    });
    assert.equal(bootstrapResp.status, 200);
    const bootstrapJson = await bootstrapResp.json();
    await check('F: POST /api/sessions response carries community_profile_version', () => {
      assert.ok(typeof bootstrapJson.community_profile_version === 'string');
      assert.ok(bootstrapJson.community_profile_version.length > 0);
    });
    await check('F: POST /api/sessions response carries story_uuid + story_version_uuid', () => {
      assert.equal(bootstrapJson.story_uuid, cafeRainIds.story_uuid);
      assert.equal(bootstrapJson.story_version_uuid, cafeRainIds.story_version_uuid);
    });

    // E4 (cross-layer regression with canonical triple).
    const canonicalVersion = bootstrapJson.community_profile_version;
    const crossResp = await fetch(`${baseUrl}/v1/ecosystem/hot?story_uuid=${cafeRainIds.story_uuid}&story_version_uuid=${cafeRainIds.story_version_uuid}&community_profile_version=${encodeURIComponent(canonicalVersion)}`);
    assert.equal(crossResp.status, 200);
    const crossJson = await crossResp.json();
    await check('E: cross-layer: hot list with canonical triple has relevant_to_story.score > 0', () => {
      assert.ok(crossJson.relevant_to_story);
      assert.ok(crossJson.relevant_to_story.score > 0, `score=${crossJson.relevant_to_story.score}`);
    });
    await check('E: cross-layer: hot list has at least one entry with relevant.score > 0', () => {
      const relatedCount = crossJson.hot.filter(
        (e) => e.relevant && typeof e.relevant.score === 'number' && e.relevant.score > 0,
      ).length;
      assert.ok(relatedCount > 0, `relatedCount=${relatedCount}`);
    });

    // ----- G. static contract: public/ never references /api/(admin|dev)/ -----
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
    await check('G: static contract: grep -rE "/api/(admin|dev)/" public/ returns 0', () => {
      assert.equal(staticContractViolation, 0);
    });

    // ----- H. homeHotModule.js renders the "相关" badge ----------------------
    const moduleSrc = readFileSync(resolve(ROOT, 'public/scripts/homeHotModule.js'), 'utf-8');
    await check('H: homeHotModule.js: source mentions "相关才关联" UI contract', () => {
      assert.match(moduleSrc, /相关才关联/);
    });
    await check('H: homeHotModule.js: source mentions RELATED_LABEL ("相关")', () => {
      assert.match(moduleSrc, /RELATED_LABEL\s*=\s*'相关'/);
    });
    await check('H: homeHotModule.js: source adds `ecosystem-hot-related-badge` element on score > 0', () => {
      assert.match(moduleSrc, /ecosystem-hot-related-badge/);
    });
    await check('H: homeHotModule.js: source reads /v1/ecosystem/hot ONLY', () => {
      assert.ok(!/\/api\/(admin|dev)\//.test(moduleSrc));
      assert.match(moduleSrc, /\/v1\/ecosystem\/hot/);
    });

    // ----- I. server.mjs wire contract ---------------------------------------
    const serverSrc = readFileSync(resolve(ROOT, 'src/server.mjs'), 'utf-8');
    await check('I: src/server.mjs: route /v1/ecosystem/hot is wired', () => {
      assert.match(serverSrc, /pathname === '\/v1\/ecosystem\/hot'/);
    });
    await check('I: src/server.mjs: route forwards `relevant_to_story` field name', () => {
      assert.match(serverSrc, /relevant_to_story/);
    });
    await check('I: src/server.mjs: route uses PUBLIC_DECORATE (no DEV_FLAG leak)', () => {
      const routeBlock = serverSrc.match(/pathname === '\/v1\/ecosystem\/hot'[\s\S]+?Root → static/);
      assert.ok(routeBlock);
      assert.match(routeBlock[0], /PUBLIC_DECORATE\(\)/);
      assert.ok(!/DEV_FLAG/.test(routeBlock[0]));
    });
    await check('I: src/server.mjs: route returns 400 community_profile_version_mismatch (no silent 0 terms)', () => {
      assert.match(serverSrc, /community_profile_version_mismatch/);
    });

    // ----- J. hot.mjs uses canonical field on the v1 schema ------------------
    const hotSrc = readFileSync(resolve(ROOT, 'src/providers/ecosystem/hot.mjs'), 'utf-8');
    await check('J: src/providers/ecosystem/hot.mjs: reads `hot_match_terms` (profile.hot_keywords)', () => {
      assert.match(hotSrc, /hot_match_terms/);
    });
    await check('J: src/providers/ecosystem/hot.mjs: reads `themes` (profile.topics)', () => {
      assert.match(hotSrc, /themes/);
    });
    await check('J: src/providers/ecosystem/hot.mjs: matches against profile via getCommunityProfile', () => {
      assert.match(hotSrc, /getCommunityProfile/);
    });
    await check('J: src/providers/ecosystem/hot.mjs: reads profile.generator_version (v1 schema)', () => {
      assert.match(hotSrc, /profile\.generator_version/);
    });
    await check('J: src/providers/ecosystem/hot.mjs (P1.v1-3): deriveExternalCommunityProfileVersion helper present', () => {
      assert.match(hotSrc, /deriveExternalCommunityProfileVersion/);
    });
    await check('J: src/providers/ecosystem/hot.mjs (P1.v1-3): computeProfileContentHash helper present', () => {
      assert.match(hotSrc, /computeProfileContentHash/);
    });
    await check('J: src/providers/ecosystem/hot.mjs (P1.v1-3): content_hash present in the module', () => {
      assert.match(hotSrc, /content_hash/);
    });

    // ----- K. pure-function relevance (cross-cut sanity) ---------------------
    await check('K: computeRelevance: cafe-rain title hit', () => {
      const r = computeRelevance(
        { title: '雨夜咖啡馆：原作两个角色究竟是谁', tags: [], excerpt: '' },
        ['雨夜咖啡馆'],
        [],
      );
      assert.equal(r.score, 1);
      assert.deepEqual(r.matched_terms, ['雨夜咖啡馆']);
    });
    await check('K: computeRelevance: zero-overlap → score 0', () => {
      const r = computeRelevance(
        { title: '美股财报前瞻', tags: ['美股'], excerpt: 'Q3 财报' },
        ['雨夜咖啡馆', '凌晨便利店'],
        ['极简对话'],
      );
      assert.equal(r.score, 0);
    });
    await check('K: sortByRelevance: related entries first', () => {
      const entries = [
        { rank: 1, heat: 5000, relevant: { score: 1, matched_terms: ['A'] } },
        { rank: 2, heat: 9999, relevant: { score: 3, matched_terms: ['B'] } },
        { rank: 3, heat: 8000, relevant: { score: 0, matched_terms: [] } },
      ];
      const sorted = sortByRelevance(entries);
      assert.equal(sorted[0].heat, 9999);
      assert.equal(sorted[1].heat, 5000);
      assert.equal(sorted[2].heat, 8000);
    });
    void KNOWN_CATEGORIES;

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
    console.log('\nAll ClickUp 16.4 P1.v1-2 fix checks passed.');
  },
  (err) => {
    console.log('\nclickup16-4-p1fix-v1-2 crashed:');
    console.log(err && err.stack ? err.stack : err);
    process.exit(1);
  },
);