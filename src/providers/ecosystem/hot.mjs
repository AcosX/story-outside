// src/providers/ecosystem/hot.mjs — 知乎热榜 (ClickUp 16.4).
//
// Product positioning (per ClickUp 16.4 description):
//   * Hot list feeds the home-page "知乎此刻热议" discovery module.
//   * It is NOT part of the story Runtime; we never turn a hot topic
//     into story beats / narrative / session events.
//   * It is a thin, capped, cached read-through to whatever provider
//     (mock today; real Zhihu tomorrow) supplies the data. The DTO
//     shape is provider-agnostic so a future real adapter can drop in
//     without changing the HTTP contract.
//
// Caching strategy (per description):
//   * Fresh window:  TTL = 5 min. While within TTL, the cache is
//     served synchronously and the upstream is NOT touched.
//   * Stale window:  stale-while-revalidate = 30 min. After the TTL
//     expires but within the SWR window, the stale data is served
//     immediately AND a background refresh is kicked off; subsequent
//     callers see the new fresh data.
//   * Past stale:    beyond SWR, no data is returned and the caller
//     sees `ecosystem_status: "unavailable"`. The module does NOT
//     keep returning data forever; the description explicitly says
//     "若 API 429/5xx/超时，允许继续展示上一份未过旧的缓存，或隐藏
//     模块".
//
// Rate limiting:
//   * Per the official Zhihu hint (100 calls/day per user) we keep a
//     process-local counter so a test / dev run cannot accidentally
//     spend the daily budget. The counter resets at the local
//     midnight. Real deployments would back this with a shared
//     store; this MVP keeps it in-process.
//
// Matching:
//   * MVP uses keyword overlap + tag overlap between hot topics and
//     the StoryCommunityProfile.hot_keywords[] entries. We do NOT
//     call an LLM. We do NOT mutate the profile. The match
//     threshold is hard-coded (see MATCH_THRESHOLD below) so the
//     behaviour is reproducible across runs.
//
// IMPORTANT: This module does NOT call any external API by default
// and does NOT read any environment variable that looks like a
// credential. The mock source is built-in; the real adapter would
// live in a sibling module and reuse this one.

import { ProviderError, ValidationError } from '../dto.mjs';
import { MOCK_HOT_TOPICS_RAW } from './mockHotSource.mjs';

/**
 * @typedef {Object} ZhihuHotTopic
 * @property {string} id             Stable identifier inside this list.
 * @property {string} title          Display title.
 * @property {string} url            Outbound link to zhihu.com.
 * @property {number} hotness        Hotness score (raw upstream scale).
 * @property {string} excerpt        优质回答摘要 excerpt (short).
 * @property {number} answer_count   Number of answers on the underlying question.
 * @property {string} question_id    Underlying question id (stringified).
 * @property {string[]} tags         Tags derived from the upstream payload
 *                                   (mock fixtures expose none; the
 *                                   real adapter will surface them).
 */

/**
 * @typedef {Object} HotTopicWithMatch
 * @property {ZhihuHotTopic} topic
 * @property {Array<{
 *   story_uuid: string,
 *   story_version_uuid: string,
 *   score: number,
 *   matched_keywords: string[],
 *   matched_tags: string[]
 * }>} matches     Empty when no story is considered relevant.
 */

/**
 * @typedef {Object} EcosystemHotList
 * @property {ZhihuHotTopic[]} hot_list              The hot topics (may be
 *                                                  shorter than `limit`
 *                                                  when the upstream
 *                                                  source has fewer).
 * @property {HotTopicWithMatch[]} entries           hot topics with optional
 *                                                  match results. Same order
 *                                                  as `hot_list`.
 * @property {'fresh' | 'stale' | 'unavailable'} ecosystem_status
 *                                                  'fresh' = served within
 *                                                          TTL (5 min).
 *                                                  'stale' = served stale
 *                                                          data while
 *                                                          triggering a
 *                                                          background
 *                                                          refresh.
 *                                                  'unavailable' = no
 *                                                          cache hit; the
 *                                                          module failed to
 *                                                          fetch fresh data.
 * @property {boolean} stale                         True iff `ecosystem_status`
 *                                                  === 'stale'. Convenience
 *                                                  field for clients.
 * @property {string} generated_at                   ISO timestamp of the
 *                                                  cached payload (when
 *                                                  applicable). Empty when
 *                                                  unavailable.
 * @property {string} source                         'mock' | 'real'.
 * @property {object} [rate_limit]                   Snapshot of the local
 *                                                  rate-limit counter.
 * @property {number} rate_limit.remaining
 * @property {number} rate_limit.daily_cap
 * @property {string} rate_limit.reset_at            ISO timestamp of next
 *                                                  local reset.
 */

/**
 * @typedef {import('../../community/profile.mjs').StoryCommunityProfile} StoryCommunityProfile
 */

// TTL = 5 min, SWR window = 30 min. Past 30 min the cache is dropped
// and the next call MUST hit the upstream (or fail with unavailable).
const TTL_MS = 5 * 60 * 1000;
const SWR_MS = 30 * 60 * 1000;
const RATE_LIMIT_DAILY_CAP = 100;
const MATCH_THRESHOLD = 0.4;

/**
 * @param {unknown} raw
 * @returns {ZhihuHotTopic}
 */
function normaliseHotTopic(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError('hot topic must be an object');
  }
  const t = /** @type {any} */ (raw);
  if (typeof t.id !== 'string' || !t.id) {
    throw new ValidationError('hot topic missing id');
  }
  if (typeof t.title !== 'string' || !t.title) {
    throw new ValidationError(`hot topic ${t.id} missing title`);
  }
  if (typeof t.url !== 'string' || !t.url) {
    throw new ValidationError(`hot topic ${t.id} missing url`);
  }
  if (typeof t.hotness !== 'number' || !Number.isFinite(t.hotness)) {
    throw new ValidationError(`hot topic ${t.id} missing hotness`);
  }
  const tags = Array.isArray(t.tags)
    ? t.tags.filter((s) => typeof s === 'string')
    : [];
  return {
    id: t.id,
    title: t.title,
    url: t.url,
    hotness: t.hotness,
    excerpt: typeof t.excerpt === 'string' ? t.excerpt : '',
    answer_count: Number.isFinite(t.answer_count) ? t.answer_count : 0,
    question_id: typeof t.question_id === 'string' ? t.question_id : '',
    tags,
  };
}

/**
 * Convert a normalised hot list into provider-agnostic entries.
 * Pure; safe to call repeatedly.
 *
 * @param {ReadonlyArray<ZhihuHotTopic>} topics
 * @returns {ReadonlyArray<ZhihuHotTopic>}
 */
function cloneTopics(topics) {
  return topics.map((t) => ({
    id: t.id,
    title: t.title,
    url: t.url,
    hotness: t.hotness,
    excerpt: t.excerpt,
    answer_count: t.answer_count,
    question_id: t.question_id,
    tags: t.tags.slice(),
  }));
}

/**
 * Tokenize a string into lower-case 2+ character tokens suitable for
 * keyword-overlap matching. The tokeniser is intentionally simple:
 * it splits on whitespace + common Chinese / Latin punctuation,
 * drops single-character noise (Chinese 的 / 是, English "a"), and
 * keeps Chinese bigrams (the natural word granularity for zh-CN).
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  // Strip obvious punctuation. We KEEP ASCII letters / digits so
  // English brand names like "Vision Pro" still match.
  const cleaned = text
    .toLowerCase()
    .replace(/[，。；、！？：·…—()（）【\[\]"'`~@#\$%\^&\*\-_+=<>\/\\|]/g, ' ');
  // Split on whitespace.
  const parts = cleaned.split(/\s+/).filter(Boolean);
  for (const part of parts) {
    if (part.length < 2) continue;
    // For Chinese-heavy strings we also emit 2-character bigrams so
    // "咖啡馆" still produces a token. For ASCII we keep the full
    // word.
    if (/^[\u4e00-\u9fff]+$/.test(part)) {
      if (part.length === 2) {
        out.push(part);
      } else {
        for (let i = 0; i + 2 <= part.length; i += 1) {
          out.push(part.slice(i, i + 2));
        }
      }
    } else {
      out.push(part);
    }
  }
  return out;
}

/**
 * Score a single (topic, profile) pair. Returns
 *   { score, matched_keywords, matched_tags }
 * The scoring rule (kept simple so the test can assert it byte-for-byte):
 *
 *   For each profile.hot_keywords[] entry, check three signals:
 *     (a) full keyword appears as a substring of (title + excerpt)
 *     (b) ALL tokens of the keyword appear in the topic token set
 *     (c) ANY tag in the topic exactly equals the keyword (or vice versa)
 *   The keyword matches when (a) OR (b) OR (c).
 *
 *   score = min(1, |matched_keywords| * 0.5 + |matched_tags| * 0.3)
 *
 * Rationale: keyword overlap is the strongest signal; tag overlap is
 * weaker but still informative. We clamp at 1.0. The MVP rule does
 * NOT use TF-IDF, embeddings, or LLM calls — those would push the
 * module outside the ClickUp 16.4 budget.
 *
 * Note: requiring ALL tokens of the keyword (not just ONE) prevents
 * the failure mode where a profile hot_keyword "雨夜 咖啡馆" matches a
 * topic that only contains the substring "咖啡". The full-keyword
 * substring fallback handles Latin brand names that tokenise
 * differently (e.g. "Vision Pro" → ["vision", "pro"] vs upstream
 * "Vision Pro 二代").
 *
 * @param {ZhihuHotTopic} topic
 * @param {StoryCommunityProfile} profile
 * @returns {{ score: number, matched_keywords: string[], matched_tags: string[] }}
 */
export function scoreHotAgainstProfile(topic, profile) {
  if (!topic || typeof topic !== 'object') {
    throw new ValidationError('scoreHotAgainstProfile: topic required');
  }
  if (!profile || typeof profile !== 'object') {
    throw new ValidationError('scoreHotAgainstProfile: profile required');
  }
  const topicTokens = new Set([
    ...tokenize(topic.title || ''),
    ...tokenize(topic.excerpt || ''),
  ]);
  const topicText = `${topic.title || ''}\n${topic.excerpt || ''}`;
  const topicTags = new Set(Array.isArray(topic.tags) ? topic.tags : []);
  const keywords = Array.isArray(profile.hot_keywords)
    ? profile.hot_keywords.map((k) => (k && typeof k.keyword === 'string' ? k.keyword : '')).filter(Boolean)
    : [];
  /** @type {string[]} */
  const matched_keywords = [];
  for (const kw of keywords) {
    const kwTokens = tokenize(kw);
    // (a) full keyword as substring of the topic text.
    const substringMatch = kw.length > 0 && topicText.includes(kw);
    // (b) ALL tokens of the keyword appear in the topic token set.
    const allTokensMatch = kwTokens.length > 0 && kwTokens.every((t) => topicTokens.has(t));
    // (c) tag equals keyword (or vice versa); handled separately as a tag match below.
    if (substringMatch || allTokensMatch) {
      matched_keywords.push(kw);
    }
  }
  /** @type {string[]} */
  const matched_tags = [];
  for (const tag of topicTags) {
    if (keywords.some((kw) => kw === tag || (kw.length > 0 && (tag.includes(kw) || kw.includes(tag))))) {
      matched_tags.push(tag);
    }
  }
  // Deduplicate keyword matches that are substrings of one another
  // (e.g. "雨夜 咖啡馆" vs "雨夜"). The longer keyword always wins.
  const deduped_keywords = deduplicateSubstrings(matched_keywords);
  const score = Math.min(
    1,
    deduped_keywords.length * 0.5 + matched_tags.length * 0.3,
  );
  return {
    score,
    matched_keywords: deduped_keywords,
    matched_tags,
  };
}

/**
 * @param {string[]} items
 * @returns {string[]}
 */
function deduplicateSubstrings(items) {
  if (items.length <= 1) return items.slice();
  const sorted = items.slice().sort((a, b) => b.length - a.length);
  /** @type {string[]} */
  const out = [];
  for (const candidate of sorted) {
    if (!out.some((keep) => keep.includes(candidate) && keep.length > candidate.length)) {
      out.push(candidate);
    }
  }
  return out;
}

/**
 * For each hot topic, find the profiles whose score crosses the
 * MATCH_THRESHOLD and surface them as match candidates. Pure;
 * does not mutate input.
 *
 * @param {ReadonlyArray<ZhihuHotTopic>} hotList
 * @param {ReadonlyArray<StoryCommunityProfile>} profiles
 * @returns {ReadonlyArray<HotTopicWithMatch>}
 */
export function matchHotToStories(hotList, profiles) {
  if (!Array.isArray(hotList)) {
    throw new ValidationError('matchHotToStories: hotList must be an array');
  }
  if (!Array.isArray(profiles)) {
    throw new ValidationError('matchHotToStories: profiles must be an array');
  }
  /** @type {HotTopicWithMatch[]} */
  const entries = [];
  for (const topic of hotList) {
    /** @type {HotTopicWithMatch['matches']} */
    const matches = [];
    for (const profile of profiles) {
      const result = scoreHotAgainstProfile(topic, profile);
      if (result.score >= MATCH_THRESHOLD) {
        matches.push({
          story_uuid: profile.story_uuid,
          story_version_uuid: profile.story_version_uuid,
          score: result.score,
          matched_keywords: result.matched_keywords,
          matched_tags: result.matched_tags,
        });
      }
    }
    matches.sort((a, b) => b.score - a.score);
    entries.push({ topic, matches });
  }
  return entries;
}

/**
 * Build a fresh-rate-limit snapshot. Pure helper for the route layer.
 * @param {RateLimiter} limiter
 * @returns {{ remaining: number, daily_cap: number, reset_at: string }}
 */
function rateLimitSnapshot(limiter) {
  return {
    remaining: Math.max(0, RATE_LIMIT_DAILY_CAP - limiter.count),
    daily_cap: RATE_LIMIT_DAILY_CAP,
    reset_at: limiter.nextResetIso,
  };
}

/**
 * In-process rate limiter. The contract says 100 calls/day; we keep
 * a single counter per process. Tests can swap the implementation
 * via `createEcosystemHotProvider({ rateLimiter })`.
 */
class RateLimiter {
  constructor() {
    this.count = 0;
    this.resetAt = nextLocalMidnightMs();
    this.nextResetIso = new Date(this.resetAt).toISOString();
  }
  /**
   * @param {number} [cost=1]
   * @returns {boolean} true if the call is allowed (and was counted),
   *                    false if the cap was reached.
   */
  acquire(cost = 1) {
    const now = Date.now();
    if (now >= this.resetAt) {
      this.count = 0;
      this.resetAt = nextLocalMidnightMs();
      this.nextResetIso = new Date(this.resetAt).toISOString();
    }
    if (this.count + cost > RATE_LIMIT_DAILY_CAP) {
      return false;
    }
    this.count += cost;
    return true;
  }
}

function nextLocalMidnightMs() {
  const d = new Date();
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);
  return next.getTime();
}

/**
 * A swappable upstream source. The default is the bundled mock. The
 * real adapter would return the same DTO shape; the rest of the
 * module is provider-agnostic.
 *
 * @typedef {Object} HotSource
 * @property {string} name                          'mock' | 'real'.
 * @property {() => Promise<ZhihuHotTopic[] | ReadonlyArray<ZhihuHotTopic>>} fetchHotList
 */

/**
 * Default mock source: returns the bundled fixed list verbatim. We
 * never call any external API here.
 * @type {HotSource}
 */
const MOCK_HOT_SOURCE = Object.freeze({
  name: 'mock',
  async fetchHotList() {
    // Defensive copy so the upstream cannot mutate the fixture.
    return cloneTopics(MOCK_HOT_TOPICS_RAW.map(normaliseHotTopic));
  },
});

/**
 * The in-memory cache entry. Fresh = within TTL. Stale = past TTL
 * but within SWR window. Past SWR the entry is dropped entirely.
 *
 * @typedef {Object} CacheEntry
 * @property {number} fetched_at
 * @property {ReadonlyArray<ZhihuHotTopic>} topics
 * @property {string} source_name
 * @property {Promise<void> | null} refreshing
 */

/**
 * Provider factory. Returns an object with three public methods:
 *   * getHotList — primary API. Resolves with a (possibly stale)
 *     cache snapshot.
 *   * matchHotList — companion helper that returns the same payload
 *     decorated with story matches. Routes call this directly when
 *     they want to ship match results to the home page.
 *   * resetForTests — wipes the cache + counter.
 *
 * @param {object} [opts]
 * @param {HotSource} [opts.source]             Override the upstream source.
 * @param {RateLimiter} [opts.rateLimiter]      Override the rate limiter.
 * @param {number} [opts.ttlMs]                 Override TTL (tests).
 * @param {number} [opts.swrMs]                 Override SWR window (tests).
 * @param {() => number} [opts.now]             Clock injection (tests).
 * @param {{ match: (topic: ZhihuHotTopic) => boolean }} [opts.errorInjector]
 *                                              Test hook: when set, the
 *                                              source's fetchHotList is
 *                                              bypassed and the injector
 *                                              is used to simulate
 *                                              failures.
 * @returns {{
 *   getHotList: (input?: { limit?: number, force?: boolean, profiles?: ReadonlyArray<StoryCommunityProfile> }) => Promise<EcosystemHotList>,
 *   matchHotList: (input?: { limit?: number, force?: boolean, profiles?: ReadonlyArray<StoryCommunityProfile> }) => Promise<EcosystemHotList>,
 *   resetForTests: () => void,
 *   _peek: () => CacheEntry | null,
 *   _rateLimiter: () => RateLimiter,
 * }}
 */
export function createEcosystemHotProvider(opts = {}) {
  const source = opts.source || MOCK_HOT_SOURCE;
  /** @type {RateLimiter} */
  const rateLimiter = opts.rateLimiter || new RateLimiter();
  const ttlMs = typeof opts.ttlMs === 'number' && opts.ttlMs > 0 ? opts.ttlMs : TTL_MS;
  const swrMs = typeof opts.swrMs === 'number' && opts.swrMs > 0 ? opts.swrMs : SWR_MS;
  const now = opts.now || (() => Date.now());
  const errorInjector = opts.errorInjector || null;
  /** @type {CacheEntry | null} */
  let cache = null;

  /**
   * @returns {Promise<ReadonlyArray<ZhihuHotTopic>>}
   */
  async function upstreamFetch() {
    if (errorInjector) {
      throw errorInjector.match ? errorInjector : new ProviderError('upstream_simulated_failure', 'Injected upstream failure.');
    }
    const out = await source.fetchHotList();
    if (!Array.isArray(out)) {
      throw new ProviderError('upstream_shape_mismatch', 'Hot source returned a non-array.');
    }
    return out.map(normaliseHotTopic);
  }

  /**
   * Refresh the cache in the background. Multiple concurrent callers
   * share the same Promise so we never spam the upstream.
   * @returns {Promise<void>}
   */
  function backgroundRefresh() {
    if (cache && cache.refreshing) return cache.refreshing;
    const promise = (async () => {
      try {
        const topics = await upstreamFetch();
        cache = {
          fetched_at: now(),
          topics: cloneTopics(topics),
          source_name: source.name,
          refreshing: null,
        };
      } catch (err) {
        // Background failures are NOT surfaced — we just leave the
        // stale cache in place. The next foreground call after SWR
        // will retry.
        if (cache) cache.refreshing = null;
        // Surface to any awaiter so tests can observe it.
        throw err;
      }
    })();
    if (cache) cache.refreshing = promise;
    return promise;
  }

  /**
   * @param {number} requested
   * @param {ReadonlyArray<ZhihuHotTopic>} topics
   * @returns {ReadonlyArray<ZhihuHotTopic>}
   */
  function clip(requested, topics) {
    if (requested <= 0) return topics.slice();
    return topics.slice(0, Math.min(requested, topics.length));
  }

  /**
   * Core getHotList implementation. Routes call this directly OR
   * call matchHotList (which wraps getHotList and decorates with
   * profile matches).
   *
   * @param {{ limit?: number, force?: boolean, profiles?: ReadonlyArray<StoryCommunityProfile> }} [input]
   * @returns {Promise<EcosystemHotList>}
   */
  async function getHotList(input = {}) {
    const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.floor(input.limit) : 30;
    const force = input.force === true;

    if (force) {
      cache = null;
    }

    // 1. Fresh cache hit: serve synchronously.
    if (cache) {
      const age = now() - cache.fetched_at;
      if (age < ttlMs) {
        const topics = clip(limit, cache.topics);
        return decorate(topics, cache, 'fresh');
      }
    }

    // 2. Stale cache hit (within SWR): serve stale + background refresh.
    if (cache) {
      const age = now() - cache.fetched_at;
      if (age < swrMs) {
        // Kick off a refresh, but do NOT await it.
        // The returned promise is stored on the cache entry so
        // concurrent calls share the same refresh.
        backgroundRefresh();
        const topics = clip(limit, cache.topics);
        return decorate(topics, cache, 'stale');
      }
    }

    // 3. No usable cache. Try the upstream. Rate-limit first.
    if (!rateLimiter.acquire(1)) {
      // Out of budget. If we DO have a past-SWR cache (already
      // dropped above) we cannot fall back; surface unavailable.
      return {
        hot_list: [],
        entries: [],
        ecosystem_status: 'unavailable',
        stale: false,
        generated_at: '',
        source: source.name,
        rate_limit: rateLimitSnapshot(rateLimiter),
      };
    }
    try {
      const topics = await upstreamFetch();
      cache = {
        fetched_at: now(),
        topics: cloneTopics(topics),
        source_name: source.name,
        refreshing: null,
      };
      const clipped = clip(limit, cache.topics);
      return decorate(clipped, cache, 'fresh');
    } catch (err) {
      // Description: "若 API 429/5xx/超时，允许继续展示上一份未过旧的
      // 缓存，或隐藏模块". We have no cache here (otherwise we would
      // have hit step 2). Surface unavailable; route layer hides the
      // module.
      return {
        hot_list: [],
        entries: [],
        ecosystem_status: 'unavailable',
        stale: false,
        generated_at: '',
        source: source.name,
        rate_limit: rateLimitSnapshot(rateLimiter),
      };
    }
  }

  /**
   * Match-decorated variant. Pulls the same cache + fallback rules
   * as getHotList and runs matchHotToStories on top.
   *
   * @param {{ limit?: number, force?: boolean, profiles?: ReadonlyArray<StoryCommunityProfile> }} [input]
   * @returns {Promise<EcosystemHotList>}
   */
  async function matchHotList(input = {}) {
    const profiles = Array.isArray(input.profiles) ? input.profiles : [];
    const result = await getHotList(input);
    const entries = matchHotToStories(result.hot_list, profiles);
    return {
      ...result,
      entries,
    };
  }

  /**
   * @param {ReadonlyArray<ZhihuHotTopic>} topics
   * @param {CacheEntry} entry
   * @param {'fresh' | 'stale' | 'unavailable'} status
   * @returns {EcosystemHotList}
   */
  function decorate(topics, entry, status) {
    return {
      hot_list: cloneTopics(topics),
      entries: topics.map((topic) => ({ topic: cloneTopics([topic])[0], matches: [] })),
      ecosystem_status: status,
      stale: status === 'stale',
      generated_at: new Date(entry.fetched_at).toISOString(),
      source: entry.source_name,
      rate_limit: rateLimitSnapshot(rateLimiter),
    };
  }

  return Object.freeze({
    async getHotList(input) {
      return getHotList(input);
    },
    async matchHotList(input) {
      return matchHotList(input);
    },
    resetForTests() {
      cache = null;
      rateLimiter.count = 0;
    },
    _peek() {
      return cache;
    },
    _rateLimiter() {
      return rateLimiter;
    },
    _config() {
      return Object.freeze({
        ttlMs,
        swrMs,
        matchThreshold: MATCH_THRESHOLD,
        rateLimitDailyCap: RATE_LIMIT_DAILY_CAP,
        sourceName: source.name,
      });
    },
  });
}

export const HOT_PROVIDER_CONFIG = Object.freeze({
  TTL_MS,
  SWR_MS,
  RATE_LIMIT_DAILY_CAP,
  MATCH_THRESHOLD,
});