// src/providers/ecosystem/search.mjs — Story 16.2 P1.v2 知乎搜索 cache 与
// orchestrator.
//
// 关键 P1.v2 修复（code review）：
//   * Search queries **必须**来自服务端解析出的 canonical
//     `StoryCommunityProfile.queries[]`，**不**由 client 拼。
//     handler 接 `story_uuid + story_version_uuid +
//     community_profile_version`，**不**接 `body.search_queries`。
//   * 多 query 聚合：orchestrator 对 canonical profile.queries[i]
//     每个 `{id, query, kind}` 独立走 cache pair-key
//     (`story_version_uuid`, `community_profile_version`,
//     `query_id`, `query_hash`)，结果按 `id` 分组返回 results[]。
//   * 去掉 sentinel cache 退化：identity 缺省 → 400，**不**再走
//     `__no_story_version__` / `__no_profile__` sentinel pair。
//   * **不**接受 client-supplied queries；任何 caller 想注入 query
//     必须改 canonical profile（生成 → 校验 → 入库 → 才有新版本）。
//
// TTL + stale-while-revalidate (per pair-key row):
//   * fresh → 直接返回；cached=true, provenance='cache'
//   * stale-but-usable → 立刻返回旧值并异步刷新
//   * expired / missing → 阻塞刷新；失败 → graceful degradation
//     (per-query ecosystem_status='unavailable'，整体 status 仍 'ok'
//      只要至少一组成功)
//
// 公共契约 (per-query result):
//   {
//     id: string,                  // echoes profile.queries[i].id
//     query: string,               // echoes profile.queries[i].query
//     kind: 'web'|'knowledge'|'hot'|'mixed',
//     discussions: DiscussionDTO[],
//     provenance: 'live'|'cache'|'mock'|'unavailable',
//     cached: boolean,
//     ecosystem_status: 'ok'|'unavailable',
//     error?: { code, message },
//   }
//
// 公共契约 (top-level response):
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
  normaliseCanonicalSearchQueries,
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

  function put(key, value, now = Date.now(), metadata = {}) {
    store.set(key, {
      value: Array.isArray(value) ? value.slice() : [],
      fetchedAt: now,
      expiresAt: now + ttlMs,
      swrExpiresAt: now + swrMs,
      storyUuid: typeof metadata.story_uuid === 'string' ? metadata.story_uuid : null,
      storyVersionUuid: typeof metadata.story_version_uuid === 'string' ? metadata.story_version_uuid : null,
      communityProfileVersion: typeof metadata.community_profile_version === 'string'
        ? metadata.community_profile_version
        : null,
      queryId: typeof metadata.query_id === 'string' ? metadata.query_id : null,
      query: typeof metadata.query === 'string' ? metadata.query : null,
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

  function _exportSnapshot() {
    return [...store.entries()].map(([key, row]) => ({
      cache_key: key,
      value: Array.isArray(row.value) ? row.value.slice() : [],
      fetched_at_ms: row.fetchedAt,
      expires_at_ms: row.expiresAt,
      swr_expires_at_ms: row.swrExpiresAt,
      story_uuid: row.storyUuid,
      story_version_uuid: row.storyVersionUuid,
      community_profile_version: row.communityProfileVersion,
      query_id: row.queryId,
      query_text: row.query,
    }));
  }

  function _hydrateSnapshot(rows) {
    if (!Array.isArray(rows)) throw new Error('ecosystemSearchCache: rows snapshot required');
    store.clear();
    inflight.clear();
    for (const row of rows) {
      if (!row || typeof row.cache_key !== 'string') continue;
      store.set(row.cache_key, {
        value: Array.isArray(row.value) ? row.value.slice() : [],
        fetchedAt: Number(row.fetched_at_ms),
        expiresAt: Number(row.expires_at_ms),
        swrExpiresAt: Number(row.swr_expires_at_ms),
        storyUuid: row.story_uuid || null,
        storyVersionUuid: row.story_version_uuid || null,
        communityProfileVersion: row.community_profile_version || null,
        queryId: row.query_id || null,
        query: row.query_text || null,
      });
    }
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
    _exportSnapshot,
    _hydrateSnapshot,
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
    query: adapter.name === 'official-zhihu-search-v1' ? `official-v1:${sq.query}` : sq.query,
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
    cache.put(key, cleanList, Date.now(), {
      story_uuid,
      story_version_uuid,
      community_profile_version,
      query_id: sq.id,
      query: sq.query,
    });
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
      input.cache.put(key, cleanList, Date.now(), {
        story_uuid: input.story_uuid,
        story_version_uuid: input.story_version_uuid,
        community_profile_version: input.community_profile_version,
        query_id: input.sq.id,
        query: input.sq.query,
      });
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
 * Orchestrator. Story 16.2 P1.v2 fix (2026-09-07):
 *   Input is the **resolved canonical profile** + identity triple,
 *   NOT the raw client body. The route layer resolves
 *   `communityProfileRepo.findCanonicalByIdentity(...)` and passes
 *   the resulting `profile` here; this function walks
 *   `profile.queries[]` and runs each one through the pair-key
 *   cache + adapter.
 *
 *   The orchestrator never trusts caller-supplied query strings; if
 *   the resolved profile has zero queries, the route is a 4xx, not
 *   a silent 200 with empty results.
 *
 * @param {object} input
 * @param {object} input.cache
 * @param {object} input.adapter
 * @param {object} input.profile                 Canonical StoryCommunityProfile.
 * @param {string} input.story_uuid
 * @param {string} input.story_version_uuid
 * @param {string} input.community_profile_version
 * @param {number} [input.limit]
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<{ results: object[], provenance, cached, ecosystem_status, error?: { code, message } }>}
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
  const story_uuid = typeof input.story_uuid === 'string' ? input.story_uuid : null;
  const story_version_uuid = typeof input.story_version_uuid === 'string' ? input.story_version_uuid : null;
  const community_profile_version = typeof input.community_profile_version === 'string'
    ? input.community_profile_version
    : null;
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
  const profile = input.profile;
  if (!isPlainObject(profile) || !profile.profile_uuid) {
    return {
      results: [],
      provenance: 'unavailable',
      cached: false,
      ecosystem_status: 'unavailable',
      error: {
        code: 'community_profile_not_found',
        message: 'canonical profile is required (resolved server-side)',
      },
    };
  }
  // Canonical queries (server-authoritative). Never trust caller-supplied
  // queries — there are none at this point (handler already rejected them).
  //
  // The canonical field on StoryCommunityProfile is `profile.queries[]`.
  // Some call sites reference `profile.search_queries` as a clearer
  // alias (it is the same array, just renamed for the consumer surface);
  // accept either so a future caller can pick the most readable name.
  const profileQueries = Array.isArray(profile.search_queries)
    ? profile.search_queries
    : profile.queries;
  const normalised = normaliseCanonicalSearchQueries(profileQueries);
  if (!normalised.ok) {
    return {
      results: [],
      provenance: 'unavailable',
      cached: false,
      ecosystem_status: 'unavailable',
      error: { code: normalised.code, message: normalised.message },
    };
  }
  const searchQueries = normalised.value;
  const limit = Number.isInteger(input.limit) && input.limit > 0 ? input.limit : ECOSYSTEM_SEARCH_DEFAULT_LIMIT;
  const signal = input.signal;

  // Fetch each canonical query in parallel (with cache-level dedup).
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
