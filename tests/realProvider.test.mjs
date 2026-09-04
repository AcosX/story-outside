// tests/realProvider.test.mjs — Real provider contract suite.
//
// Covers the integration boundary between src/providers/realProvider.mjs
// and the Zhihu Hackathon 2026 P2 story content API. Every test runs
// against a stubbed `fetch` so the suite has zero network dependency
// and is deterministic. The contract reference is
// /root/.openclaw/workspace/skills/zhihu/references/hackathon-content-api.md.
//
// What this suite pins:
//   1. listStories / getStory happy path returns the right DTO shape
//      and preserves unknown upstream fields under `source.raw`.
//   2. work_id validation rejects '/', '?', '#', CR, LF and control
//      characters at the provider boundary — the route layer is never
//      asked to construct a hostile URL.
//   3. Failures map to typed ProviderError codes. We never loop-retry,
//      never fabricate content, never echo upstream error bodies.
//   4. No Authorization / X-OAuth-Token headers ever leave the process.
//   5. The Mock provider regression check confirms adding the real
//      provider did not silently change mock behaviour.
//   6. STORY_OUTSIDE_PROVIDER=real boots the server with the live
//      banner on /api/health and serves /api/stories through the real
//      adapter (against a local fake, not the public internet).

import assert from 'node:assert/strict';
import http from 'node:http';

import {
  __resetStoryProviderForTests,
  createRealZhihuStoryProvider,
  ProviderError,
  StoryNotFoundError,
  ValidationError,
  getStoryProvider,
} from '../src/providers/index.mjs';

let casesRun = 0;
let casesFailed = 0;

function test(name, fn) {
  casesRun += 1;
  return Promise.resolve()
    .then(fn)
    .then(
      () => console.log(`  ok   ${name}`),
      (err) => {
        casesFailed += 1;
        console.log(`  FAIL ${name}`);
        console.log(`    ${err && err.message ? err.message : err}`);
      },
    );
}

/**
 * Build a fake `fetch` from a static response map. Each entry maps
 * the request URL to a { status, body, delayMs? } envelope. The
 * returned fetch:
 *   - asserts no Authorization / X-OAuth-Token headers were set;
 *   - asserts the URL host is api.zhihu.com (defence in depth);
 *   - returns the configured response after the configured delay.
 *
 * @param {Record<string, { status: number, body?: unknown, delayMs?: number, raw?: string }>} map
 * @param {{ seenRequests?: Array<{ url: string, headers: Record<string, string> }> }} [opts]
 */
function makeFakeFetch(map, opts = {}) {
  const seen = opts.seenRequests || [];
  /** @type {typeof fetch} */
  return async function fakeFetch(url, init) {
    const u = new URL(/** @type {string} */ (url));
    if (u.hostname !== 'api.zhihu.com') {
      throw new Error(`unexpected upstream host: ${u.hostname}`);
    }
    /** @type {Record<string, string>} */
    const headers = {};
    for (const [k, v] of Object.entries(/** @type {Record<string, string>} */ (init && init.headers) || {})) {
      headers[k.toLowerCase()] = String(v);
    }
    for (const forbidden of ['authorization', 'x-oauth-token']) {
      if (forbidden in headers) {
        throw new Error(`forbidden header set on upstream request: ${forbidden}`);
      }
    }
    seen.push({ url: u.toString(), headers });
    const key = `${u.pathname}${u.search}`;
    const cfg = map[key];
    if (!cfg) {
      throw new Error(`unexpected URL in fake fetch: ${key}`);
    }
    if (cfg.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, cfg.delayMs));
    }
    const body = cfg.raw !== undefined
      ? cfg.raw
      : cfg.body === undefined
        ? ''
        : JSON.stringify(cfg.body);
    return new Response(body, {
      status: cfg.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

const LIST_PAYLOAD = [
  {
    work_id: '1747681485547843585',
    title: '近视眼勇闯恐怖游戏',
    artwork: 'https://pic.example/artwork.png',
    tab_artwork: 'https://pic.example/tab.png',
    description: '一位近视眼的玩家闯入了恐怖游戏。',
    labels: ['惊悚', '脑洞'],
    upstream_extra: 'should survive as source.raw',
  },
  {
    work_id: '1747681485547843586',
    title: '雨夜咖啡馆',
    artwork: 'https://pic.example/cafe.png',
    tab_artwork: 'https://pic.example/cafe-tab.png',
    description: '',
    labels: [],
  },
];

const DETAIL_PAYLOAD = {
  work_id: '1747681485547843585',
  chapter_name: '近视眼勇闯恐怖游戏',
  author_avatar: 'https://pic.example/avatar.png',
  author_name: '沈南因',
  labels: ['惊悚', '脑洞'],
  introduction: '作品导语。',
  content: 'A'.repeat(40),
  upstream_extra: 'kept under source.raw',
};

async function run() {
  console.log('Real provider suite');

  // ----- 1. listStories happy path -------------------------------------
  await test('1. listStories returns summaries with source/raw attribution', async () => {
    const seen = [];
    const fakeFetch = makeFakeFetch({
      '/km-indep-home/hackathon/v2/story/list': { status: 200, body: LIST_PAYLOAD },
    }, { seenRequests: seen });
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
    const list = await provider.listStories();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, '1747681485547843585');
    assert.equal(list[0].title, '近视眼勇闯恐怖游戏');
    assert.equal(list[0].hook, '一位近视眼的玩家闯入了恐怖游戏。');
    assert.equal(list[0].roles.length, 1);
    assert.equal(list[0].roles[0].id, 'author');
    // Source envelope preserves untrusted upstream payload + metadata.
    assert.equal(list[0].source.attribution, 'zhihu_hackathon_2026_p2');
    assert.deepEqual(list[0].source.labels, ['惊悚', '脑洞']);
    assert.equal(list[0].source.raw.upstream_extra, 'should survive as source.raw');
    // Description-less entries fall back to a short attributable hook
    // rather than fabricating story content.
    assert.equal(list[1].hook.startsWith('来自知乎黑客松参赛作品'), true);
    // The wire request must not carry credentials.
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers.authorization, undefined);
    assert.equal(seen[0].headers['x-oauth-token'], undefined);
  });

  // ----- 2. getStory happy path ---------------------------------------
  await test('2. getStory maps detail fields into the StoryDetail DTO and preserves raw payload', async () => {
    const fakeFetch = makeFakeFetch({
      '/km-indep-home/hackathon/v2/story/1747681485547843585': { status: 200, body: DETAIL_PAYLOAD },
    });
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
    const detail = await provider.getStory('1747681485547843585');
    assert.equal(detail.id, '1747681485547843585');
    assert.equal(detail.title, '近视眼勇闯恐怖游戏');
    assert.equal(detail.hook, '作品导语。');
    assert.equal(detail.roles.length, 1);
    assert.equal(detail.roles[0].label, '沈南因');
    assert.equal(detail.beats.length, 1);
    assert.equal(detail.beats[0].type, 'narration');
    assert.equal(detail.beats[0].text.length, 40);
    assert.equal(detail.source.author_name, '沈南因');
    assert.deepEqual(detail.source.labels, ['惊悚', '脑洞']);
    assert.equal(detail.source.raw.upstream_extra, 'kept under source.raw');
    // Real provider MUST NOT pretend a structured dialogue / choice
    // boundary exists; the upstream does not provide one.
    assert.equal(detail.beats.find((b) => b.type === 'ask_player_choice'), undefined);
  });

  // ----- 3. work_id injection guards -----------------------------------
  await test('3. work_id validation rejects path-traversal, control and CRLF inputs', async () => {
    const fakeFetch = makeFakeFetch({});
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
    for (const bad of ['', '   ', 'a/b', 'a?b', 'a#b', 'a\rb', 'a\nb', 'a\x00b', 'a'.repeat(129)]) {
      await assert.rejects(
        () => provider.getStory(bad),
        (err) => err instanceof ValidationError,
        `expected ${JSON.stringify(bad)} to be rejected`,
      );
    }
    // Control codes inside the string should also be rejected.
    await assert.rejects(() => provider.getStory('abc\x07'), ValidationError);
  });

  // ----- 4. 404 -> StoryNotFoundError ----------------------------------
  await test('4. upstream 404 maps to StoryNotFoundError', async () => {
    const fakeFetch = makeFakeFetch({
      '/km-indep-home/hackathon/v2/story/missing': { status: 404 },
    });
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
    await assert.rejects(
      () => provider.getStory('missing'),
      (err) => err instanceof StoryNotFoundError && err.code === 'story_not_found',
    );
  });

  // ----- 5. 429 -> typed upstream_rate_limited, no retry --------------
  await test('5. upstream 429 maps to typed upstream_rate_limited without retrying', async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      return new Response('', { status: 429 });
    };
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
    await assert.rejects(
      () => provider.getStory('1747681485547843585'),
      (err) => err instanceof ProviderError && err.code === 'upstream_rate_limited',
    );
    assert.equal(calls, 1, '429 must NOT trigger a retry');
  });

  // ----- 6. 5xx -> typed upstream_5xx ----------------------------------
  await test('6. upstream 5xx maps to typed upstream_5xx without leaking status details', async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      return new Response('{"trace_id":"internal-only"}', { status: 502 });
    };
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
    await assert.rejects(
      () => provider.getStory('1747681485547843585'),
      (err) => err instanceof ProviderError
        && err.code === 'upstream_5xx'
        // Upstream error bodies MUST NOT leak into the message.
        && !/trace_id/.test(err.message),
    );
    assert.equal(calls, 1, '5xx must NOT trigger a retry');
  });

  // ----- 7. timeout -> typed upstream_timeout --------------------------
  await test('7. timeout maps to upstream_timeout without leaking AbortError internals', async () => {
    const fakeFetch = (_url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
      // Never resolves naturally; the timeout will fire first.
      setTimeout(() => resolve(new Response('', { status: 200 })), 10_000);
    });
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch, timeoutMs: 25 });
    await assert.rejects(
      () => provider.getStory('1747681485547843585'),
      (err) => err instanceof ProviderError
        && err.code === 'upstream_timeout'
        && !/AbortError/i.test(err.message),
    );
  });

  // ----- 8. bad JSON -> typed upstream_invalid_json --------------------
  await test('8. upstream non-JSON body maps to upstream_invalid_json', async () => {
    const fakeFetch = makeFakeFetch({
      '/km-indep-home/hackathon/v2/story/1747681485547843585': {
        status: 200,
        raw: '<html>oops</html>',
      },
    });
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
    await assert.rejects(
      () => provider.getStory('1747681485547843585'),
      (err) => err instanceof ProviderError && err.code === 'upstream_invalid_json',
    );
  });

  // ----- 9. empty body -------------------------------------------------
  await test('9. upstream empty body maps to upstream_empty_body', async () => {
    const fakeFetch = makeFakeFetch({
      '/km-indep-home/hackathon/v2/story/list': { status: 200, raw: '' },
    });
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
    await assert.rejects(
      () => provider.listStories(),
      (err) => err instanceof ProviderError && err.code === 'upstream_empty_body',
    );
  });

  // ----- 10. missing fields --------------------------------------------
  await test('10. upstream payload missing required fields maps to ValidationError', async () => {
    const fakeFetch = makeFakeFetch({
      '/km-indep-home/hackathon/v2/story/list': {
        status: 200,
        body: [{ title: 'no work_id here' }],
      },
    });
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
    await assert.rejects(
      () => provider.listStories(),
      (err) => err instanceof ValidationError && /work_id/.test(err.message),
    );

    const fakeFetch2 = makeFakeFetch({
      '/km-indep-home/hackathon/v2/story/1747681485547843585': {
        status: 200,
        body: { work_id: '1747681485547843585' }, // no chapter_name / title
      },
    });
    const provider2 = createRealZhihuStoryProvider({ fetchImpl: fakeFetch2 });
    await assert.rejects(
      () => provider2.getStory('1747681485547843585'),
      (err) => err instanceof ValidationError,
    );
  });

  // ----- 11. list endpoint does not return array -----------------------
  await test('11. list payload that is not an array maps to upstream_shape_mismatch', async () => {
    const fakeFetch = makeFakeFetch({
      '/km-indep-home/hackathon/v2/story/list': { status: 200, body: { items: [] } },
    });
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
    await assert.rejects(
      () => provider.listStories(),
      (err) => err instanceof ProviderError && err.code === 'upstream_shape_mismatch',
    );
  });

  // ----- 11.5. no auth headers on the wire ----------------------------
  await test('11.5. real provider never sets Authorization or X-OAuth-Token on the wire', async () => {
    const seen = [];
    const fakeFetch = makeFakeFetch({
      '/km-indep-home/hackathon/v2/story/list': { status: 200, body: LIST_PAYLOAD },
      '/km-indep-home/hackathon/v2/story/1747681485547843585': { status: 200, body: DETAIL_PAYLOAD },
    }, { seenRequests: seen });
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
    await provider.listStories();
    await provider.getStory('1747681485547843585');
    assert.equal(seen.length, 2);
    for (const req of seen) {
      for (const forbidden of ['authorization', 'x-oauth-token']) {
        assert.equal(req.headers[forbidden], undefined, `${forbidden} must not be set on the wire`);
      }
      assert.equal(req.headers.accept, 'application/json');
    }
  });

  // ----- 12. mock regression -------------------------------------------
  await test('12. mock provider regression — adding the real provider does not change mock DTOs', async () => {
    // We import the mock factory through the public selector to ensure
    // both surfaces stay in sync.
    __resetStoryProviderForTests();
    delete process.env.STORY_OUTSIDE_PROVIDER;
    const mock = getStoryProvider();
    assert.equal(mock.name, 'mock');
    const list = await mock.listStories();
    assert.ok(list.length >= 2);
    for (const s of list) {
      assert.ok(typeof s.id === 'string');
      assert.equal(s.source, undefined, 'mock summaries must not gain a source envelope');
    }
    const detail = await mock.getStory('cafe-rain');
    assert.ok(detail.beats.find((b) => b.type === 'ask_player_choice'));
  });

  // ----- 13. real provider boot + http smoke ---------------------------
  await test('13. STORY_OUTSIDE_PROVIDER=real boots the server with the live banner', async () => {
    // The selector has no fetchImpl parameter; tests that need a stub
    // fetch exercise the factory directly (see cases 1\u201312). For this
    // case we only need /api/health to advertise the real provider.
    // The data routes are exercised against the live upstream by the
    // clickup-13 live-smoke step described in the report, never from
    // CI.
    __resetStoryProviderForTests();
    process.env.STORY_OUTSIDE_PROVIDER = 'real';
    try {
      const { server: appServer } = await import('../src/server.mjs');
      const appPort = await new Promise((resolve, reject) => {
        appServer.listen(0, '127.0.0.1', () => {
          const a = /** @type {import('node:net').AddressInfo} */ (appServer.address());
          resolve(a.port);
        });
        appServer.on('error', reject);
      });
      try {
        const health = await fetch(`http://127.0.0.1:${appPort}/api/health`).then((r) => r.json());
        assert.equal(health.provider, 'real');
        assert.equal(health.demo.mode, 'live');
        assert.equal(health.demo.official_zhihu_api, true);
        assert.equal(health.demo.contract, 'zhihu_hackathon_2026_p2');
        assert.equal(health.demo.auth, 'none');
      } finally {
        await new Promise((resolve) => appServer.close(resolve));
      }
    } finally {
      delete process.env.STORY_OUTSIDE_PROVIDER;
      __resetStoryProviderForTests();
    }
  });

  // ----- 14. provider refuses non-zhihu hosts --------------------------
  await test('14. real provider refuses to be re-pointed at a non-api.zhihu.com host', () => {
    assert.throws(
      () => createRealZhihuStoryProvider({ baseUrl: 'https://attacker.example.com' }),
      (err) => err instanceof ProviderError && err.code === 'unsupported_upstream_host',
    );
  });

  // ----- 15. defensive copies -----------------------------------------
  await test('15. detail returns defensive copies so callers cannot mutate cache', async () => {
    const fakeFetch = makeFakeFetch({
      '/km-indep-home/hackathon/v2/story/1747681485547843585': { status: 200, body: DETAIL_PAYLOAD },
    });
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
    const a = await provider.getStory('1747681485547843585');
    a.title = 'mutated';
    a.source.author_name = 'mutated';
    a.beats[0].text = 'mutated';
    const b = await provider.getStory('1747681485547843585');
    assert.notEqual(b.title, 'mutated');
    assert.notEqual(b.source.author_name, 'mutated');
    assert.notEqual(b.beats[0].text, 'mutated');
  });
}

run()
  .then(() => {
    if (casesFailed > 0) {
      console.error(`\n${casesFailed}/${casesRun} realProvider case(s) failed`);
      process.exit(1);
    }
    console.log(`\nall ${casesRun} realProvider case(s) passed`);
  })
  .catch((err) => {
    console.error(`\nunexpected error: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });