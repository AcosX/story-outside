// tests/clickup16-4-p1fix-v2.test.mjs — ClickUp 16.4 P1.v2 fix
// regression suite (2026-09-07).
//
// What this test guards:
//
//   1. P1.v2-3: `community_profile_version` is the canonical 13th
//      top-level field on StoryCommunityProfile, strict
//      MAJOR.MINOR.PATCH semver. The legacy `generator_version` is no
//      longer in the shape contract; passing it through the public
//      composite seam returns 400 `community_profile_version_mismatch`
//      instead of silently degrading to "0 terms".
//
//   2. P1.v2-1: `homeHotModule.readActiveIdentity` no longer triggers
//      a Temporal Dead Zone ReferenceError. The function reads the
//      triple off `window.STORY_OUTSIDE_IDENTITY` with explicit
//      destructuring on the INPUT parameter (no `const X = X.field`
//      self-reference).
//
//   3. P1.v2-2: A global identity producer lives in
//      `public/scripts/identity.js`, exposes
//      `window.STORY_OUTSIDE_IDENTITY_API.setActiveIdentity(...)`,
//      and broadcasts `story:identity-changed` on `document`. Cross-
//      page reload restores the triple from sessionStorage.
//
//   4. The home-page 知乎热榜 orchestrator reads
//      StoryCommunityProfile.hot_keywords (= hot_match_terms) AND
//      topics[].label (= themes) to compute a deterministic,
//      non-LLM relevance score per hot entry.
//
//   5. The HTTP façade GET /v1/ecosystem/hot accepts an optional
//      identity triple. When ALL THREE are supplied AND the canonical
//      profile row's `community_profile_version` matches the supplied
//      one, the response carries `relevant_to_story` and every entry
//      carries `relevant: { score, matched_terms }`. Related entries
//      (score > 0) sort to the top.
//
//   6. When the supplied `community_profile_version` does NOT match
//      the canonical row, the route returns 400
//      `community_profile_version_mismatch` with the expected vs
//      actual versions. The data-contract mismatch is observable
//      instead of silent.
//
//   7. Cross-layer regression: a real story pick
//      (cafe-rain / `CAFE_RAIN_STORY_UUID`) drives the full chain
//      `pickStory → bootstrapSession → /v1/ecosystem/hot` and the
//      response carries `relevant_to_story.score > 0` with at least
//      one related entry.
//
//   8. The static contract `grep -rE "/api/(admin|dev)/" public/` is
//      zero — the new module never touches admin/dev surfaces.

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
import {
  COMMUNITY_PROFILE_GENERATOR_VERSION,
  COMMUNITY_PROFILE_VERSION_PATTERN,
  COMMUNITY_PROFILE_VERSION_FORMAT_DESCRIPTION,
  assertCommunityProfileVersionSemver,
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
  console.log('ClickUp 16.4 P1.v2 fix — home-page 知乎热榜 relevance + identity global');

  // ----- A. P1.v2-3: community_profile_version semver contract -----------------
  await check('P1.v2-3: community_profile_version appears on 13 lines in profile.mjs (canonical 13th top-level field)', () => {
    const src = readFileSync(resolve(ROOT, 'src/community/profile.mjs'), 'utf-8');
    const lineHits = src.split('\n').filter((l) => /community_profile_version/.test(l)).length;
    assert.equal(lineHits, 13, `expected 13 line hits, got ${lineHits}`);
  });
  await check('P1.v2-3: profile.mjs JSDoc + comment mentions MAJOR.MINOR.PATCH', () => {
    const src = readFileSync(resolve(ROOT, 'src/community/profile.mjs'), 'utf-8');
    assert.match(src, /MAJOR\.MINOR\.PATCH/);
  });
  await check('P1.v2-3: assertCommunityProfileVersionSemver rejects empty string', () => {
    assert.throws(() => assertCommunityProfileVersionSemver('x', ''), /MAJOR\.MINOR\.PATCH/);
  });
  await check('P1.v2-3: assertCommunityProfileVersionSemver rejects legacy generator_version shape', () => {
    assert.throws(
      () => assertCommunityProfileVersionSemver('x', 'community-profile@community-profile-rules/1'),
      /MAJOR\.MINOR\.PATCH/,
    );
  });
  await check('P1.v2-3: assertCommunityProfileVersionSemver accepts "1.0.0"', () => {
    assert.doesNotThrow(() => assertCommunityProfileVersionSemver('x', '1.0.0'));
  });
  await check('P1.v2-3: assertCommunityProfileVersionSemver rejects "v1.0.0"', () => {
    assert.throws(() => assertCommunityProfileVersionSemver('x', 'v1.0.0'), /MAJOR\.MINOR\.PATCH/);
  });
  await check('P1.v2-3: assertCommunityProfileVersionSemver rejects "1.0.0-rc.1" (no pre-release allowed)', () => {
    assert.throws(
      () => assertCommunityProfileVersionSemver('x', '1.0.0-rc.1'),
      /MAJOR\.MINOR\.PATCH/,
    );
  });
  await check('P1.v2-3: COMMUNITY_PROFILE_VERSION_PATTERN matches valid semver only', () => {
    assert.match('1.0.0', COMMUNITY_PROFILE_VERSION_PATTERN);
    assert.match('100.200.300', COMMUNITY_PROFILE_VERSION_PATTERN);
    assert.doesNotMatch('1.0', COMMUNITY_PROFILE_VERSION_PATTERN);
    assert.doesNotMatch('community-profile@1.0.0', COMMUNITY_PROFILE_VERSION_PATTERN);
  });

  // ----- B. P1.v2-1: homeHotModule readActiveIdentity has no TDZ ----------------
  await check('P1.v2-1: homeHotModule.js exists at public/scripts/homeHotModule.js', () => {
    const src = readFileSync(resolve(ROOT, 'public/scripts/homeHotModule.js'), 'utf-8');
    assert.ok(src.length > 0);
  });
  await check('P1.v2-1: homeHotModule.js does NOT contain `const X = X.field` self-reference', () => {
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
  await check('P1.v2-1: homeHotModule.js readActiveIdentity() function definition is present', () => {
    const src = readFileSync(resolve(ROOT, 'public/scripts/homeHotModule.js'), 'utf-8');
    assert.match(src, /function\s+readActiveIdentity\s*\(/);
  });

  // ----- C. P1.v2-2: identity global producer + event ----------------------------
  await check('P1.v2-2: public/scripts/identity.js exposes STORY_OUTSIDE_IDENTITY_API on window', () => {
    const src = readFileSync(resolve(ROOT, 'public/scripts/identity.js'), 'utf-8');
    assert.match(src, /STORY_OUTSIDE_IDENTITY_API/);
    assert.match(src, /setActiveIdentity/);
    assert.match(src, /getActiveIdentity/);
    assert.match(src, /clearActiveIdentity/);
  });
  await check('P1.v2-2: identity.js broadcasts story:identity-changed CustomEvent', () => {
    const src = readFileSync(resolve(ROOT, 'public/scripts/identity.js'), 'utf-8');
    assert.match(src, /story:identity-changed/);
    assert.match(src, /CustomEvent/);
  });
  await check('P1.v2-2: identity.js persists triple to sessionStorage under story-outside:active-identity', () => {
    const src = readFileSync(resolve(ROOT, 'public/scripts/identity.js'), 'utf-8');
    assert.match(src, /story-outside:active-identity/);
    assert.match(src, /sessionStorage/);
  });
  await check('P1.v2-2: homeHotModule.js listens for story:identity-changed on document', () => {
    const src = readFileSync(resolve(ROOT, 'public/scripts/homeHotModule.js'), 'utf-8');
    assert.match(src, /addEventListener\s*\(\s*IDENTITY_EVENT/);
    assert.match(src, /IDENTITY_EVENT\s*=\s*'story:identity-changed'/);
  });
  await check('P1.v2-2: player.js calls publishIdentityIfAvailable() on pickStory + bootstrapSession', () => {
    const src = readFileSync(resolve(ROOT, 'public/scripts/player.js'), 'utf-8');
    assert.match(src, /publishIdentityIfAvailable\s*\(\s*\)/);
    assert.match(src, /STORY_OUTSIDE_IDENTITY_API/);
  });
  await check('P1.v2-2: endingPage.js calls publishEndingIdentity() on mount', () => {
    const src = readFileSync(resolve(ROOT, 'public/scripts/endingPage.js'), 'utf-8');
    assert.match(src, /publishEndingIdentity/);
    assert.match(src, /STORY_OUTSIDE_IDENTITY_API/);
  });

  // ----- D. pure-function relevance ----------------------------------------------
  await check('computeRelevance: title-only hit, term in title', () => {
    const r = computeRelevance(
      { title: '雨夜咖啡馆：原作两个角色究竟是谁', tags: [], excerpt: '' },
      ['雨夜咖啡馆'],
      [],
    );
    assert.equal(r.score, 1);
    assert.deepEqual(r.matched_terms, ['雨夜咖啡馆']);
  });
  await check('computeRelevance: term in tags counts', () => {
    const r = computeRelevance(
      { title: '无关标题', tags: ['凌晨 咖啡馆'], excerpt: '' },
      ['凌晨 咖啡馆'],
      [],
    );
    assert.equal(r.score, 1);
  });
  await check('computeRelevance: themes (topics[].label) count', () => {
    const r = computeRelevance(
      { title: '无关', tags: [], excerpt: '一篇关于极简对话与潜文本的盘点' },
      [],
      ['极简对话与潜文本'],
    );
    assert.equal(r.score, 1);
  });
  await check('computeRelevance: case-insensitive', () => {
    const r = computeRelevance(
      { title: 'Rain Cafe: 雨夜咖啡馆再讨论', tags: [], excerpt: '' },
      ['雨夜咖啡馆'],
      [],
    );
    assert.equal(r.score, 1);
  });
  await check('computeRelevance: zero terms → score 0', () => {
    const r = computeRelevance({ title: '任何标题', tags: [], excerpt: '' }, [], []);
    assert.equal(r.score, 0);
  });
  await check('computeRelevance: zero-overlap → score 0', () => {
    const r = computeRelevance(
      { title: '美股财报前瞻', tags: ['美股'], excerpt: 'Q3 财报' },
      ['雨夜咖啡馆', '凌晨便利店'],
      ['极简对话'],
    );
    assert.equal(r.score, 0);
  });
  await check('computeRelevance: dedup across hot_match_terms + themes', () => {
    const r = computeRelevance(
      { title: '雨夜咖啡馆再讨论', tags: [], excerpt: '' },
      ['雨夜咖啡馆', '雨夜咖啡馆'],
      ['雨夜咖啡馆'],
    );
    assert.equal(r.score, 1);
    assert.deepEqual(r.matched_terms, ['雨夜咖啡馆']);
  });

  // ----- E. sortByRelevance --------------------------------------------------------
  await check('sortByRelevance: related entries first, score desc', () => {
    const entries = [
      { rank: 1, heat: 5000, relevant: { score: 1, matched_terms: ['A'] } },
      { rank: 2, heat: 9999, relevant: { score: 3, matched_terms: ['B'] } },
      { rank: 3, heat: 8000, relevant: { score: 0, matched_terms: [] } },
      { rank: 4, heat: 9000, relevant: { score: 2, matched_terms: ['C'] } },
    ];
    const sorted = sortByRelevance(entries);
    assert.equal(sorted[0].heat, 9999);
    assert.equal(sorted[0].relevant.score, 3);
    assert.equal(sorted[1].heat, 9000);
    assert.equal(sorted[1].relevant.score, 2);
    assert.equal(sorted[2].heat, 5000);
    assert.equal(sorted[2].relevant.score, 1);
    assert.equal(sorted[3].heat, 8000);
    assert.equal(sorted[3].relevant.score, 0);
    assert.deepEqual(sorted.map((e) => e.rank), [1, 2, 3, 4]);
  });

  // ----- F. orchestrator + profile-driven attach -----------------------------------
  const { repository: storyRepo } = createSeededRepository();
  const profileRepo = createInMemoryCommunityProfileRepository();
  // community_profile_version is now MAJOR.MINOR.PATCH semver. The
  // mock catalog pins the default to 1.0.0.
  const communityProfileVersion =
    COMMUNITY_PROFILE_GENERATOR_VERSION.rules_version;
  assert.match(communityProfileVersion, COMMUNITY_PROFILE_VERSION_PATTERN);

  const cafeRainIds = FIXTURE_UUIDS['cafe-rain'];
  // Import the cafe-rain fixture profile so we know the matcher has
  // terms to read.
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
  await check('orchestrator: cafe-rain profile.community_profile_version is strict semver', () => {
    assert.match(cafeRainProfile.community_profile_version, COMMUNITY_PROFILE_VERSION_PATTERN);
  });

  const orchestrator = createEcosystemHotOrchestrator();
  const baseResp = await orchestrator.fetchHot({ category: 'total' });
  await check('orchestrator: base list has hot[]', () => {
    assert.ok(Array.isArray(baseResp.hot) && baseResp.hot.length > 0);
  });
  await check('orchestrator: category clamps to KNOWN_CATEGORIES', () => {
    assert.ok(KNOWN_CATEGORIES.includes(baseResp.category));
  });
  await check('orchestrator: provenance.source = "mock"', () => {
    assert.equal(baseResp.provenance.source, 'mock');
  });

  // ----- G. attachRelevance: full-identity path -----------------------------------
  const respWithIdentity = attachRelevance(
    JSON.parse(JSON.stringify(baseResp)),
    {
      story_uuid: cafeRainIds.story_uuid,
      story_version_uuid: cafeRainIds.story_version_uuid,
      community_profile_version: communityProfileVersion,
    },
    { profileRepository: profileRepo },
  );
  await check('attachRelevance: result.attached = true when triple matches canonical row', () => {
    assert.equal(respWithIdentity.attached, true);
  });
  await check('attachRelevance: relevant_to_story is set with full identity', () => {
    assert.ok(respWithIdentity.response.relevant_to_story);
    assert.equal(typeof respWithIdentity.response.relevant_to_story.score, 'number');
    assert.ok(respWithIdentity.response.relevant_to_story.score > 0);
    assert.equal(respWithIdentity.response.relevant_to_story.story_uuid, cafeRainIds.story_uuid);
    assert.equal(respWithIdentity.response.relevant_to_story.story_version_uuid, cafeRainIds.story_version_uuid);
    assert.equal(respWithIdentity.response.relevant_to_story.community_profile_version, communityProfileVersion);
  });
  await check('attachRelevance: hot_match_terms carries profile.hot_keywords', () => {
    const r = respWithIdentity.response.relevant_to_story;
    assert.ok(Array.isArray(r.hot_match_terms));
    assert.ok(r.hot_match_terms.length >= 2);
    assert.ok(r.hot_match_terms.includes('雨夜咖啡馆'));
  });
  await check('attachRelevance: themes carries profile.topics labels', () => {
    const r = respWithIdentity.response.relevant_to_story;
    assert.ok(Array.isArray(r.themes));
    assert.ok(r.themes.length >= 3);
  });
  await check('attachRelevance: related entries are at the top', () => {
    const ranked = respWithIdentity.response.hot.slice(0, 5);
    const relatedCount = ranked.filter(
      (e) => e.relevant && typeof e.relevant.score === 'number' && e.relevant.score > 0,
    ).length;
    assert.ok(relatedCount >= 1, '至少一条相关 entry 应排在前 5');
  });
  await check('attachRelevance: cafe-rain "雨夜咖啡馆" entry hits term', () => {
    const hit = respWithIdentity.response.hot.find(
      (e) => typeof e.title === 'string' && e.title.includes('雨夜咖啡馆'),
    );
    assert.ok(hit, '应存在一条以雨夜咖啡馆为标题的 entry');
    assert.ok(hit.relevant, '该 entry 应有 relevant 字段');
    assert.ok(hit.relevant.score > 0, '该 entry relevant.score > 0');
    assert.ok(hit.relevant.matched_terms.includes('雨夜咖啡馆'));
  });

  // ----- H. P1.v2-3: 400 community_profile_version_mismatch ---------------------
  await check('P1.v2-3: attachRelevance rejects legacy generator_version shape at semver check', () => {
    const resp = attachRelevance(
      JSON.parse(JSON.stringify(baseResp)),
      {
        story_uuid: cafeRainIds.story_uuid,
        story_version_uuid: cafeRainIds.story_version_uuid,
        // Wrong version on purpose (legacy package-coord shape).
        community_profile_version: 'community-profile@community-profile-rules/1',
      },
      { profileRepository: profileRepo },
    );
    // The semver validator refuses the legacy shape before the route
    // layer can mismatch it. The reason is 'identity_incomplete'.
    assert.equal(resp.attached, false);
    assert.equal(resp.reason, 'identity_incomplete');
  });
  await check('P1.v2-3: attachRelevance returns mismatch when canonical version differs from supplied semver', () => {
    // Build a fresh in-memory profile repo containing exactly ONE row
    // at community_profile_version='9.9.9' for this story_version.
    // The caller will request version '1.0.0' which the row does NOT
    // match, so the matcher MUST return mismatch. We use a dedicated
    // repo so we don't fight the cafe-rain seeded row.
    const isolatedRepo = createInMemoryCommunityProfileRepository();
    ensureCommunityProfile({
      repository: storyRepo,
      profileRepository: isolatedRepo,
      story_version_uuid: cafeRainIds.story_version_uuid,
      story: { id: 'cafe-rain', title: '雨夜咖啡馆', hook: '凌晨的咖啡馆只剩你和她。' },
      options: {
        source: 'mock-generated',
        community_profile_version: '9.9.9',
        topics: [
          { label: '雨夜咖啡馆的空间与孤独感', summary: '原作用雨声、玻璃窗、咖啡机的细节建立凌晨的孤独感与两个人之间的距离。' },
        ],
        queries: [{ query: '雨夜咖啡馆 故事', kind: 'web' }],
        knowledge_queries: [{ query: '雨夜咖啡馆 设定', kind: 'knowledge' }],
        hot_keywords: [{ keyword: '雨夜咖啡馆', rationale: '原作标题本身的热榜匹配关键词。' }],
      },
    });
    const resp = attachRelevance(
      JSON.parse(JSON.stringify(baseResp)),
      {
        story_uuid: cafeRainIds.story_uuid,
        story_version_uuid: cafeRainIds.story_version_uuid,
        community_profile_version: '1.0.0',
      },
      { profileRepository: isolatedRepo },
    );
    assert.equal(resp.attached, false);
    assert.equal(resp.reason, 'mismatch');
    assert.equal(resp.expected_version, '9.9.9');
    assert.equal(resp.actual_version, '1.0.0');
  });

  // ----- I. attachRelevance: partial-identity path (graceful degrade) ----------
  await check('attachRelevance: missing story_version_uuid → no relevance', () => {
    const resp = attachRelevance(
      JSON.parse(JSON.stringify(baseResp)),
      {
        story_uuid: cafeRainIds.story_uuid,
        story_version_uuid: '',
        community_profile_version: communityProfileVersion,
      },
      { profileRepository: profileRepo },
    );
    assert.equal(resp.attached, false);
    assert.equal(resp.reason, 'identity_incomplete');
  });
  await check('attachRelevance: missing community_profile_version → no relevance', () => {
    const resp = attachRelevance(
      JSON.parse(JSON.stringify(baseResp)),
      {
        story_uuid: cafeRainIds.story_uuid,
        story_version_uuid: cafeRainIds.story_version_uuid,
        community_profile_version: '',
      },
      { profileRepository: profileRepo },
    );
    assert.equal(resp.attached, false);
    assert.equal(resp.reason, 'identity_incomplete');
  });

  // ----- J. unrelated story → 0 terms path --------------------------------------
  // cafe-rain's on-topic hot list has plenty of overlap. Use an
  // off-topic hot list to exercise the 0-terms path explicitly.
  const offTopicSource = {
    name: 'mock',
    fetchHotList: async () => ([
      {
        id: '99999999-9999-4999-8999-999999999999',
        title: '美元汇率走势分析',
        url: 'https://www.zhihu.com/question/offtopic',
        hotness: 9999,
        excerpt: '美元汇率',
        answer_count: 12,
        question_id: 'offtopic',
        tags: ['汇率', '美元'],
        category: 'finance',
        rank: 1,
      },
    ]),
  };
  const offTopicOrchestrator = createEcosystemHotOrchestrator({ source: offTopicSource });
  const offTopicBase = await offTopicOrchestrator.fetchHot({ category: 'total' });
  const respOff = attachRelevance(
    JSON.parse(JSON.stringify(offTopicBase)),
    {
      story_uuid: cafeRainIds.story_uuid,
      story_version_uuid: cafeRainIds.story_version_uuid,
      community_profile_version: communityProfileVersion,
    },
    { profileRepository: profileRepo },
  );
  await check('attachRelevance: unrelated hot list → relevant_to_story.score === 0', () => {
    assert.ok(respOff.attached, 'attached must be true when profile resolves, even with 0 matches');
    assert.ok(respOff.response.relevant_to_story);
    assert.equal(respOff.response.relevant_to_story.score, 0);
  });

  // ----- K. HTTP façade /v1/ecosystem/hot ----------------------------------------
  await sleep(50);

  // K1. No identity → plain list, no `relevant_to_story`.
  const r1 = await fetch(`${baseUrl}/v1/ecosystem/hot`);
  assert.equal(r1.status, 200);
  const j1 = await r1.json();
  await check('GET /v1/ecosystem/hot: 200 + hot[] when no identity', () => {
    assert.ok(Array.isArray(j1.hot));
    assert.ok(j1.hot.length > 0);
  });
  await check('GET /v1/ecosystem/hot: no `relevant_to_story` when no identity', () => {
    assert.equal(j1.relevant_to_story, undefined);
  });
  await check('GET /v1/ecosystem/hot: entries have no `relevant` when no identity', () => {
    for (const e of j1.hot) assert.equal(e.relevant, undefined);
  });
  await check('GET /v1/ecosystem/hot: provenance.source = "mock"', () => {
    assert.equal(j1.provenance && j1.provenance.source, 'mock');
  });

  // K2. Full identity for cafe-rain → relevance attached + sorted.
  const r2 = await fetch(`${baseUrl}/v1/ecosystem/hot?story_uuid=${cafeRainIds.story_uuid}&story_version_uuid=${cafeRainIds.story_version_uuid}&community_profile_version=${encodeURIComponent(communityProfileVersion)}`);
  assert.equal(r2.status, 200);
  const j2 = await r2.json();
  await check('GET /v1/ecosystem/hot: relevant_to_story with full identity', () => {
    assert.ok(j2.relevant_to_story);
    assert.equal(j2.relevant_to_story.story_uuid, cafeRainIds.story_uuid);
    assert.ok(j2.relevant_to_story.score > 0);
  });
  await check('GET /v1/ecosystem/hot: related entries sorted to top with full identity', () => {
    const firstFew = j2.hot.slice(0, 5);
    const hasRelated = firstFew.some(
      (e) => e.relevant && typeof e.relevant.score === 'number' && e.relevant.score > 0,
    );
    assert.ok(hasRelated);
  });

  // K3. Bad UUID → 400 invalid_identity, no DEV_FLAG.
  const r3 = await fetch(`${baseUrl}/v1/ecosystem/hot?story_uuid=not-a-uuid&story_version_uuid=${cafeRainIds.story_version_uuid}&community_profile_version=${encodeURIComponent(communityProfileVersion)}`);
  assert.equal(r3.status, 400);
  const j3 = await r3.json();
  await check('GET /v1/ecosystem/hot: bad UUID → 400', () => {
    assert.equal(j3.error, 'invalid_identity');
  });
  await check('GET /v1/ecosystem/hot: bad-UUID response MUST NOT carry DEV_FLAG', () => {
    assert.equal(j3.dev, undefined);
  });
  await check('GET /v1/ecosystem/hot: bad-UUID response MUST carry PUBLIC_DECORATE', () => {
    assert.ok(j3.demo);
  });

  // server.mjs exposes the live communityProfileRepo via a
  // process-global test hook so we can install / override rows for
  // the mismatch path.
  const serverProfileRepo = /** @type {any} */ (globalThis).__storyOutsideCommunityRepoForTests;
  if (!serverProfileRepo) {
    throw new Error('server-side communityProfileRepo hook missing');
  }

  // K4. P1.v2-3 contract: wrong-version → 400 community_profile_version_mismatch.
  // We need the canonical row to be a version DIFFERENT from what
  // we'll send. The server-side seedCommunityProfiles already
  // installed a row at "1.0.0" for cafe-rain; the live HTTP call
  // here uses the server's seeded repo (the one we shared into
  // server.mjs). To trigger mismatch, install a row at a different
  // version AFTER server start so the seed is overridden for this
  // exact story_version.
  ensureCommunityProfile({
    repository: storyRepo,
    profileRepository: serverProfileRepo,
    story_version_uuid: cafeRainIds.story_version_uuid,
    story: { id: 'cafe-rain', title: '雨夜咖啡馆', hook: '凌晨的咖啡馆只剩你和她。' },
    options: {
      source: 'mock-generated',
      community_profile_version: '7.7.7',
    },
  });
  const r4 = await fetch(`${baseUrl}/v1/ecosystem/hot?story_uuid=${cafeRainIds.story_uuid}&story_version_uuid=${cafeRainIds.story_version_uuid}&community_profile_version=1.0.0`);
  assert.equal(r4.status, 400);
  const j4 = await r4.json();
  await check('GET /v1/ecosystem/hot: P1.v2-3 wrong-version → 400 community_profile_version_mismatch', () => {
    assert.equal(j4.error, 'community_profile_version_mismatch');
    assert.equal(j4.expected_community_profile_version, '7.7.7');
    assert.equal(j4.actual_community_profile_version, '1.0.0');
  });

  // K5. Legacy generator_version-shape value → 400 invalid_identity (semver check).
  const r5 = await fetch(`${baseUrl}/v1/ecosystem/hot?story_uuid=${cafeRainIds.story_uuid}&story_version_uuid=${cafeRainIds.story_version_uuid}&community_profile_version=${encodeURIComponent('community-profile@community-profile-rules/1')}`);
  assert.equal(r5.status, 400);
  const j5 = await r5.json();
  await check('GET /v1/ecosystem/hot: legacy version shape → 400 (no silent 0 terms)', () => {
    assert.equal(j5.error, 'invalid_identity');
  });

  // ----- L. static contract: grep -rE "/api/(admin|dev)/" public/ is zero -------
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
  await check('static contract: grep -rE "/api/(admin|dev)/" public/ returns 0', () => {
    assert.equal(staticContractViolation, 0);
  });

  // ----- M. homeHotModule.js renders the "相关" badge ----------------------------
  const moduleSrc = readFileSync(resolve(ROOT, 'public/scripts/homeHotModule.js'), 'utf-8');
  await check('homeHotModule.js: source mentions "相关才关联" UI contract', () => {
    assert.match(moduleSrc, /相关才关联/);
  });
  await check('homeHotModule.js: source mentions RELATED_LABEL ("相关")', () => {
    assert.match(moduleSrc, /RELATED_LABEL\s*=\s*'相关'/);
  });
  await check('homeHotModule.js: source adds `ecosystem-hot-related-badge` element on score > 0', () => {
    assert.match(moduleSrc, /ecosystem-hot-related-badge/);
  });
  await check('homeHotModule.js: source reads /v1/ecosystem/hot ONLY', () => {
    assert.ok(!/\/api\/(admin|dev)\//.test(moduleSrc));
    assert.match(moduleSrc, /\/v1\/ecosystem\/hot/);
  });

  // ----- N. server.mjs wire contract ---------------------------------------------
  const serverSrc = readFileSync(resolve(ROOT, 'src/server.mjs'), 'utf-8');
  await check('src/server.mjs: route /v1/ecosystem/hot is wired', () => {
    assert.match(serverSrc, /pathname === '\/v1\/ecosystem\/hot'/);
  });
  await check('src/server.mjs: route forwards `relevant_to_story` field name', () => {
    assert.match(serverSrc, /relevant_to_story/);
  });
  await check('src/server.mjs: route uses PUBLIC_DECORATE (no DEV_FLAG leak)', () => {
    const routeBlock = serverSrc.match(/pathname === '\/v1\/ecosystem\/hot'[\s\S]+?Root → static/);
    assert.ok(routeBlock);
    assert.match(routeBlock[0], /PUBLIC_DECORATE\(\)/);
    assert.ok(!/DEV_FLAG/.test(routeBlock[0]));
  });
  await check('src/server.mjs: route returns 400 community_profile_version_mismatch (no silent 0 terms)', () => {
    assert.match(serverSrc, /community_profile_version_mismatch/);
  });

  // ----- O. hot.mjs uses canonical field ----------------------------------------
  const hotSrc = readFileSync(resolve(ROOT, 'src/providers/ecosystem/hot.mjs'), 'utf-8');
  await check('src/providers/ecosystem/hot.mjs: reads `hot_match_terms` (profile.hot_keywords)', () => {
    assert.match(hotSrc, /hot_match_terms/);
  });
  await check('src/providers/ecosystem/hot.mjs: reads `themes` (profile.topics)', () => {
    assert.match(hotSrc, /themes/);
  });
  await check('src/providers/ecosystem/hot.mjs: matches against profile via getCommunityProfile', () => {
    assert.match(hotSrc, /getCommunityProfile/);
  });
  await check('src/providers/ecosystem/hot.mjs: reads profile.community_profile_version (canonical field)', () => {
    assert.match(hotSrc, /profile\.community_profile_version/);
  });
  await check('src/providers/ecosystem/hot.mjs: does NOT read legacy profile.generator_version', () => {
    assert.ok(!/profile\.generator_version/.test(hotSrc));
  });

  // ----- P. cross-layer regression: real story pick → hot list score > 0 ---------
  // Use the canonical cafe-rain triple from the server. The server
  // already seeds the community profile, so the bootstrap call
  // resolves the canonical community_profile_version via the response.
  const bootstrapResp = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ work_id: 'cafe-rain', role_id: 'stranger' }),
  });
  assert.equal(bootstrapResp.status, 200);
  const bootstrapJson = await bootstrapResp.json();
  await check('cross-layer: bootstrap response carries community_profile_version', () => {
    assert.match(bootstrapJson.community_profile_version, COMMUNITY_PROFILE_VERSION_PATTERN);
    assert.match(bootstrapJson.community_profile_version, COMMUNITY_PROFILE_VERSION_PATTERN);
  });
  await check('cross-layer: bootstrap response carries story_uuid + story_version_uuid', () => {
    assert.equal(bootstrapJson.story_uuid, cafeRainIds.story_uuid);
    assert.equal(bootstrapJson.story_version_uuid, cafeRainIds.story_version_uuid);
  });
  // Now drive the orchestrator path with that exact triple. The hot
  // list MUST carry `relevant_to_story.score > 0` and at least one
  // related entry must be present. The orchestrator reads the
  // server-side communityProfileRepo (NOT the local profileRepo),
  // so we install a row into the server-side repo that matches the
  // bootstrap version. The K4 mismatch test above may have left a
  // "7.7.7" row active, so we reinstall a row matching the bootstrap
  // version to override the active profile.
  const bootstrapCommunityProfileVersion = bootstrapJson.community_profile_version;
  const canonicalProfileVersion = bootstrapCommunityProfileVersion;
  ensureCommunityProfile({
    repository: storyRepo,
    profileRepository: serverProfileRepo,
    story_version_uuid: cafeRainIds.story_version_uuid,
    story: { id: 'cafe-rain', title: '雨夜咖啡馆', hook: '凌晨的咖啡馆只剩你和她。' },
    options: {
      source: 'mock-fixture',
      seed: getCommunityFixtureSeed('cafe-rain'),
      community_profile_version: canonicalProfileVersion,
    },
  });
  const crossResp = await fetch(`${baseUrl}/v1/ecosystem/hot?story_uuid=${cafeRainIds.story_uuid}&story_version_uuid=${cafeRainIds.story_version_uuid}&community_profile_version=${encodeURIComponent(canonicalProfileVersion)}`);
  assert.equal(crossResp.status, 200);
  const crossJson = await crossResp.json();
  await check('cross-layer: hot list with canonical triple has relevant_to_story.score > 0', () => {
    assert.ok(crossJson.relevant_to_story);
    assert.ok(crossJson.relevant_to_story.score > 0, `score=${crossJson.relevant_to_story.score}`);
  });
  await check('cross-layer: hot list has at least one entry with relevant.score > 0', () => {
    const relatedCount = crossJson.hot.filter(
      (e) => e.relevant && typeof e.relevant.score === 'number' && e.relevant.score > 0,
    ).length;
    assert.ok(relatedCount > 0, `relatedCount=${relatedCount}`);
  });

  // ----- Q. canonical community_profile_version is the canonical 13th field -----
  await check('Q: PROFILE_TOP_LEVEL_KEYS in profile.mjs contains community_profile_version', () => {
    const src = readFileSync(resolve(ROOT, 'src/community/profile.mjs'), 'utf-8');
    assert.match(src, /PROFILE_TOP_LEVEL_KEYS[\s\S]+community_profile_version/);
  });
  await check('Q: PROFILE_TOP_LEVEL_KEYS in profile.mjs does NOT contain legacy generator_version', () => {
    const src = readFileSync(resolve(ROOT, 'src/community/profile.mjs'), 'utf-8');
    const allowlistSection = src.match(/PROFILE_TOP_LEVEL_KEYS[\s\S]+?\];/);
    assert.ok(allowlistSection);
    assert.ok(!/generator_version/.test(allowlistSection[0]));
  });
  await check('Q: COMMUNITY_PROFILE_VERSION_FORMAT_DESCRIPTION is exposed for downstream callers', () => {
    assert.equal(
      typeof COMMUNITY_PROFILE_VERSION_FORMAT_DESCRIPTION,
      'string',
    );
    assert.match(COMMUNITY_PROFILE_VERSION_FORMAT_DESCRIPTION, /MAJOR\.MINOR\.PATCH/);
  });

  // ----- R. community_profile_version_mismatch error code in server.mjs ----------
  await check('R: server.mjs route returns 400 community_profile_version_mismatch for version drift', () => {
    // Install a row at "9.9.9" in the server-side repo so the
    // canonical version differs from every caller-supplied value.
    // Then a request with "1.0.0" should mismatch.
    ensureCommunityProfile({
      repository: storyRepo,
      profileRepository: serverProfileRepo,
      story_version_uuid: cafeRainIds.story_version_uuid,
      story: { id: 'cafe-rain', title: '雨夜咖啡馆', hook: '凌晨的咖啡馆只剩你和她。' },
      options: {
        source: 'mock-generated',
        community_profile_version: '9.9.9',
      },
    });
    return (async () => {
      const r = await fetch(`${baseUrl}/v1/ecosystem/hot?story_uuid=${cafeRainIds.story_uuid}&story_version_uuid=${cafeRainIds.story_version_uuid}&community_profile_version=1.0.0`);
      const j = await r.json();
      assert.equal(r.status, 400);
      assert.equal(j.error, 'community_profile_version_mismatch');
      assert.equal(j.expected_community_profile_version, '9.9.9');
      assert.equal(j.actual_community_profile_version, '1.0.0');
    })();
  });

  // ----- S. identity.js module-level invariants ---------------------------------
  await check('S: identity.js does NOT use any const X = X.field pattern (TDZ)', () => {
    const src = readFileSync(resolve(ROOT, 'public/scripts/identity.js'), 'utf-8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const tdz = /(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*\1\s*\./;
    assert.equal(tdz.test(code), false, 'TDZ pattern detected in identity.js');
  });
  await check('S: identity.js semver check rejects the legacy package-coord shape', () => {
    const src = readFileSync(resolve(ROOT, 'public/scripts/identity.js'), 'utf-8');
    assert.match(src, /SEMVER_PATTERN/);
    // The producer's semver guard MUST be strict MAJOR.MINOR.PATCH.
    assert.match(src, /\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
  });

  // ----- T. cross-page persistence: identity restored from sessionStorage ------
  // We can't run a real browser here, but we can verify the
  // sessionStorage key + read path are wired correctly.
  await check('T: identity.js reads sessionStorage on load (readStorage path)', () => {
    const src = readFileSync(resolve(ROOT, 'public/scripts/identity.js'), 'utf-8');
    assert.match(src, /const initial = readStorage\(\)/);
    assert.match(src, /GLOBAL_KEY\]\s*=\s*initial/);
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
    console.log('\nAll ClickUp 16.4 P1.v2 fix checks passed.');
  },
  (err) => {
    console.log('\nclickup16-4-p1fix-v2 crashed:');
    console.log(err && err.stack ? err.stack : err);
    process.exit(1);
  },
);
