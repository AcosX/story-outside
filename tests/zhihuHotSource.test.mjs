import assert from 'node:assert/strict';
import { createRealZhihuHotSource } from '../src/providers/ecosystem/zhihuHotSource.mjs';
import { createEcosystemHotOrchestrator } from '../src/providers/ecosystem/hot.mjs';

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
console.log('zhihuHotSource: official contract, projection, cache, mock isolation and safe failure passed');
