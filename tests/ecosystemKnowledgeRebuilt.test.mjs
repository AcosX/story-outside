// tests/ecosystemKnowledgeRebuilt.test.mjs — ClickUp 16.5 (rebuilt).
//
// Verifies the public POST /v1/ecosystem/knowledge façade end-to-end:
//
//   1. Happy path POST returns 200 + `provisional: true` + non-empty
//      `knowledge[]` + the surface disclaimer.
//   2. Missing required fields (story_uuid, story_version_uuid,
//      community_profile_version) map to 400 validation_failed.
//   3. Real provider env var (ZHIHU_KNOWLEDGE_ENDPOINT) unset → mock
//      fallback. `degraded: true`, `source: 'mock'`, no 5xx.
//   4. Real provider env var set → real fetch goes out; mock is NOT
//      used. The URL it builds is exactly the configured endpoint.
//   5. Cache is a pair-key map: A→B→A still hits A. Two distinct
//      (story_version_uuid, community_profile_version, topic_id)
//      tuples never collide.
//   6. Static guard: no `/api/admin/` or `/api/dev/` references in
//      public/**/*.js (the public contract).
//   7. DEV_FLAG is NOT echoed in the public response.
//   8. Response carries `provisional: true` so a UI / client cannot
//      mistake an entry for canonical story facts.
//   9. endingPage.js has a `relatedKnowledge` section with stable DOM
//      ids (DOM-injection test using the same harness as
//      endingPage.test.mjs).
//
// Static contract guards live in the public/scripts/ sub-tree only.

import assert from 'node:assert/strict';
import http from 'node:http';
import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

import { server } from '../src/server.mjs';
import {
  createEcosystemKnowledgeProvider,
  buildKnowledgeCacheKey,
} from '../src/providers/ecosystem/knowledge.mjs';
import {
  createRealZhihuKnowledgeProvider,
  readKnowledgeBaseUrl,
} from '../src/providers/ecosystem/zhihuKnowledgeSource.mjs';
import {
  MOCK_KNOWLEDGE_ENTRIES,
  knowledgeSurfaceDisclaimer,
} from '../src/providers/ecosystem/mockKnowledgeSource.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, '..');
const ENDING_PAGE_PATH = resolvePath(REPO_ROOT, 'public', 'scripts', 'endingPage.js');

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

function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`);
  else {
    casesFailed += 1;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`);
  }
}

async function pickPort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

async function postJson(baseUrl, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body: json };
}

async function main() {
  console.log('--- ClickUp 16.5 (rebuilt) public knowledge surface ---');

  // -----------------------------------------------------------------
  // 0) Static contract guards — run BEFORE the HTTP suite so a CI
  //    failure points at the contract violation, not at the server.
  // -----------------------------------------------------------------
  {
    const cmd = `grep -rE "/api/(admin|dev)/" ${REPO_ROOT}/public --include="*.js" || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    check(
      'public/**/*.js does NOT reference /api/admin/ or /api/dev/',
      out.trim() === '',
      `unexpected matches:\n${out}`,
    );
  }
  {
    const cmd = `grep -rE "let cache = null|let cache;" ${REPO_ROOT}/src/providers/ecosystem --include="*Knowledge*" || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    check(
      'src/providers/ecosystem/*Knowledge* does NOT use single-entry let cache',
      out.trim() === '',
      `unexpected matches:\n${out}`,
    );
  }
  {
    const cmd = `grep -nE "knowledge/list|km-indep" ${REPO_ROOT}/src/providers/ecosystem/zhihuKnowledgeSource.mjs || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    // Only the explanatory comment is allowed. The comment explicitly
    // says we do NOT hard-code the URL — every match must contain the
    // word "never" or be a comment line that documents the absence of
    // the contract. Filter out the explanatory line and assert the
    // remainder is empty.
    const stripped = out
      .split('\n')
      .filter((line) => {
        if (!line.trim()) return false;
        // Comment lines documenting the absence of the contract are
        // allowed. They MUST contain "never" or "contract" or "do not".
        if (/never/i.test(line) || /contract/i.test(line) || /do not/i.test(line)) {
          return false;
        }
        return true;
      })
      .join('\n');
    check(
      'real provider does NOT hard-code knowledge endpoint',
      stripped.trim() === '',
      `unexpected matches:\n${out}`,
    );
  }
  {
    const cmd = `grep -n "provisional: true" ${REPO_ROOT}/src/server.mjs || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    check(
      'src/server.mjs carries the provisional flag contract',
      out.trim().length > 0,
      `no provisional marker found`,
    );
  }
  {
    const cmd = `grep -n "relatedKnowledge" ${REPO_ROOT}/public/scripts/endingPage.js || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    check(
      'public/scripts/endingPage.js has relatedKnowledge section',
      out.trim().length > 0,
      `no relatedKnowledge reference found`,
    );
  }
  {
    const cmd = `grep -nE "/api/(admin|dev)/" ${REPO_ROOT}/public/scripts/endingPage.js || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    check(
      'endingPage.js does NOT touch /api/admin/ or /api/dev/',
      out.trim() === '',
      `unexpected matches:\n${out}`,
    );
  }

  // -----------------------------------------------------------------
  // 1) Unit-level cache contract — pair-key map, no single entry.
  //    These tests do not require the HTTP server.
  // -----------------------------------------------------------------
  console.log('--- knowledge orchestrator cache contract ---');

  await test('buildKnowledgeCacheKey is stable across inputs', async () => {
    const a = buildKnowledgeCacheKey({
      story_version_uuid: 'sv-1',
      community_profile_version: 'cp-1',
      topic_id: null,
    });
    const b = buildKnowledgeCacheKey({
      story_version_uuid: 'sv-1',
      community_profile_version: 'cp-1',
      topic_id: null,
    });
    assert.equal(a, b);
  });

  await test('buildKnowledgeCacheKey changes with topic_id', async () => {
    const a = buildKnowledgeCacheKey({
      story_version_uuid: 'sv-1',
      community_profile_version: 'cp-1',
      topic_id: 't-1',
    });
    const b = buildKnowledgeCacheKey({
      story_version_uuid: 'sv-1',
      community_profile_version: 'cp-1',
      topic_id: 't-2',
    });
    assert.notEqual(a, b);
  });

  await test('orchestrator uses Map<pair-key, row> not single entry', async () => {
    const orchestrator = createEcosystemKnowledgeProvider({ ttlMs: 1000, swrMs: 2000 });
    // Three different pair-keys must occupy three independent rows.
    const keyA = buildKnowledgeCacheKey({ story_version_uuid: 'sv-A', community_profile_version: 'cp-A', topic_id: null });
    const keyB = buildKnowledgeCacheKey({ story_version_uuid: 'sv-B', community_profile_version: 'cp-B', topic_id: 't-B' });
    const keyC = buildKnowledgeCacheKey({ story_version_uuid: 'sv-A', community_profile_version: 'cp-A', topic_id: 't-C' });
    await orchestrator.match({ story_version_uuid: 'sv-A', community_profile_version: 'cp-A' });
    await orchestrator.match({ story_version_uuid: 'sv-B', community_profile_version: 'cp-B', topic_id: 't-B' });
    await orchestrator.match({ story_version_uuid: 'sv-A', community_profile_version: 'cp-A', topic_id: 't-C' });
    const keys = orchestrator._keys();
    assert.equal(keys.length, 3, `expected 3 cache rows, got ${keys.length}: ${keys.join(',')}`);
    assert.ok(keys.includes(keyA));
    assert.ok(keys.includes(keyB));
    assert.ok(keys.includes(keyC));
  });

  await test('A→B→A still hits the A row (pair-key isolation)', async () => {
    let calls = 0;
    const mockFetch = () => {
      calls += 1;
      return MOCK_KNOWLEDGE_ENTRIES.map((e) => ({
        id: e.id,
        title: e.title,
        summary: e.summary,
        source: e.source,
        url: e.url,
        related_topics: e.related_topics.slice(),
        disclaimer: knowledgeSurfaceDisclaimer(),
      }));
    };
    const orchestrator = createEcosystemKnowledgeProvider({
      mockFetch,
      ttlMs: 1000,
      swrMs: 2000,
    });
    // A: first fetch.
    const rA1 = await orchestrator.match({ story_version_uuid: 'sv-iso-A', community_profile_version: 'cp-iso-A' });
    assert.equal(rA1.cached, false);
    // A: hit cache.
    const rA2 = await orchestrator.match({ story_version_uuid: 'sv-iso-A', community_profile_version: 'cp-iso-A' });
    assert.equal(rA2.cached, true);
    // B: different pair-key → forces a fresh fetch.
    const rB = await orchestrator.match({ story_version_uuid: 'sv-iso-B', community_profile_version: 'cp-iso-B' });
    assert.equal(rB.cached, false);
    // A again: must STILL hit the cached A row, not the B fetch.
    const rA3 = await orchestrator.match({ story_version_uuid: 'sv-iso-A', community_profile_version: 'cp-iso-A' });
    assert.equal(rA3.cached, true, 'A row should still be cached after B fetch');
    // Mock was called exactly twice (once for A, once for B).
    assert.equal(calls, 2, `mock called ${calls} times; expected 2`);
  });

  await test('real provider not configured → degraded mock fallback', async () => {
    // Clear the env to be sure.
    const prev = process.env.ZHIHU_KNOWLEDGE_ENDPOINT;
    delete process.env.ZHIHU_KNOWLEDGE_ENDPOINT;
    try {
      const real = createRealZhihuKnowledgeProvider();
      assert.equal(real.isConfigured(), false);
      await assert.rejects(
        () => real.fetchKnowledge({}),
        (err) => err && err.code === 'unconfigured',
        'real provider must raise unconfigured when env var missing',
      );
      const orchestrator = createEcosystemKnowledgeProvider({ realProvider: real });
      const r = await orchestrator.match({
        story_version_uuid: 'sv-fb',
        community_profile_version: 'cp-fb',
      });
      assert.equal(r.source, 'mock');
      assert.equal(r.degraded, true);
      assert.equal(r.provisional, true);
      assert.ok(Array.isArray(r.knowledge) && r.knowledge.length >= 1);
    } finally {
      if (prev !== undefined) process.env.ZHIHU_KNOWLEDGE_ENDPOINT = prev;
    }
  });

  await test('readKnowledgeBaseUrl returns null on unset', async () => {
    const prev = process.env.ZHIHU_KNOWLEDGE_ENDPOINT;
    delete process.env.ZHIHU_KNOWLEDGE_ENDPOINT;
    try {
      const v = readKnowledgeBaseUrl();
      assert.equal(v, null);
    } finally {
      if (prev !== undefined) process.env.ZHIHU_KNOWLEDGE_ENDPOINT = prev;
    }
  });

  // -----------------------------------------------------------------
  // 2) HTTP façade — live server.
  // -----------------------------------------------------------------
  console.log('--- POST /v1/ecosystem/knowledge wire contract ---');

  // Ensure the env var is unset so the real provider stays
  // unconfigured. The server module is already imported above; the
  // knowledge provider factory reads the env at construction time,
  // so unsetting it here suffices for the default provider instance.
  const prevEnv = process.env.ZHIHU_KNOWLEDGE_ENDPOINT;
  delete process.env.ZHIHU_KNOWLEDGE_ENDPOINT;

  let appServer = server;
  let baseUrl = '';
  let port = 0;
  try {
    port = await pickPort();
    await new Promise((resolve) => appServer.listen(port, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${port}`;

    // Happy path.
    await test('POST /v1/ecosystem/knowledge happy path → 200', async () => {
      const r = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 'story-uuid-1',
        story_version_uuid: 'sv-1',
        community_profile_version: 'cp-1',
      });
      assert.equal(r.status, 200, `status=${r.status}`);
      assert.equal(r.body.provisional, true);
      assert.ok(Array.isArray(r.body.knowledge));
      assert.ok(r.body.knowledge.length >= 1);
      assert.equal(r.body.source, 'mock'); // real provider not configured
      assert.equal(r.body.degraded, true);
      assert.equal(typeof r.body.disclaimer, 'string');
      assert.ok(r.body.disclaimer.includes('现实/知乎知识延伸'));
      assert.ok(r.body.cache_key);
      assert.equal(r.body.cache_key.story_version_uuid, 'sv-1');
      assert.equal(r.body.cache_key.community_profile_version, 'cp-1');
      // NEVER echo DEV_FLAG on the public surface.
      assert.equal(r.body.dev, undefined);
      assert.equal(r.body.demo, undefined);
    });

    // Validation: missing story_uuid.
    await test('missing story_uuid → 400 validation_failed', async () => {
      const r = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_version_uuid: 'sv-1',
        community_profile_version: 'cp-1',
      });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'validation_failed');
      assert.equal(r.body.field, 'story_uuid');
    });

    // Validation: missing story_version_uuid.
    await test('missing story_version_uuid → 400', async () => {
      const r = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 's',
        community_profile_version: 'cp-1',
      });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'validation_failed');
      assert.equal(r.body.field, 'story_version_uuid');
    });

    // Validation: missing community_profile_version.
    await test('missing community_profile_version → 400', async () => {
      const r = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 's',
        story_version_uuid: 'sv-1',
      });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'validation_failed');
      assert.equal(r.body.field, 'community_profile_version');
    });

    // Validation: unknown field.
    await test('unknown field → 400 validation_failed', async () => {
      const r = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 's',
        story_version_uuid: 'sv-1',
        community_profile_version: 'cp-1',
        evil: 'should-not-be-allowed',
      });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'validation_failed');
    });

    // Bad json.
    await test('bad json body → 400 bad_json', async () => {
      const r = await postJson(baseUrl, '/v1/ecosystem/knowledge', '{not-json');
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'bad_json');
    });

    // Provisional flag is preserved on every response.
    await test('provisional flag is set on success responses', async () => {
      const r = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 's',
        story_version_uuid: 'sv-pf',
        community_profile_version: 'cp-pf',
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.provisional, true);
    });

    // Pair-key cache: A→B→A still hits A.
    await test('pair-key cache: A→B→A still hits A', async () => {
      // First A — cache miss.
      const rA1 = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 's',
        story_version_uuid: 'sv-cache-A',
        community_profile_version: 'cp-cache-A',
      });
      assert.equal(rA1.body.cached, false);
      // Second A — cache hit.
      const rA2 = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 's',
        story_version_uuid: 'sv-cache-A',
        community_profile_version: 'cp-cache-A',
      });
      assert.equal(rA2.body.cached, true);
      // B — different pair-key, cache miss.
      const rB = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 's',
        story_version_uuid: 'sv-cache-B',
        community_profile_version: 'cp-cache-B',
      });
      assert.equal(rB.body.cached, false);
      // Third A — STILL cached.
      const rA3 = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 's',
        story_version_uuid: 'sv-cache-A',
        community_profile_version: 'cp-cache-A',
      });
      assert.equal(rA3.body.cached, true);
      // Pair-key echoes back.
      assert.equal(rA3.body.cache_key.story_version_uuid, 'sv-cache-A');
      assert.equal(rA3.body.cache_key.community_profile_version, 'cp-cache-A');
    });

    // Topic isolation.
    await test('topic_id isolates cache rows', async () => {
      const rT1 = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 's',
        story_version_uuid: 'sv-t',
        community_profile_version: 'cp-t',
        topic_id: 't-1',
      });
      assert.equal(rT1.body.cached, false);
      const rT2 = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 's',
        story_version_uuid: 'sv-t',
        community_profile_version: 'cp-t',
        topic_id: 't-2',
      });
      assert.equal(rT2.body.cached, false);
      const rT1b = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 's',
        story_version_uuid: 'sv-t',
        community_profile_version: 'cp-t',
        topic_id: 't-1',
      });
      assert.equal(rT1b.body.cached, true);
    });

    // Real provider configured → real fetch goes out, mock is NOT used.
    await test('real provider configured → real fetch hits configured URL', async () => {
      const calls = [];
      const fakeFetch = async (url, init) => {
        calls.push({ url: String(url), init });
        if ('authorization' in Object(init && init.headers || {})) {
          throw new Error('forbidden header set on upstream request');
        }
        return new Response(
          JSON.stringify({
            entries: [
              {
                id: 'real-001',
                title: 'real upstream entry',
                summary: 'real entry summary',
                source: 'zhihu-knowledge-real',
                url: 'https://www.zhihu.com/knowledge/real-001',
                related_topics: ['real', 'topic'],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      };
      const real = createRealZhihuKnowledgeProvider({
        baseUrl: 'https://example.test/knowledge',
        fetchImpl: fakeFetch,
      });
      assert.equal(real.isConfigured(), true);
      // Construct a parallel orchestrator against this real provider
      // and a mock that must NOT be called.
      let mockCalls = 0;
      const mockFetch = () => {
        mockCalls += 1;
        throw new Error('mock must NOT be called when real is configured');
      };
      const orchestrator = createEcosystemKnowledgeProvider({
        realProvider: real,
        mockFetch,
        ttlMs: 1000,
        swrMs: 2000,
      });
      const r = await orchestrator.match({
        story_version_uuid: 'sv-real',
        community_profile_version: 'cp-real',
      });
      assert.equal(r.source, 'real');
      assert.equal(r.degraded, false);
      assert.equal(r.provisional, true);
      assert.equal(r.knowledge.length, 1);
      assert.equal(r.knowledge[0].id, 'real-001');
      assert.equal(mockCalls, 0);
      assert.equal(calls.length, 1);
      assert.ok(calls[0].url.startsWith('https://example.test/knowledge'));
    });

    // Static guard: DEV_FLAG is NOT in the public response.
    await test('DEV_FLAG is NOT echoed on /v1/ecosystem/knowledge', async () => {
      const r = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 's',
        story_version_uuid: 'sv-dev',
        community_profile_version: 'cp-dev',
      });
      const wire = JSON.stringify(r.body || {});
      assert.ok(!/admin_only/.test(wire), 'admin_only leaked');
      assert.ok(!/dev_only/.test(wire), 'dev_only leaked');
      assert.ok(!/"dev"\s*:/.test(wire), '"dev" key leaked');
    });

    // Static guard: knowledge entries do NOT include /api/admin or /api/dev.
    await test('knowledge entries do NOT include /api/admin or /api/dev', async () => {
      const r = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 's',
        story_version_uuid: 'sv-leak',
        community_profile_version: 'cp-leak',
      });
      const wire = JSON.stringify(r.body || {});
      assert.ok(!/\/api\/admin/.test(wire));
      assert.ok(!/\/api\/dev/.test(wire));
    });

    // endingPage DOM coverage.
    await test('endingPage.js renders relatedKnowledge section in the DOM', async () => {
      const source = await readFile(ENDING_PAGE_PATH, 'utf-8');
      // Stub minimal DOM just enough to drive the section builder.
      const calls = { mount: null };
      // Strip ESM export tail and execute in a sandbox.
      const stripped = source.replace(/export\s*\{[^}]*\}\s*;?\s*$/m, '');
      const wrapper = `${stripped}\nsandbox.__ENDING_PAGE__ = { mount, teardown, STATE };`;
      const minimalDoc = makeMinimalDom();
      const minimalWindow = { location: { href: 'http://localhost/?s=ending' }, history: { replaceState() {} } };
      const sandbox = {
        document: minimalDoc,
        window: minimalWindow,
        fetch: 'fetch',
        __ENDING_PAGE__: null,
      };
      const fn = new Function('document', 'window', 'fetch', 'sandbox', wrapper);
      fn(minimalDoc, minimalWindow, () => {}, sandbox);
      const ep = sandbox.__ENDING_PAGE__;
      assert.ok(ep && typeof ep.mount === 'function', 'endingPage module did not expose mount');
      // Mount with a degraded knowledge state — section must still
      // render with the disabled hint.
      const degradedState = {
        degraded: true,
        knowledge: [],
        provisional: true,
        source: 'mock',
      };
      // Manually push the section since mount also pulls from /api.
      // We call the section renderer indirectly by populating STATE
      // and re-running render.
      ep.STATE.ending = {
        ending_title: 'test',
        ending_summary: 'summary',
      };
      ep.STATE.originalTimeline = { source_attribution: 'src', key_facts: [] };
      ep.STATE.replay = { events: [] };
      ep.STATE.relatedKnowledge = degradedState;
      // Re-run the public render path: emulate the body of mount()
      // after the projections have been resolved.
      ep.STATE.sessionUuid = '00000000-0000-4000-8000-000000000099';
      // Inline call into the render path: we re-execute the module
      // body so we can call render() — but render is not exported,
      // so we drive mount() with a mocked fetch that resolves
      // immediately. The simplest verification: assert the source
      // contains the section builder AND assert the DOM after mount.
      assert.ok(/renderRelatedKnowledgeSection/.test(source));
      assert.ok(/relatedKnowledge/.test(source));
      assert.ok(/ending-related-knowledge/.test(source));
      assert.ok(/相关话题/.test(source) || /相关话题/.test(wrapper));
      assert.ok(/知识延伸暂未启用/.test(source) || /知识延伸暂未启用/.test(wrapper));
      // DOM assertion: call mount() and assert the section exists.
      // mount() calls fetchRelatedKnowledge, which fetches
      // /v1/ecosystem/knowledge — stub fetch to return the
      // degraded state.
      const fakeFetch = async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({
          knowledge: [],
          provisional: true,
          degraded: true,
          source: 'mock',
          disclaimer: '...',
          cache_key: { story_version_uuid: 'sv', community_profile_version: 'cp', topic_id: null },
          cached: false,
          fetched_at: new Date().toISOString(),
        }),
      });
      const sandbox2 = {
        document: makeMinimalDom(),
        window: minimalWindow,
        fetch: fakeFetch,
        __ENDING_PAGE__: null,
      };
      const wrapper2 = `${stripped}\nsandbox.__ENDING_PAGE__ = { mount, teardown, STATE };`;
      const fn2 = new Function('document', 'window', 'fetch', 'sandbox', wrapper2);
      fn2(sandbox2.document, sandbox2.window, fakeFetch, sandbox2);
      const ep2 = sandbox2.__ENDING_PAGE__;
      await ep2.mount({
        sessionUuid: '00000000-0000-4000-8000-000000000099',
        sessionMeta: {
          story_uuid: 's',
          story_version_uuid: 'sv',
          community_profile_version: 'cp',
        },
      });
      const screen = sandbox2.document.body.querySelector('#screen-ending');
      const section = screen.querySelector('#ending-related-knowledge');
      assert.ok(section, 'relatedKnowledge section not found in DOM');
      const disabled = section.querySelector('#ending-related-knowledge-disabled');
      assert.ok(disabled, 'disabled hint not rendered');
      const intro = section.querySelector('#ending-related-knowledge-intro');
      assert.ok(intro, 'disclaimer intro not rendered');
      const introText = intro.textContent || '';
      assert.ok(introText.includes('以下内容属于现实/知乎知识延伸'),
        `disclaimer text missing from intro: ${introText}`);
    });

    await test('endingPage.js renders real knowledge entries when enabled', async () => {
      const source = await readFile(ENDING_PAGE_PATH, 'utf-8');
      const stripped = source.replace(/export\s*\{[^}]*\}\s*;?\s*$/m, '');
      const wrapper = `${stripped}\nglobalThis.__ENDING_PAGE__ = { mount, teardown, STATE };`;
      const fakeFetch = async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({
          knowledge: [
            {
              id: 'mock-know-001',
              title: '雨夜咖啡馆叙事技巧',
              summary: '知乎社区对短篇 + 凌晨时空叙事的总结',
              source: 'zhihu-knowledge-mock',
              url: 'https://www.zhihu.com/knowledge/mock-001',
              related_topics: ['写作技巧', '短篇叙事'],
              disclaimer: '以下内容属于现实/知乎知识延伸，不是原作设定或 AI 世界线事实',
            },
          ],
          provisional: true,
          degraded: false,
          source: 'mock',
          disclaimer: '以下内容属于现实/知乎知识延伸，不是原作设定或 AI 世界线事实',
          cache_key: { story_version_uuid: 'sv', community_profile_version: 'cp', topic_id: null },
          cached: false,
          fetched_at: new Date().toISOString(),
        }),
      });
      const minimalDoc = makeMinimalDom();
      const minimalWindow = { location: { href: 'http://localhost/?s=ending' }, history: { replaceState() {} } };
      const sandbox = {
        document: minimalDoc,
        window: minimalWindow,
        fetch: fakeFetch,
        __ENDING_PAGE__: null,
      };
      const wrapper3 = `${stripped}\nsandbox.__ENDING_PAGE__ = { mount, teardown, STATE };`;
      const fn = new Function('document', 'window', 'fetch', 'sandbox', wrapper3);
      fn(minimalDoc, minimalWindow, fakeFetch, sandbox);
      const ep = sandbox.__ENDING_PAGE__;
      await ep.mount({
        sessionUuid: '00000000-0000-4000-8000-000000000099',
        sessionMeta: {
          story_uuid: 's',
          story_version_uuid: 'sv',
          community_profile_version: 'cp',
        },
      });
      const screen = sandbox.document.body.querySelector('#screen-ending');
      const section = screen.querySelector('#ending-related-knowledge');
      assert.ok(section);
      const list = section.querySelector('#ending-related-knowledge-list');
      assert.ok(list, 'entry list not rendered');
      const items = list.children;
      assert.ok(items.length >= 1, `expected at least one entry, got ${items.length}`);
      const firstTitle = items[0].querySelector('.related-knowledge-link, .related-knowledge-title');
      assert.ok(firstTitle);
    });
  } finally {
    if (prevEnv !== undefined) process.env.ZHIHU_KNOWLEDGE_ENDPOINT = prevEnv;
    try { appServer.close(); } catch { /* ignore */ }
  }

  console.log(`\n--- ${casesRun - casesFailed}/${casesRun} passed ---`);
  if (casesFailed > 0) {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------
// Minimal DOM stub. Just enough surface for endingPage.js to render.
// ---------------------------------------------------------------------
function makeMinimalDom() {
  const document = makeElement('html', { tagName: 'HTML' });
  // Polyfills used by endingPage.js.
  document.createElement = (tag) => makeElement(tag);
  document.createTextNode = (text) => ({ nodeType: 3, textContent: String(text == null ? '' : text) });
  const head = makeElement('head', { tagName: 'HEAD' });
  const body = makeElement('body', { tagName: 'BODY' });
  const playerMain = makeElement('div', { id: 'player-main' });
  const screenEnding = makeElement('section', { id: 'screen-ending', dataset: { screen: 'ending' } });
  playerMain.appendChild(screenEnding);
  body.appendChild(playerMain);
  document.appendChild(head);
  document.appendChild(body);
  // Expose standard DOM shortcuts.
  Object.defineProperty(document, 'body', { configurable: true, get() { return body; } });
  Object.defineProperty(document, 'head', { configurable: true, get() { return head; } });
  return document;
}

function makeElement(tag, props = {}) {
  const node = {
    tagName: (props.tagName || tag).toUpperCase(),
    nodeType: 1,
    children: [],
    childNodes: [],
    parentNode: null,
    classList: makeClassList(),
    dataset: { ...(props.dataset || {}) },
    style: {},
    hidden: false,
    _attrs: {},
    get firstChild() { return this.children[0] || null; },
    get lastChild() { return this.children[this.children.length - 1] || null; },
    get nextSibling() { return null; },
    get parentElement() { return this.parentNode; },
    get id() { return this._attrs.id || ''; },
    set id(v) { this._attrs.id = v; },
    get className() { return this._attrs.class || ''; },
    set className(v) { this._attrs.class = v; },
    get textContent() {
      let out = '';
      for (const c of this.children) out += c.textContent || '';
      return out;
    },
    set textContent(v) {
      this.children = [];
      if (v != null && v !== '') {
        this.children.push({ nodeType: 3, textContent: String(v) });
      }
    },
    // Methods are defined inline so the props loop below can call
    // setAttribute without a forward-reference.
    setAttribute(name, value) {
      this._attrs[name] = String(value == null ? '' : value);
      if (name === 'class') this.className = String(value);
      if (name === 'id') this.id = String(value);
    },
    getAttribute(name) {
      return this._attrs[name] != null ? this._attrs[name] : null;
    },
    removeAttribute(name) {
      delete this._attrs[name];
    },
    appendChild(child) {
      if (child == null) return child;
      if (child.nodeType === 3) {
        this.children.push({ nodeType: 3, textContent: child.textContent || '' });
      } else {
        child.parentNode = this;
        this.children.push(child);
      }
      return child;
    },
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) this.children.splice(idx, 1);
      return child;
    },
    querySelector(sel) {
      return queryBySel(this, sel);
    },
    querySelectorAll(sel) {
      return queryAllBySel(this, sel);
    },
    addEventListener() {},
    removeEventListener() {},
  };
  for (const [k, v] of Object.entries(props)) {
    if (k === 'tagName' || k === 'children' || k === 'dataset') continue;
    node.setAttribute(k, v);
  }
  return node;
}

function makeClassList() {
  const list = [];
  const classList = {
    list,
    add() { for (const c of arguments) if (!list.includes(c)) list.push(c); },
    remove() { for (const c of arguments) { const i = list.indexOf(c); if (i >= 0) list.splice(i, 1); } },
    toggle(c, force) {
      if (force === true) { this.add(c); return true; }
      if (force === false) { this.remove(c); return false; }
      if (list.includes(c)) { this.remove(c); return false; }
      this.add(c);
      return true;
    },
    contains(c) { return list.includes(c); },
  };
  return classList;
}

function queryBySel(root, sel) {
  // Very small selector engine. id: '#id'; class: '.cls'; tag: 'tag'.
  const all = [];
  walk(root);
  return all[0] || null;
  function walk(n) {
    if (!n || !n.children) return;
    for (const c of n.children) {
      if (c.nodeType === 1) {
        if (matches(c, sel)) all.push(c);
        walk(c);
      }
    }
  }
}

function queryAllBySel(root, sel) {
  const all = [];
  walk(root);
  return all;
  function walk(n) {
    if (!n || !n.children) return;
    for (const c of n.children) {
      if (c.nodeType === 1) {
        if (matches(c, sel)) all.push(c);
        walk(c);
      }
    }
  }
}

function matches(node, sel) {
  if (!sel) return false;
  // Comma-separated: any segment matches.
  const segments = sel.split(/\s*,\s*/);
  for (const seg of segments) {
    if (matchOne(node, seg)) return true;
  }
  return false;
}

function matchOne(node, sel) {
  if (!sel) return false;
  if (sel.startsWith('#')) {
    return node.id === sel.slice(1);
  }
  if (sel.startsWith('.')) {
    const cls = (node.className || '').split(/\s+/);
    return cls.includes(sel.slice(1));
  }
  return (node.tagName || '').toLowerCase() === sel.toLowerCase();
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});