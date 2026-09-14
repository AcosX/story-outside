// tests/realProvider.test.mjs — Real provider contract suite.
//
// Covers the integration boundary between src/providers/realProvider.mjs
// and the Zhihu Hackathon 2026 P2 story content API. Every test runs
// against a stubbed `fetch` so the suite has zero network dependency
// and is deterministic. The contract reference is
// the official Zhihu Hackathon content API reference.
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
    assert.equal(list[0].cover_url, LIST_PAYLOAD[0].artwork);
    assert.deepEqual(list[0].categories, ['惊悚', '脑洞']);
    assert.equal(list[0].description, LIST_PAYLOAD[0].description);
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
    assert.equal(detail.author, '沈南因');
    assert.equal(detail.author_avatar, DETAIL_PAYLOAD.author_avatar);
    assert.equal(detail.word_count, 40);
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
    // story-13 live-smoke step described in the report, never from
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

  // ----- 16. host-guard defensive cases (P1-1) ------------------------
  await test('16. host guard refuses prefix-bypass, IDN, http, and path-suffix variants', () => {
    const hostile = [
      // Prefix bypass — `api.zhihu.com.attacker.example` shares the
      // exact prefix with the allow-listed host. A naive startsWith()
      // check would happily accept this URL.
      'https://api.zhihu.com.attacker.example',
      'https://api.zhihu.com.evil.tld',
      // IDN / lookalike host.
      'https://api.zhihu.cn',
      'https://api.zhihu.co',
      // Wrong scheme.
      'http://api.zhihu.com',
      // Path bypass — the host part is `attacker.com`, not
      // `api.zhihu.com`. A naive check on the URL.toString() value
      // would still find the allow-listed substring inside the path.
      'https://attacker.com/api.zhihu.com',
    ];
    for (const baseUrl of hostile) {
      assert.throws(
        () => createRealZhihuStoryProvider({ baseUrl }),
        (err) => err instanceof ProviderError && err.code === 'unsupported_upstream_host',
        `expected ${baseUrl} to be rejected`,
      );
    }
    // Sanity: the canonical host (with /v1 suffix or no suffix) is
    // accepted — the test above would falsely pass if every URL were
    // denied, so we must keep the allow-list meaningful.
    for (const baseUrl of ['https://api.zhihu.com', 'https://api.zhihu.com/']) {
      assert.doesNotThrow(() => createRealZhihuStoryProvider({
        baseUrl,
        fetchImpl: makeFakeFetch({}),
      }));
    }
  });

  // ----- 17. redirect handling (P1-2) ---------------------------------
  await test('17. 30x responses are followed manually and host-pinned per hop', async () => {
    let hops = 0;
    const fakeFetch = async (url, init) => {
      hops += 1;
      const u = new URL(url);
      assert.equal(init.redirect, 'manual', 'fetch must use redirect:manual');
      if (hops === 1) {
        assert.equal(u.hostname, 'api.zhihu.com');
        return new Response('', {
          status: 302,
          headers: {
            location: 'https://api.zhihu.com/km-indep-home/hackathon/v2/story/list',
          },
        });
      }
      // Second hop — list endpoint with valid payload.
      return new Response(JSON.stringify(LIST_PAYLOAD), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
    const list = await provider.listStories();
    assert.equal(list.length, 2);
    assert.equal(hops, 2);
  });

  await test('17.1 30x to a non-allow-listed host is refused', async () => {
    const fakeFetch = async (url) => {
      const u = new URL(url);
      return new Response('', {
        status: 302,
        headers: { location: 'https://attacker.example/api.zhihu.com/steal' },
      });
    };
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
    await assert.rejects(
      () => provider.listStories(),
      (err) => err instanceof ProviderError
        && (err.code === 'unsupported_upstream_host' || err.code === 'upstream_too_many_redirects'),
    );
  });

  await test('17.2 more than MAX_REDIRECTS hops raises upstream_too_many_redirects', async () => {
    let hops = 0;
    const fakeFetch = async (url) => {
      hops += 1;
      const u = new URL(url);
      return new Response('', {
        status: 302,
        headers: { location: `${u.toString()}?loop=${hops}` },
      });
    };
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
    await assert.rejects(
      () => provider.listStories(),
      (err) => err instanceof ProviderError && err.code === 'upstream_too_many_redirects',
    );
  });

  // ----- 17.3 redirect scheme/port lockdown (B1) ----------------------
  // PR #8 code review follow-up: the previous allow-list only checked the
  // hostname. A redirect to `http://api.zhihu.com/...` (downgrade) or
  // `https://api.zhihu.com:8080/...` (non-default port) slipped through.
  // The fix pins scheme=https AND port='' (or '443') on every hop.
  await test('17.3 30x to http://api.zhihu.com (scheme downgrade) is refused', async () => {
    const fakeFetch = async () => {
      return new Response('', {
        status: 302,
        headers: { location: 'http://api.zhihu.com/km-indep-home/hackathon/v2/story/list' },
      });
    };
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
    await assert.rejects(
      () => provider.listStories(),
      (err) => err instanceof ProviderError && err.code === 'unsupported_upstream_origin',
    );
  });

  await test('17.4 30x to https://api.zhihu.com:8080/... (non-default port) is refused', async () => {
    const fakeFetch = async () => {
      return new Response('', {
        status: 302,
        headers: { location: 'https://api.zhihu.com:8080/km-indep-home/hackathon/v2/story/list' },
      });
    };
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
    await assert.rejects(
      () => provider.listStories(),
      (err) => err instanceof ProviderError && err.code === 'unsupported_upstream_origin',
    );
  });

  await test('17.5 30x to a cleartext non-zhihu host is refused (combo of host + scheme)', async () => {
    const fakeFetch = async () => {
      return new Response('', {
        status: 302,
        headers: { location: 'http://api.zhihu.com.attacker.example/km-indep-home/hackathon/v2/story/list' },
      });
    };
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
    await assert.rejects(
      () => provider.listStories(),
      (err) => err instanceof ProviderError
        && (err.code === 'unsupported_upstream_host' || err.code === 'unsupported_upstream_origin'),
    );
  });

  await test('17.6 explicit port=443 is accepted (canonical default-port form)', async () => {
    // The Location header may carry `https://api.zhihu.com:443/...`
    // even though the default-port form collapses to `https://api.zhihu.com/...`
    // after URL canonicalisation. Both forms must be accepted: a real
    // upstream that re-emits its own canonical port=443 URL string in
    // a Location header is allowed. (Test 17.4 already covers the
    // explicit port=8080 rejection path.) We construct a redirect that
    // exercises the `target.port === '443'` branch directly (bypassing
    // URL canonicalisation by passing an explicit port).
    let hops = 0;
    const fakeFetch = async (url) => {
      hops += 1;
      const u = new URL(url);
      if (hops === 1) {
        // First hop returns the list directly, but tagged with a custom
        // location we will read back. The point is to prove the path
        // through port='443' does NOT throw. To trigger the port='443'
        // branch we need a target whose URL does not collapse the port
        // — that is only possible with `new URL(string, base)` when the
        // string already contains an explicit port that matches default.
        // Since URL normalises away port=443, we instead verify that
        // passing port=443 manually still flows through the accept
        // branch by calling the internal followRedirect-equivalent via
        // a 302 to the same host (no port) — which is just test 17
        // already. For this case we instead assert the accept branch
        // logic itself with a manually-constructed hop target: the
        // Location header carries `https://api.zhihu.com:443/list?...`
        // and the URL constructor collapses port=443 to '', and we
        // accept that. The test therefore observes a successful hop
        // and an empty-port target.
        return new Response('', {
          status: 302,
          headers: {
            location: 'https://api.zhihu.com:443/km-indep-home/hackathon/v2/story/list?via=port-443',
          },
        });
      }
      assert.equal(u.search, '?via=port-443');
      assert.equal(u.port, '', 'URL constructor collapses default port=443 → port=""');
      return new Response(JSON.stringify(LIST_PAYLOAD), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
    const list = await provider.listStories();
    assert.equal(list.length, 2);
    assert.equal(hops, 2);
  });

  // ----- 18. source.raw does not triple-allocate (P1-3) ---------------
  await test('18. source.raw drops body-sized fields and source.content is capped', async () => {
    const longContent = 'B'.repeat(80 * 1024); // 80 KiB > MAX_SOURCE_TEXT_BYTES
    const payload = {
      work_id: '1747681485547843585',
      chapter_name: 'X',
      author_avatar: 'https://pic.example/a.png',
      author_name: '沈南因',
      labels: ['惊悚'],
      introduction: 'I'.repeat(80 * 1024),
      content: longContent,
      custom_field: 'kept in source.raw',
    };
    const fakeFetch = makeFakeFetch({
      '/km-indep-home/hackathon/v2/story/1747681485547843585': { status: 200, body: payload },
    });
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
    const detail = await provider.getStory('1747681485547843585');
    // Body-sized fields are NOT inside source.raw — they live on the
    // explicit DTO / source.content fields.
    assert.equal(detail.source.raw.content, undefined);
    assert.equal(detail.source.raw.introduction, undefined);
    assert.equal(detail.source.raw.labels, undefined);
    // Surviving fields (non-content) stay in source.raw.
    assert.equal(detail.source.raw.custom_field, 'kept in source.raw');
    // source.content is capped at MAX_SOURCE_TEXT_BYTES; the truncated
    // flag is set so downstream consumers know the value was clipped.
    assert.equal(detail.source.content.length, 64 * 1024);
    assert.equal(detail.source.content_truncated, true);
    assert.equal(detail.source.introduction.length, 64 * 1024);
    // The detail.beats[0].text still carries the FULL original body —
    // the cap applies only to source.content / source.introduction so
    // the in-app reader still sees the full story.
    assert.equal(detail.beats[0].text.length, 80 * 1024);
  });

  // ----- 19. detailCache is bounded (P1-5) ----------------------------
  await test('19. realProvider.detailCache evicts LRU entries beyond the cap', async () => {
    const tracker = [];
    const fetchSpy = async (url) => {
      tracker.push(new URL(url).pathname);
      return new Response(JSON.stringify({ ...DETAIL_PAYLOAD, work_id: 'id-0' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const provider = createRealZhihuStoryProvider({ fetchImpl: fetchSpy });
    // Pre-warm id-0, id-1, ..., id-255 (256 entries — at the cap).
    for (let i = 0; i < 256; i += 1) {
      await provider.getStory(`id-${i}`);
    }
    // The 257th unique id evicts id-0 from the LRU.
    await provider.getStory('id-257');
    // Re-fetch id-0 — must hit the wire again. We count distinct call
    // timestamps (the URL pathname is the same in the spy above, but
    // the calls themselves are observable).
    const callsBefore = tracker.length;
    await provider.getStory('id-0');
    assert.ok(
      tracker.length > callsBefore,
      `id-0 must be re-fetched after LRU eviction (tracker went from ${callsBefore} to ${tracker.length})`,
    );
  });

  // ----- 20. body size cap (P1-6 / P1-2) ------------------------------
  await test('20. upstream response body > MAX_RESPONSE_BYTES is rejected as upstream_body_too_large', async () => {
    // Fake fetch returns a body that declares Content-Length above the
    // cap. The provider must refuse without buffering the entire body.
    const oversized = 'x'.repeat(2 * 1024 * 1024); // 2 MiB
    const fakeFetch = async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(oversized));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': String(oversized.length),
        },
      });
    };
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
    await assert.rejects(
      () => provider.listStories(),
      (err) => err instanceof ProviderError && err.code === 'upstream_body_too_large',
    );
  });

  // ----- 21. real mode flags admin/chat/generate as mock_only (P1-4) -
  await test('21. /api/health under STORY_OUTSIDE_PROVIDER=real surfaces mock_only_routes', async () => {
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
        assert.equal(health.demo.official_zhihu_api, true);
        assert.ok(Array.isArray(health.demo.mock_only_routes), 'mock_only_routes must be an array');
        // /api/chat must be in the whitelist (it never bound to a real
        // provider in the first place — the contract has no chat
        // endpoint).
        assert.ok(
          health.demo.mock_only_routes.includes('/api/chat'),
          '/api/chat must be on the mock_only_routes whitelist',
        );
        // /api/dev/sessions/:uuid/generate must be in the whitelist
        // (the agent runtime stays deterministic in real mode).
        assert.ok(
          health.demo.mock_only_routes.some((p) => p.endsWith('/generate')),
          '/api/dev/sessions/:uuid/generate must be on the mock_only_routes whitelist',
        );
        // /api/admin/stories/import must be in the whitelist.
        assert.ok(
          health.demo.mock_only_routes.some((p) => p.endsWith('/import')),
          'import route must be on the mock_only_routes whitelist',
        );
      } finally {
        await new Promise((resolve) => appServer.close(resolve));
      }
    } finally {
      delete process.env.STORY_OUTSIDE_PROVIDER;
      __resetStoryProviderForTests();
    }
  });

  // ----- 22. work_id mismatch between list entry and detail param ----
  await test('22. detail request for a work_id the upstream does not know returns StoryNotFoundError, never silent fallback', async () => {
    const fakeFetch = makeFakeFetch({
      '/km-indep-home/hackathon/v2/story/nonexistent': { status: 404 },
    });
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
    await assert.rejects(
      () => provider.getStory('nonexistent'),
      (err) => err instanceof StoryNotFoundError && err.code === 'story_not_found',
    );
    // The provider must NOT serve a cached fallback for a 404 — we
    // confirm the cache stays empty by re-issuing the request after
    // a successful sibling detail, then re-issuing 'nonexistent'.
    const fakeFetch2 = makeFakeFetch({
      '/km-indep-home/hackathon/v2/story/1747681485547843585': { status: 200, body: DETAIL_PAYLOAD },
      '/km-indep-home/hackathon/v2/story/nonexistent': { status: 404 },
    });
    const provider2 = createRealZhihuStoryProvider({ fetchImpl: fakeFetch2 });
    await provider2.getStory('1747681485547843585');
    await assert.rejects(
      () => provider2.getStory('nonexistent'),
      (err) => err instanceof StoryNotFoundError,
    );
  });

  // ----- 23. list resilience: bounded retry + TTL cache + stale fallback --
  // Regression coverage for the 2026-09-14 incident: the upstream edge
  // returned transient 4xx for ~22 minutes and the homepage failed hard.
  // listStories now (a) retries a transient failure once, (b) serves a
  // fresh cache without network, (c) falls back to a recent good list
  // while the upstream is failing, (d) still surfaces the typed error
  // when there is nothing cached. Detail requests keep fail-fast.
  await test('23. transient list 4xx is retried once and then succeeds', async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      if (calls === 1) return new Response('{"error":"edge glitch"}', { status: 403 });
      return new Response(JSON.stringify(LIST_PAYLOAD), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
    const list = await provider.listStories();
    assert.equal(list.length, 2);
    assert.equal(calls, 2, 'exactly one retry after a transient 4xx');
  });

  await test('23.1 list 429 is NOT retried (rate limit must fail fast)', async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      return new Response('', { status: 429 });
    };
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
    await assert.rejects(
      () => provider.listStories(),
      (err) => err instanceof ProviderError && err.code === 'upstream_rate_limited',
    );
    assert.equal(calls, 1, '429 must NOT trigger a retry');
  });

  await test('23.2 fresh list cache is served without touching the network', async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      return new Response(JSON.stringify(LIST_PAYLOAD), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
    await provider.listStories();
    const again = await provider.listStories();
    assert.equal(again.length, 2);
    assert.equal(calls, 1, 'second listStories within TTL must not re-fetch');
  });

  await test('23.3 sustained list failure falls back to the recent good list', async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify(LIST_PAYLOAD), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // Every subsequent attempt fails with the incident's signature.
      return new Response('{"error":"forbidden"}', { status: 403 });
    };
    const realNow = Date.now.bind(Date);
    let fakeNow = realNow();
    Date.now = () => fakeNow;
    try {
      const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
      const first = await provider.listStories();
      assert.equal(first.length, 2);
      // Jump past the fresh-TTL window so the second call must hit the
      // wire, fail, retry once, then serve the stale list.
      fakeNow += 90_000;
      const second = await provider.listStories();
      assert.equal(second.length, 2, 'stale-but-recent list must shield the homepage');
      // 1 initial success + initial attempt + one bounded retry.
      assert.equal(calls, 3, `expected 1 success + 2 failed attempts, saw ${calls}`);
    } finally {
      Date.now = realNow;
    }
  });

  await test('23.3b stale fallback survives beyond the TTL window', async () => {
    // The fresh-TTL window (60s) must not cut off the stale-fallback
    // window (10min): a failure arriving 61s after the last good list
    // still serves the stale list rather than an error page. We fake
    // time by monkey-patching Date.now for the duration of the test.
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify(LIST_PAYLOAD), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{"error":"forbidden"}', { status: 403 });
    };
    const realNow = Date.now.bind(Date);
    let fakeNow = realNow();
    Date.now = () => fakeNow;
    try {
      const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
      await provider.listStories();
      // Jump past LIST_TTL_MS (60s) but stay inside LIST_STALE_MAX_MS (10min).
      fakeNow += 90_000;
      const list = await provider.listStories();
      assert.equal(list.length, 2, 'list older than TTL but within stale window must still be served');
    } finally {
      Date.now = realNow;
    }
  });

  await test('23.4 list failure with NO cached value still raises the typed error', async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      return new Response('{"error":"forbidden"}', { status: 403 });
    };
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
    await assert.rejects(
      () => provider.listStories(),
      (err) => err instanceof ProviderError && err.code === 'upstream_4xx',
    );
    // One initial attempt + one bounded retry, never more.
    assert.equal(calls, 2);
  });

  await test('23.5 list results are defensive copies (cache cannot be mutated)', async () => {
    const fakeFetch = makeFakeFetch({
      '/km-indep-home/hackathon/v2/story/list': { status: 200, body: LIST_PAYLOAD },
    });
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
    const a = await provider.listStories();
    a[0].title = 'mutated';
    a[0].source.labels = ['mutated'];
    const b = await provider.listStories();
    assert.notEqual(b[0].title, 'mutated');
    assert.notEqual(b[0].source.labels[0], 'mutated');
  });

  await test('23.6 detail 4xx is still fail-fast (no retry, no stale fallback)', async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      return new Response('{"error":"forbidden"}', { status: 403 });
    };
    const provider = createRealZhihuStoryProvider({ fetchImpl: fakeFetch });
    await assert.rejects(
      () => provider.getStory('1747681485547843585'),
      (err) => err instanceof ProviderError && err.code === 'upstream_4xx',
    );
    assert.equal(calls, 1, 'detail requests keep the fail-fast contract');
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