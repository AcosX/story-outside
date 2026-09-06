// tests/clickup16-5-p1-v2.test.mjs
//
// ClickUp 16.5 P1 v2 regression — server-authoritative canonical
// queries + q.query truly drives retrieval.
//
// Owner巡检 + ChatGPT independent review (2026-09-07 02:23) flagged
// PR #25 (a54aebd) for two P1 blockers:
//
//   P1.v2-1 — POST /v1/ecosystem/knowledge still read
//   `body.knowledge_queries[]` from the request and forwarded it
//   straight into the orchestrator. The browser could therefore
//   pick any query, defeating the canonical-subject contract.
//
//   P1.v2-2 — knowledge.mjs cache key was
//   `(story_version_uuid, community_profile_version, query_id)`,
//   i.e. it used the canonical `query.id` only and ignored the
//   canonical `query.query` string. Two completely different
//   canonical queries with two completely different query strings
//   therefore collapsed onto the same cache row, returning the
//   same bundle.
//
// This test rebuilds the regression on a CLEAN main (44343b2) and
// asserts the v2 contract:
//
//   P1.v2-1
//     * body whitelist is strict — only
//       {story_uuid, story_version_uuid, community_profile_version,
//       limit?} is accepted.
//     * Every forbidden surface field is rejected with 400
//       `forbidden_field`: knowledge_queries, topic_id, topic_label,
//       topic, theme, subject, query, identity.
//     * Server-side canonical lookup is performed via
//       `communityProfileService.findCanonicalByIdentity` and the
//       canonical `profile.knowledge_queries` are the ONLY source
//       of queries.
//     * Identity mismatch returns 400 with one of the three typed
//       reasons: `community_profile_not_found`,
//       `community_profile_version_mismatch`,
//       `story_version_mismatch`.
//
//   P1.v2-2
//     * Cache key contains `query_hash` (sha256 of the query
//       string), NOT just `query_id`.
//     * `knowledge.mjs match()` invokes the upstream provider
//       with `query.query` (the verbatim string), NOT `query.id`.
//     * Two distinct canonical query strings produce two distinct
//       cache rows and two distinct result bundles.
//     * Re-calling with the same identity + same query string hits
//       the cache (`cached: true`) but does NOT collapse the two
//       bundles.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import http from 'node:http';

import { server } from '../src/server.mjs';
import {
  createEcosystemKnowledgeProvider,
  buildKnowledgeCacheKey,
  hashQuery,
} from '../src/providers/ecosystem/knowledge.mjs';

import {
  createInMemoryCommunityProfileRepository,
  seedCommunityProfiles,
} from '../src/community/index.mjs';

import { createSeededRepository } from '../src/stories/fixture.mjs';

// ----- helpers ----------------------------------------------------------

const CAFE_RAIN_STORY_UUID = '11111111-1111-4111-8111-111111111111';
const CAFE_RAIN_VERSION_UUID = '21111111-1111-4111-8111-111111111111';
const CAFE_RAIN_PROFILE_VERSION = 'community-profile@community-profile-rules/1';

const FORBIDDEN_FIELDS = [
  'knowledge_queries',
  'topic_id',
  'topic_label',
  'topic',
  'theme',
  'subject',
  'query',
  'identity',
  'q',
  'prompt',
  'search',
];

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

async function startServer() {
  const port = await pickPort();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** @returns {Promise<Response>} */
function post(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ----- 1. forbidden_field ----------------------------------------------

test('forbidden_field: knowledge_queries supplied → 400', async () => {
  const ctx = await startServer();
  try {
    const res = await post(`${ctx.baseUrl}/v1/ecosystem/knowledge`, {
      story_uuid: CAFE_RAIN_STORY_UUID,
      story_version_uuid: CAFE_RAIN_VERSION_UUID,
      community_profile_version: CAFE_RAIN_PROFILE_VERSION,
      knowledge_queries: [{ id: 'fake', query: 'anything', kind: 'fake' }],
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'forbidden_field');
    assert.deepEqual(body.unknown_fields, ['knowledge_queries']);
  } finally {
    await ctx.close();
  }
});

test('forbidden_field: each banned free-form field is rejected', async () => {
  const ctx = await startServer();
  try {
    for (const field of FORBIDDEN_FIELDS) {
      const payload = {
        story_uuid: CAFE_RAIN_STORY_UUID,
        story_version_uuid: CAFE_RAIN_VERSION_UUID,
        community_profile_version: CAFE_RAIN_PROFILE_VERSION,
        [field]: field === 'knowledge_queries' ? [{ id: 'x', query: 'x', kind: 'web' }] : 'x',
      };
      const res = await post(`${ctx.baseUrl}/v1/ecosystem/knowledge`, payload);
      assert.equal(res.status, 400, `field=${field}`);
      const body = await res.json();
      assert.equal(body.error, 'forbidden_field', `field=${field}`);
      assert.ok(
        Array.isArray(body.unknown_fields) && body.unknown_fields.includes(field),
        `field=${field} unknown_fields=${JSON.stringify(body.unknown_fields)}`,
      );
    }
  } finally {
    await ctx.close();
  }
});

// ----- 2. identity mismatch typed 400 ----------------------------------

test('community_profile_version_mismatch → 400', async () => {
  const ctx = await startServer();
  try {
    const res = await post(`${ctx.baseUrl}/v1/ecosystem/knowledge`, {
      story_uuid: CAFE_RAIN_STORY_UUID,
      story_version_uuid: CAFE_RAIN_VERSION_UUID,
      community_profile_version: '0.0.0-fake',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'community_profile_version_mismatch');
    assert.equal(body.field, 'community_profile_version');
  } finally {
    await ctx.close();
  }
});

test('community_profile_not_found → 400 (unknown story_version)', async () => {
  const ctx = await startServer();
  try {
    const res = await post(`${ctx.baseUrl}/v1/ecosystem/knowledge`, {
      story_uuid: '00000000-0000-4000-8000-000000000099',
      story_version_uuid: '00000000-0000-4000-8000-000000000199',
      community_profile_version: 'whatever',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'community_profile_not_found');
  } finally {
    await ctx.close();
  }
});

test('story_version_mismatch → 400 (right version, wrong story)', async () => {
  const ctx = await startServer();
  try {
    const res = await post(`${ctx.baseUrl}/v1/ecosystem/knowledge`, {
      story_uuid: '00000000-0000-4000-8000-deadbeefdead',
      story_version_uuid: CAFE_RAIN_VERSION_UUID,
      community_profile_version: CAFE_RAIN_PROFILE_VERSION,
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'story_version_mismatch');
  } finally {
    await ctx.close();
  }
});

// ----- 3. canonical lookup happy path -----------------------------------

test('clean body + canonical identity → 200 with canonical queries', async () => {
  const ctx = await startServer();
  try {
    const res = await post(`${ctx.baseUrl}/v1/ecosystem/knowledge`, {
      story_uuid: CAFE_RAIN_STORY_UUID,
      story_version_uuid: CAFE_RAIN_VERSION_UUID,
      community_profile_version: CAFE_RAIN_PROFILE_VERSION,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.results));
    assert.equal(body.results.length, 2);
    // Canonical queries should be echoed back unchanged.
    assert.equal(body.results[0].query, '雨夜咖啡馆 设定 百科');
    assert.equal(body.results[1].query, '雨夜咖啡馆 主题 释义');
    assert.ok(body.results[0].cache_key && body.results[0].cache_key.query_hash);
    assert.ok(body.results[1].cache_key && body.results[1].cache_key.query_hash);
    // The two query hashes MUST differ because the query strings
    // differ.
    assert.notEqual(
      body.results[0].cache_key.query_hash,
      body.results[1].cache_key.query_hash,
    );
    // The two bundles MUST NOT be byte-identical.
    assert.notDeepEqual(body.results[0].knowledge, body.results[1].knowledge);
  } finally {
    await ctx.close();
  }
});

// ----- 4. cache key contract --------------------------------------------

test('buildKnowledgeCacheKey: query_hash is sha256(query) and query_id is orthogonal', () => {
  const keyObjA = buildKnowledgeCacheKey({
    story_version_uuid: 'sv-1',
    community_profile_version: 'cp-1',
    query_id: 'shared-id',
    query: '咖啡因对人的影响',
  });
  const keyObjB = buildKnowledgeCacheKey({
    story_version_uuid: 'sv-1',
    community_profile_version: 'cp-1',
    query_id: 'shared-id', // same id, DIFFERENT query string
    query: '小红书的咖啡店',
  });
  // Same id, but the query_hash MUST differ — that's the whole point
  // of P1.v2-2.
  assert.equal(keyObjA.query_id, 'shared-id');
  assert.equal(keyObjB.query_id, 'shared-id');
  assert.notEqual(keyObjA.query_hash, keyObjB.query_hash);
  assert.equal(
    keyObjA.query_hash,
    createHash('sha256').update('咖啡因对人的影响', 'utf8').digest('hex'),
  );
});

test('hashQuery: distinct strings yield distinct hashes', () => {
  assert.notEqual(hashQuery('a'), hashQuery('b'));
  assert.equal(hashQuery('x'), hashQuery('x'));
});

// ----- 5. orchestrator unit tests: cache + upstream subject --------------

function makeCapturingRealProvider() {
  /** @type {Array<{ query: string, limit: number }>} */
  const calls = [];
  const provider = {
    isConfigured: () => true,
    baseUrl: () => 'http://real.test',
    name: () => 'real',
    async fetchKnowledge(input) {
      calls.push({ query: input.query, limit: input.limit });
      // Return a query-shaped bundle so the cache can pin a result
      // that's truly distinct between queries.
      return [
        {
          id: `real-${createHash('sha256').update(input.query).digest('hex').slice(0, 8)}`,
          title: `Real bundle for ${input.query}`,
          summary: `query echo: ${input.query}`,
          source: 'real',
          url: '',
          related_topics: [`q:${input.query}`],
          disclaimer: '以下内容属于现实/知乎知识延伸，不是原作设定或 AI 世界线事实',
        },
      ];
    },
  };
  return { provider, calls };
}

test('match() invokes real provider with verbatim query.query (NOT query.id)', async () => {
  const { provider: realProvider, calls } = makeCapturingRealProvider();
  const knowledge = createEcosystemKnowledgeProvider({ realProvider });
  const r1 = await knowledge.match({
    story_version_uuid: 'sv-1',
    community_profile_version: 'cp-1',
    query: { id: 'qid-A', query: '咖啡因对人的影响', kind: 'knowledge' },
  });
  const r2 = await knowledge.match({
    story_version_uuid: 'sv-1',
    community_profile_version: 'cp-1',
    query: { id: 'qid-B', query: '小红书的咖啡店', kind: 'knowledge' },
  });
  // Two real-provider calls. Each one MUST carry the verbatim query
  // string (NOT the id).
  assert.equal(calls.length, 2);
  assert.equal(calls[0].query, '咖啡因对人的影响');
  assert.equal(calls[1].query, '小红书的咖啡店');
  // The two result bundles MUST be different.
  assert.notDeepEqual(r1.knowledge, r2.knowledge);
  // Cache row count: two distinct query strings → two distinct rows.
  assert.equal(knowledge._keys().length, 2);
});

test('match() second call with same query string hits cache; distinct query misses', async () => {
  const { provider: realProvider, calls } = makeCapturingRealProvider();
  const knowledge = createEcosystemKnowledgeProvider({ realProvider });
  // First pass — populate cache.
  const r1 = await knowledge.match({
    story_version_uuid: 'sv-1',
    community_profile_version: 'cp-1',
    query: { id: 'qid-A', query: '咖啡因对人的影响', kind: 'knowledge' },
  });
  const r2 = await knowledge.match({
    story_version_uuid: 'sv-1',
    community_profile_version: 'cp-1',
    query: { id: 'qid-B', query: '小红书的咖啡店', kind: 'knowledge' },
  });
  assert.equal(calls.length, 2);
  // Second pass — must hit cache (no new real calls).
  const r1b = await knowledge.match({
    story_version_uuid: 'sv-1',
    community_profile_version: 'cp-1',
    query: { id: 'qid-A', query: '咖啡因对人的影响', kind: 'knowledge' },
  });
  const r2b = await knowledge.match({
    story_version_uuid: 'sv-1',
    community_profile_version: 'cp-1',
    query: { id: 'qid-B', query: '小红书的咖啡店', kind: 'knowledge' },
  });
  assert.equal(calls.length, 2, 'real provider should NOT be re-invoked on cache hit');
  assert.equal(r1b.cached, true);
  assert.equal(r2b.cached, true);
  // Identical bundles on cache hit.
  assert.deepEqual(r1b.knowledge, r1.knowledge);
  assert.deepEqual(r2b.knowledge, r2.knowledge);
});

test('match() cache key contains query_hash; identical query_id with different query diverges', async () => {
  const knowledge = createEcosystemKnowledgeProvider();
  // First query with qid-shared + query 'a'.
  await knowledge.match({
    story_version_uuid: 'sv-1',
    community_profile_version: 'cp-1',
    query: { id: 'qid-shared', query: 'a', kind: 'knowledge' },
  });
  // Second query with the SAME id but a different query string.
  await knowledge.match({
    story_version_uuid: 'sv-1',
    community_profile_version: 'cp-1',
    query: { id: 'qid-shared', query: 'b', kind: 'knowledge' },
  });
  // Cache MUST contain two rows (the cache key includes query_hash).
  assert.equal(knowledge._keys().length, 2);
});

// ----- 6. real-world regression — cafe-rain canonical flow -------------

test('real regression: cafe-rain canonical identity → 2 distinct bundles', async () => {
  const ctx = await startServer();
  try {
    // First call: cold cache, both queries go upstream.
    const res = await post(`${ctx.baseUrl}/v1/ecosystem/knowledge`, {
      story_uuid: CAFE_RAIN_STORY_UUID,
      story_version_uuid: CAFE_RAIN_VERSION_UUID,
      community_profile_version: CAFE_RAIN_PROFILE_VERSION,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.results.length, 2);
    // Two completely distinct bundles — not the same set with a
    // different id. The contract of P1.v2-2 is that the query
    // string itself segregates the result set.
    assert.notDeepEqual(body.results[0].knowledge, body.results[1].knowledge);
    // Each bundle must echo the query string verbatim.
    for (const r of body.results) {
      assert.ok(r.knowledge.length > 0);
      const echo = r.knowledge.find((k) => String(k.summary).includes(r.query));
      assert.ok(echo, `query "${r.query}" should appear in its bundle summary`);
    }
    // query_hash is sha256 of the canonical query string.
    assert.equal(
      body.results[0].cache_key.query_hash,
      createHash('sha256').update('雨夜咖啡馆 设定 百科', 'utf8').digest('hex'),
    );
    assert.equal(
      body.results[1].cache_key.query_hash,
      createHash('sha256').update('雨夜咖啡馆 主题 释义', 'utf8').digest('hex'),
    );
    // Second call: warm cache, both queries hit cache; bundle
    // diversity must be preserved.
    const res2 = await post(`${ctx.baseUrl}/v1/ecosystem/knowledge`, {
      story_uuid: CAFE_RAIN_STORY_UUID,
      story_version_uuid: CAFE_RAIN_VERSION_UUID,
      community_profile_version: CAFE_RAIN_PROFILE_VERSION,
    });
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    for (const r of body2.results) {
      assert.equal(r.cached, true);
    }
    assert.notDeepEqual(body2.results[0].knowledge, body2.results[1].knowledge);
  } finally {
    await ctx.close();
  }
});

// ----- 7. guard rails: bare repo / service seam ------------------------

test('communityProfileService.findCanonicalByIdentity resolves the seeded profile', () => {
  const { repository } = createSeededRepository();
  const profileRepo = createInMemoryCommunityProfileRepository();
  seedCommunityProfiles(repository, profileRepo);
  // Re-resolve by identity tuple; this is what the handler does.
  const row = profileRepo.findCanonicalByIdentity({
    story_uuid: CAFE_RAIN_STORY_UUID,
    story_version_uuid: CAFE_RAIN_VERSION_UUID,
    community_profile_version: CAFE_RAIN_PROFILE_VERSION,
  });
  assert.ok(row);
  assert.equal(row.story_uuid, CAFE_RAIN_STORY_UUID);
  assert.equal(row.story_version_uuid, CAFE_RAIN_VERSION_UUID);
  assert.equal(row.generator_version, CAFE_RAIN_PROFILE_VERSION);
  // Knowledge queries carry the canonical query string — the
  // orchestrator consumes them as-is.
  assert.equal(row.knowledge_queries[0].query, '雨夜咖啡馆 设定 百科');
  assert.equal(row.knowledge_queries[1].query, '雨夜咖啡馆 主题 释义');
});

test('communityProfileRepo.findCanonicalByIdentity: mismatch on community_profile_version', () => {
  const { repository } = createSeededRepository();
  const profileRepo = createInMemoryCommunityProfileRepository();
  seedCommunityProfiles(repository, profileRepo);
  assert.equal(
    profileRepo.findCanonicalByIdentity({
      story_uuid: CAFE_RAIN_STORY_UUID,
      story_version_uuid: CAFE_RAIN_VERSION_UUID,
      community_profile_version: '0.0.0-fake',
    }),
    null,
  );
});