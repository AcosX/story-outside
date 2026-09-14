import assert from 'node:assert/strict';
import { createRealZhihuHotSource } from '../src/providers/ecosystem/zhihuHotSource.mjs';
import {
  createEcosystemHotOrchestrator,
  createInMemoryEcosystemHotCacheRepository,
  ECOSYSTEM_HOT_CACHE_KEY,
  ECOSYSTEM_HOT_DEFAULT_TTL_MS,
} from '../src/providers/ecosystem/hot.mjs';

let calls = 0;
const source = createRealZhihuHotSource({ accessSecret: 'test-secret', fetchImpl: async (url, options) => {
  calls++;
  assert.equal(url, 'https://developer.zhihu.com/api/v1/content/hot_list?Limit=30');
  assert.equal(options.headers.Authorization, 'Bearer test-secret');
  assert.match(options.headers['X-Request-Timestamp'], /^\d{10}$/);
  assert.equal(options.redirect, 'error');
  return Response.json({Code:0,Data:{Items:[
    {Title:'真实标题',Url:'https://www.zhihu.com/question/123',ThumbnailUrl:'https://pic1.zhimg.com/a.jpg',Summary:'摘要'},
    {Title:'duplicate',Url:'https://www.zhihu.com/question/123'},
    {Title:'bad',Url:'https://evil.test/question/1'},
  ]}});
} });
const orchestrator = createEcosystemHotOrchestrator({ source });
const response = await orchestrator.fetchHot();
assert.equal(response.provenance.source, 'real');
assert.equal(response.hot.length, 1);
assert.equal(response.hot[0].excerpt, '摘要');
assert.equal(response.hot[0].thumbnail_url, 'https://pic1.zhimg.com/a.jpg');
assert.equal(response.hot[0].heat, 0);
assert.equal(response.hot[0].category, undefined);
assert.equal((await orchestrator.fetchHot()).cached, true);
assert.equal(calls, 1);
await assert.rejects(source.fetchHotList({category:'tech'}), {code:'hot_category_unavailable'});
const missing = await createEcosystemHotOrchestrator({provider:'real',accessSecret:''}).fetchHot();
assert.deepEqual(missing.hot, []);
assert.equal(missing.unavailable, true);
assert.equal(missing.reason, 'hot_credentials_missing');
assert.equal(missing.provenance.source, 'real');
for (const [response, code] of [
  [Response.json({Code:20001,Message:'private error'}), 'hot_upstream_rejected'],
  [new Response('private invalid body'), 'hot_invalid_response'],
  [new Response('private error', {status:403}), 'hot_http_403'],
]) {
  await assert.rejects(createRealZhihuHotSource({accessSecret:'test',fetchImpl:async()=>response}).fetchHotList(), {code,message:code});
}
assert.ok((await createEcosystemHotOrchestrator({provider:'mock'}).fetchHot()).hot.length);
assert.equal(ECOSYSTEM_HOT_DEFAULT_TTL_MS, 15 * 60 * 1000);

// The hot list is a single site-wide snapshot. Category/story identity must
// not create another upstream request, and concurrent misses must collapse to
// one refresh.
let sharedCalls = 0;
const sharedCategories = [];
const sharedSource = {
  name: 'real',
  fetchHotList: async ({ category }) => {
    sharedCalls++;
    sharedCategories.push(category);
    await new Promise((resolve) => setTimeout(resolve, 10));
    return [{ id: 'shared-hot', title: `shared-${sharedCalls}`, url: 'https://www.zhihu.com/question/shared' }];
  },
};
const sharedCache = createInMemoryEcosystemHotCacheRepository();
const sharedOrchestrator = createEcosystemHotOrchestrator({ source: sharedSource, cache: sharedCache });
const [firstShared, concurrentShared] = await Promise.all([
  sharedOrchestrator.fetchHot({ category: 'total' }),
  sharedOrchestrator.fetchHot({ category: 'finance' }),
]);
assert.equal(sharedCalls, 1);
assert.deepEqual(sharedCategories, ['total']);
assert.equal(firstShared.cached, false);
assert.equal(concurrentShared.cached, true);
assert.equal((await sharedOrchestrator.fetchHot({ category: 'tech' })).cached, true);
assert.equal(sharedCalls, 1);
assert.deepEqual([...sharedCache._exportSnapshot()].map((row) => row.cache_key), [ECOSYSTEM_HOT_CACHE_KEY]);

// Hydrating the same snapshot into a fresh repository models a process
// restart: a fresh persisted row must satisfy the request without a source
// call.
const restoredCache = createInMemoryEcosystemHotCacheRepository();
restoredCache._hydrateSnapshot(sharedCache._exportSnapshot());
let restoredCalls = 0;
const restoredOrchestrator = createEcosystemHotOrchestrator({
  source: { name: 'real', fetchHotList: async () => { restoredCalls++; return []; } },
  cache: restoredCache,
});
const restored = await restoredOrchestrator.fetchHot();
assert.equal(restored.cached, true);
assert.equal(restoredCalls, 0);

// The production default is 15 minutes; a short override keeps the expiry
// boundary regression deterministic and cheap to exercise.
let expiryCalls = 0;
const expiryOrchestrator = createEcosystemHotOrchestrator({
  source: { name: 'real', fetchHotList: async () => {
    expiryCalls++;
    return [{ id: `expiry-${expiryCalls}`, title: 'expiry', url: 'https://www.zhihu.com/question/expiry' }];
  } },
  cache: createInMemoryEcosystemHotCacheRepository({ ttlMs: 20, swrMs: 100 }),
});
await expiryOrchestrator.fetchHot();
await new Promise((resolve) => setTimeout(resolve, 35));
await expiryOrchestrator.fetchHot();
assert.equal(expiryCalls, 2);
console.log('zhihuHotSource: official contract, projection, cache, mock isolation and safe failure passed');
