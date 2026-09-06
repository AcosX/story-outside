// src/providers/ecosystem/knowledge.mjs — ClickUp 16.5 (rebuilt)
//
// Orchestrator for the public POST /v1/ecosystem/knowledge façade.
//
// Goals (per ChatGPT review P1 — see PR #15 blockers):
//
//   1. The real provider (src/providers/ecosystem/zhihuKnowledgeSource.mjs)
//      MUST NOT be hard-wired. When its env var is unset, the
//      orchestrator transparently falls back to the mock so the
//      public surface always answers 200 with non-empty entries.
//      A failure on the real path also degrades to the mock — the
//      player is never shown a 503 just because the knowledge
//      extension is unavailable.
//
//   2. The cache is keyed by
//      JSON.stringify({ story_version_uuid, community_profile_version, topic_id })
//      — a pair-key map. The previous single-entry `let cache = null`
//      pattern leaked across requests and was the second P1 blocker.
//
//   3. The response is ALWAYS decorated with `provisional: true` so
//      the UI / client never treats knowledge entries as canonical
//      story facts. The surface disclaimer ("以下内容属于现实/知乎
//      知识延伸，不是原作设定或 AI 世界线事实") is echoed on every
//      response for the same reason.
//
//   4. The orchestrator never imports any /api/dev/* or /api/admin/*
//      seam and never reflects the DEV_FLAG banner. Knowledge is a
//      player-facing surface.
//
// What this module deliberately does NOT do:
//   - No LLM call. No prompt to the agent runtime.
//   - No mutation of the community profile.
//   - No write to the in-memory story repository.
//   - No knowledge entry is turned into a story beat or session event.
//     Knowledge 区 and 讨论区 / Runtime are independent surfaces.

import { defaultMockFetchKnowledge, knowledgeSurfaceDisclaimer } from './mockKnowledgeSource.mjs';
import { createRealZhihuKnowledgeProvider } from './zhihuKnowledgeSource.mjs';
import { ProviderError, ValidationError } from '../dto.mjs';

const DEFAULT_TTL_MS = 5 * 60 * 1000;     // 5 min
const DEFAULT_SWR_MS = 30 * 60 * 1000;    // 30 min
const DEFAULT_LIMIT = 8;
const SURFACE_DISCLAIMER = knowledgeSurfaceDisclaimer();

/**
 * @typedef {import('./mockKnowledgeSource.mjs').MockKnowledgeEntry} MockKnowledgeEntry
 * @typedef {import('./zhihuKnowledgeSource.mjs').KnowledgeEntry} RealKnowledgeEntry
 */

/**
 * @typedef {Object} KnowledgeEntry
 * @property {string} id
 * @property {string} title
 * @property {string} summary
 * @property {string} source
 * @property {string} url
 * @property {ReadonlyArray<string>} related_topics
 * @property {string} disclaimer
 */

/**
 * @typedef {Object} EcosystemKnowledgeResponse
 * @property {ReadonlyArray<KnowledgeEntry>} knowledge
 * @property {true} provisional                        Always true. The
 *                                                     knowledge surface
 *                                                     is provisional; the
 *                                                     UI MUST NOT treat
 *                                                     entries as canonical
 *                                                     story facts.
 * @property {string} disclaimer                        Surface disclaimer.
 * @property {string} source                            'real' | 'mock'.
 * @property {boolean} cached                           True iff served from cache.
 * @property {string} fetched_at                        ISO timestamp of the
 *                                                     underlying fetch (mock
 *                                                     or real).
 * @property {{ story_version_uuid: string, community_profile_version: string, topic_id: string | null }} cache_key
 *                                                     Echo of the cache key
 *                                                     for operator debug.
 * @property {boolean} degraded                         True iff the real
 *                                                     provider was
 *                                                     unavailable and the
 *                                                     mock took over.
 * @property {{ code: string, message: string } | null} degradation
 *                                                     When `degraded` is
 *                                                     true, the underlying
 *                                                     real-provider error
 *                                                     so an operator can
 *                                                     diagnose; never
 *                                                     echoed to clients.
 */

/**
 * Build the pair-key used by the cache. Stable JSON.stringify of the
 * three identifiers — order is fixed so two callers with the same
 * semantic input always hit the same cache row.
 *
 * @param {{ story_version_uuid: string, community_profile_version: string, topic_id?: string | null }} input
 * @returns {string}
 */
export function buildKnowledgeCacheKey(input) {
  if (!input || typeof input !== 'object') {
    throw new ValidationError('buildKnowledgeCacheKey: input required');
  }
  const story_version_uuid = typeof input.story_version_uuid === 'string'
    ? input.story_version_uuid
    : '';
  const community_profile_version = typeof input.community_profile_version === 'string'
    ? input.community_profile_version
    : '';
  const topic_id = typeof input.topic_id === 'string' && input.topic_id
    ? input.topic_id
    : null;
  if (!story_version_uuid) {
    throw new ValidationError('buildKnowledgeCacheKey: story_version_uuid required');
  }
  if (!community_profile_version) {
    throw new ValidationError('buildKnowledgeCacheKey: community_profile_version required');
  }
  return JSON.stringify({
    story_version_uuid,
    community_profile_version,
    topic_id,
  });
}

/**
 * Apply the `limit` knob to a knowledge list. Returns a frozen
 * snapshot so callers cannot mutate the underlying bundle.
 *
 * @param {ReadonlyArray<KnowledgeEntry>} entries
 * @param {number} limit
 * @returns {ReadonlyArray<KnowledgeEntry>}
 */
function clipEntries(entries, limit) {
  const out = limit > 0 && entries.length > limit ? entries.slice(0, limit) : entries.slice();
  return Object.freeze(out.map((e) => Object.freeze({
    id: e.id,
    title: e.title,
    summary: e.summary,
    source: e.source,
    url: e.url,
    related_topics: Object.freeze(e.related_topics.slice()),
    disclaimer: e.disclaimer || SURFACE_DISCLAIMER,
  })));
}

/**
 * Knowledge orchestrator factory. Returns a controller object with a
 * single public method `match({ story_version_uuid, community_profile_version,
 * topic_id?, limit?, force? })` that resolves with an
 * `EcosystemKnowledgeResponse`.
 *
 * Cache strategy (per ClickUp 16.5):
 *   * `Map<cache_key, { value, expires_at }>` — pair-key map, NEVER
 *     a single `let cache = null`. Two requests with different
 *     (story_version_uuid, community_profile_version, topic_id) tuples
 *     occupy independent rows and never collide.
 *   * TTL:  5 min. While within TTL the cache is served synchronously
 *     and the upstream is NOT touched.
 *   * SWR:  30 min. Past TTL but within SWR, the stale data is served
 *     immediately AND a background refresh is kicked off (one
 *     in-flight Promise per cache row — concurrent callers share it).
 *   * Past SWR the row is dropped and the next call MUST fetch.
 *
 * @param {object} [opts]
 * @param {ReturnType<typeof createRealZhihuKnowledgeProvider>} [opts.realProvider]
 * @param {() => ReadonlyArray<KnowledgeEntry>} [opts.mockFetch]          Override the mock (tests).
 * @param {number} [opts.ttlMs]                                            Override TTL (tests).
 * @param {number} [opts.swrMs]                                            Override SWR window (tests).
 * @param {() => number} [opts.now]                                        Clock injection (tests).
 * @returns {{
 *   match: (input: { story_version_uuid: string, community_profile_version: string, topic_id?: string | null, limit?: number, force?: boolean }) => Promise<EcosystemKnowledgeResponse>,
 *   _peek: (cacheKey: string) => ({ value: ReadonlyArray<KnowledgeEntry>, expires_at: number, swr_at: number, source: 'real' | 'mock', refreshed_at: string, refreshing: Promise<void> | null } | null),
 *   _keys: () => string[],
 *   resetForTests: () => void,
 *   _config: () => object,
 * }}
 */
export function createEcosystemKnowledgeProvider(opts = {}) {
  const realProvider = opts.realProvider || createRealZhihuKnowledgeProvider();
  const mockFetch = opts.mockFetch || defaultMockFetchKnowledge;
  const ttlMs = typeof opts.ttlMs === 'number' && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS;
  const swrMs = typeof opts.swrMs === 'number' && opts.swrMs > 0 ? opts.swrMs : DEFAULT_SWR_MS;
  const now = opts.now || (() => Date.now());

  /**
   * The cache. KEY = pair-key (see buildKnowledgeCacheKey).
   * VALUE = { value, expires_at, swr_at, source, refreshed_at, refreshing }.
   *
   * @type {Map<string, {
   *   value: ReadonlyArray<KnowledgeEntry>,
   *   expires_at: number,
   *   swr_at: number,
   *   source: 'real' | 'mock',
   *   refreshed_at: number,
   *   refreshing: Promise<void> | null,
   * }>}
   */
  const cache = new Map();

  /**
   * Decorate an entry list into a public response. Always carries
   * `provisional: true` and the surface disclaimer.
   *
   * @param {ReadonlyArray<KnowledgeEntry>} entries
   * @param {{ source: 'real' | 'mock', refreshed_at: number }} meta
   * @param {{ cache_key: string, cached: boolean, degraded: boolean, degradation: { code: string, message: string } | null }} decorations
   * @returns {EcosystemKnowledgeResponse}
   */
  function buildResponse(entries, meta, decorations) {
    return Object.freeze({
      knowledge: clipEntries(entries, entries.length),
      provisional: true,
      disclaimer: SURFACE_DISCLAIMER,
      source: meta.source,
      cached: decorations.cached,
      fetched_at: new Date(meta.refreshed_at).toISOString(),
      cache_key: JSON.parse(decorations.cache_key),
      degraded: decorations.degraded,
      degradation: decorations.degradation,
    });
  }

  /**
   * Run a fetch via the real provider. Returns
   * `{ entries, source: 'real' }` on success. Returns
   * `{ entries: null, source: 'mock', degradation }` on failure —
   * the caller decides whether to fall back.
   *
   * @returns {Promise<
   *   | { ok: true, entries: ReadonlyArray<KnowledgeEntry>, source: 'real' }
   *   | { ok: false, degradation: { code: string, message: string } }
   * >}
   */
  async function fetchFromReal() {
    if (!realProvider.isConfigured()) {
      return {
        ok: false,
        degradation: {
          code: 'unconfigured',
          message: 'Real knowledge provider is not configured; mock fallback engaged.',
        },
      };
    }
    try {
      const entries = await realProvider.fetchKnowledge({});
      return { ok: true, entries, source: 'real' };
    } catch (err) {
      const code = err && err.code ? String(err.code) : 'upstream_failure';
      const message = err && err.message ? String(err.message) : 'Real provider failed.';
      return {
        ok: false,
        degradation: { code, message },
      };
    }
  }

  /**
   * Fetch the mock. The mock never throws under normal use; we wrap
   * the call in a try/catch anyway so a test that swaps a throwing
   * mock surfaces a typed error rather than crashing the orchestrator.
   *
   * @returns {Promise<
   *   | { ok: true, entries: ReadonlyArray<KnowledgeEntry> }
   *   | { ok: false, degradation: { code: string, message: string } }
   * >}
   */
  async function fetchFromMock() {
    try {
      const entries = mockFetch();
      if (!Array.isArray(entries)) {
        return {
          ok: false,
          degradation: { code: 'mock_shape_mismatch', message: 'Mock returned non-array.' },
        };
      }
      return { ok: true, entries };
    } catch (err) {
      const code = err && err.code ? String(err.code) : 'mock_failure';
      const message = err && err.message ? String(err.message) : 'Mock failed.';
      return { ok: false, degradation: { code, message } };
    }
  }

  /**
   * Background refresh on a cache row. Concurrent callers share the
   * same Promise so we never spam the upstream while a refresh is
   * already in flight.
   *
   * @param {string} cacheKey
   * @returns {Promise<void>}
   */
  function backgroundRefresh(cacheKey) {
    const row = cache.get(cacheKey);
    if (row && row.refreshing) return row.refreshing;
    const promise = (async () => {
      try {
        const real = await fetchFromReal();
        if (real.ok) {
          cache.set(cacheKey, {
            value: Object.freeze(real.entries.map((e) => Object.freeze({
              id: e.id,
              title: e.title,
              summary: e.summary,
              source: e.source,
              url: e.url,
              related_topics: Object.freeze(e.related_topics.slice()),
              disclaimer: e.disclaimer || SURFACE_DISCLAIMER,
            }))),
            expires_at: now() + ttlMs,
            swr_at: now() + swrMs,
            source: 'real',
            refreshed_at: now(),
            refreshing: null,
          });
        } else {
          // Real degraded — leave the row in place but flip source to
          // mock so the next fresh read does not pretend the stale row
          // is real. We do NOT mutate `value` so a /backgroundRefresh/
          // still in flight cannot corrupt a reader's snapshot.
          if (row) {
            const mock = await fetchFromMock();
            if (mock.ok) {
              cache.set(cacheKey, {
                value: Object.freeze(mock.entries.map((e) => Object.freeze({
                  id: e.id,
                  title: e.title,
                  summary: e.summary,
                  source: e.source,
                  url: e.url,
                  related_topics: Object.freeze(e.related_topics.slice()),
                  disclaimer: e.disclaimer || SURFACE_DISCLAIMER,
                }))),
                expires_at: now() + ttlMs,
                swr_at: now() + swrMs,
                source: 'mock',
                refreshed_at: now(),
                refreshing: null,
              });
            } else if (row) {
              row.refreshing = null;
            }
          }
        }
      } catch (err) {
        if (row) row.refreshing = null;
      }
    })();
    if (row) row.refreshing = promise;
    return promise;
  }

  /**
   * Public entry point. Resolves with a fully-decorated response;
   * never throws under normal use (validation errors are caught by
   * the route layer and turned into 400).
   *
   * @param {{
   *   story_version_uuid: string,
   *   community_profile_version: string,
   *   topic_id?: string | null,
   *   limit?: number,
   *   force?: boolean,
   * }} input
   * @returns {Promise<EcosystemKnowledgeResponse>}
   */
  async function match(input) {
    if (!input || typeof input !== 'object') {
      throw new ValidationError('match: input required');
    }
    if (typeof input.story_version_uuid !== 'string' || !input.story_version_uuid) {
      throw new ValidationError('match: story_version_uuid required');
    }
    if (typeof input.community_profile_version !== 'string' || !input.community_profile_version) {
      throw new ValidationError('match: community_profile_version required');
    }
    const cacheKey = buildKnowledgeCacheKey({
      story_version_uuid: input.story_version_uuid,
      community_profile_version: input.community_profile_version,
      topic_id: typeof input.topic_id === 'string' && input.topic_id ? input.topic_id : null,
    });
    const limit = Number.isInteger(input.limit) && input.limit > 0
      ? Math.min(input.limit, 64)
      : DEFAULT_LIMIT;
    const force = input.force === true;

    // Force bypass — drop any matching row.
    if (force) {
      cache.delete(cacheKey);
    }

    // 1) Fresh cache hit.
    const row = cache.get(cacheKey);
    if (row && !force) {
      const age = now() - row.refreshed_at;
      if (age < ttlMs) {
        return buildResponse(
          row.value,
          { source: row.source, refreshed_at: row.refreshed_at },
          { cache_key: cacheKey, cached: true, degraded: false, degradation: null },
        );
      }
      // 2) Stale within SWR — serve stale + background refresh.
      if (age < swrMs) {
        backgroundRefresh(cacheKey);
        return buildResponse(
          row.value,
          { source: row.source, refreshed_at: row.refreshed_at },
          { cache_key: cacheKey, cached: true, degraded: false, degradation: null },
        );
      }
    }

    // 3) No usable cache — try the real provider first, then mock.
    const real = await fetchFromReal();
    if (real.ok) {
      const refreshed = now();
      cache.set(cacheKey, {
        value: Object.freeze(real.entries.map((e) => Object.freeze({
          id: e.id,
          title: e.title,
          summary: e.summary,
          source: e.source,
          url: e.url,
          related_topics: Object.freeze(e.related_topics.slice()),
          disclaimer: e.disclaimer || SURFACE_DISCLAIMER,
        }))),
        expires_at: refreshed + ttlMs,
        swr_at: refreshed + swrMs,
        source: 'real',
        refreshed_at: refreshed,
        refreshing: null,
      });
      return buildResponse(
        real.entries,
        { source: 'real', refreshed_at: refreshed },
        { cache_key: cacheKey, cached: false, degraded: false, degradation: null },
      );
    }
    // Real degraded — fall back to mock. We still record the row so a
    // second call within TTL hits the cache instead of regenerating.
    const mock = await fetchFromMock();
    if (!mock.ok) {
      // Both providers failed — return an empty degraded response so
      // the player is never stranded. The route layer turns this into
      // 200 with `knowledge: []` and `degraded: true`.
      return buildResponse(
        [],
        { source: 'mock', refreshed_at: now() },
        { cache_key: cacheKey, cached: false, degraded: true, degradation: real.degradation },
      );
    }
    const refreshed = now();
    cache.set(cacheKey, {
      value: Object.freeze(mock.entries.map((e) => Object.freeze({
        id: e.id,
        title: e.title,
        summary: e.summary,
        source: e.source,
        url: e.url,
        related_topics: Object.freeze(e.related_topics.slice()),
        disclaimer: e.disclaimer || SURFACE_DISCLAIMER,
      }))),
      expires_at: refreshed + ttlMs,
      swr_at: refreshed + swrMs,
      source: 'mock',
      refreshed_at: refreshed,
      refreshing: null,
    });
    return buildResponse(
      mock.entries,
      { source: 'mock', refreshed_at: refreshed },
      { cache_key: cacheKey, cached: false, degraded: true, degradation: real.degradation },
    );
  }

  return Object.freeze({
    match,
    _peek(cacheKey) {
      const row = cache.get(cacheKey);
      if (!row) return null;
      return {
        value: row.value,
        expires_at: row.expires_at,
        swr_at: row.swr_at,
        source: row.source,
        refreshed_at: new Date(row.refreshed_at).toISOString(),
        refreshing: row.refreshing,
      };
    },
    _keys() {
      return Array.from(cache.keys());
    },
    resetForTests() {
      cache.clear();
    },
    _config() {
      return Object.freeze({
        ttlMs,
        swrMs,
        defaultLimit: DEFAULT_LIMIT,
        surfaceDisclaimer: SURFACE_DISCLAIMER,
        realConfigured: realProvider.isConfigured(),
      });
    },
  });
}

// Re-export the ProviderError so the route layer can use a single
// import path.
export { ProviderError };

export const ECOSYSTEM_KNOWLEDGE_CONFIG = Object.freeze({
  TTL_MS: DEFAULT_TTL_MS,
  SWR_MS: DEFAULT_SWR_MS,
  DEFAULT_LIMIT,
  SURFACE_DISCLAIMER,
});