// src/providers/ecosystem/search.mjs — ClickUp 16.2 知乎搜索 cache 与
// orchestrator。
//
// 关键 P1 修复（主人 + ChatGPT 2026-09-06 / 09-07 巡检）：
//   * Search queries **必须**来自 `StoryCommunityProfile.queries[]`，
//     **不**由 AI 拼（AI-generated fields are FORBIDDEN at the seam）。
//     请求体
//     强校验：`search_queries: [{id, query, kind}][]` 必填；AI 字段
//     → 400 'forbidden_field'。
//   * 多 query 聚合：handler 对每个 `{id, query, kind}` 独立走 cache
//     pair-key (`story_version_uuid`, `community_profile_version`,
//     `query_id`, `query_hash`)，结果按 `id` 分组返回。
//   * 去掉 sentinel cache 退化：identity (story_uuid,
//     story_version_uuid, community_profile_version) 缺省 → 400
//     `missing_*`，**不**再走 `__no_story_version__` /
//     `__no_profile__` sentinel pair。
//
// TTL + stale-while-revalidate（per pair-key row）：
//   * fresh → 直接返回；cached=true, provenance='cache'
//   * stale-but-usable → 立刻返回旧值并异步刷新
//   * expired / missing → 阻塞刷新；失败 → graceful degradation
//     （per-query ecosystem_status='unavailable'，整体 status 仍 'ok'
//     只要至少一组成功）。
//
// 公共契约（per-query result）：
//   {
//     id: string,                  // echoes search_queries[i].id
//     query: string,               // echoes search_queries[i].query
//     kind: 'web'|'knowledge'|'hot'|'mixed',
//     discussions: DiscussionDTO[],
//     provenance: 'live'|'cache'|'mock'|'unavailable',
//     cached: boolean,
//     ecosystem_status: 'ok'|'unavailable',
//     error?: { code, message },
//   }
//
// 公共契约（top-level response）：
//   {
//     results: PerQueryResult[],
//     provenance: 'live'|'cache'|'mock'|'unavailable',
//     cached: boolean,
//     ecosystem_status: 'ok'|'unavailable',
//   }

import {
  buildEcosystemSearchCacheKey,
  clampDiscussions,
  isDiscussionShape,
  isPlainObject,
} from './dto.mjs';
import { EcosystemUpstreamError } from './zhihuSearchSource.mjs';

export const ECOSYSTEM_SEARCH_DEFAULT_TTL_MS = 5 * 60 * 1000;     // 5 min
export const ECOSYSTEM_SEARCH_DEFAULT_SWR_MS = 30 * 60 * 1000;    // 30 min
export const ECOSYSTEM_SEARCH_DEFAULT_LIMIT = 8;

/**
 * In-memory pair-key cache repository. Stores `{ value, fetchedAt,
 * expiresAt, swrExpiresAt, refreshInFlight }` per cache key.
 *
 * Each cache row is bound to a single
 * `(story_version_uuid, community_profile_version, query_id, query)`,
 * so different profiles / different queries never share a row.
 */
export function createInMemoryEcosystemSearchCacheRepository(opts = {}) {
  const ttlMs = Number.isInteger(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : ECOSYSTEM_SEARCH_DEFAULT_TTL_MS;
  const swrMs = Number.isInteger(opts.swrMs) && opts.swrMs >= ttlMs ? opts.swrMs : Math.max(ttlMs, ECOSYSTEM_SEARCH_DEFAULT_SWR_MS);
  const store = new Map();
  const inflight = new Map();

  function get(key) {
    return store.get(key) || null;
  }

  function put(key, value, now = Date.now()) {
    store.set(key, {
      value: Array.isArray(value) ? value.slice() : [],
      fetchedAt: now,
      expiresAt: now + ttlMs,
      swrExpiresAt: now + swrMs,
    });
  }

  function hasInflight(key) {
    return inflight.has(key);
  }

  function getInflight(key) {
    return inflight.get(key) || null;
  }

  function setInflight(key, promise) {
    inflight.set(key, promise);
  }

  function clearInflight(key) {
    inflight.delete(key);
  }

  function isFresh(row, now = Date.now()) {
    return !!row && row.expiresAt > now;
  }

  function isStaleButUsable(row, now = Date.now()) {
    return !!row && row.expiresAt <= now && row.swrExpiresAt > now;
  }

  function isExpired(row, now = Date.now()) {
    return !row || row.swrExpiresAt <= now;
  }

  function _size() {
    return store.size;
  }

  function _clear() {
    store.clear();
    inflight.clear();
  }

  function _inflightSize() {
    return inflight.size;
  }

  return Object.freeze({
    name: 'in-memory-ecosystem-search-cache',
    ttlMs,
    swrMs,
    get,
    put,
    hasInflight,
    getInflight,
    setInflight,
    clearInflight,
    isFresh,
    isStaleButUsable,
    isExpired,
    _size,
    _clear,
    _inflightSize,
  });
}

/**
 * Build a per-query OK result. The orchestrator assembles many of
 * these into the top-level `results[]`.
 */
function buildPerQueryOk({ id, query, kind, discussions, provenance, cached, limit }) {
  return {
    id,
    query,
    kind,
    discussions: clampDiscussions(discussions, limit),
    provenance,
    cached,
    ecosystem_status: 'ok',
  };
}

/**
 * Build a per-query "upstream is down" payload. Never throws —
 * graceful degradation contract: route must keep POST alive even
 * when ecosystem search fails for a single query.
 */
export function buildEcosystemUnavailableOutcome({ code, message, cached = false }) {
  return {
    discussions: [],
    provenance: 'unavailable',
    cached,
    ecosystem_status: 'unavailable',
    error: { code: typeof code === 'string' ? code : 'unavailable', message: typeof message === 'string' ? message : 'search unavailable' },
  };
}

/**
 * Reduce a list of per-query results into the top-level response.
 * If at least one query returned ecosystem_status='ok', the overall
 * status is 'ok'; otherwise 'unavailable'. `cached=true` only when
 * every per-query row came from cache.
 */
function aggregateOutcomes(perQueryResults) {
  let allOk = true;
  let anyOk = false;
  let allCache = true;
  let anyCache = false;
  let mockSeen = false;
  for (const r of perQueryResults) {
    if (r.ecosystem_status === 'ok') anyOk = true;
    else allOk = false;
    if (r.cached) anyCache = true;
    else allCache = false;
    if (r.provenance === 'mock') mockSeen = true;
  }
  let provenance;
  if (!anyOk) provenance = 'unavailable';
  else if (allCache && anyCache) provenance = 'cache';
  else if (mockSeen && !anyCache) provenance = 'mock';
  else if (allCache === false && anyCache) provenance = 'live'; // mix of cached + live → treat as live
  else provenance = 'live';
  return {
    provenance,
    cached: allCache && anyCache,
    ecosystem_status: allOk ? 'ok' : 'unavailable',
  };
}

/**
 * Fetch one query through the cache + adapter. Returns a per-query
 * result ready to be aggregated. This is the unit that the SWR
 * dedup map (per pair-key) operates on.
 *
 * @param {object} args
 * @param {object} args.cache
 * @param {object} args.adapter
 * @param {{ id: string, query: string, kind: string }} args.sq
 * @param {string} args.story_uuid
 * @param {string} args.story_version_uuid
 * @param {string} args.community_profile_version
 * @param {number} args.limit
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<object>}
 */
async function fetchOneQuery(args) {
  const { cache, adapter, sq, story_uuid, story_version_uuid, community_profile_version, limit, signal } = args;
  const key = buildEcosystemSearchCacheKey({
    query: sq.query,
    story_version_uuid,
    community_profile_version,
    query_id: sq.id,
  });
  const now = Date.now();
  const row = cache.get(key);

  // 1) Fresh → straight cache hit
  if (cache.isFresh(row, now)) {
    return buildPerQueryOk({
      id: sq.id,
      query: sq.query,
      kind: sq.kind,
      discussions: row.value,
      provenance: 'cache',
      cached: true,
      limit,
    });
  }

  // 2) Stale-but-usable → return stale, fire-and-forget refresh.
  if (cache.isStaleButUsable(row, now)) {
    scheduleBackgroundRefresh({
      cache, adapter, key, sq,
      story_uuid, story_version_uuid, community_profile_version, limit, signal,
    });
    return buildPerQueryOk({
      id: sq.id,
      query: sq.query,
      kind: sq.kind,
      discussions: row.value,
      provenance: 'cache',
      cached: true,
      limit,
    });
  }

  // 3) Expired / missing → block on refresh.
  try {
    const result = await adapter.search({
      query: sq.query,
      kind: sq.kind,
      story_uuid,
      story_version_uuid,
      community_profile_version,
      limit,
    });
    const list = Array.isArray(result && result.discussions) ? result.discussions : [];
    const cleanList = list.filter((d) => isDiscussionShape(d));
    cache.put(key, cleanList, Date.now());
    const source = result && result.source ? result.source : 'mock';
    // 'cache' is reserved for the per-query cache hit; live or mock
    // provenance reflects the actual source.
    const provenance = source === 'mock' ? 'mock' : 'live';
    return buildPerQueryOk({
      id: sq.id,
      query: sq.query,
      kind: sq.kind,
      discussions: cleanList,
      provenance,
      cached: false,
      limit,
    });
  } catch (err) {
    const code = err instanceof EcosystemUpstreamError ? err.code : (err && err.code) || 'upstream_unavailable';
    const message = err && err.message ? err.message : 'upstream unavailable';
    return {
      id: sq.id,
      query: sq.query,
      kind: sq.kind,
      ...buildEcosystemUnavailableOutcome({ code, message, cached: false }),
    };
  }
}

/**
 * Schedule a single refresh for a given key. Subsequent calls for
 * the same key share the same in-flight promise (de-duplication).
 */
function scheduleBackgroundRefresh(input) {
  const key = input.key;
  if (!key) return;
  if (typeof input.cache.hasInflight === 'function' && input.cache.hasInflight(key)) {
    return input.cache.getInflight(key);
  }
  const promise = (async () => {
    try {
      const result = await input.adapter.search({
        query: input.sq.query,
        kind: input.sq.kind,
        story_uuid: input.story_uuid,
        story_version_uuid: input.story_version_uuid,
        community_profile_version: input.community_profile_version,
        limit: input.limit,
      });
      const list = Array.isArray(result && result.discussions) ? result.discussions : [];
      const cleanList = list.filter((d) => isDiscussionShape(d));
      input.cache.put(key, cleanList, Date.now());
    } catch {
      // Swallow background failures — the SWR row stays valid.
    } finally {
      if (typeof input.cache.clearInflight === 'function') input.cache.clearInflight(key);
    }
  })();
  if (typeof input.cache.setInflight === 'function') input.cache.setInflight(key, promise);
  return promise;
}

/**
 * Orchestrator. ClickUp 16.2 P1 fix (2026-09-07): input MUST carry
 * `search_queries: [{id, query, kind}][]` plus the three identity
 * fields. Sentinel fallback for missing identity is REMOVED — the
 * route layer enforces identity before this function runs.
 *
 * @param {object} input
 * @param {object} input.cache
 * @param {object} input.adapter
 * @param {{ id: string, query: string, kind: string }[]} input.search_queries
 * @param {string} input.story_uuid
 * @param {string} input.story_version_uuid
 * @param {string} input.community_profile_version
 * @param {number} [input.limit]
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<{ results: object[], provenance, cached, ecosystem_status }>}
 */
export async function searchEcosystemDiscussions(input) {
  if (!isPlainObject(input)) {
    return {
      results: [],
      provenance: 'unavailable',
      cached: false,
      ecosystem_status: 'unavailable',
      error: { code: 'bad_input', message: 'input must be an object' },
    };
  }
  const adapter = input.adapter;
  const cache = input.cache;
  if (!adapter || typeof adapter.search !== 'function') {
    return {
      results: [],
      provenance: 'unavailable',
      cached: false,
      ecosystem_status: 'unavailable',
      error: { code: 'bad_adapter', message: 'adapter.search missing' },
    };
  }
  if (!cache || typeof cache.get !== 'function' || typeof cache.put !== 'function') {
    return {
      results: [],
      provenance: 'unavailable',
      cached: false,
      ecosystem_status: 'unavailable',
      error: { code: 'bad_cache', message: 'cache.get/put missing' },
    };
  }
  const searchQueries = Array.isArray(input.search_queries) ? input.search_queries : [];
  if (searchQueries.length === 0) {
    return {
      results: [],
      provenance: 'unavailable',
      cached: false,
      ecosystem_status: 'unavailable',
      error: { code: 'empty_search_queries', message: 'search_queries required' },
    };
  }
  const story_uuid = typeof input.story_uuid === 'string' ? input.story_uuid : null;
  const story_version_uuid = typeof input.story_version_uuid === 'string' ? input.story_version_uuid : null;
  const community_profile_version = typeof input.community_profile_version === 'string'
    ? input.community_profile_version
    : null;
  // Identity is REQUIRED. The route layer enforces it via normaliseDiscussionsRequest,
  // but defend in depth: missing identity → 400-style unavailable payload
  // (never a sentinel pair-key).
  if (!story_uuid || !story_version_uuid || !community_profile_version) {
    return {
      results: [],
      provenance: 'unavailable',
      cached: false,
      ecosystem_status: 'unavailable',
      error: {
        code: 'missing_identity',
        message: 'story_uuid / story_version_uuid / community_profile_version are all required',
      },
    };
  }

  const limit = Number.isInteger(input.limit) && input.limit > 0 ? input.limit : ECOSYSTEM_SEARCH_DEFAULT_LIMIT;
  const signal = input.signal;

  // Fetch each query in parallel (with cache-level dedup). Sequential
  // would also be correct but slower; mock adapter is sync so this is
  // mainly to keep the real adapter latency-bound to one round-trip.
  const perQueryPromises = searchQueries.map((sq) => fetchOneQuery({
    cache,
    adapter,
    sq,
    story_uuid,
    story_version_uuid,
    community_profile_version,
    limit,
    signal,
  }));
  const perQueryResults = await Promise.all(perQueryPromises);
  const aggregate = aggregateOutcomes(perQueryResults);
  return {
    results: perQueryResults,
    ...aggregate,
  };
}
