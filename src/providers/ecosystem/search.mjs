// src/providers/ecosystem/search.mjs — ClickUp 16.2 知乎搜索 cache 与
// orchestrator。
//
// 关键 P1 修复（ChatGPT 巡检 2026-09-06）：
//   * Cache key 是 **pair-key** ——
//     `(story_version_uuid, community_profile_version, query_hash)`，
//     **不**用单全局 entry。`buildEcosystemSearchCacheKey` 已经把这个
//     pair-key 形式固化了。
//   * TTL + stale-while-revalidate：fresh → 直接返回；stale → 立刻返回
//     旧值并异步刷新；missing → 阻塞刷新。
//   * 任何 refresh 失败 → graceful degradation：保留旧值（如果有），
//     不抛错到上层 route。
//
// 公共契约：
//   * `createInMemoryEcosystemSearchCacheRepository({ ttlMs, swrMs })`
//     提供单进程内的 pair-key cache，**不**做跨进程持久化。
//   * `searchEcosystemDiscussions({ repository, adapter, query, story_uuid,
//     story_version_uuid, community_profile_version, limit })` 是给
//     route 层用的 orchestrator。
//
// 公开 response（经由 orchestrator 装配的 DTO）：
//   {
//     discussions: DiscussionDTO[],
//     provenance: 'live' | 'cache' | 'mock',
//     cached: boolean,
//     ecosystem_status?: 'ok' | 'unavailable',
//   }
//   公开契约 **不**带 DEV_FLAG / demo 字段。route 层负责包装。

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
 * The repository is intentionally tiny: no eviction, no global entry,
 * no single-key shared row. Each cache row is bound to a single pair
 * `(story_version_uuid, community_profile_version, query)`.
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
 * Compute the orchestrator response shape from a raw adapter output.
 * Public response never includes DEV_FLAG / demo.
 */
function buildOkResponse({ discussions, source, provenance, cached, limit }) {
  return {
    discussions: clampDiscussions(discussions, limit),
    provenance,
    cached,
    ecosystem_status: 'ok',
    source,
  };
}

/**
 * Build an "upstream is down" response. Never throws — graceful
 * degradation contract: route must keep POST /api/sessions alive
 * even when ecosystem search fails.
 */
export function buildEcosystemUnavailableOutcome({ code, message, cached = false, limit = ECOSYSTEM_SEARCH_DEFAULT_LIMIT }) {
  return {
    discussions: [],
    provenance: 'unavailable',
    cached,
    ecosystem_status: 'unavailable',
    error: { code: typeof code === 'string' ? code : 'unavailable', message: typeof message === 'string' ? message : 'search unavailable' },
    limit,
  };
}

/**
 * Orchestrator. Wires cache ↔ adapter; never throws upstream errors —
 * translates them into a graceful "unavailable" outcome.
 *
 * Behaviour matrix:
 *   cache fresh   → return cached (cached=true, provenance='cache')
 *   cache SWR     → return stale (cached=true, provenance='cache'),
 *                   fire-and-forget refresh
 *   cache expired → refresh; on success store + return (cached=false,
 *                   provenance='live'/'mock'); on failure return
 *                   unavailable with cached=false
 *   cache missing → refresh; same as "expired"
 *
 * @param {object} input
 * @param {object} input.cache
 * @param {object} input.adapter
 * @param {string} input.query
 * @param {string} [input.story_uuid]
 * @param {string} [input.story_version_uuid]
 * @param {string} [input.community_profile_version]
 * @param {number} [input.limit]
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<object>}
 */
export async function searchEcosystemDiscussions(input) {
  if (!isPlainObject(input)) {
    return buildEcosystemUnavailableOutcome({ code: 'bad_input', message: 'input must be an object' });
  }
  const adapter = input.adapter;
  const cache = input.cache;
  if (!adapter || typeof adapter.search !== 'function') {
    return buildEcosystemUnavailableOutcome({ code: 'bad_adapter', message: 'adapter.search missing' });
  }
  if (!cache || typeof cache.get !== 'function' || typeof cache.put !== 'function') {
    return buildEcosystemUnavailableOutcome({ code: 'bad_cache', message: 'cache.get/put missing' });
  }
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (!query) {
    return buildEcosystemUnavailableOutcome({ code: 'empty_query', message: 'query required' });
  }
  const limit = Number.isInteger(input.limit) && input.limit > 0 ? input.limit : ECOSYSTEM_SEARCH_DEFAULT_LIMIT;
  const key = buildEcosystemSearchCacheKey({
    query,
    story_version_uuid: typeof input.story_version_uuid === 'string' ? input.story_version_uuid : undefined,
    community_profile_version: typeof input.community_profile_version === 'string' ? input.community_profile_version : undefined,
  });

  const now = Date.now();
  const row = cache.get(key);

  // 1) Fresh → straight cache hit
  if (cache.isFresh(row, now)) {
    return buildOkResponse({
      discussions: row.value,
      source: row.value && row.value[0] && row.value[0].source ? row.value[0].source : 'cache',
      provenance: 'cache',
      cached: true,
      limit,
    });
  }

  // 2) Stale-but-usable → return stale, fire-and-forget refresh.
  if (cache.isStaleButUsable(row, now)) {
    scheduleBackgroundRefresh({ cache, adapter, key, query, story_uuid: input.story_uuid, story_version_uuid: input.story_version_uuid, community_profile_version: input.community_profile_version, limit, signal: input.signal });
    return buildOkResponse({
      discussions: row.value,
      source: row.value && row.value[0] && row.value[0].source ? row.value[0].source : 'cache',
      provenance: 'cache',
      cached: true,
      limit,
    });
  }

  // 3) Expired / missing → block on refresh.
  try {
    const result = await adapter.search({
      query,
      story_uuid: input.story_uuid,
      story_version_uuid: input.story_version_uuid,
      community_profile_version: input.community_profile_version,
      limit,
    });
    const list = Array.isArray(result && result.discussions) ? result.discussions : [];
    const cleanList = list.filter((d) => isDiscussionShape(d));
    cache.put(key, cleanList, Date.now());
    return buildOkResponse({
      discussions: cleanList,
      source: result && result.source ? result.source : 'cache',
      provenance: 'live',
      cached: false,
      limit,
    });
  } catch (err) {
    const code = err instanceof EcosystemUpstreamError ? err.code : (err && err.code) || 'upstream_unavailable';
    const message = err && err.message ? err.message : 'upstream unavailable';
    return buildEcosystemUnavailableOutcome({ code, message, cached: false, limit });
  }
}

/**
 * Schedule a single refresh for a given key. Subsequent calls for the
 * same key share the same in-flight promise (de-duplication).
 */
function scheduleBackgroundRefresh(input) {
  const key = input.key;
  if (!key) return;
  // Dedupe on the cache repository itself so concurrent SWR requests
  // for the same pair-key share one upstream call.
  if (typeof input.cache.hasInflight === 'function' && input.cache.hasInflight(key)) {
    return input.cache.getInflight(key);
  }
  const promise = (async () => {
    try {
      const result = await input.adapter.search({
        query: input.query,
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
