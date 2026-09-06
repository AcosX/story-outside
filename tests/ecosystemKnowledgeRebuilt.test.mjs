// tests/ecosystemKnowledgeRebuilt.test.mjs — ClickUp 16.5 (rebuilt) +
// 2026-09-07 P1 fix (PR #25).
//
// Verifies the public POST /v1/ecosystem/knowledge façade end-to-end:
//
//   1. Happy path POST returns 200 + `provisional: true` + non-empty
//      `knowledge[]` + the surface disclaimer.
//   2. Missing required fields (story_uuid, story_version_uuid,
//      community_profile_version) map to 400 validation_failed.
//   3. knowledge_queries[] is REQUIRED and is the ONLY accepted topic
//      source — free-form `query_id` / `topic_label` / `topic` /
//      `theme` / `subject` fields are REJECTED so the AI cannot pick
//      a topic of its own (P1.2, PR #25).
//   4. knowledge_queries[] aggregates one orchestrator.match() per
//      query; the response carries `results[]` with one row per
//      query and a flat deduped `knowledge[]`.
//   5. Real provider env var (ZHIHU_KNOWLEDGE_ENDPOINT) unset → mock
//      fallback. `degraded: true`, `source: 'mock'`, no 5xx.
//   6. Cache is a pair-key map: A→B→A still hits A. Two distinct
//      (story_version_uuid, community_profile_version, query.id)
//      tuples never collide.
//   7. Static guard: no `/api/admin/` or `/api/dev/` references in
//      public/**/*.js (the public contract).
//   8. DEV_FLAG is NOT echoed in the public response.
//   9. Response carries `provisional: true` so a UI / client cannot
//      mistake an entry for canonical story facts.
//  10. player.js mountEndingPage() passes story_uuid + story_version_uuid
//      + community_profile_version + knowledge_queries[] to the
//      ending page (P1.1, PR #25). The player is a courier — it
//      never picks a topic itself.
//  11. endingPage.js renders a `relatedKnowledge` section with stable
//      DOM ids (DOM-injection test using the same harness as
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
const PLAYER_JS_PATH = resolvePath(REPO_ROOT, 'public', 'scripts', 'player.js');

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

const CANONICAL_QUERIES = Object.freeze([
  { id: 'knowledge:abc123', query: '雨夜咖啡馆 设定 百科', kind: 'knowledge' },
  { id: 'knowledge:def456', query: '便利店 夜班 文学流派', kind: 'knowledge' },
  { id: 'knowledge:ghi789', query: '原创短篇 写作伦理', kind: 'knowledge' },
]);

async function main() {
  console.log('--- ClickUp 16.5 (rebuilt) public knowledge surface (P1 fix PR #25) ---');

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
    // P1.2: the handler is the gate. We do NOT allow free-form topic
    // inputs on the public surface.
    const cmd = `grep -nE "topic_label|query_id|\\.topic[^_]|\\.theme|\\.subject" ${REPO_ROOT}/src/server.mjs | grep -i "ecosystem/knowledge" -A0 -B0 || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    check(
      'POST /v1/ecosystem/knowledge handler does NOT accept query_id/topic_label/topic/theme/subject',
      out.trim() === '',
      `unexpected matches:\n${out}`,
    );
  }
  {
    // P1.2: the player is a courier. It never invents a topic of its own
    // — knowledge_queries[] flows straight from /api/sessions into the
    // ending page.
    const cmd = `grep -nE "query_id|topic_label" ${REPO_ROOT}/public/scripts/endingPage.js || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    // Comment lines that DOCUMENT the absence of query_id/topic_label
    // are allowed (the regression-test comment explaining the fix).
    // Strip those out before asserting no live code references exist.
    const lines = out.split('\n').filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      // Strip the optional "<line>:" prefix that grep emits so we
      // can test for a JS comment marker.
      const codeOnly = trimmed.replace(/^\d+:/, '');
      if (codeOnly.startsWith('//') || codeOnly.startsWith('*')) return false;
      return true;
    });
    check(
      'public/scripts/endingPage.js does NOT send query_id/topic_label',
      lines.length === 0,
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
  {
    // P1.1: player.js mountEndingPage MUST pass the three identity
    // fields. The values come from state.* populated by /api/sessions
    // — the player never picks a topic itself.
    const source = await readFile(PLAYER_JS_PATH, 'utf-8');
    check(
      'player.js mountEndingPage passes story_uuid + story_version_uuid + community_profile_version',
      /state\.storyUuid[\s\S]{0,200}story_uuid/.test(source)
        && /state\.storyVersionUuid[\s\S]{0,200}story_version_uuid/.test(source)
        && /state\.communityProfileVersion[\s\S]{0,200}community_profile_version/.test(source),
      'mountEndingPage sessionMeta must include story_uuid + story_version_uuid + community_profile_version',
    );
    check(
      'player.js mountEndingPage forwards canonical knowledge_queries[]',
      /knowledge_queries[\s\S]{0,200}state\.knowledgeQueries/.test(source),
      'mountEndingPage sessionMeta must forward state.knowledgeQueries',
    );
  }
  {
    // P1.1: state.communityProfileVersion is sourced from
    // /api/sessions bootstrap response.
    const source = await readFile(PLAYER_JS_PATH, 'utf-8');
    check(
      'player.js captures community_profile_version from /api/sessions bootstrap',
      /state\.communityProfileVersion[\s\S]{0,200}created\.community_profile_version/.test(source),
      'player.js must capture community_profile_version from bootstrap',
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
      query_id: null,
    });
    const b = buildKnowledgeCacheKey({
      story_version_uuid: 'sv-1',
      community_profile_version: 'cp-1',
      query_id: null,
    });
    assert.equal(a, b);
  });

  await test('buildKnowledgeCacheKey changes with query_id', async () => {
    const a = buildKnowledgeCacheKey({
      story_version_uuid: 'sv-1',
      community_profile_version: 'cp-1',
      query_id: 't-1',
    });
    const b = buildKnowledgeCacheKey({
      story_version_uuid: 'sv-1',
      community_profile_version: 'cp-1',
      query_id: 't-2',
    });
    assert.notEqual(a, b);
  });

  await test('orchestrator uses Map<pair-key, row> not single entry', async () => {
    const orchestrator = createEcosystemKnowledgeProvider({ ttlMs: 1000, swrMs: 2000 });
    // Three different pair-keys must occupy three independent rows.
    const keyA = buildKnowledgeCacheKey({ story_version_uuid: 'sv-A', community_profile_version: 'cp-A', query_id: null });
    const keyB = buildKnowledgeCacheKey({ story_version_uuid: 'sv-B', community_profile_version: 'cp-B', query_id: 't-B' });
    const keyC = buildKnowledgeCacheKey({ story_version_uuid: 'sv-A', community_profile_version: 'cp-A', query_id: 't-C' });
    await orchestrator.match({ story_version_uuid: 'sv-A', community_profile_version: 'cp-A' });
    await orchestrator.match({ story_version_uuid: 'sv-B', community_profile_version: 'cp-B', query_id: 't-B' });
    await orchestrator.match({ story_version_uuid: 'sv-A', community_profile_version: 'cp-A', query_id: 't-C' });
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
  // 2) HTTP façade — live server. The P1 contract:
  //    * knowledge_queries[] is REQUIRED (free-form topic fields are
  //      rejected).
  //    * The orchestrator is invoked once per canonical query and
  //      the response aggregates `results[]` + flat deduped
  //      `knowledge[]`.
  // -----------------------------------------------------------------
  console.log('--- POST /v1/ecosystem/knowledge wire contract (P1) ---');

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

    // Happy path: knowledge_queries[] with 3 canonical queries.
    await test('POST /v1/ecosystem/knowledge happy path → 200 + aggregated 3 results', async () => {
      const r = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 'story-uuid-1',
        story_version_uuid: 'sv-1',
        community_profile_version: 'cp-1',
        knowledge_queries: CANONICAL_QUERIES.map((q) => ({ ...q })),
      });
      assert.equal(r.status, 200, `status=${r.status}`);
      assert.equal(r.body.provisional, true);
      assert.ok(Array.isArray(r.body.knowledge));
      assert.ok(r.body.knowledge.length >= 1);
      // Real provider not configured → mock fallback.
      assert.equal(r.body.degraded, true);
      assert.ok(['mock', 'mixed'].includes(r.body.source));
      assert.equal(typeof r.body.disclaimer, 'string');
      assert.ok(r.body.disclaimer.includes('现实/知乎知识延伸'));
      // knowledge_queries echoed back.
      assert.ok(Array.isArray(r.body.knowledge_queries));
      assert.equal(r.body.knowledge_queries.length, 3);
      assert.equal(r.body.knowledge_queries[0].query, CANONICAL_QUERIES[0].query);
      // results[] has one entry per canonical query.
      assert.ok(Array.isArray(r.body.results));
      assert.equal(r.body.results.length, 3);
      assert.equal(r.body.results[0].query, CANONICAL_QUERIES[0].query);
      assert.equal(r.body.results[0].kind, 'knowledge');
      // NEVER echo DEV_FLAG on the public surface.
      assert.equal(r.body.dev, undefined);
      assert.equal(r.body.demo, undefined);
    });

    // P1.2: knowledge_queries required.
    await test('missing knowledge_queries → 400 validation_failed', async () => {
      const r = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 's',
        story_version_uuid: 'sv-1',
        community_profile_version: 'cp-1',
      });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'validation_failed');
      assert.equal(r.body.field, 'knowledge_queries');
    });

    // P1.2: empty knowledge_queries rejected.
    await test('empty knowledge_queries → 400 validation_failed', async () => {
      const r = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 's',
        story_version_uuid: 'sv-1',
        community_profile_version: 'cp-1',
        knowledge_queries: [],
      });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'validation_failed');
      assert.equal(r.body.field, 'knowledge_queries');
    });

    // P1.2: free-form query_id REJECTED.
    await test('free-form query_id → 400 (P1.2)', async () => {
      const r = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 's',
        story_version_uuid: 'sv-1',
        community_profile_version: 'cp-1',
        knowledge_queries: CANONICAL_QUERIES.map((q) => ({ ...q })),
        query_id: 'free-form-attempt',
      });
      assert.equal(r.status, 400, `query_id should be rejected, got status=${r.status}`);
      assert.equal(r.body.error, 'validation_failed');
    });

    // P1.2: free-form topic_label REJECTED.
    await test('free-form topic_label → 400 (P1.2)', async () => {
      const r = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 's',
        story_version_uuid: 'sv-1',
        community_profile_version: 'cp-1',
        knowledge_queries: CANONICAL_QUERIES.map((q) => ({ ...q })),
        topic_label: 'AI 自己选的主题',
      });
      assert.equal(r.status, 400, `topic_label should be rejected, got status=${r.status}`);
      assert.equal(r.body.error, 'validation_failed');
    });

    // P1.2: free-form topic/theme/subject REJECTED.
    await test('free-form topic/theme/subject → 400 (P1.2)', async () => {
      const r = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 's',
        story_version_uuid: 'sv-1',
        community_profile_version: 'cp-1',
        knowledge_queries: CANONICAL_QUERIES.map((q) => ({ ...q })),
        topic: 'AI 自己想聊的主题',
        theme: 'theme attempt',
        subject: 'subject attempt',
      });
      assert.equal(r.status, 400, `free-form topic/theme/subject should be rejected, got status=${r.status}`);
      assert.equal(r.body.error, 'validation_failed');
    });

    // Validation: missing story_uuid.
    await test('missing story_uuid → 400 validation_failed', async () => {
      const r = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_version_uuid: 'sv-1',
        community_profile_version: 'cp-1',
        knowledge_queries: CANONICAL_QUERIES.map((q) => ({ ...q })),
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
        knowledge_queries: CANONICAL_QUERIES.map((q) => ({ ...q })),
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
        knowledge_queries: CANONICAL_QUERIES.map((q) => ({ ...q })),
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
        knowledge_queries: CANONICAL_QUERIES.map((q) => ({ ...q })),
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

    // P1.2: knowledge_query missing required `query` field.
    await test('knowledge_query missing `query` field → 400', async () => {
      const r = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 's',
        story_version_uuid: 'sv-1',
        community_profile_version: 'cp-1',
        knowledge_queries: [{ kind: 'knowledge' }],
      });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'validation_failed');
    });

    // P1.2: knowledge_query wrong `kind`.
    await test('knowledge_query invalid `kind` → 400', async () => {
      const r = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 's',
        story_version_uuid: 'sv-1',
        community_profile_version: 'cp-1',
        knowledge_queries: [{ query: 'foo', kind: 'unsupported-kind' }],
      });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'validation_failed');
    });

    // Provisional flag is preserved on every response.
    await test('provisional flag is set on success responses', async () => {
      const r = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 's',
        story_version_uuid: 'sv-pf',
        community_profile_version: 'cp-pf',
        knowledge_queries: CANONICAL_QUERIES.map((q) => ({ ...q })),
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
        knowledge_queries: [CANONICAL_QUERIES[0]],
      });
      assert.equal(rA1.body.cached, false);
      // Second A — cache hit.
      const rA2 = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 's',
        story_version_uuid: 'sv-cache-A',
        community_profile_version: 'cp-cache-A',
        knowledge_queries: [CANONICAL_QUERIES[0]],
      });
      assert.equal(rA2.body.cached, true);
      // B — different pair-key, cache miss.
      const rB = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 's',
        story_version_uuid: 'sv-cache-B',
        community_profile_version: 'cp-cache-B',
        knowledge_queries: [CANONICAL_QUERIES[0]],
      });
      assert.equal(rB.body.cached, false);
      // Third A — STILL cached.
      const rA3 = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 's',
        story_version_uuid: 'sv-cache-A',
        community_profile_version: 'cp-cache-A',
        knowledge_queries: [CANONICAL_QUERIES[0]],
      });
      assert.equal(rA3.body.cached, true);
    });

    // Cache isolation across query.id.
    await test('knowledge_query.id isolates cache rows', async () => {
      const rQ1 = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 's',
        story_version_uuid: 'sv-t',
        community_profile_version: 'cp-t',
        knowledge_queries: [{ id: 'q-A', query: 'query A', kind: 'knowledge' }],
      });
      assert.equal(rQ1.body.cached, false);
      const rQ2 = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 's',
        story_version_uuid: 'sv-t',
        community_profile_version: 'cp-t',
        knowledge_queries: [{ id: 'q-B', query: 'query B', kind: 'knowledge' }],
      });
      assert.equal(rQ2.body.cached, false);
      const rQ1b = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 's',
        story_version_uuid: 'sv-t',
        community_profile_version: 'cp-t',
        knowledge_queries: [{ id: 'q-A', query: 'query A', kind: 'knowledge' }],
      });
      assert.equal(rQ1b.body.cached, true);
    });

    // Aggregated results: 3 knowledge_queries → 3 results rows.
    await test('3 knowledge_queries → 3 results rows aggregated', async () => {
      const r = await postJson(baseUrl, '/v1/ecosystem/knowledge', {
        story_uuid: 's',
        story_version_uuid: 'sv-agg',
        community_profile_version: 'cp-agg',
        knowledge_queries: CANONICAL_QUERIES.map((q) => ({ ...q })),
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.results.length, 3);
      assert.equal(r.body.results[0].id, CANONICAL_QUERIES[0].id);
      assert.equal(r.body.results[1].id, CANONICAL_QUERIES[1].id);
      assert.equal(r.body.results[2].id, CANONICAL_QUERIES[2].id);
      // Each result has its own knowledge[] (orchestrator per-query).
      for (const row of r.body.results) {
        assert.ok(Array.isArray(row.knowledge));
        assert.ok(row.knowledge.length >= 0);
        assert.equal(row.source, 'mock'); // real provider not configured
        assert.equal(row.degraded, true);
      }
      // Flat deduped knowledge[] is non-empty.
      assert.ok(r.body.knowledge.length >= 1);
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
        knowledge_queries: CANONICAL_QUERIES.map((q) => ({ ...q })),
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
        knowledge_queries: CANONICAL_QUERIES.map((q) => ({ ...q })),
      });
      const wire = JSON.stringify(r.body || {});
      assert.ok(!/\/api\/admin/.test(wire));
      assert.ok(!/\/api\/dev/.test(wire));
    });
  } finally {
    if (prevEnv !== undefined) process.env.ZHIHU_KNOWLEDGE_ENDPOINT = prevEnv;
    try { appServer.close(); } catch { /* ignore */ }
  }

  // -----------------------------------------------------------------
  // 3) endingPage.js DOM coverage — the page module renders the
  //    `relatedKnowledge` section from sessionMeta carrying the three
  //    canonical identity fields + knowledge_queries[].
  // -----------------------------------------------------------------
  console.log('--- endingPage.js DOM coverage ---');

  await test('endingPage.js renders relatedKnowledge section in the DOM', async () => {
    const source = await readFile(ENDING_PAGE_PATH, 'utf-8');
    const stripped = source.replace(/export\s*\{[^}]*\}\s*;?\s*$/m, '');
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({
        knowledge: [],
        provisional: true,
        degraded: true,
        source: 'mock',
        disclaimer: '以下内容属于现实/知乎知识延伸',
        cache_key: { story_version_uuid: 'sv', community_profile_version: 'cp', query_id: null },
        cached: false,
        fetched_at: new Date().toISOString(),
        knowledge_queries: CANONICAL_QUERIES.map((q) => ({ ...q })),
        results: [],
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
    const wrapper = `${stripped}\nsandbox.__ENDING_PAGE__ = { mount, teardown, STATE };`;
    const fn = new Function('document', 'window', 'fetch', 'sandbox', wrapper);
    fn(minimalDoc, minimalWindow, fakeFetch, sandbox);
    const ep = sandbox.__ENDING_PAGE__;
    await ep.mount({
      sessionUuid: '00000000-0000-4000-8000-000000000099',
      sessionMeta: {
        story_uuid: 's',
        story_version_uuid: 'sv',
        community_profile_version: 'cp',
        knowledge_queries: CANONICAL_QUERIES.map((q) => ({ ...q })),
      },
    });
    const screen = sandbox.document.body.querySelector('#screen-ending');
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
        cache_key: { story_version_uuid: 'sv', community_profile_version: 'cp', query_id: null },
        cached: false,
        fetched_at: new Date().toISOString(),
        knowledge_queries: CANONICAL_QUERIES.map((q) => ({ ...q })),
        results: [],
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
    const wrapper = `${stripped}\nsandbox.__ENDING_PAGE__ = { mount, teardown, STATE };`;
    const fn = new Function('document', 'window', 'fetch', 'sandbox', wrapper);
    fn(minimalDoc, minimalWindow, fakeFetch, sandbox);
    const ep = sandbox.__ENDING_PAGE__;
    await ep.mount({
      sessionUuid: '00000000-0000-4000-8000-000000000099',
      sessionMeta: {
        story_uuid: 's',
        story_version_uuid: 'sv',
        community_profile_version: 'cp',
        knowledge_queries: CANONICAL_QUERIES.map((q) => ({ ...q })),
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