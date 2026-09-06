// src/providers/ecosystem/knowledge.mjs — 知乎知识区 (ClickUp 16.5).
//
// Product positioning (per ClickUp 16.5 description):
//   * Knowledge 区 is the independent "知乎知识" discovery module for a
//     specific (story_version_uuid, community_profile_version) pair.
//   * It is NOT the discussion 区 (queries[] / topics[] / hot_keywords[]),
//     and it is NOT part of the story Runtime. We never turn a knowledge
//     entry into story beats / narrative / session events.
//   * It is a thin, capped, cached read-through to whatever provider
//     (mock today; real Zhihu tomorrow) supplies the data. The DTO
//     shape is provider-agnostic so a future real adapter can drop in
//     without changing the HTTP contract.
//
// 知识区 vs 讨论区 (independent surfaces, do NOT mix):
//   * 讨论区 (ClickUp 16.1 community profile.queries/topics) —
//     original-story discussion; the player can post / reply.
//   * 知识区 (this module, ClickUp 16.5) — Zhihu Knowledge extension
//     of the original story; explicitly labelled on every response as
//     "以下内容属于现实/知乎知识延伸，不是原作设定或 AI 世界线事实"
//     so a reader can never mistake it for canonical story content.
//
// Caching strategy (per description):
//   * Cache key = (story_version_uuid, community_profile_version).
//     Bumping the community profile generator_version invalidates the
//     whole knowledge cache for that story version automatically.
//   * Fresh window:  TTL = 5 min. While within TTL, the cache is
//     served synchronously and the upstream is NOT touched.
//   * Stale window:  stale-while-revalidate = 30 min. After the TTL
//     expires but within the SWR window, the stale data is served
//     immediately AND a background refresh is kicked off.
//   * Past stale:    beyond SWR, no data is returned and the caller
//     sees `ecosystem_status: "unavailable"` AND the route returns
//     HTTP 503 (per description: "provider 故障 → 返空 + 503").
//
// Matching:
//   * MVP uses keyword overlap between knowledge entry
//     (title + excerpt + labels) and the
//     community profile.knowledge_queries[] entries. We do NOT call
//     an LLM. We do NOT mutate the profile.
//   * The mock path runs against the bundled fixture; the real path
//     runs against the official Zhihu hackathon
//     /km-indep-home/hackathon/v2/knowledge/list endpoint. Both
//     produce the same DTO.
//
// IMPORTANT: This module does NOT call any external API by default
// and does NOT read any environment variable that looks like a
// credential. The mock source is built-in; the real adapter would
// live in a sibling module and reuse this one.

import { ProviderError, ValidationError } from '../dto.mjs';
import { MOCK_KNOWLEDGE_ENTRIES_RAW } from './mockKnowledgeSource.mjs';

/**
 * @typedef {Object} ZhihuKnowledgeEntry
 * @property {string} id             Stable identifier inside this list.
 * @property {string} title          Knowledge entry title (zh-CN).
 * @property {string} url            Outbound link to zhihu.com.
 * @property {string} excerpt        Short snippet / summary (200 chars).
 * @property {string} source_name    Source display name (mock/real).
 * @property {string[]} labels       Content labels (mock fixtures expose
 *                                   none; the real adapter will surface
 *                                   them).
 * @property {string} work_id        Original upstream work_id (stringified
 *                                   number for the hackathon contract).
 *                                   Stable identifier within one upstream
 *                                   snapshot so the route layer can
 *                                   de-duplicate entries that share a
 *                                   work_id.
 */

/**
 * @typedef {Object} KnowledgeEntryWithMatch
 * @property {ZhihuKnowledgeEntry} entry
 * @property {Array<{
 *   query: string,
 *   score: number,
 *   matched_tokens: string[]
 * }>} matches     Empty when no knowledge_query is considered relevant.
 *                 The Knowledge surface explicitly does NOT emit a
 *                 "matched story" because Knowledge is independent
 *                 from the discussion surface.
 */

/**
 * @typedef {Object} EcosystemKnowledgeList
 * @property {ZhihuKnowledgeEntry[]} knowledge_list     The knowledge entries (may
 *                                                      be shorter than `limit`
 *                                                      when the upstream source
 *                                                      has fewer).
 * @property {KnowledgeEntryWithMatch[]} entries        Knowledge entries with
 *                                                      optional match results.
 *                                                      Same order as
 *                                                      `knowledge_list`.
 * @property {'fresh' | 'stale' | 'unavailable'} ecosystem_status
 *                                                      'fresh' = served within
 *                                                              TTL (5 min).
 *                                                      'stale' = served stale
 *                                                              data while
 *                                                              triggering a
 *                                                              background
 *                                                              refresh.
 *                                                      'unavailable' = no
 *                                                              cache hit; the
 *                                                              module failed to
 *                                                              fetch fresh data.
 * @property {boolean} stale                           True iff `ecosystem_status`
 *                                                    === 'stale'. Convenience
 *                                                    field for clients.
 * @property {string} generated_at                     ISO timestamp of the
 *                                                    cached payload (when
 *                                                    applicable). Empty when
 *                                                    unavailable.
 * @property {string} source                           'mock' | 'real'.
 * @property {string} story_version_uuid               Echo of the cache key
 *                                                    first component.
 * @property {string} community_profile_version       Echo of the cache key
 *                                                    second component (taken
 *                                                    from the community
 *                                                    profile.generator_version).
 * @property {string} surface_disclaimer               Always set to
 *                                                    '以下内容属于现实/知乎知识延伸，不是原作设定或 AI 世界线事实'
 *                                                    so a client / operator
 *                                                    can verify the
 *                                                    Knowledge 区 vs 讨论区
 *                                                    contract on the wire.
 */

/**
 * @typedef {import('../../community/profile.mjs').StoryCommunityProfile} StoryCommunityProfile
 */

// TTL = 5 min, SWR window = 30 min. Past 30 min the cache is dropped
// and the next call MUST hit the upstream (or fail with unavailable).
const TTL_MS = 5 * 60 * 1000;
const SWR_MS = 30 * 60 * 1000;
const MATCH_THRESHOLD = 0.3;
const DEFAULT_LIMIT = 8;
const SURFACE_DISCLAIMER = '以下内容属于现实/知乎知识延伸，不是原作设定或 AI 世界线事实';

/**
 * @param {unknown} raw
 * @returns {ZhihuKnowledgeEntry}
 */
function normaliseKnowledgeEntry(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError('knowledge entry must be an object');
  }
  const t = /** @type {any} */ (raw);
  if (typeof t.id !== 'string' || !t.id) {
    throw new ValidationError('knowledge entry missing id');
  }
  if (typeof t.title !== 'string' || !t.title) {
    throw new ValidationError(`knowledge entry ${t.id} missing title`);
  }
  if (typeof t.url !== 'string' || !t.url) {
    throw new ValidationError(`knowledge entry ${t.id} missing url`);
  }
  const labels = Array.isArray(t.labels)
    ? t.labels.filter((s) => typeof s === 'string')
    : [];
  const work_id = typeof t.work_id === 'string' && t.work_id
    ? t.work_id
    : t.id;
  return {
    id: t.id,
    title: t.title,
    url: t.url,
    excerpt: typeof t.excerpt === 'string' ? t.excerpt : '',
    source_name: typeof t.source_name === 'string' && t.source_name ? t.source_name : 'mock',
    labels,
    work_id,
  };
}

/**
 * Convert a normalised knowledge list into provider-agnostic entries.
 * Pure; safe to call repeatedly.
 *
 * @param {ReadonlyArray<ZhihuKnowledgeEntry>} entries
 * @returns {ReadonlyArray<ZhihuKnowledgeEntry>}
 */
function cloneEntries(entries) {
  return entries.map((e) => ({
    id: e.id,
    title: e.title,
    url: e.url,
    excerpt: e.excerpt,
    source_name: e.source_name,
    labels: e.labels.slice(),
    work_id: e.work_id,
  }));
}

/**
 * Tokenize a string into lower-case tokens suitable for keyword-overlap
 * matching. Same rules as hot.mjs so the two ecosystem surfaces share
 * one vocabulary.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  const cleaned = text
    .toLowerCase()
    .replace(/[，。；、！？：·…—()（）【\[\]"'`~@#\$%\^&\*\-_+=<>\/\\|]/g, ' ');
  const parts = cleaned.split(/\s+/).filter(Boolean);
  for (const part of parts) {
    if (part.length < 2) continue;
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
 * Score a single (entry, profile) pair against the community profile's
 * knowledge_queries. The score uses the strongest signal: any one
 * knowledge_query token appears in the entry's token set. The match
 * list returns the queries that crossed the threshold, sorted by
 * descending score.
 *
 * @param {ZhihuKnowledgeEntry} entry
 * @param {StoryCommunityProfile} profile
 * @returns {{ score: number, matches: Array<{query: string, score: number, matched_tokens: string[]}> }}
 */
export function scoreKnowledgeAgainstProfile(entry, profile) {
  if (!entry || typeof entry !== 'object') {
    throw new ValidationError('scoreKnowledgeAgainstProfile: entry required');
  }
  if (!profile || typeof profile !== 'object') {
    throw new ValidationError('scoreKnowledgeAgainstProfile: profile required');
  }
  const entryTokens = new Set([
    ...tokenize(entry.title || ''),
    ...tokenize(entry.excerpt || ''),
    ...(Array.isArray(entry.labels) ? entry.labels.flatMap((l) => tokenize(String(l))) : []),
  ]);
  const knowledgeQueries = Array.isArray(profile.knowledge_queries)
    ? profile.knowledge_queries
        .map((q) => (q && typeof q.query === 'string' ? q.query : ''))
        .filter(Boolean)
    : [];
  /** @type {Array<{query: string, score: number, matched_tokens: string[]}>} */
  const matches = [];
  for (const query of knowledgeQueries) {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) continue;
    const matched = queryTokens.filter((t) => entryTokens.has(t));
    const ratio = matched.length / queryTokens.length;
    if (ratio >= MATCH_THRESHOLD) {
      matches.push({
        query,
        score: Math.min(1, ratio + 0.1 * Math.min(matched.length, 5) / 5),
        matched_tokens: matched,
      });
    }
  }
  matches.sort((a, b) => b.score - a.score);
  return { score: matches.length > 0 ? matches[0].score : 0, matches };
}

/**
 * For each knowledge entry, run match scoring against the supplied
 * profile and surface the matches. Pure; does not mutate input.
 *
 * @param {ReadonlyArray<ZhihuKnowledgeEntry>} knowledgeList
 * @param {StoryCommunityProfile} profile
 * @returns {ReadonlyArray<KnowledgeEntryWithMatch>}
 */
export function matchKnowledgeToProfile(knowledgeList, profile) {
  if (!Array.isArray(knowledgeList)) {
    throw new ValidationError('matchKnowledgeToProfile: knowledgeList must be an array');
  }
  if (!profile || typeof profile !== 'object') {
    throw new ValidationError('matchKnowledgeToProfile: profile required');
  }
  /** @type {KnowledgeEntryWithMatch[]} */
  const out = [];
  for (const entry of knowledgeList) {
    const { matches } = scoreKnowledgeAgainstProfile(entry, profile);
    out.push({ entry, matches });
  }
  return out;
}

/**
 * A swappable upstream source. The default is the bundled mock. The
 * real adapter returns the same DTO shape; the rest of the module is
 * provider-agnostic.
 *
 * @typedef {Object} KnowledgeSource
 * @property {string} name                          'mock' | 'real'.
 * @property {(input: { query?: string, limit?: number }) => Promise<ZhihuKnowledgeEntry[] | ReadonlyArray<ZhihuKnowledgeEntry>>} fetchKnowledge
 */

/**
 * Default mock source: returns the bundled fixed list verbatim. We
 * never call any external API here.
 * @type {KnowledgeSource}
 */
const MOCK_KNOWLEDGE_SOURCE = Object.freeze({
  name: 'mock',
  async fetchKnowledge() {
    return cloneEntries(MOCK_KNOWLEDGE_ENTRIES_RAW.map(normaliseKnowledgeEntry));
  },
});

/**
 * @typedef {Object} CacheEntry
 * @property {string} story_version_uuid
 * @property {string} community_profile_version
 * @property {number} fetched_at
 * @property {ReadonlyArray<ZhihuKnowledgeEntry>} entries
 * @property {string} source_name
 * @property {Promise<void> | null} refreshing
 */

/**
 * Provider factory. Returns an object with public methods:
 *   * getKnowledgeList — primary API. Resolves with a (possibly stale)
 *     cache snapshot. The caller is expected to know the
 *     (story_version_uuid, community_profile_version) pair; the cache
 *     keys entries on it.
 *   * matchKnowledgeList — companion helper that decorates entries
 *     with profile match results.
 *   * unavailableResponse — explicit helper for the route layer to
 *     produce an HTTP-503-ready payload when the provider cannot serve
 *     data right now (per description: "provider 故障 → 返空 + 503").
 *   * resetForTests — wipes the cache.
 *
 * @param {object} [opts]
 * @param {KnowledgeSource} [opts.source]             Override the upstream source.
 * @param {number} [opts.ttlMs]                       Override TTL (tests).
 * @param {number} [opts.swrMs]                       Override SWR window (tests).
 * @param {() => number} [opts.now]                   Clock injection (tests).
 * @param {() => Promise<never>} [opts.errorInjector] Test hook: when set, the
 *                                                    source's fetchKnowledge
 *                                                    is bypassed and the
 *                                                    injector is awaited to
 *                                                    simulate failures.
 * @returns {{
 *   getKnowledgeList: (input: { story_version_uuid: string, community_profile_version: string, limit?: number, force?: boolean }) => Promise<EcosystemKnowledgeList>,
 *   matchKnowledgeList: (input: { story_version_uuid: string, community_profile_version: string, profile?: StoryCommunityProfile, limit?: number, force?: boolean }) => Promise<EcosystemKnowledgeList>,
 *   unavailableResponse: (input: { story_version_uuid: string, community_profile_version: string }) => EcosystemKnowledgeList,
 *   resetForTests: () => void,
 *   _peek: () => CacheEntry | null,
 * }}
 */
export function createEcosystemKnowledgeProvider(opts = {}) {
  const source = opts.source || MOCK_KNOWLEDGE_SOURCE;
  const ttlMs = typeof opts.ttlMs === 'number' && opts.ttlMs > 0 ? opts.ttlMs : TTL_MS;
  const swrMs = typeof opts.swrMs === 'number' && opts.swrMs > 0 ? opts.swrMs : SWR_MS;
  const now = opts.now || (() => Date.now());
  const errorInjector = opts.errorInjector || null;
  /** @type {CacheEntry | null} */
  let cache = null;

  /**
   * @returns {Promise<ReadonlyArray<ZhihuKnowledgeEntry>>}
   */
  async function upstreamFetch() {
    if (errorInjector) {
      await errorInjector();
      // Unreachable; the injector must throw.
      throw new ProviderError('upstream_simulated_failure', 'Injected upstream failure.');
    }
    const out = await source.fetchKnowledge({});
    if (!Array.isArray(out)) {
      throw new ProviderError('upstream_shape_mismatch', 'Knowledge source returned a non-array.');
    }
    return out.map(normaliseKnowledgeEntry);
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
        const entries = await upstreamFetch();
        if (cache) {
          cache.entries = cloneEntries(entries);
          cache.fetched_at = now();
          cache.source_name = source.name;
          cache.refreshing = null;
        }
      } catch (err) {
        if (cache) cache.refreshing = null;
        throw err;
      }
    })();
    if (cache) cache.refreshing = promise;
    return promise;
  }

  /**
   * @param {number} requested
   * @param {ReadonlyArray<ZhihuKnowledgeEntry>} entries
   * @returns {ReadonlyArray<ZhihuKnowledgeEntry>}
   */
  function clip(requested, entries) {
    if (requested <= 0) return entries.slice();
    return entries.slice(0, Math.min(requested, entries.length));
  }

  /**
   * Core getKnowledgeList implementation.
   *
   * @param {{ story_version_uuid: string, community_profile_version: string, limit?: number, force?: boolean }} input
   * @returns {Promise<EcosystemKnowledgeList>}
   */
  async function getKnowledgeList(input) {
    if (!input || typeof input !== 'object') {
      throw new ValidationError('getKnowledgeList: input required');
    }
    const story_version_uuid = input.story_version_uuid;
    const community_profile_version = input.community_profile_version;
    if (typeof story_version_uuid !== 'string' || !story_version_uuid) {
      throw new ValidationError('getKnowledgeList: story_version_uuid required');
    }
    if (typeof community_profile_version !== 'string' || !community_profile_version) {
      throw new ValidationError('getKnowledgeList: community_profile_version required');
    }
    const limit = typeof input.limit === 'number' && input.limit > 0
      ? Math.floor(input.limit)
      : DEFAULT_LIMIT;
    const force = input.force === true;

    // Cache-key mismatch: when either component of the key changes the
    // existing cache entry is treated as miss and dropped, so the next
    // call rebuilds against the new key.
    if (cache
        && (cache.story_version_uuid !== story_version_uuid
            || cache.community_profile_version !== community_profile_version
            || force)) {
      cache = null;
    }

    // 1. Fresh cache hit: serve synchronously.
    if (cache) {
      const age = now() - cache.fetched_at;
      if (age < ttlMs) {
        const entries = clip(limit, cache.entries);
        return decorate(entries, cache, 'fresh', { story_version_uuid, community_profile_version });
      }
    }

    // 2. Stale cache hit (within SWR): serve stale + background refresh.
    if (cache) {
      const age = now() - cache.fetched_at;
      if (age < swrMs) {
        backgroundRefresh();
        const entries = clip(limit, cache.entries);
        return decorate(entries, cache, 'stale', { story_version_uuid, community_profile_version });
      }
    }

    // 3. No usable cache. Try the upstream.
    try {
      const entries = await upstreamFetch();
      cache = {
        story_version_uuid,
        community_profile_version,
        fetched_at: now(),
        entries: cloneEntries(entries),
        source_name: source.name,
        refreshing: null,
      };
      const clipped = clip(limit, cache.entries);
      return decorate(clipped, cache, 'fresh', { story_version_uuid, community_profile_version });
    } catch (err) {
      // Description: "provider 故障 → 返空 + 503".
      return unavailableResponse({ story_version_uuid, community_profile_version, cause: err });
    }
  }

  /**
   * Match-decorated variant. Pulls the same cache + fallback rules
   * as getKnowledgeList and runs matchKnowledgeToProfile on top.
   *
   * @param {{ story_version_uuid: string, community_profile_version: string, profile?: StoryCommunityProfile, limit?: number, force?: boolean }} input
   * @returns {Promise<EcosystemKnowledgeList>}
   */
  async function matchKnowledgeList(input) {
    const profile = input && input.profile;
    const result = await getKnowledgeList(input);
    if (!profile) {
      return {
        ...result,
        entries: result.knowledge_list.map((entry) => ({ entry, matches: [] })),
      };
    }
    const entries = matchKnowledgeToProfile(result.knowledge_list, profile);
    return {
      ...result,
      entries,
    };
  }

  /**
   * Build an explicit unavailable payload (the route layer returns this
   * with HTTP 503). Exported on the factory so a route can build it
   * synchronously when the provider cannot even be reached (e.g. the
   * mock source failed to load at boot).
   *
   * @param {{ story_version_uuid: string, community_profile_version: string, cause?: unknown }} input
   * @returns {EcosystemKnowledgeList}
   */
  function unavailableResponse(input) {
    return {
      knowledge_list: [],
      entries: [],
      ecosystem_status: 'unavailable',
      stale: false,
      generated_at: '',
      source: source.name,
      story_version_uuid: input.story_version_uuid,
      community_profile_version: input.community_profile_version,
      surface_disclaimer: SURFACE_DISCLAIMER,
    };
  }

  /**
   * @param {ReadonlyArray<ZhihuKnowledgeEntry>} entries
   * @param {CacheEntry} entry
   * @param {'fresh' | 'stale' | 'unavailable'} status
   * @param {{ story_version_uuid: string, community_profile_version: string }} keys
   * @returns {EcosystemKnowledgeList}
   */
  function decorate(entries, entry, status, keys) {
    return {
      knowledge_list: cloneEntries(entries),
      entries: entries.map((e) => ({ entry: cloneEntries([e])[0], matches: [] })),
      ecosystem_status: status,
      stale: status === 'stale',
      generated_at: new Date(entry.fetched_at).toISOString(),
      source: entry.source_name,
      story_version_uuid: keys.story_version_uuid,
      community_profile_version: keys.community_profile_version,
      surface_disclaimer: SURFACE_DISCLAIMER,
    };
  }

  return Object.freeze({
    async getKnowledgeList(input) {
      return getKnowledgeList(input);
    },
    async matchKnowledgeList(input) {
      return matchKnowledgeList(input);
    },
    unavailableResponse(input) {
      return unavailableResponse(input);
    },
    resetForTests() {
      cache = null;
    },
    _peek() {
      return cache;
    },
    _config() {
      return Object.freeze({
        ttlMs,
        swrMs,
        matchThreshold: MATCH_THRESHOLD,
        defaultLimit: DEFAULT_LIMIT,
        sourceName: source.name,
        surfaceDisclaimer: SURFACE_DISCLAIMER,
      });
    },
  });
}

export const KNOWLEDGE_PROVIDER_CONFIG = Object.freeze({
  TTL_MS,
  SWR_MS,
  MATCH_THRESHOLD,
  DEFAULT_LIMIT,
  SURFACE_DISCLAIMER,
});