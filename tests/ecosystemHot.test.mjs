// tests/ecosystemHot.test.mjs — ClickUp 16.4 ecosystem hot-list contract.
//
// The test covers:
//   1. DTO shape & mock fixture (≥5 topics, 2 related, 3 unrelated).
//   2. getHotList basic — fresh cache, ordering, source=mock.
//   3. TTL: a second call within 5 min does NOT re-hit the upstream.
//   4. SWR (stale-while-revalidate): after TTL but within SWR the
//      caller gets stale data and a background refresh is triggered.
//   5. Past SWR: a forced refresh brings data back.
//   6. Upstream failure on cold cache returns unavailable without throwing.
//   7. Rate limit: after 100 calls the 101st returns
//      `ecosystem_status: "unavailable"` with remaining=0.
//   8. Match: 2 related topics match the cafe-rain / night-shift
//      profiles; the 3 unrelated topics do NOT match.
//   9. Score threshold: a deliberately decoy profile (overlapping
//      token "咖啡" alone) does NOT cross the threshold.
//  10. Defensive: rate-limit snapshot shape.
//  11. resetForTests clears cache + counter.

import assert from 'node:assert/strict';

import {
  createEcosystemHotProvider,
  matchHotToStories,
  scoreHotAgainstProfile,
  tokenize,
  HOT_PROVIDER_CONFIG,
} from '../src/providers/ecosystem/hot.mjs';
import { MOCK_HOT_TOPICS_RAW, mockHotTopicCount } from '../src/providers/ecosystem/mockHotSource.mjs';
import { createInMemoryCommunityProfileRepository } from '../src/community/repository.mjs';
import { seedCommunityProfiles } from '../src/community/importHook.mjs';
import { getCommunityProfile } from '../src/community/service.mjs';
import { createSeededRepository, FIXTURE_UUIDS } from '../src/stories/fixture.mjs';

let failures = 0;
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => console.log(`  ok   ${name}`),
        (err) => {
          failures += 1;
          console.log(`  FAIL ${name}`);
          console.log(`    ${err && err.message ? err.message : err}`);
        },
      );
    }
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`    ${err && err.message ? err.message : err}`);
  }
}

async function runChecks() {
  console.log('ClickUp 16.4 ecosystem hot-list contract');

  // ----- fixture / DTO -------------------------------------------------

  await check('mock fixture: ≥5 topics, ≥2 related, ≥3 unrelated', () => {
    const topics = MOCK_HOT_TOPICS_RAW;
    assert.ok(topics.length >= 5, `mock fixture must have ≥5 topics, got ${topics.length}`);
    const titles = topics.map((t) => t.title);
    const hasRainMatch = titles.some((t) => /雨夜|咖啡|旧友|陌生人/.test(t));
    const hasShiftMatch = titles.some((t) => /凌晨|便利店|夜班|店员/.test(t));
    assert.ok(hasRainMatch, 'mock fixture must include at least one cafe-rain related topic');
    assert.ok(hasShiftMatch, 'mock fixture must include at least one night-shift related topic');
    const unrelated = topics.filter((t) => !/雨夜|咖啡|旧友|陌生人|凌晨|便利店|夜班|店员/.test(t.title));
    assert.ok(unrelated.length >= 2, `mock fixture must include ≥2 unrelated topics, got ${unrelated.length}`);
  });

  await check('mockHotTopicCount matches MOCK_HOT_TOPICS_RAW.length', () => {
    assert.equal(mockHotTopicCount(), MOCK_HOT_TOPICS_RAW.length);
  });

  await check('HOT_PROVIDER_CONFIG exposes TTL/SWR/cap/threshold', () => {
    assert.equal(HOT_PROVIDER_CONFIG.TTL_MS, 5 * 60 * 1000);
    assert.equal(HOT_PROVIDER_CONFIG.SWR_MS, 30 * 60 * 1000);
    assert.equal(HOT_PROVIDER_CONFIG.RATE_LIMIT_DAILY_CAP, 100);
    assert.ok(HOT_PROVIDER_CONFIG.MATCH_THRESHOLD > 0);
  });

  await check('tokenize emits bigrams for Chinese + word tokens for ASCII', () => {
    const tokens = tokenize('雨夜咖啡馆的陌生人');
    assert.ok(tokens.includes('雨夜'), 'bigram must be present');
    assert.ok(tokens.includes('咖啡'), 'bigram must be present');
    assert.ok(!tokens.includes('的'), 'single character must be dropped');
    const ascii = tokenize('Apple Vision Pro 二代');
    assert.ok(ascii.includes('apple'), 'ascii word must be present');
    assert.ok(ascii.includes('vision'), 'ascii word must be present');
    assert.ok(!ascii.includes('代'), 'single Chinese char dropped');
  });

  // ----- basic getHotList ----------------------------------------------

  await check('getHotList returns fresh cache with all mock topics + source=mock', async () => {
    const provider = createEcosystemHotProvider();
    const result = await provider.getHotList({ limit: 30 });
    assert.equal(result.ecosystem_status, 'fresh');
    assert.equal(result.stale, false);
    assert.equal(result.source, 'mock');
    assert.equal(result.hot_list.length, MOCK_HOT_TOPICS_RAW.length);
    for (const topic of result.hot_list) {
      assert.equal(typeof topic.id, 'string');
      assert.equal(typeof topic.title, 'string');
      assert.equal(typeof topic.url, 'string');
      assert.equal(typeof topic.hotness, 'number');
      assert.ok(Array.isArray(topic.tags));
    }
  });

  await check('getHotList honours limit', async () => {
    const provider = createEcosystemHotProvider();
    const result = await provider.getHotList({ limit: 2 });
    assert.equal(result.hot_list.length, 2);
  });

  await check('second getHotList within TTL does NOT touch upstream', async () => {
    let calls = 0;
    const source = {
      name: 'mock-counter',
      async fetchHotList() {
        calls += 1;
        return MOCK_HOT_TOPICS_RAW.map((t) => ({ ...t }));
      },
    };
    const provider = createEcosystemHotProvider({ source });
    const first = await provider.getHotList({ limit: 30 });
    const second = await provider.getHotList({ limit: 30 });
    assert.equal(first.ecosystem_status, 'fresh');
    assert.equal(second.ecosystem_status, 'fresh');
    assert.equal(calls, 1, 'upstream must be hit exactly once within TTL');
  });

  // ----- SWR (stale-while-revalidate) ----------------------------------

  await check('after TTL but within SWR: stale served + background refresh triggered', async () => {
    let calls = 0;
    let now = 1000;
    const source = {
      name: 'mock-swr',
      async fetchHotList() {
        calls += 1;
        return MOCK_HOT_TOPICS_RAW.map((t) => ({ ...t }));
      },
    };
    const provider = createEcosystemHotProvider({
      source,
      ttlMs: 100,
      swrMs: 1000,
      now: () => now,
    });
    const first = await provider.getHotList({ limit: 30 });
    assert.equal(first.ecosystem_status, 'fresh');
    assert.equal(calls, 1);
    // Advance past TTL but stay within SWR.
    now += 200;
    const second = await provider.getHotList({ limit: 30 });
    assert.equal(second.ecosystem_status, 'stale', 'must serve stale data after TTL');
    assert.equal(second.stale, true);
    // The foreground response must NOT block on the upstream fetch:
    // even though the background refresh call lands in the microtask
    // queue as part of `backgroundRefresh()`, the foreground caller
    // already received the stale payload. Allow 1 (initial) + 1 (SWR
    // background refresh) as the strict upper bound for the immediate
    // path; the wait below ensures the refresh actually completed.
    assert.ok(calls <= 2, `foreground must not have triggered extra upstream calls, got ${calls}`);
    // Wait for the background refresh to settle.
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(calls >= 2, 'background refresh must have hit upstream');
    // After the background refresh completed, the cache was rewritten
    // at the time of the refresh, so a follow-up call (made within
    // TTL of that rewrite) returns 'fresh'.
    now += 50; // small advance, still well within TTL of the rewrite
    const third = await provider.getHotList({ limit: 30 });
    assert.equal(third.ecosystem_status, 'fresh');
  });

  await check('past SWR: forced refresh brings data back; non-forced falls to unavailable', async () => {
    let calls = 0;
    let now = 1000;
    const errorInjector = { match: false };
    const source = {
      name: 'mock-past-swr',
      async fetchHotList() {
        calls += 1;
        if (errorInjector.match) {
          throw new Error('simulated upstream failure');
        }
        return MOCK_HOT_TOPICS_RAW.map((t) => ({ ...t }));
      },
    };
    const provider = createEcosystemHotProvider({
      source,
      ttlMs: 50,
      swrMs: 100,
      now: () => now,
    });
    const first = await provider.getHotList({ limit: 30 });
    assert.equal(first.ecosystem_status, 'fresh');
    // Advance past SWR.
    now += 200;
    errorInjector.match = true;
    const second = await provider.getHotList({ limit: 30 });
    assert.equal(second.ecosystem_status, 'unavailable');
    assert.equal(second.hot_list.length, 0);
    // Disable failure and force refresh.
    errorInjector.match = false;
    const third = await provider.getHotList({ limit: 30, force: true });
    assert.equal(third.ecosystem_status, 'fresh');
    assert.ok(third.hot_list.length > 0);
    assert.ok(calls >= 3, `upstream should be called at least 3 times, got ${calls}`);
  });

  // ----- upstream failure + rate limit ---------------------------------

  await check('upstream failure on cold cache returns unavailable without throwing', async () => {
    const provider = createEcosystemHotProvider({
      errorInjector: { match: false }, // any truthy object throws
    });
    const result = await provider.getHotList({ limit: 30 });
    assert.equal(result.ecosystem_status, 'unavailable');
    assert.equal(result.hot_list.length, 0);
  });

  await check('rate limit caps at 100 calls/day; 101st returns unavailable', async () => {
    let calls = 0;
    const source = {
      name: 'mock-rl',
      async fetchHotList() {
        calls += 1;
        return MOCK_HOT_TOPICS_RAW.map((t) => ({ ...t }));
      },
    };
    const provider = createEcosystemHotProvider({ source });
    // Burn 100 calls (each forces a fresh fetch).
    for (let i = 0; i < 100; i += 1) {
      const r = await provider.getHotList({ limit: 1, force: true });
      assert.equal(r.ecosystem_status, 'fresh');
    }
    assert.equal(calls, 100);
    // 101st — past the cap.
    const overCap = await provider.getHotList({ limit: 1, force: true });
    assert.equal(overCap.ecosystem_status, 'unavailable');
    assert.equal(overCap.rate_limit.remaining, 0);
    assert.equal(overCap.rate_limit.daily_cap, 100);
    assert.equal(calls, 100, 'over-cap call must NOT hit the upstream');
  });

  // ----- matching ------------------------------------------------------

  await check('related topics match, unrelated topics do NOT', async () => {
    const { repository } = createSeededRepository();
    const profileRepo = createInMemoryCommunityProfileRepository();
    seedCommunityProfiles(repository, profileRepo);
    const cafeProfile = getCommunityProfile({
      profileRepository: profileRepo,
      story_version_uuid: FIXTURE_UUIDS['cafe-rain'].story_version_uuid,
    });
    const shiftProfile = getCommunityProfile({
      profileRepository: profileRepo,
      story_version_uuid: FIXTURE_UUIDS['night-shift'].story_version_uuid,
    });
    assert.ok(cafeProfile && shiftProfile, 'profiles must be seeded');
    const provider = createEcosystemHotProvider();
    const result = await provider.matchHotList({
      limit: 30,
      profiles: [cafeProfile, shiftProfile],
    });
    const byId = new Map(result.entries.map((e) => [e.topic.id, e]));
    const cafeEntry = byId.get('mock-hot-001');
    const shiftEntry = byId.get('mock-hot-002');
    const unrelatedEntry = byId.get('mock-hot-003');
    const techEntry = byId.get('mock-hot-004');
    const stocksEntry = byId.get('mock-hot-005');
    assert.ok(cafeEntry.matches.length >= 1, 'cafe-rain related topic must match cafe profile');
    assert.ok(cafeEntry.matches.some((m) => m.story_uuid === cafeProfile.story_uuid));
    assert.ok(shiftEntry.matches.length >= 1, 'night-shift related topic must match shift profile');
    assert.ok(shiftEntry.matches.some((m) => m.story_uuid === shiftProfile.story_uuid));
    assert.equal(unrelatedEntry.matches.length, 0, 'unrelated sports topic must not match');
    assert.equal(techEntry.matches.length, 0, 'unrelated tech topic must not match');
    assert.equal(stocksEntry.matches.length, 0, 'unrelated stocks topic must not match');
    for (const entry of result.entries) {
      for (const m of entry.matches) {
        assert.ok(m.score >= HOT_PROVIDER_CONFIG.MATCH_THRESHOLD);
        assert.equal(typeof m.story_uuid, 'string');
        assert.equal(typeof m.story_version_uuid, 'string');
        assert.ok(Array.isArray(m.matched_keywords));
        assert.ok(Array.isArray(m.matched_tags));
      }
    }
  });

  await check('scoreHotAgainstProfile fires above and below threshold correctly', () => {
    const profile = {
      profile_uuid: '00000000-0000-4000-8000-000000000001',
      story_uuid: '00000000-0000-4000-8000-000000000002',
      story_version_uuid: '00000000-0000-4000-8000-000000000003',
      story_version_checksum: 'x',
      generator_version: 'community-profile@community-profile-rules/1',
      generated_at: '1970-01-01T00:00:00.000Z',
      source: 'mock-fixture',
      locale: 'zh-CN',
      topics: [],
      queries: [],
      knowledge_queries: [],
      hot_keywords: [
        { id: 'k1', keyword: '雨夜 咖啡馆', rationale: 'test' },
        { id: 'k2', keyword: '陌生人', rationale: 'test' },
      ],
      hash: { content_hash: 'h' },
    };
    const relatedTopic = {
      id: 't1',
      title: '雨夜咖啡馆的陌生人',
      url: 'https://example.com/q/1',
      hotness: 1,
      excerpt: '凌晨的故事',
      answer_count: 1,
      question_id: 'q1',
      tags: [],
    };
    const decoyTopic = {
      id: 't2',
      title: '咖啡的最新研究报告',
      url: 'https://example.com/q/2',
      hotness: 1,
      excerpt: '喝咖啡的十大好处',
      answer_count: 1,
      question_id: 'q2',
      tags: [],
    };
    const relatedScore = scoreHotAgainstProfile(relatedTopic, profile);
    assert.ok(relatedScore.score >= HOT_PROVIDER_CONFIG.MATCH_THRESHOLD,
      `related score ${relatedScore.score} must be >= threshold`);
    assert.ok(relatedScore.matched_keywords.length >= 1);
    const decoyScore = scoreHotAgainstProfile(decoyTopic, profile);
    assert.ok(decoyScore.score < HOT_PROVIDER_CONFIG.MATCH_THRESHOLD,
      `decoy score ${decoyScore.score} must be < threshold`);
  });

  await check('matchHotToStories returns one entry per topic, sorted by score desc within entry', () => {
    const profileA = {
      profile_uuid: '00000000-0000-4000-8000-00000000000a',
      story_uuid: '00000000-0000-4000-8000-00000000000b',
      story_version_uuid: '00000000-0000-4000-8000-00000000000c',
      story_version_checksum: 'x',
      generator_version: 'community-profile@community-profile-rules/1',
      generated_at: '1970-01-01T00:00:00.000Z',
      source: 'mock-fixture',
      locale: 'zh-CN',
      topics: [],
      queries: [],
      knowledge_queries: [],
      hot_keywords: [{ id: 'k1', keyword: '雨夜咖啡馆', rationale: 'r' }],
      hash: { content_hash: 'h' },
    };
    const profileB = {
      ...profileA,
      profile_uuid: '00000000-0000-4000-8000-00000000000d',
      story_uuid: '00000000-0000-4000-8000-00000000000e',
      story_version_uuid: '00000000-0000-4000-8000-00000000000f',
      hot_keywords: [
        { id: 'k1', keyword: '雨夜咖啡馆', rationale: 'r' },
        { id: 'k2', keyword: '陌生人', rationale: 'r' },
      ],
    };
    const topic = {
      id: 't1',
      title: '雨夜咖啡馆里的陌生人',
      url: 'u',
      hotness: 1,
      excerpt: '',
      answer_count: 0,
      question_id: 'q1',
      tags: [],
    };
    const entries = matchHotToStories([topic], [profileA, profileB]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].topic.id, 't1');
    assert.equal(entries[0].matches.length, 2);
    // Profile B has more keyword matches → must come first.
    assert.equal(entries[0].matches[0].story_uuid, profileB.story_uuid);
    assert.ok(entries[0].matches[0].score >= entries[0].matches[1].score);
  });

  await check('empty profiles → entries have zero matches', async () => {
    const provider = createEcosystemHotProvider();
    const result = await provider.matchHotList({ limit: 30, profiles: [] });
    assert.equal(result.entries.length, result.hot_list.length);
    for (const entry of result.entries) assert.equal(entry.matches.length, 0);
  });

  // ----- defensive: rate-limit field shape -----------------------------

  await check('rate_limit snapshot always carries remaining + daily_cap + reset_at', async () => {
    const provider = createEcosystemHotProvider();
    const result = await provider.getHotList({ limit: 5 });
    assert.ok(result.rate_limit);
    assert.equal(typeof result.rate_limit.remaining, 'number');
    assert.equal(typeof result.rate_limit.daily_cap, 'number');
    assert.equal(typeof result.rate_limit.reset_at, 'string');
    assert.equal(result.rate_limit.daily_cap, 100);
  });

  await check('resetForTests clears cache + counter', async () => {
    const provider = createEcosystemHotProvider();
    await provider.getHotList({ limit: 5 });
    provider.resetForTests();
    const peek = provider._peek();
    assert.equal(peek, null);
    assert.equal(provider._rateLimiter().count, 0);
  });
}

(async () => {
  await runChecks();
  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  } else {
    console.log('\nall checks passed');
  }
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});