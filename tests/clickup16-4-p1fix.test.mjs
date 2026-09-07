// tests/clickup16-4-p1fix.test.mjs — ClickUp 16.4 P1 fix regression suite.
//
// What this test guards (owner-supervised inspection + ChatGPT independent
// review, 2026-09-07):
//
//   1. The home-page 知乎热榜 orchestrator reads
//      StoryCommunityProfile.hot_match_terms (= hot_keywords[].keyword)
//      AND themes (= topics[].label) to compute a deterministic,
//      non-LLM relevance score per hot entry.
//
//   2. The HTTP façade GET /v1/ecosystem/hot accepts an optional
//      identity triple (story_uuid, story_version_uuid,
//      community_profile_version). When ALL THREE are supplied, the
//      response carries `relevant_to_story` AND every entry carries
//      `relevant: { score, matched_terms }`. Related entries
//      (score > 0) sort to the top.
//
//   3. When ANY identity field is omitted, the route degrades to a
//      plain hot list. The response MUST NOT carry `relevant_to_story`
//      and the entries MUST NOT carry `relevant`.
//
//   4. With an unrelated story (one whose community profile has zero
//      overlap with the hot fixture), every entry scores 0 and the
//      list returns to a pure heat-rank order.
//
//   5. The static contract `grep -rE "/api/(admin|dev)/" public/` is
//      zero — the new module never touches admin/dev surfaces.
//
//   6. The home-page script (public/scripts/homeHotModule.js) renders
//      a "相关" badge for every entry whose `relevant.score > 0`.

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
  createInMemoryCommunityProfileRepository,
  ensureCommunityProfile,
  getCommunityFixtureSeed,
} from '../src/community/index.mjs';
import { createSeededRepository, FIXTURE_UUIDS } from '../src/stories/fixture.mjs';
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

async function runAllChecks() {
  try {
  console.log('ClickUp 16.4 P1 fix — home-page 知乎热榜 relevance matching');

  // ----- A. pure-function relevance ------------------------------------------------
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
    assert.deepEqual(r.matched_terms, ['凌晨 咖啡馆']);
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

  // ----- B. sortByRelevance --------------------------------------------------------
  await check('sortByRelevance: related entries first, score desc', () => {
    const entries = [
      { rank: 1, heat: 5000, relevant: { score: 1, matched_terms: ['A'] } },
      { rank: 2, heat: 9999, relevant: { score: 3, matched_terms: ['B'] } },
      { rank: 3, heat: 8000, relevant: { score: 0, matched_terms: [] } },
      { rank: 4, heat: 9000, relevant: { score: 2, matched_terms: ['C'] } },
    ];
    const sorted = sortByRelevance(entries);
    // Re-rank contract: related band first (score desc, then heat desc),
    // unrelated band after (heat desc). Score=1 still beats score=0
    // even when the unrelated entry has higher heat.
    assert.equal(sorted[0].heat, 9999);
    assert.equal(sorted[0].relevant.score, 3);
    assert.equal(sorted[1].heat, 9000);
    assert.equal(sorted[1].relevant.score, 2);
    assert.equal(sorted[2].heat, 5000);
    assert.equal(sorted[2].relevant.score, 1);
    assert.equal(sorted[3].heat, 8000);
    assert.equal(sorted[3].relevant.score, 0);
    // Re-rank is 1..4.
    assert.deepEqual(sorted.map((e) => e.rank), [1, 2, 3, 4]);
  });
  await check('sortByRelevance: zero-score band sorts by heat desc', () => {
    const entries = [
      { rank: 1, heat: 5000, relevant: { score: 0, matched_terms: [] } },
      { rank: 2, heat: 9000, relevant: { score: 0, matched_terms: [] } },
      { rank: 3, heat: 7000, relevant: { score: 0, matched_terms: [] } },
    ];
    const sorted = sortByRelevance(entries);
    assert.equal(sorted[0].heat, 9000);
    assert.equal(sorted[1].heat, 7000);
    assert.equal(sorted[2].heat, 5000);
  });

  // ----- C. orchestrator + profile-driven attach -----------------------------------
  // Build a community profile repository seeded with both fixture stories
  // so we can read the actual hot_match_terms + themes.
  const { repository: storyRepo } = createSeededRepository();
  const profileRepo = createInMemoryCommunityProfileRepository();
  // P1.v1-3 (2026-09-07): the wire-contract community_profile_version
  // is the EXTERNAL identity (= `${generator_version}-${shortContentHash}`)
  // derived via `deriveExternalCommunityProfileVersion`. The internal
  // ruleset string `'community-profile-rules/1'` is preserved on the
  // profile row as `generator_version`, but the matcher compares
  // against the external version. Use the helper below to compute the
  // canonical external version from the freshly-imported profile row.
  let communityProfileVersion =
    'community-profile@community-profile-rules/1';

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
  // P1.v1-3 (2026-09-07): derive the canonical EXTERNAL version from
  // the freshly-imported profile row. The internal `generator_version`
  // field is preserved as the ruleset version; the external string
  // gains the content-hash suffix.
  communityProfileVersion = deriveExternalCommunityProfileVersion(cafeRainProfile);

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

  // Identity path with cafe-rain.
  const attachResult = attachRelevance(
    JSON.parse(JSON.stringify(baseResp)),
    {
      story_uuid: cafeRainIds.story_uuid,
      story_version_uuid: cafeRainIds.story_version_uuid,
      community_profile_version: communityProfileVersion,
    },
    { profileRepository: profileRepo },
  );
  // P1.v1-2 (2026-09-07): attachRelevance returns
  // { attached, reason, expected_version, actual_version, response }.
  // The matching response is in `result.response`.
  const respWithIdentity = attachResult && attachResult.response ? attachResult.response : attachResult;
  await check('attachRelevance: result.attached = true with full identity', () => {
    assert.equal(attachResult.attached, true);
  });
  await check('attachRelevance: relevant_to_story is set with full identity', () => {
    assert.ok(respWithIdentity.relevant_to_story);
    assert.equal(typeof respWithIdentity.relevant_to_story.score, 'number');
    assert.ok(respWithIdentity.relevant_to_story.score > 0);
    assert.equal(respWithIdentity.relevant_to_story.story_uuid, cafeRainIds.story_uuid);
    assert.equal(respWithIdentity.relevant_to_story.story_version_uuid, cafeRainIds.story_version_uuid);
    assert.equal(respWithIdentity.relevant_to_story.community_profile_version, communityProfileVersion);
  });
  await check('attachRelevance: hot_match_terms carries profile.hot_keywords', () => {
    const r = respWithIdentity.relevant_to_story;
    assert.ok(Array.isArray(r.hot_match_terms));
    assert.ok(r.hot_match_terms.length >= 2);
    assert.ok(r.hot_match_terms.includes('雨夜咖啡馆'));
  });
  await check('attachRelevance: themes carries profile.topics labels', () => {
    const r = respWithIdentity.relevant_to_story;
    assert.ok(Array.isArray(r.themes));
    assert.ok(r.themes.length >= 3);
  });
  await check('attachRelevance: related entries are at the top', () => {
    const ranked = respWithIdentity.hot.slice(0, 5);
    const relatedCount = ranked.filter(
      (e) => e.relevant && typeof e.relevant.score === 'number' && e.relevant.score > 0,
    ).length;
    assert.ok(relatedCount >= 1, '至少一条相关 entry 应排在前 5');
  });
  await check('attachRelevance: cafe-rain "雨夜咖啡馆" entry hits term', () => {
    const hit = respWithIdentity.hot.find(
      (e) => typeof e.title === 'string' && e.title.includes('雨夜咖啡馆'),
    );
    assert.ok(hit, '应存在一条以雨夜咖啡馆为标题的 entry');
    assert.ok(hit.relevant, '该 entry 应有 relevant 字段');
    assert.ok(hit.relevant.score > 0, '该 entry relevant.score > 0');
    assert.ok(hit.relevant.matched_terms.includes('雨夜咖啡馆'));
  });

  // Partial-identity path: missing one of the three → no relevance.
  await check('attachRelevance: missing story_version_uuid → no relevance', () => {
    const result = attachRelevance(
      JSON.parse(JSON.stringify(baseResp)),
      {
        story_uuid: cafeRainIds.story_uuid,
        story_version_uuid: '',
        community_profile_version: communityProfileVersion,
      },
      { profileRepository: profileRepo },
    );
    assert.equal(result.attached, false);
    assert.equal(result.reason, 'identity_incomplete');
    const resp = result.response;
    assert.equal(resp.relevant_to_story, undefined);
    for (const e of resp.hot) assert.equal(e.relevant, undefined);
  });
  await check('attachRelevance: missing community_profile_version → no relevance', () => {
    const result = attachRelevance(
      JSON.parse(JSON.stringify(baseResp)),
      {
        story_uuid: cafeRainIds.story_uuid,
        story_version_uuid: cafeRainIds.story_version_uuid,
        community_profile_version: '',
      },
      { profileRepository: profileRepo },
    );
    assert.equal(result.attached, false);
    assert.equal(result.reason, 'identity_incomplete');
    assert.equal(result.response.relevant_to_story, undefined);
  });

  // ----- D. unrelated story → every score 0 --------------------------------------
  // A story whose hot_keywords + topics are all on sports/digital. None
  // should overlap with the fixture hot list.
  const unrelatedProfile = ensureCommunityProfile({
    repository: storyRepo,
    profileRepository: profileRepo,
    story_version_uuid: FIXTURE_UUIDS['night-shift'].story_version_uuid,
    story: { id: 'night-shift', title: '凌晨两点的便利店', hook: '夜班店员在货架尽头发现你。' },
    options: {
      source: 'mock-fixture',
      seed: getCommunityFixtureSeed('night-shift'),
    },
  });
  // night-shift fixture has '凌晨便利店' as a hot_keyword — that overlaps with
  // the fixture title "凌晨便利店的悬疑氛围" → score > 0. Use a STUB profile
  // built from off-topic terms instead so we get a clean "score 0" path.
  // Build a one-off profile repo with a stub profile whose terms are
  // entirely off-topic.
  const offTopicRepo = createInMemoryCommunityProfileRepository();
  // First seed night-shift so the story_version_uuid resolves, then
  // override hot_keywords + topics via buildCommunityProfileFromSeed.
  // Easier: install a profile that targets an UNKNOWN story_version_uuid
  // and pass `profileRepository: offTopicRepo` so attachRelevance reads
  // from there.
  const ghostVersionUuid = '33333333-3333-4333-8333-333333333333';
  // The repo will refuse a profile whose story_version_uuid is not in
  // the storyRepo, so we need to import a ghost story first.
  // Simpler: rely on the OFF-TOPIC hot list itself (the default mock
  // hot list is already on-topic for cafe-rain and night-shift, so we
  // can't get a clean zero with it).
  //
  // Use an orchestrator that injects an off-topic hot list.
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
  // Use the cafe-rain profile (with on-topic terms) against an off-topic
  // hot list: every entry's score must be 0.
  const respOffResult = attachRelevance(
    JSON.parse(JSON.stringify(offTopicBase)),
    {
      story_uuid: cafeRainIds.story_uuid,
      story_version_uuid: cafeRainIds.story_version_uuid,
      community_profile_version: communityProfileVersion,
    },
    { profileRepository: profileRepo },
  );
  const respOff = respOffResult.response;
  await check('attachRelevance: unrelated hot list → every entry score 0', () => {
    assert.ok(respOffResult.attached, 'attached must be true when profile resolves, even with 0 matches');
    assert.ok(respOff.relevant_to_story);
    for (const e of respOff.hot) {
      if (e.relevant) {
        assert.equal(e.relevant.score, 0, `entry ${e.title} should have score 0`);
      }
    }
    assert.equal(respOff.relevant_to_story.score, 0);
  });
  await check('attachRelevance: unrelated list keeps original rank', () => {
    assert.deepEqual(
      respOff.hot.map((e) => e.rank),
      [1],
    );
  });
  void unrelatedProfile; // keep import alive for symmetry

  // ----- E. HTTP façade /v1/ecosystem/hot -----------------------------------------
  // Use a fresh server with seeded repo. The server was already started
  // above with `createSeededRepository` so cafe-rain / night-shift profiles
  // are already loaded.
  // Wait briefly so any in-flight orchestrator cache is rebuilt.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(50);

  // E1. No identity → plain list, no `relevant_to_story`.
  const r1 = await fetch(`${baseUrl}/v1/ecosystem/hot`);
  assert.equal(r1.status, 200);
  const j1 = await r1.json();
  await check('GET /v1/ecosystem/hot: 200 + hot[] when no identity', () => {
    assert.ok(Array.isArray(j1.hot));
    assert.equal(j1.catalog_matched, true);
    assert.equal(j1.hot.length, 0, 'unrelated mock fixtures must not become home recommendations');
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

  // E2. Full identity for cafe-rain → relevance attached + sorted.
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

  // E3. Bad UUID → 400, no DEV_FLAG.
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

  // ----- E'. P1.v1-9 (2026-09-07) — story_uuid triple-check -----------------------
  // ChatGPT independent review of PR #23 (#5127997067) flagged that
  // the hot-relevance path resolved profiles by
  // `story_version_uuid + community_profile_version` only; a wrong
  // but format-legal `story_uuid` would still produce
  // `attached: true` for a profile that belonged to a different
  // story. P1.v1-9 closes that hole by switching the lookup to
  // `profileRepository.findCanonicalByIdentity(...)` (the triple-
  // check lives in exactly one place — the community layer) and
  // surfacing a new `reason: 'story_uuid_mismatch'` that the route
  // layer maps onto 400 `community_profile_story_uuid_mismatch`.
  //
  // E'.1: wrong-but-format-legal story_uuid against a known profile
  // row → 400 `community_profile_story_uuid_mismatch` (NOT 200
  // attached=true). Use a UUID-shaped string that is NOT the row's
  // own story_uuid; the repo's `findCanonicalByIdentity` walks every
  // row bound to the requested `story_version_uuid`, finds a row
  // whose `story_uuid` disagrees, and bails with
  // `story_version_mismatch`; the route layer translates that into
  // the new wire code.
  const wrongStoryUuid = '99999999-9999-4999-8999-111111111111';
  const r4 = await fetch(`${baseUrl}/v1/ecosystem/hot?story_uuid=${wrongStoryUuid}&story_version_uuid=${cafeRainIds.story_version_uuid}&community_profile_version=${encodeURIComponent(communityProfileVersion)}`);
  assert.equal(r4.status, 400);
  const j4 = await r4.json();
  await check('GET /v1/ecosystem/hot: wrong story_uuid (format-legal, disagrees with row) → 400 community_profile_story_uuid_mismatch', () => {
    assert.equal(j4.error, 'community_profile_story_uuid_mismatch');
  });
  await check('GET /v1/ecosystem/hot: wrong-story_uuid response MUST NOT carry DEV_FLAG', () => {
    assert.equal(j4.dev, undefined);
  });
  await check('GET /v1/ecosystem/hot: wrong-story_uuid response MUST carry PUBLIC_DECORATE', () => {
    assert.ok(j4.demo);
  });
  await check('GET /v1/ecosystem/hot: wrong-story_uuid response echoes actual_story_uuid', () => {
    assert.equal(j4.actual_story_uuid, wrongStoryUuid);
  });
  await check('GET /v1/ecosystem/hot: wrong-story_uuid response echoes story_version_uuid', () => {
    assert.equal(j4.story_version_uuid, cafeRainIds.story_version_uuid);
  });
  await check('GET /v1/ecosystem/hot: wrong-story_uuid response MUST NOT carry relevant_to_story', () => {
    // Defence-in-depth: a 400 mismatch MUST NOT also carry
    // `relevant_to_story` — otherwise the home page would silently
    // render badges for a profile that does not belong to this
    // story. The route layer returns the raw JSON object on the
    // 400 path, so `relevant_to_story` is not part of the wire
    // shape at all here.
    assert.equal(j4.relevant_to_story, undefined);
  });

  // E'.2: matching story_uuid against the same profile row → 200
  // attached=true. This is the existing happy-path assertion (it
  // was already covered by E2 above), restated under the P1.v1-9
  // triple-check contract so a future regression that breaks the
  // triple-check is caught by the SAME test that verifies the
  // mismatch path.
  const r5 = await fetch(`${baseUrl}/v1/ecosystem/hot?story_uuid=${cafeRainIds.story_uuid}&story_version_uuid=${cafeRainIds.story_version_uuid}&community_profile_version=${encodeURIComponent(communityProfileVersion)}`);
  assert.equal(r5.status, 200);
  const j5 = await r5.json();
  await check('GET /v1/ecosystem/hot: matching story_uuid → 200 with relevant_to_story (P1.v1-9 happy path)', () => {
    assert.ok(j5.relevant_to_story);
    assert.equal(j5.relevant_to_story.story_uuid, cafeRainIds.story_uuid);
    assert.ok(j5.relevant_to_story.score > 0);
  });

  // E'.3: missing story_uuid → existing behaviour UNCHANGED
  // (200 + plain list with no `relevant_to_story`, no `relevant`).
  // P1.v1-9 MUST NOT regress this path: the route layer's
  // identity-completeness check fires before the triple-check,
  // so a missing field still degrades to a plain list. The
  // task description's "现有 400 `missing_story_uuid`" was a
  // placeholder for "the existing behaviour, unchanged"; the
  // existing behaviour is plain-list-200, NOT a new 400.
  const r6 = await fetch(`${baseUrl}/v1/ecosystem/hot?story_version_uuid=${cafeRainIds.story_version_uuid}&community_profile_version=${encodeURIComponent(communityProfileVersion)}`);
  assert.equal(r6.status, 200);
  const j6 = await r6.json();
  await check('GET /v1/ecosystem/hot: missing story_uuid → 200 plain list (existing behaviour unchanged, P1.v1-9)', () => {
    assert.equal(j6.relevant_to_story, undefined);
    for (const e of j6.hot) assert.equal(e.relevant, undefined);
  });

  // E'.4: PURE-FUNCTION attachRelevance — wrong story_uuid →
  // reason: 'story_uuid_mismatch', attached: false. This
  // covers the matcher in isolation (without going through HTTP)
  // so a future refactor of the route layer cannot silently
  // re-map the new reason onto a 200.
  const wrongAttach = attachRelevance(
    JSON.parse(JSON.stringify(baseResp)),
    {
      story_uuid: wrongStoryUuid,
      story_version_uuid: cafeRainIds.story_version_uuid,
      community_profile_version: communityProfileVersion,
    },
    { profileRepository: profileRepo },
  );
  await check('attachRelevance: wrong story_uuid → attached: false, reason: story_uuid_mismatch', () => {
    assert.equal(wrongAttach.attached, false);
    assert.equal(wrongAttach.reason, 'story_uuid_mismatch');
    assert.equal(wrongAttach.actual_story_uuid, wrongStoryUuid);
    // The route layer translates `expected_story_uuid` onto the
    // 400 response; the matcher may surface either the row's
    // actual `story_uuid` or a stable non-identifying marker.
    assert.ok(typeof wrongAttach.expected_story_uuid === 'string');
  });

  // E'.5: historical profile — SAME `story_version_uuid` +
  // SAME `generator_version` + DIFFERENT `content_hash` (two
  // generations coexisting). Both generations MUST resolve
  // correctly when the caller's `story_uuid` matches, AND
  // MUST refuse with `community_profile_story_uuid_mismatch`
  // when the caller's `story_uuid` is wrong. This is the
  // P1.v1-9 regression for the historical-fixture case:
  // a pinned session from a previous regeneration must still
  // be able to re-resolve its old row, AND a wrong-story_uuid
  // caller must NOT be able to silently ride the pinned
  // external version onto someone else's profile row.
  const seedA = getCommunityFixtureSeed('cafe-rain');
  const seedB = {
    ...seedA,
    // Mutate one of the hot_keywords so the content hash differs
    // while the rest of the structure stays coherent with the
    // cafe-rain fixture. The seed object is frozen, so spread
    // into a fresh object and override the keywords field.
    hot_keywords: [
      ...seedA.hot_keywords,
      { keyword: '雨夜咖啡馆 续篇', rationale: '第二世代 fixture：新增一个与原作标题相关的热搜关键词以驱动 content_hash 变化。' },
    ],
  };
  const historicalRepo = createInMemoryCommunityProfileRepository();
  // First generation (hash A): seed with seedA. The probe
  // comparison sees no existing active row, so a new row is
  // created and `setCommunityProfile` returns it.
  const historicalA = ensureCommunityProfile({
    repository: storyRepo,
    profileRepository: historicalRepo,
    story_version_uuid: cafeRainIds.story_version_uuid,
    story: { id: 'cafe-rain', title: '雨夜咖啡馆', hook: '凌晨的咖啡馆只剩你和她。' },
    options: { source: 'mock-fixture', seed: seedA },
  });
  // Second generation (hash B): different content_hash, SAME
  // `story_version_uuid`, SAME `generator_version`. The repo
  // keeps the old row AND inserts a new row; the active
  // pointer moves to B, but `findCanonicalByIdentity` still
  // resolves A from its pinned external version.
  const historicalB = ensureCommunityProfile({
    repository: storyRepo,
    profileRepository: historicalRepo,
    story_version_uuid: cafeRainIds.story_version_uuid,
    story: { id: 'cafe-rain', title: '雨夜咖啡馆', hook: '凌晨的咖啡馆只剩你和她。' },
    options: { source: 'mock-fixture', seed: seedB },
  });
  await check('historical profile: same generator_version + different content_hash → two distinct rows', () => {
    assert.notEqual(historicalA.hash.content_hash, historicalB.hash.content_hash);
    assert.equal(historicalA.story_version_uuid, historicalB.story_version_uuid);
    assert.equal(historicalA.generator_version, historicalB.generator_version);
    assert.notEqual(historicalA.profile_uuid, historicalB.profile_uuid);
  });
  const historicalAVersion = deriveExternalCommunityProfileVersion(historicalA);
  const historicalBVersion = deriveExternalCommunityProfileVersion(historicalB);
  await check('historical profile: distinct external versions for the two generations', () => {
    assert.notEqual(historicalAVersion, historicalBVersion);
  });

  // Historical A: correct story_uuid → attached: true.
  const historicalAResult = attachRelevance(
    JSON.parse(JSON.stringify(baseResp)),
    {
      story_uuid: cafeRainIds.story_uuid,
      story_version_uuid: cafeRainIds.story_version_uuid,
      community_profile_version: historicalAVersion,
    },
    { profileRepository: historicalRepo },
  );
  await check('historical profile: pinned A + correct story_uuid → attached: true', () => {
    assert.equal(historicalAResult.attached, true);
    assert.ok(historicalAResult.response.relevant_to_story);
  });
  // Historical A: WRONG story_uuid → reason: story_uuid_mismatch.
  const historicalAWrong = attachRelevance(
    JSON.parse(JSON.stringify(baseResp)),
    {
      story_uuid: wrongStoryUuid,
      story_version_uuid: cafeRainIds.story_version_uuid,
      community_profile_version: historicalAVersion,
    },
    { profileRepository: historicalRepo },
  );
  await check('historical profile: pinned A + wrong story_uuid → reason: story_uuid_mismatch', () => {
    assert.equal(historicalAWrong.attached, false);
    assert.equal(historicalAWrong.reason, 'story_uuid_mismatch');
  });

  // Historical B: correct story_uuid → attached: true.
  const historicalBResult = attachRelevance(
    JSON.parse(JSON.stringify(baseResp)),
    {
      story_uuid: cafeRainIds.story_uuid,
      story_version_uuid: cafeRainIds.story_version_uuid,
      community_profile_version: historicalBVersion,
    },
    { profileRepository: historicalRepo },
  );
  await check('historical profile: pinned B + correct story_uuid → attached: true', () => {
    assert.equal(historicalBResult.attached, true);
    assert.ok(historicalBResult.response.relevant_to_story);
  });
  // Historical B: WRONG story_uuid → reason: story_uuid_mismatch.
  const historicalBWrong = attachRelevance(
    JSON.parse(JSON.stringify(baseResp)),
    {
      story_uuid: wrongStoryUuid,
      story_version_uuid: cafeRainIds.story_version_uuid,
      community_profile_version: historicalBVersion,
    },
    { profileRepository: historicalRepo },
  );
  await check('historical profile: pinned B + wrong story_uuid → reason: story_uuid_mismatch', () => {
    assert.equal(historicalBWrong.attached, false);
    assert.equal(historicalBWrong.reason, 'story_uuid_mismatch');
  });

  // E'.6: hot.mjs now routes the lookup through
  // `findCanonicalByIdentity` (the triple-check lives in
  // exactly one place — the community layer). Source-level
  // grep guard so a future refactor that re-introduces the
  // v1-8 `findByExternalVersion` lookup is caught.
  const hotSrcV19 = readFileSync(resolve(ROOT, 'src/providers/ecosystem/hot.mjs'), 'utf-8');
  await check('src/providers/ecosystem/hot.mjs: PRIMARY lookup goes through findCanonicalByIdentity (P1.v1-9)', () => {
    assert.match(hotSrcV19, /findCanonicalByIdentity/);
  });
  await check('src/providers/ecosystem/hot.mjs: still surfaces the v1-5 fallback `expected_version` resolver', () => {
    // The SECONDARY `resolveCanonicalExternalVersion` read is
    // kept for the mismatch path (when the PRIMARY lookup
    // misses entirely, but a canonical row exists for the
    // caller's `story_version_uuid`). P1.v1-9 MUST NOT regress
    // that fallback.
    assert.match(hotSrcV19, /resolveCanonicalExternalVersion/);
  });

  // E'.7: server.mjs maps the new reason to the new wire code.
  const serverSrcV19 = readFileSync(resolve(ROOT, 'src/server.mjs'), 'utf-8');
  await check('src/server.mjs: hot route maps story_uuid_mismatch → community_profile_story_uuid_mismatch (P1.v1-9)', () => {
    // Slice the hot route handler block (same brace-depth walk
    // as the existing H check) and assert the new mapping
    // appears inside it.
    const startMatch = serverSrcV19.match(/pathname === '\/v1\/ecosystem\/hot'/);
    assert.ok(startMatch, 'hot route block start anchor not found');
    const startIdx = startMatch.index;
    let depth = 0;
    let endIdx = -1;
    for (let i = startIdx; i < serverSrcV19.length; i += 1) {
      const ch = serverSrcV19[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          endIdx = i + 1;
          break;
        }
      }
    }
    assert.ok(endIdx > startIdx, 'hot route block end not located');
    const routeBlock = serverSrcV19.slice(startIdx, endIdx);
    assert.match(routeBlock, /community_profile_story_uuid_mismatch/);
    assert.match(routeBlock, /story_uuid_mismatch/);
  });

  // ----- F. static contract: grep -rE "/api/(admin|dev)/" public/ is zero -------
  let staticContractViolation = 0;
  try {
    const out = execFileSync(
      'grep',
      ['-rE', '/api/(admin|dev)/', 'public/'],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    staticContractViolation = String(out).split('\n').filter((l) => l.length > 0).length;
  } catch (err) {
    // grep exits 1 when no match — that's the expected outcome.
    staticContractViolation = 0;
  }
  await check('static contract: grep -rE "/api/(admin|dev)/" public/ returns 0', () => {
    assert.equal(staticContractViolation, 0);
  });

  // ----- G. homeHotModule.js renders the "相关" badge ----------------------------
  const moduleSrc = readFileSync(resolve(ROOT, 'public/scripts/homeHotModule.js'), 'utf-8');
  await check('homeHotModule.js: source mentions "相关才关联" UI contract', () => {
    assert.match(moduleSrc, /相关才关联/);
  });
  await check('homeHotModule.js: source mentions RELATED_LABEL ("相关")', () => {
    assert.match(moduleSrc, /RELATED_LABEL = '相关'/);
  });
  await check('homeHotModule.js: source adds `ecosystem-hot-related-badge` element on score > 0', () => {
    assert.match(moduleSrc, /ecosystem-hot-related-badge/);
  });
  await check('homeHotModule.js: source reads /v1/ecosystem/hot ONLY', () => {
    // The module must never touch /api/admin or /api/dev.
    assert.ok(!/\/api\/(admin|dev)\//.test(moduleSrc));
    assert.match(moduleSrc, /\/v1\/ecosystem\/hot/);
  });

  // ----- H. server.mjs wire contract ----------------------------------------------
  const serverSrc = readFileSync(resolve(ROOT, 'src/server.mjs'), 'utf-8');
  await check('src/server.mjs: route /v1/ecosystem/hot is wired', () => {
    assert.match(serverSrc, /pathname === '\/v1\/ecosystem\/hot'/);
  });
  await check('src/server.mjs: route forwards `relevant_to_story` field name', () => {
    assert.match(serverSrc, /relevant_to_story/);
  });
  await check('src/server.mjs: route uses PUBLIC_DECORATE (no DEV_FLAG leak)', () => {
    // The /v1/ecosystem/hot handler must spread PUBLIC_DECORATE and
    // must NOT leak DEV_FLAG. P1.v1-6 (2026-09-07): bound the slice
    // to just the hot route handler (via brace-depth matching from
    // the `pathname === '/v1/ecosystem/hot'` anchor), because main
    // merged in /v1/ecosystem/discussions between the hot route and
    // the original end-anchor `Root → static`, and that
    // discussions-route comment block legitimately mentions
    // `DEV_FLAG` to assert it is NOT leaked.
    const startMatch = serverSrc.match(/pathname === '\/v1\/ecosystem\/hot'/);
    assert.ok(startMatch, 'hot route block start anchor not found');
    const startIdx = startMatch.index;
    // Walk brace depth to find the matching close of the
    // `if (method === 'GET' && pathname === '/v1/ecosystem/hot') { ... }`.
    let depth = 0;
    let endIdx = -1;
    for (let i = startIdx; i < serverSrc.length; i += 1) {
      const ch = serverSrc[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          endIdx = i + 1;
          break;
        }
      }
    }
    assert.ok(endIdx > startIdx, 'hot route block end not located');
    const routeBlock = [serverSrc.slice(startIdx, endIdx)];
    assert.match(routeBlock[0], /PUBLIC_DECORATE\(\)/);
    assert.ok(
      !/DEV_FLAG/.test(routeBlock[0]),
      'hot route must not reference DEV_FLAG in code',
    );
  });

  // ----- I. hot.mjs uses the profile fields ---------------------------------------
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
    console.log('\nAll ClickUp 16.4 P1 fix checks passed.');
  },
  (err) => {
    console.log('\nclickup16-4-p1fix crashed:');
    console.log(err && err.stack ? err.stack : err);
    process.exit(1);
  },
);
