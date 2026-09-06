// tests/zhihuHotSource.test.mjs — ClickUp 16.4 real adapter contract:
//   * host allow-list refuses non-api.zhihu.com
//   * non-HTTPS / non-default-port refused
//   * 429 / 5xx / 4xx → ProviderError
//   * valid payload → normalised ZhihuHotTopic[]
//   * redirect off-allow-list refused
//   * body cap enforced
//   * fetch unavailable surfaces ProviderError

import assert from 'node:assert/strict';

import { createZhihuHotSource, ZHIHU_HOT_SOURCE_CONFIG } from '../src/providers/ecosystem/zhihuHotSource.mjs';

let failures = 0;

/**
 * Run a check. fn may be sync or return a Promise. Async checks
 * that EXPECT a throw must return the promise themselves so we can
 * inspect the rejection.
 */
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`    ${err && err.message ? err.message : err}`);
  }
}

/**
 * Wrap a "must throw" check. Returns a check-compatible async fn
 * that throws when the inner predicate did NOT throw.
 */
function expectThrow(predicate) {
  return async () => {
    let thrown = null;
    try {
      await predicate();
    } catch (err) {
      thrown = err;
    }
    if (!thrown) {
      throw new Error('expected predicate to throw, but it resolved');
    }
    return thrown;
  };
}

function fakeFetchOk() {
  return async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            id: 'zh-001',
            target: {
              title: '凌晨便利店的夜班店员',
              question: {
                id: '1000000123',
                topics: [{ name: '便利店' }, { name: '夜班' }],
              },
              answer_count: 456,
            },
            url: 'https://www.zhihu.com/question/1000000123',
            hot_score: 1234567,
            excerpt: '夜班视角的小故事',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
}

function fakeFetchBareArray() {
  return async () =>
    new Response(JSON.stringify([
      {
        id: 'zh-002',
        target: { title: '雨夜咖啡馆', question: { id: '1000000456' } },
        url: 'https://www.zhihu.com/question/1000000456',
        hot_score: 555,
      },
    ]), { status: 200, headers: { 'content-type': 'application/json' } });
}

function fakeFetchStatus(status) {
  return async () => new Response('', { status });
}

function fakeFetchRedirect(toUrl) {
  return async (url) => {
    if (url.includes('/openapi/feed/hot')) {
      return new Response('', { status: 302, headers: { location: toUrl } });
    }
    return new Response('', { status: 200 });
  };
}

async function runChecks() {
  console.log('ClickUp 16.4 zhihu hot-source real adapter');

  await check('config exposes api.zhihu.com as base URL', () => {
    assert.equal(ZHIHU_HOT_SOURCE_CONFIG.DEFAULT_BASE_URL, 'https://api.zhihu.com');
    assert.ok(ZHIHU_HOT_SOURCE_CONFIG.HOST_ALLOW_LIST.includes('api.zhihu.com'));
  });

  await check('factory source name = real', () => {
    const s = createZhihuHotSource({ fetchImpl: fakeFetchOk() });
    assert.equal(s.name, 'real');
  });

  await check('valid payload → normalised topics', async () => {
    const s = createZhihuHotSource({ fetchImpl: fakeFetchOk() });
    const out = await s.fetchHotList();
    assert.equal(out.length, 1);
    const t = out[0];
    assert.equal(t.id, 'zh-001');
    assert.equal(t.title, '凌晨便利店的夜班店员');
    assert.equal(t.hotness, 1234567);
    assert.equal(t.answer_count, 456);
    assert.equal(t.question_id, '1000000123');
    assert.ok(Array.isArray(t.tags));
    assert.ok(t.tags.includes('便利店'));
  });

  await check('bare array payload accepted', async () => {
    const s = createZhihuHotSource({ fetchImpl: fakeFetchBareArray() });
    const out = await s.fetchHotList();
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'zh-002');
  });

  await check('429 → upstream_rate_limited', async () => {
    const s = createZhihuHotSource({ fetchImpl: fakeFetchStatus(429) });
    const err = await s.fetchHotList().then(() => null, (e) => e);
    assert.ok(err, 'should have thrown');
    assert.match(err.message, /rate.?limit/i);
  });

  await check('500 → upstream_5xx', async () => {
    const s = createZhihuHotSource({ fetchImpl: fakeFetchStatus(503) });
    const err = await s.fetchHotList().then(() => null, (e) => e);
    assert.ok(err, 'should have thrown');
    assert.match(err.message, /5xx|503/);
  });

  await check('404 → upstream_4xx', async () => {
    const s = createZhihuHotSource({ fetchImpl: fakeFetchStatus(404) });
    const err = await s.fetchHotList().then(() => null, (e) => e);
    assert.ok(err, 'should have thrown');
    assert.match(err.message, /4xx|404/);
  });

  await check('non-allow-listed host refused', async () => {
    const s = createZhihuHotSource({
      baseUrl: 'https://attacker.example/openapi',
      fetchImpl: async () => new Response('', { status: 200 }),
    });
    const err = await s.fetchHotList().then(() => null, (e) => e);
    assert.ok(err, 'should have thrown');
    assert.match(err.message, /unsupported_upstream_host|allow.?list/i);
  });

  await check('cleartext host refused', async () => {
    const s = createZhihuHotSource({
      baseUrl: 'http://api.zhihu.com/openapi/feed/hot',
      fetchImpl: async () => new Response('', { status: 200 }),
    });
    const err = await s.fetchHotList().then(() => null, (e) => e);
    assert.ok(err, 'should have thrown');
    assert.match(err.message, /unsupported_upstream_origin|https/i);
  });

  await check('non-default port refused', async () => {
    const s = createZhihuHotSource({
      baseUrl: 'https://api.zhihu.com:8443/openapi/feed/hot',
      fetchImpl: async () => new Response('', { status: 200 }),
    });
    const err = await s.fetchHotList().then(() => null, (e) => e);
    assert.ok(err, 'should have thrown');
    assert.match(err.message, /unsupported_upstream_origin|port/i);
  });

  await check('redirect off allow-list refused', async () => {
    const s = createZhihuHotSource({
      fetchImpl: fakeFetchRedirect('https://attacker.example/foo'),
    });
    const err = await s.fetchHotList().then(() => null, (e) => e);
    assert.ok(err, 'should have thrown');
    assert.match(err.message, /unsupported_upstream_host|allow.?list/i);
  });

  await check('body too large → upstream_body_too_large', async () => {
    const s = createZhihuHotSource({
      maxBodyBytes: 32,
      fetchImpl: async () =>
        new Response(JSON.stringify({ data: [{ id: 'x', target: { title: '长字符串', question: { id: '1' } }, url: 'https://www.zhihu.com/q/1' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const err = await s.fetchHotList().then(() => null, (e) => e);
    assert.ok(err, 'should have thrown');
    assert.match(err.message, /too.?large|body/i);
  });

  await check('malformed JSON → upstream_shape_mismatch', async () => {
    const s = createZhihuHotSource({
      fetchImpl: async () =>
        new Response('not-json{{', { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    const err = await s.fetchHotList().then(() => null, (e) => e);
    assert.ok(err, 'should have thrown');
    assert.match(err.message, /JSON|shape/i);
  });

  await check('payload missing data[] → upstream_shape_mismatch', async () => {
    const s = createZhihuHotSource({
      fetchImpl: async () =>
        new Response(JSON.stringify({ unexpected: 'shape' }), { status: 200 }),
    });
    const err = await s.fetchHotList().then(() => null, (e) => e);
    assert.ok(err, 'should have thrown');
    assert.match(err.message, /data\[|shape/i);
  });

  await check('missing fetch → fetch_unavailable', async () => {
    const realFetch = globalThis.fetch;
    Object.defineProperty(globalThis, 'fetch', { value: undefined, configurable: true, writable: true });
    try {
      const s = createZhihuHotSource({ fetchImpl: null });
      const err = await s.fetchHotList().then(() => null, (e) => e);
      assert.ok(err, 'should have thrown');
      assert.match(err.message, /fetch_unavailable|fetch/i);
    } finally {
      Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
    }
  });

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

runChecks().catch((err) => {
  console.error(err);
  process.exit(1);
});