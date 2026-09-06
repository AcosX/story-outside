// tests/ecosystemSearch.test.mjs — ClickUp 16.2 ecosystem search contract.
//
// Asserts the four ClickUp 16.2 description contracts for the ending-page
// "故事之外 · 知乎在讨论什么" module:
//   * mock adapter returns 5 fixed discussion results + sorts by
//     authority/relevance/interactions (本地去重排序).
//   * second call with the same (story_version_uuid, community_profile_version)
//     does NOT call the adapter — cache hit.
//   * adapter throws → outcome is {results:[], ecosystem_status:"unavailable"}
//     and a short retry window is installed.
//   * does NOT depend on auth_configured=true (no Access Secret /
//     zhihu-cli invocations in the test path).

import assert from 'node:assert/strict';

import {
  buildEcosystemSearchCacheKey,
  buildEcosystemUnavailableOutcome,
  createInMemoryEcosystemSearchCacheRepository,
  createMockSearchAdapter,
  createRealSearchAdapter,
  dedupeAndRankZhihuDiscussions,
  ECOSYSTEM_SEARCH_DEFAULT_LIMIT,
  ECOSYSTEM_SEARCH_MOCK_FIXTURES,
  ECOSYSTEM_SEARCH_DEFAULT_TTL_MS,
  normaliseZhihuDiscussionResult,
  searchZhihuDiscussions,
} from '../src/providers/ecosystem/index.mjs';
import { FIXTURE_UUIDS } from '../src/stories/fixture.mjs';

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
  console.log('ClickUp 16.2 ecosystem-search contract');

  // ----- DTO + normaliser --------------------------------------------

  await check('normaliseZhihuDiscussionResult: requires title + http(s) url', () => {
    const r = normaliseZhihuDiscussionResult({
      title: '示例问题',
      url: 'https://www.zhihu.com/question/1',
      kind: 'question',
      authority_level: 'high',
    });
    assert.equal(r.title, '示例问题');
    assert.equal(r.url, 'https://www.zhihu.com/question/1');
    assert.equal(r.kind, 'question');
    assert.equal(r.authority_level, 'high');
    assert.equal(r.attribution, 'zhihu');
    assert.equal(r.excerpt, '');
    // 缺 url 必报错
    let threw = false;
    try {
      normaliseZhihuDiscussionResult({ title: 'no-url' });
    } catch (err) {
      threw = true;
      assert.match(String(err && err.message), /url required/);
    }
    assert.ok(threw, 'must reject result without url');
    // javascript: 协议必须拒绝
    threw = false;
    try {
      normaliseZhihuDiscussionResult({ title: 'xss', url: 'javascript:alert(1)' });
    } catch (err) {
      threw = true;
      assert.match(String(err && err.message), /must be http\(s\)/);
    }
    assert.ok(threw, 'must reject javascript: url');
  });

  await check('buildEcosystemUnavailableOutcome: produces stable envelope shape', () => {
    const o = buildEcosystemUnavailableOutcome({
      story_version_uuid: FIXTURE_UUIDS['cafe-rain'].story_version_uuid,
      community_profile_version: 'community-profile@community-profile-rules/1',
      code: 'search_failed',
      message: 'mock: boom',
    });
    assert.equal(o.ecosystem_status, 'unavailable');
    assert.deepEqual(o.results, []);
    assert.equal(o.error_code, 'search_failed');
    assert.equal(o.cached, false);
    assert.equal(o.scope.story_version_uuid, FIXTURE_UUIDS['cafe-rain'].story_version_uuid);
  });

  // ----- Dedupe + rank ------------------------------------------------

  await check('dedupeAndRankZhihuDiscussions: collapses by url, sorts by authority/relevance/interactions', () => {
    // 两条同 url，第二条权威度更高 → 第二条赢
    const a = {
      result_uuid: 'a', story_version_uuid: 'sv', community_profile_version: 'v',
      query_id: 'q1', query_text: 'q', kind: 'question',
      title: 'same url', excerpt: '', author_name: '', author_avatar: '',
      url: 'https://x/y/1', relevance_score: 0.5, authority_level: 'low',
      like_count: 0, comment_count: 0, top_comment: '',
      published_at: '2026-01-01T00:00:00.000Z', attribution: 'zhihu',
    };
    const b = { ...a, result_uuid: 'b', authority_level: 'high', relevance_score: 0.6 };
    const ranked = dedupeAndRankZhihuDiscussions([a, b]);
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].result_uuid, 'b');
    // 三条不同 url：权威度优先级
    const c = { ...a, url: 'https://x/y/2', authority_level: 'medium', relevance_score: 0.9 };
    const d = { ...a, url: 'https://x/y/3', authority_level: 'low', relevance_score: 0.95 };
    const ranked2 = dedupeAndRankZhihuDiscussions([c, d, b]);
    assert.equal(ranked2.length, 3);
    // b (high) > c (medium) > d (low)
    assert.equal(ranked2[0].result_uuid, 'b');
    assert.equal(ranked2[1].url, c.url);
    assert.equal(ranked2[2].url, d.url);
  });

  // ----- Mock adapter: 5 results + dedupe + sort ---------------------

  await check('mock adapter returns 5 fixed results + cache miss-then-hit', async () => {
    const cache = createInMemoryEcosystemSearchCacheRepository();
    const slugResolver = (sv) => {
      for (const [slug, ids] of Object.entries(FIXTURE_UUIDS)) {
        if (ids.story_version_uuid === sv) return slug;
      }
      return null;
    };
    const adapter = createMockSearchAdapter({ slugResolver });
    const queries = [
      { id: 'q1', query: '雨夜咖啡馆 故事 解读' },
      { id: 'q2', query: '雨夜咖啡馆 角色分析' },
      { id: 'q3', query: '雨夜咖啡馆 极简对话' },
    ];
    const first = await searchZhihuDiscussions({
      adapter,
      cacheRepository: cache,
      story_version_uuid: FIXTURE_UUIDS['cafe-rain'].story_version_uuid,
      community_profile_version: 'community-profile@community-profile-rules/1',
      queries,
    });
    assert.equal(first.ecosystem_status, 'ok');
    assert.equal(first.cached, false);
    assert.equal(first.provider, 'mock');
    assert.ok(first.results.length >= 3 && first.results.length <= ECOSYSTEM_SEARCH_DEFAULT_LIMIT,
      `results.length=${first.results.length} should be 3..${ECOSYSTEM_SEARCH_DEFAULT_LIMIT}`);
    for (const r of first.results) {
      assert.equal(r.story_version_uuid, FIXTURE_UUIDS['cafe-rain'].story_version_uuid);
      assert.equal(r.community_profile_version, 'community-profile@community-profile-rules/1');
      assert.match(r.url, /^https?:\/\//);
      assert.ok(['question', 'answer', 'article', 'video', 'mixed'].includes(r.kind));
      assert.ok(['low', 'medium', 'high', 'top'].includes(r.authority_level));
    }
    // 同一 (story_version, profile_version) 第二次调用 → cache hit
    let adapterCalls = 0;
    const trackingAdapter = {
      name: 'tracking-mock',
      async searchZhihuDiscussions(input) {
        adapterCalls += 1;
        return adapter.searchZhihuDiscussions(input);
      },
    };
    const cache2 = createInMemoryEcosystemSearchCacheRepository();
    await searchZhihuDiscussions({
      adapter: trackingAdapter,
      cacheRepository: cache2,
      story_version_uuid: FIXTURE_UUIDS['cafe-rain'].story_version_uuid,
      community_profile_version: 'community-profile@community-profile-rules/1',
      queries,
    });
    assert.equal(adapterCalls, 1, 'first call must invoke adapter');
    const cached = await searchZhihuDiscussions({
      adapter: trackingAdapter,
      cacheRepository: cache2,
      story_version_uuid: FIXTURE_UUIDS['cafe-rain'].story_version_uuid,
      community_profile_version: 'community-profile@community-profile-rules/1',
      queries,
    });
    assert.equal(adapterCalls, 1, 'second call must NOT invoke adapter (cache hit)');
    assert.equal(cached.cached, true);
    assert.equal(cached.ecosystem_status, first.ecosystem_status);
    assert.equal(cached.results.length, first.results.length);
  });

  await check('mock fixtures provide 5 fixed entries per fixture story', () => {
    assert.ok(ECOSYSTEM_SEARCH_MOCK_FIXTURES['cafe-rain']);
    assert.ok(ECOSYSTEM_SEARCH_MOCK_FIXTURES['night-shift']);
    assert.equal(ECOSYSTEM_SEARCH_MOCK_FIXTURES['cafe-rain'].length, 5);
    assert.equal(ECOSYSTEM_SEARCH_MOCK_FIXTURES['night-shift'].length, 5);
    // 所有 url 都以 https://mock.zhihu.com 开头（不指向真实知乎资源）
    for (const list of Object.values(ECOSYSTEM_SEARCH_MOCK_FIXTURES)) {
      for (const r of list) {
        assert.match(r.url, /^https:\/\/mock\.zhihu\.com\//);
        assert.ok(typeof r.title === 'string' && r.title.length > 0);
      }
    }
  });

  await check('changing community_profile_version creates a new cache row (no cross-version bleed)', async () => {
    const cache = createInMemoryEcosystemSearchCacheRepository();
    const slugResolver = (sv) => {
      for (const [slug, ids] of Object.entries(FIXTURE_UUIDS)) {
        if (ids.story_version_uuid === sv) return slug;
      }
      return null;
    };
    const adapter = createMockSearchAdapter({ slugResolver });
    const queries = [{ id: 'q1', query: '雨夜咖啡馆 故事 解读' }];
    const a = await searchZhihuDiscussions({
      adapter, cacheRepository: cache,
      story_version_uuid: FIXTURE_UUIDS['cafe-rain'].story_version_uuid,
      community_profile_version: 'community-profile@community-profile-rules/1',
      queries,
    });
    const b = await searchZhihuDiscussions({
      adapter, cacheRepository: cache,
      story_version_uuid: FIXTURE_UUIDS['cafe-rain'].story_version_uuid,
      community_profile_version: 'community-profile-rules/2',
      queries,
    });
    assert.notEqual(a.ecosystem_status, b.cached);
    assert.equal(b.cached, false, 'different profile_version must NOT hit the v1 cache');
    // 三行：(v1, v2) + 'cafe-rain' 独立 (无需再做)
    assert.equal(cache.stats().row_count, 2);
  });

  // ----- Error degradation -------------------------------------------

  await check('adapter throws → ecosystem_status=unavailable + adapter is NOT called on second hit', async () => {
    const cache = createInMemoryEcosystemSearchCacheRepository();
    const failAdapter = {
      name: 'fail-once',
      async searchZhihuDiscussions() {
        const err = new Error('simulated upstream 5xx');
        err.code = 'upstream_5xx';
        throw err;
      },
    };
    const queries = [{ id: 'q1', query: '任何 query' }];
    const first = await searchZhihuDiscussions({
      adapter: failAdapter,
      cacheRepository: cache,
      story_version_uuid: FIXTURE_UUIDS['night-shift'].story_version_uuid,
      community_profile_version: 'community-profile@community-profile-rules/1',
      queries,
    });
    assert.equal(first.ecosystem_status, 'unavailable');
    assert.deepEqual(first.results, []);
    assert.equal(first.error_code, 'upstream_5xx');
    assert.equal(first.provider, 'fail-once');
    // 失败短期缓存：第二次直接命中失败状态、不再抛
    let secondCalls = 0;
    const failAdapter2 = {
      name: 'fail-twice',
      async searchZhihuDiscussions() {
        secondCalls += 1;
        throw new Error('never reached');
      },
    };
    const cached = await searchZhihuDiscussions({
      adapter: failAdapter2,
      cacheRepository: cache,
      story_version_uuid: FIXTURE_UUIDS['night-shift'].story_version_uuid,
      community_profile_version: 'community-profile@community-profile-rules/1',
      queries,
    });
    assert.equal(secondCalls, 0, 'failed call must be cached so retry does NOT re-call adapter');
    assert.equal(cached.ecosystem_status, 'unavailable');
    assert.equal(cached.cached, true);
    assert.deepEqual(cached.results, []);
  });

  await check('adapter returns [] → ecosystem_status=empty (not unavailable)', async () => {
    const cache = createInMemoryEcosystemSearchCacheRepository();
    const emptyAdapter = {
      name: 'empty',
      async searchZhihuDiscussions() {
        return [];
      },
    };
    const queries = [{ id: 'q1', query: 'no-result query' }];
    const o = await searchZhihuDiscussions({
      adapter: emptyAdapter,
      cacheRepository: cache,
      story_version_uuid: FIXTURE_UUIDS['cafe-rain'].story_version_uuid,
      community_profile_version: 'community-profile@community-profile-rules/1',
      queries,
    });
    assert.equal(o.ecosystem_status, 'empty');
    assert.equal(o.results.length, 0);
  });

  await check('no queries → ecosystem_status=empty (adapter NOT called)', async () => {
    const cache = createInMemoryEcosystemSearchCacheRepository();
    let calls = 0;
    const adapter = {
      name: 'spy',
      async searchZhihuDiscussions() {
        calls += 1;
        return [];
      },
    };
    const o = await searchZhihuDiscussions({
      adapter,
      cacheRepository: cache,
      story_version_uuid: FIXTURE_UUIDS['cafe-rain'].story_version_uuid,
      community_profile_version: 'community-profile@community-profile-rules/1',
      queries: [],
    });
    assert.equal(o.ecosystem_status, 'empty');
    assert.equal(o.results.length, 0);
    assert.equal(calls, 0, 'must NOT call adapter when queries list is empty');
  });

  await check('unknown story_version (no fixture) → ecosystem_status=empty (mock), no error', async () => {
    const cache = createInMemoryEcosystemSearchCacheRepository();
    const adapter = createMockSearchAdapter(); // default slugResolver
    const o = await searchZhihuDiscussions({
      adapter,
      cacheRepository: cache,
      story_version_uuid: '99999999-9999-4999-8999-999999999999',
      community_profile_version: 'community-profile@community-profile-rules/1',
      queries: [{ id: 'q1', query: 'unknown' }],
    });
    assert.equal(o.ecosystem_status, 'empty');
    assert.equal(o.results.length, 0);
    assert.equal(o.provider, 'mock');
  });

  // ----- Real adapter isolation / no-credential contract -------------

  await check('real adapter falls back to mock when isAuthConfigured() returns false (no zhihu-cli call)', async () => {
    const cache = createInMemoryEcosystemSearchCacheRepository();
    // Use a cliPath that DOES NOT exist; if it were called, the call would
    // fail with spawn ENOENT and propagate as upstream_unavailable.
    // The fallback path never spawns, so this must still succeed with
    // status='ok' using the mock fixture.
    const adapter = createRealSearchAdapter({
      isAuthConfigured: () => false,
      cliPath: '/this/path/does/not/exist/zhihu-cli-ignored',
    });
    const o = await searchZhihuDiscussions({
      adapter,
      cacheRepository: cache,
      story_version_uuid: FIXTURE_UUIDS['cafe-rain'].story_version_uuid,
      community_profile_version: 'community-profile@community-profile-rules/1',
      queries: [{ id: 'q1', query: '雨夜咖啡馆 故事 解读' }],
    });
    assert.equal(o.ecosystem_status, 'ok');
    assert.ok(o.results.length >= 3);
    // result urls are from the mock fixture (mock.zhihu.com), not real
    // Zhihu — this proves the fallback to mock fired rather than a
    // zhihu-cli spawn.
    for (const r of o.results) {
      assert.match(r.url, /^https:\/\/mock\.zhihu\.com\//);
    }
  });

  await check('cache key is stable for the same (story_version_uuid, community_profile_version)', () => {
    const k1 = buildEcosystemSearchCacheKey(FIXTURE_UUIDS['cafe-rain'].story_version_uuid, 'community-profile@community-profile-rules/1');
    const k2 = buildEcosystemSearchCacheKey(FIXTURE_UUIDS['cafe-rain'].story_version_uuid, 'community-profile@community-profile-rules/1');
    assert.equal(k1, k2);
    const k3 = buildEcosystemSearchCacheKey(FIXTURE_UUIDS['cafe-rain'].story_version_uuid, 'community-profile-rules/2');
    assert.notEqual(k1, k3);
  });

  await check('default TTL is process-stable and positive', () => {
    assert.ok(Number.isFinite(ECOSYSTEM_SEARCH_DEFAULT_TTL_MS));
    assert.ok(ECOSYSTEM_SEARCH_DEFAULT_TTL_MS > 0);
    assert.ok(ECOSYSTEM_SEARCH_DEFAULT_LIMIT >= 3 && ECOSYSTEM_SEARCH_DEFAULT_LIMIT <= 5);
  });
}

runChecks().then(
  () => {
    if (failures > 0) {
      console.log(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log('\nAll ecosystem-search checks passed.');
  },
  (err) => {
    console.log('\necosystem-search checks crashed:');
    console.log(err && err.stack ? err.stack : err);
    process.exit(1);
  },
);