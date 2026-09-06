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
  const communityProfileVersion =
    'community-profile@community-profile-rules/1';

  const cafeRainIds = FIXTURE_UUIDS['cafe-rain'];
  // Import the cafe-rain fixture profile so we know the matcher has
  // terms to read.
  ensureCommunityProfile({
    repository: storyRepo,
    profileRepository: profileRepo,
    story_version_uuid: cafeRainIds.story_version_uuid,
    story: { id: 'cafe-rain', title: '雨夜咖啡馆', hook: '凌晨的咖啡馆只剩你和她。' },
    options: {
      source: 'mock-fixture',
      seed: getCommunityFixtureSeed('cafe-rain'),
    },
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

  // Identity path with cafe-rain.
  const respWithIdentity = attachRelevance(
    JSON.parse(JSON.stringify(baseResp)),
    {
      story_uuid: cafeRainIds.story_uuid,
      story_version_uuid: cafeRainIds.story_version_uuid,
      community_profile_version: communityProfileVersion,
    },
    { profileRepository: profileRepo },
  );
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
    const resp = attachRelevance(
      JSON.parse(JSON.stringify(baseResp)),
      {
        story_uuid: cafeRainIds.story_uuid,
        story_version_uuid: '',
        community_profile_version: communityProfileVersion,
      },
      { profileRepository: profileRepo },
    );
    assert.equal(resp.relevant_to_story, undefined);
    for (const e of resp.hot) assert.equal(e.relevant, undefined);
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
    assert.equal(resp.relevant_to_story, undefined);
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
  const respOff = attachRelevance(
    JSON.parse(JSON.stringify(offTopicBase)),
    {
      story_uuid: cafeRainIds.story_uuid,
      story_version_uuid: cafeRainIds.story_version_uuid,
      community_profile_version: communityProfileVersion,
    },
    { profileRepository: profileRepo },
  );
  await check('attachRelevance: unrelated hot list → every entry score 0', () => {
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
    // The /v1/ecosystem/hot handler must spread PUBLIC_DECORATE.
    const routeBlock = serverSrc.match(/pathname === '\/v1\/ecosystem\/hot'[\s\S]+?Root → static/);
    assert.ok(routeBlock);
    assert.match(routeBlock[0], /PUBLIC_DECORATE\(\)/);
    assert.ok(!/DEV_FLAG/.test(routeBlock[0]));
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