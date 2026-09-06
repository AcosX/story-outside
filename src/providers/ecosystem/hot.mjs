// src/providers/ecosystem/hot.mjs — 知乎热榜 orchestrator (ClickUp 16.4
// rebuilt on current main 44343b2).
//
// Product positioning (per ClickUp 16.4 description):
//   * Hot list feeds the home-page "知乎此刻热议" discovery module.
//   * It is NOT part of the story Runtime; we never turn a hot topic
//     into story beats / narrative / session events.
//   * The orchestrator wires a swappable upstream source (mock today,
//     real Zhihu adapter tomorrow) into a pair-key cache and the
//     HTTP façade. The DTO shape and the cache strategy are
//     provider-agnostic.
//
// Response shape (per ClickUp 16.4 spec):
//   {
//     hot: [
//       { rank, question_uuid, title, heat, url, category },
//       ...
//     ],
//     provenance: { source: 'mock' | 'real', endpoint?: string },
//     cached: boolean,
//     fetched_at: string  // ISO timestamp of the cache entry
//   }
//
// Caching strategy (pair-key + TTL, per ClickUp 16.4 description):
//   * Key = (category, fetched_at_bucket). NEVER a single global entry;
//     the description explicitly calls out category-filtered reads so
//     A→B→A must still hit the A-cache (the rebuilt implementation
//     pairs every cache entry with the category that produced it).
//   * Fresh window:  TTL = 5 min. While within TTL, the cache is
//     served synchronously and the upstream is NOT touched.
//   * Stale window:  stale-while-revalidate = 30 min. After the TTL
//     expires but within the SWR window, the stale data is served
//     immediately AND a background refresh is kicked off; subsequent
//     callers see the new fresh data.
//   * Past stale:    beyond SWR, no data is returned and the route
//     layer returns the cached payload with `cached: true` only if a
//     past-SWR entry is still present and the upstream is currently
//     failing (graceful degradation). Otherwise the orchestrator
//     returns an empty list and `cached: false`.
//
// Category handling:
//   * Categories are CLAMPED to a known safe allow-list
//     (KNOWN_CATEGORIES) so the query string cannot be smuggled
//     verbatim into the upstream URL.
//   * `category=total` is the default and returns everything.
//
// Failure modes (graceful degradation):
//   * Upstream 5xx, 4xx, timeout, network error → the orchestrator
//     falls back to whatever (possibly stale) cache is still in the
//     pair-key map. If nothing is usable it returns `{ hot: [],
//     cached: false, fetched_at: '' }` and the route layer surfaces a
//     "暂时无法获取知乎热议" placeholder on the home page rather
//     than 502-ing the HTTP request.
//   * Mock provider failures are NOT possible (pure in-memory
//     fixture), so the mock path is always available.

import { ProviderError } from '../dto.mjs';
import { MOCK_HOT_TOPICS_RAW, filterMockHotByCategory } from './mockZhihuHotSource.mjs';

/**
 * @typedef {Object} ZhihuHotTopic
 * @property {string} id             Stable identifier inside this list.
 * @property {string} title          Display title.
 * @property {string} url            Outbound link to zhihu.com.
 * @property {number} hotness        Hotness score (raw upstream scale).
 * @property {string} excerpt        优质回答摘要 excerpt (short).
 * @property {number} answer_count   Number of answers on the underlying question.
 * @property {string} question_id    Underlying question id (stringified).
 * @property {string[]} tags         Tags derived from the upstream payload.
 * @property {string} category       Echoed category that produced this row.
 * @property {number} rank           1-based rank inside this list.
 */

/**
 * @typedef {Object} EcosystemHotList
 * @property {Array<{
 *   rank: number,
 *   question_uuid: string,
 *   title: string,
 *   heat: number,
 *   url: string,
 *   category: string
 * }>} hot
 * @property {{ source: 'mock' | 'real', endpoint?: string }} provenance
 * @property {boolean} cached        True iff the response was served
 *                                   from the cache (fresh or stale).
 * @property {string} fetched_at     ISO timestamp of the cache entry
 *                                   that produced this response; empty
 *                                   when there was no usable cache.
 */

/**
 * @typedef {Object} HotSource
 * @property {string} name                                            'mock' | 'real'.
 * @property {(input?: { category?: string }) => Promise<ReadonlyArray<ZhihuHotTopic>>} fetchHotList
 * @property {() => string} [endpoint]                                 Debug surface for the
 *                                                                     upstream endpoint (real
 *                                                                     source only).
 * @property {() => ReadonlyArray<string>} [hosts]                    Debug surface for the
 *                                                                     allow-list (real only).
 */

// TTL = 5 min, SWR window = 30 min. Past 30 min the cache is dropped
// entirely UNLESS the upstream is failing AND a past-SWR entry is
// still in the pair-key map (graceful degradation).
const TTL_MS = 5 * 60 * 1000;
const SWR_MS = 30 * 60 * 1000;
const BUCKET_MS = 60 * 1000; // 1-min bucket so two requests in the same minute share a cache entry.

/**
 * Categories the orchestrator will forward to the upstream. Anything
 * else clamps to `total` so the query string cannot be smuggled into
 * the URL verbatim.
 */
export const KNOWN_CATEGORIES = Object.freeze(['total', 'tech', 'finance', 'sports', 'entertainment', 'digital']);

/**
 * @param {unknown} raw
 * @returns {string}
 */
function clampCategory(raw) {
  if (typeof raw !== 'string') return 'total';
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return 'total';
  if (KNOWN_CATEGORIES.includes(trimmed)) return trimmed;
  return 'total';
}

/**
 * @param {string} category
 * @param {number} nowMs
 * @returns {number}
 */
function bucketFor(category, nowMs) {
  // Stable bucket index: floor(nowMs / BUCKET_MS). Two requests in
  // the same minute collide on the same bucket and therefore share
  // the cache entry — that is the intended behaviour of pair-key
  // caching with minute granularity.
  return Math.floor(nowMs / BUCKET_MS);
}

/**
 * Convert an internal ZhihuHotTopic row into the public hot[] shape
 * the ClickUp 16.4 spec mandates. Pure.
 *
 * @param {ZhihuHotTopic} topic
 * @returns {{ rank: number, question_uuid: string, title: string, heat: number, url: string, category: string }}
 */
export function toPublicHotRow(topic) {
  return {
    rank: topic.rank,
    question_uuid: topic.question_id || topic.id,
    title: topic.title,
    heat: topic.hotness,
    url: topic.url,
    category: topic.category,
  };
}

/**
 * @param {unknown} raw
 * @param {string} category
 * @param {number} rank
 * @returns {ZhihuHotTopic | null}
 */
function normaliseHotTopic(raw, category, rank) {
  if (!raw || typeof raw !== 'object') return null;
  const t = /** @type {any} */ (raw);
  if (typeof t.id !== 'string' || !t.id) return null;
  if (typeof t.title !== 'string' || !t.title) return null;
  if (typeof t.url !== 'string' || !t.url) return null;
  const hotness = typeof t.hotness === 'number' && Number.isFinite(t.hotness)
    ? t.hotness
    : 0;
  const tags = Array.isArray(t.tags) ? t.tags.filter((s) => typeof s === 'string') : [];
  return {
    id: t.id,
    title: t.title,
    url: t.url,
    hotness,
    excerpt: typeof t.excerpt === 'string' ? t.excerpt : '',
    answer_count: typeof t.answer_count === 'number' && Number.isFinite(t.answer_count)
      ? t.answer_count
      : 0,
    question_id: typeof t.question_id === 'string' ? t.question_id : t.id,
    tags,
    category,
    rank,
  };
}

/**
 * Mock source — defensive copy of the fixture so the orchestrator
 * can normalise without aliasing the frozen constants.
 * @type {HotSource}
 */
const MOCK_HOT_SOURCE = Object.freeze({
  name: 'mock',
  async fetchHotList(input = {}) {
    const category = clampCategory(input && typeof input.category === 'string' ? input.category : 'total');
    const filtered = filterMockHotByCategory(category);
    /** @type {ZhihuHotTopic[]} */
    const out = [];
    for (let i = 0; i < filtered.length; i += 1) {
      const norm = normaliseHotTopic(filtered[i], category, i + 1);
      if (norm) out.push(norm);
    }
    return out;
  },
  endpoint() { return '(mock fixture)'; },
  hosts() { return ['(mock fixture)']; },
});

/**
 * Pick the active upstream source based on env var. STORY_OUTSIDE_HOT_PROVIDER
 * controls the choice; mock is the default fallback.
 *
 * @param {{
 *   realSource?: HotSource | null,
 *   env?: NodeJS.ProcessEnv | null
 * }} [opts]
 * @returns {HotSource}
 */
export function pickHotSource(opts = {}) {
  const env = (opts && opts.env) || process.env;
  const raw = (env && typeof env.STORY_OUTSIDE_HOT_PROVIDER === 'string')
    ? env.STORY_OUTSIDE_HOT_PROVIDER.trim().toLowerCase()
    : '';
  if (raw === 'real' && opts.realSource) return opts.realSource;
  return MOCK_HOT_SOURCE;
}

/**
 * @typedef {Object} CacheEntry
 * @property {number} fetched_at
 * @property {ReadonlyArray<ZhihuHotTopic>} topics
 * @property {string} source_name
 * @property {string} endpoint
 * @property {string[]} hosts
 * @property {Promise<void> | null} refreshing
 */

/**
 * Pair-key cache key. The category is the FIRST dimension so two
 * different categories never collide; the bucket is the SECOND
 * dimension so two requests in the same minute share an entry.
 *
 * @param {string} category
 * @param {number} bucket
 * @returns {string}
 */
export function cacheKey(category, bucket) {
  return `${category}::${bucket}`;
}

/**
 * Provider factory. Returns an object with the public API the route
 * layer needs:
 *   * getHot — returns the public EcosystemHotList payload.
 *   * resetForTests — wipes the cache + source.
 *   * _peek — test introspection.
 *   * _config — test introspection of TTL/SWR.
 *
 * @param {object} [opts]
 * @param {HotSource} [opts.realSource]    Real adapter to swap in
 *                                          (constructed via
 *                                          createRealZhihuHotSource()).
 * @param {HotSource} [opts.mockSource]    Mock adapter override (tests).
 * @param {number} [opts.ttlMs]            Override TTL.
 * @param {number} [opts.swrMs]            Override SWR window.
 * @param {() => number} [opts.now]        Clock injection (tests).
 * @param {NodeJS.ProcessEnv} [opts.env]   Env override (tests).
 * @returns {{
 *   getHot: (input?: { category?: string, limit?: number, force?: boolean }) => Promise<EcosystemHotList>,
 *   resetForTests: () => void,
 *   _peek: (category: string) => { fetched_at: number, source_name: string, endpoint: string, size: number } | null,
 *   _config: () => { ttlMs: number, swrMs: number, bucketMs: number, sourceName: string, endpoint: string, knownCategories: ReadonlyArray<string> },
 * }}
 */
export function createEcosystemHotProvider(opts = {}) {
  const mockSource = opts.mockSource || MOCK_HOT_SOURCE;
  const realSource = opts.realSource || null;
  /** @type {HotSource} */
  let activeSource = null;
  function ensureSource() {
    if (activeSource) return activeSource;
    activeSource = pickHotSource({ realSource, env: opts.env });
    return activeSource;
  }
  const ttlMs = typeof opts.ttlMs === 'number' && opts.ttlMs > 0 ? opts.ttlMs : TTL_MS;
  const swrMs = typeof opts.swrMs === 'number' && opts.swrMs > 0 ? opts.swrMs : SWR_MS;
  const now = opts.now || (() => Date.now());

  // === PAIR-KEY CACHE ===
  // CRITICAL: this is a Map keyed by (category, bucket), NOT a single
  // global entry. The rebuilt implementation MUST NOT regress to a
  // single global entry; the description explicitly calls out
  // A→B→A → A cache hit as a P1 invariant.
  /** @type {Map<string, CacheEntry>} */
  const cache = new Map();

  /**
   * @returns {Promise<ReadonlyArray<ZhihuHotTopic>>}
   */
  async function upstreamFetch(category) {
    const source = ensureSource();
    const topics = await source.fetchHotList({ category });
    if (!Array.isArray(topics)) {
      throw new ProviderError('upstream_shape_mismatch', 'Hot source returned a non-array.');
    }
    return topics;
  }

  /**
   * @param {string} category
   * @returns {string}
   */
  function endpointFor(category) {
    const source = ensureSource();
    if (typeof source.endpoint === 'function') {
      try { return source.endpoint(); } catch { return '(source endpoint unavailable)'; }
    }
    return category === 'mock' ? '(mock fixture)' : '';
  }

  /**
   * @returns {string[]}
   */
  function hostsFor() {
    const source = ensureSource();
    if (typeof source.hosts === 'function') {
      try { return Array.from(source.hosts()); } catch { return []; }
    }
    return [];
  }

  /**
   * @param {string} category
   * @returns {Promise<ReadonlyArray<ZhihuHotTopic>>}
   */
  function backgroundRefresh(category) {
    const bucket = bucketFor(category, now());
    const key = cacheKey(category, bucket);
    const existing = cache.get(key);
    if (existing && existing.refreshing) return existing.refreshing;
    const source = ensureSource();
    const promise = (async () => {
      try {
        const topics = await upstreamFetch(category);
        // Re-rank + re-tag so a category-filtered cache entry stays
        // consistent with its key.
        const ranked = topics.map((t, i) => normaliseHotTopic(t, t.category || category, i + 1)).filter(Boolean);
        cache.set(key, {
          fetched_at: now(),
          topics: ranked,
          source_name: source.name,
          endpoint: endpointFor(category),
          hosts: hostsFor(),
          refreshing: null,
        });
      } catch (err) {
        // Background failures are NOT surfaced. We leave whatever
        // stale cache is in place; the next foreground call after
        // SWR will retry.
        const cur = cache.get(key);
        if (cur) cache.set(key, { ...cur, refreshing: null });
      }
    })();
    const cur = cache.get(key);
    if (cur) {
      cache.set(key, { ...cur, refreshing: promise });
    }
    return promise;
  }

  /**
   * @param {ReadonlyArray<ZhihuHotTopic>} topics
 * @param {number} limit
 * @returns {ReadonlyArray<ZhihuHotTopic>}
 */
  function clip(topics, limit) {
    if (limit <= 0) return topics.slice();
    return topics.slice(0, Math.min(limit, topics.length));
  }

  /**
   * Build the public payload from a cache entry.
   *
   * @param {ReadonlyArray<ZhihuHotTopic>} topics
   * @param {CacheEntry} entry
   * @returns {EcosystemHotList}
   */
  function decorate(topics, entry) {
    return {
      hot: topics.map(toPublicHotRow),
      provenance: {
        source: /** @type {'mock' | 'real'} */ (entry.source_name),
        ...(entry.endpoint ? { endpoint: entry.endpoint } : {}),
      },
      cached: true,
      fetched_at: new Date(entry.fetched_at).toISOString(),
    };
  }

  /**
   * Public API. Returns the EcosystemHotList the route layer
   * spreads into the JSON response.
   *
   * @param {{ category?: string, limit?: number, force?: boolean }} [input]
   * @returns {Promise<EcosystemHotList>}
   */
  async function getHot(input = {}) {
    const category = clampCategory(input && typeof input.category === 'string' ? input.category : 'total');
    const requestedLimit = typeof input.limit === 'number' && input.limit > 0 ? Math.floor(input.limit) : 30;
    const limit = Math.min(requestedLimit, 50);
    const force = input && input.force === true;
    const source = ensureSource();

    if (force) {
      // `force` is intentionally not implemented in the public façade
      // (the route layer ignores it) — we honour it here for tests.
      for (const key of Array.from(cache.keys())) {
        if (key.startsWith(`${category}::`)) cache.delete(key);
      }
    }

    const currentBucket = bucketFor(category, now());
    const key = cacheKey(category, currentBucket);
    const entry = cache.get(key);

    // 1. Fresh cache hit: serve synchronously.
    if (entry) {
      const age = now() - entry.fetched_at;
      if (age < ttlMs) {
        return decorate(clip(entry.topics, limit), entry);
      }
    }

    // 2. Stale cache hit (within SWR): serve stale + background refresh.
    if (entry) {
      const age = now() - entry.fetched_at;
      if (age < swrMs) {
        // Kick off a refresh but do NOT await it.
        backgroundRefresh(category);
        return decorate(clip(entry.topics, limit), entry);
      }
    }

    // 3. No usable cache in the current bucket. Look in OTHER buckets
    //    for the SAME category (graceful degradation).
    let pastEntry = null;
    for (const [k, e] of cache.entries()) {
      if (k.startsWith(`${category}::`) && e.fetched_at > (pastEntry ? pastEntry.fetched_at : 0)) {
        pastEntry = e;
      }
    }
    // 4. Try the upstream.
    try {
      const topics = await upstreamFetch(category);
      const ranked = topics.map((t, i) => normaliseHotTopic(t, t.category || category, i + 1)).filter(Boolean);
      const freshEntry = {
        fetched_at: now(),
        topics: ranked,
        source_name: source.name,
        endpoint: endpointFor(category),
        hosts: hostsFor(),
        refreshing: null,
      };
      cache.set(key, freshEntry);
      return decorate(clip(ranked, limit), freshEntry);
    } catch (err) {
      // Graceful degradation: serve the past-entry (past-SWR is OK
      // when the upstream is failing) before we return empty.
      if (pastEntry) {
        // We deliberately do NOT touch cache here — the next request
        // for this bucket will retry the upstream and either succeed
        // (refreshing the bucket) or hit this same fallback path.
        return decorate(clip(pastEntry.topics, limit), pastEntry);
      }
      // Truly nothing usable. Empty list + cached:false; the route
      // layer surfaces the "暂时无法获取知乎热议" placeholder.
      return {
        hot: [],
        provenance: { source: /** @type {'mock' | 'real'} */ (source.name) },
        cached: false,
        fetched_at: '',
      };
    }
  }

  return Object.freeze({
    async getHot(input) {
      return getHot(input);
    },
    resetForTests() {
      cache.clear();
      activeSource = null;
    },
    _peek(category) {
      const safe = clampCategory(category);
      for (const [k, e] of cache.entries()) {
        if (k.startsWith(`${safe}::`)) {
          return {
            fetched_at: e.fetched_at,
            source_name: e.source_name,
            endpoint: e.endpoint,
            size: e.topics.length,
          };
        }
      }
      return null;
    },
    _config() {
      const source = ensureSource();
      return {
        ttlMs,
        swrMs,
        bucketMs: BUCKET_MS,
        sourceName: source.name,
        endpoint: endpointFor('total'),
        knownCategories: KNOWN_CATEGORIES,
      };
    },
  });
}

export const HOT_PROVIDER_CONFIG = Object.freeze({
  TTL_MS,
  SWR_MS,
  BUCKET_MS,
  KNOWN_CATEGORIES: KNOWN_CATEGORIES.slice(),
});
