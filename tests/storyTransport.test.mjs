import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createStoryTransport, sshStoryFetch, storyTransportId } from '../src/providers/storyTransport.mjs';
import { validateStoryTransportPayload as validate } from '../src/providers/realProvider.mjs';

const url = 'https://api.zhihu.com/km-indep-home/hackathon/v2/story/list';
const list = [{ work_id: '123', title: 'Real story', artwork: 'https://example.com/cover.png' }];
const good = (data = list) => Response.json(data);
const offline = async () => { throw new Error('offline'); };
function store() {
  const records = new Map();
  return { records, get: async url => structuredClone(records.get(url)), put: async (url, data) => { records.set(url, structuredClone(data)); } };
}

test('403 switches to relay, suppresses repeated primary probes and coalesces calls', async () => {
  let calls = 0; let primary = 0; let clock = 1000;
  const transport = createStoryTransport({ validate, now: () => clock,
    direct: async () => { primary++; return new Response('{}', { status: 403 }); },
    alternate: async () => { calls++; await new Promise(r => setTimeout(r, 10)); return good(); },
  });
  const results = await Promise.all(Array.from({ length: 8 }, () => transport(url)));
  for (const result of results) assert.deepEqual(await result.json(), list);
  assert.equal(calls, 1); assert.equal(primary, 1);
  await transport(url); assert.equal(primary, 1);
  clock += 60_001; await transport(url); assert.equal(primary, 2);
});

test('durable cache interface preserves full list metadata across provider instances', async () => {
  const cacheStore = store();
  await createStoryTransport({ validate, cacheStore, direct: offline, alternate: async () => good() })(url);
  const next = createStoryTransport({ validate, cacheStore, direct: offline, alternate: offline });
  assert.deepEqual(await (await next(url)).json(), list);
});

test('invalid successful responses cannot replace last-good data', async t => {
  const cacheStore = store();
  await createStoryTransport({ validate, cacheStore, direct: async () => good() })(url);
  for (const bad of [{ error: 'challenge' }, [{ work_id: '123' }]]) {
    const f = createStoryTransport({ validate, cacheStore, direct: async () => good(bad), alternate: async () => good(bad) });
    assert.deepEqual(await (await f(url)).json(), list);
  }
});

test('detail cache preserves complete payload and rejects wrong work IDs', async t => {
  const cacheStore = store();
  const target = url.replace('/list', '/123');
  const payload = { work_id: '123', chapter_name: 'Chapter', content: '正文'.repeat(40000), labels: ['real'] };
  await createStoryTransport({ validate, cacheStore, direct: async () => good(payload) })(target);
  const f = createStoryTransport({ validate, cacheStore, direct: offline, alternate: async () => good({ ...payload, work_id: '456' }) });
  assert.deepEqual(await (await f(target)).json(), payload);
});

test('404 and 429 do not generate alternate requests', async t => {
  const cacheStore = store();
  for (const status of [404, 429]) {
    const f = createStoryTransport({ validate, cacheStore, direct: async () => new Response('{}', { status }), alternate: async () => { assert.fail('unexpected alternate'); } });
    assert.equal((await f(url)).status, status);
  }
});

test('corrupt cache fails closed without fabricating content', async t => {
  const cacheStore = store();
  await createStoryTransport({ validate, cacheStore, direct: async () => good() })(url);
  cacheStore.records.set(url, { version: 1, url, savedAt: Date.now(), payload: { invalid: true } });
  await assert.rejects(createStoryTransport({ validate, cacheStore, direct: offline, alternate: offline })(url));
});

test('cache write failure does not discard valid upstream result', async t => {
  const cacheStore = { get: async () => null, put: async () => { throw Error('database unavailable'); } };
  const f = createStoryTransport({ validate, cacheStore, direct: async () => good() });
  assert.deepEqual(await (await f(url)).json(), list);
});

test('untrusted URLs and mutations never reach SSH or direct fetch', async () => {
  const f = createStoryTransport({ validate, direct: async () => assert.fail('network'), alternate: async () => assert.fail('relay') });
  for (const target of [url+'?token=x', url+'#x', url.replace('api.zhihu.com','api.zhihu.com.evil'), url.replace('/list','/%2e%2e'), url.replace('/list','/a%2fb'), url.replace('https:', 'http:')]) {
    await assert.rejects(f(target));
  }
  await assert.rejects(f(url, { method: 'POST' }));
  assert.equal(storyTransportId(url), 'list');
});

test('SSH command contains only validated base64 ID and fixed helper; no headers forwarded', async () => {
  let args;
  const relay = sshStoryFetch('opc@vm2', async (...input) => { args = input; return { stdout: JSON.stringify(list)+'\n200' }; });
  assert.deepEqual(await (await relay(url, { headers: { Authorization: 'never-forward' } })).json(), list);
  assert.equal(args[0], '/usr/bin/ssh');
  assert.equal(args[1].at(-1), '/usr/local/libexec/story-outside-zhihu-get.py bGlzdA');
  assert.ok(!JSON.stringify(args).includes('never-forward'));
  assert.throws(() => sshStoryFetch('vm2;touch /tmp/oops'));
});

test('oversized successful body falls back without replacing cache', async t => {
  const cacheStore = store();
  await createStoryTransport({ validate, cacheStore, direct: async () => good() })(url);
  const f = createStoryTransport({ validate, cacheStore, direct: async () => new Response('x'.repeat(1024*1024+1)) });
  assert.deepEqual(await (await f(url)).json(), list);
});

test('disabled transport preserves original fetch identity', () => {
  assert.equal(createStoryTransport({ direct: offline }), offline);
});

test('preload preserves other APIs and a newly integrated provider does not wrap it twice', () => {
  const code = `process.env.STORY_OUTSIDE_STORY_SSH_HOST='opc@unused.invalid';
    let calls=0; globalThis.fetch=async()=>{calls++;return Response.json(${JSON.stringify(list)})};
    await import(${JSON.stringify(new URL('../src/providers/registerStoryTransport.mjs', import.meta.url).href)});
    await fetch('https://example.com/private',{headers:{Authorization:'private'}});
    if(calls!==1)throw Error('other API changed');
    const {createRealZhihuStoryProvider}=await import(${JSON.stringify(new URL('../src/providers/realProvider.mjs', import.meta.url).href)});
    const p=createRealZhihuStoryProvider();const s=await p.listStories();
    if(calls!==2||s.length!==1)throw Error('nested transport');
    console.log('preload passed');`;
  assert.match(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' }), /preload passed/);
});

test('391464a hook bound is retained without truncating original introduction', async () => {
  const { createRealZhihuStoryProvider } = await import('../src/providers/realProvider.mjs');
  const intro='原'.repeat(650);
  const p=createRealZhihuStoryProvider({fetchImpl:async()=>good({work_id:'123',chapter_name:'Real',introduction:intro,content:'正文'})});
  const d=await p.getStory('123');assert.equal(Array.from(d.hook).length,500);assert.equal(d.source.introduction,intro);
});

test('a stalled database transaction is bounded and queued writes fail without starting late', async () => {
  const {createMariaStoryCache}=await import('../src/db/storyUpstreamCache.mjs');
  let destroyed=0;let connections=0;
  const pool={getConnection:async()=>{connections++;return {query:async()=>new Promise(()=>{}),release:()=>{},destroy:()=>{destroyed++;}}}};
  const c=createMariaStoryCache(pool);const started=Date.now();
  const results=await Promise.allSettled([c.put(url,{savedAt:started,payload:list}),c.put(url,{savedAt:started,payload:list})]);
  assert.ok(results.every(r=>r.status==='rejected'));assert.ok(Date.now()-started<5000);
  assert.ok(connections <= 2);assert.equal(destroyed,connections);
});
