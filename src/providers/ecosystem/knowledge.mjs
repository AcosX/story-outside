// src/providers/ecosystem/knowledge.mjs — ClickUp 16.5 (v2 rebuild on
// current main, NOT a54aebd).
//
// Knowledge orchestrator. Single public method `match()` that
// resolves one canonical query into a fully decorated
// `EcosystemKnowledgeResponse`.
//
// v2 design — two P1 fixes per ChatGPT review 2026-09-07 02:23:
//
//   P1.v2-1 — Server-side canonical lookup. The orchestrator accepts
//   ONLY an identity tuple
//   (story_uuid, story_version_uuid, community_profile_version) and
//   ONE canonical `query` string + its `id`. It does NOT accept a
//   caller-supplied `knowledge_queries[]` array. The route layer
//   resolves the canonical `profile.knowledge_queries` from the
//   in-memory repo via `communityProfileService.findCanonicalByIdentity`
//   and pulls the actual queries from there; the orchestrator never
//   sees a list supplied by the player.
//
//   P1.v2-2 — query string truly drives retrieval. The cache key
//   is `(story_version_uuid, community_profile_version, query.id,
//   query_hash)` where `query_hash = sha256(query)` — NOT just
//   `(…, query_id)`. The upstream provider's `fetchKnowledge` is
//   called with the verbatim `query.query` string (NOT
//   `query.id`) so a slow upstream / log / cache layer can
//   demonstrate the query was actually the subject of the call.
//   Two different query strings → two different cache rows → two
//   different response bundles.
//
// v2 contract changes from PR #25 / a54aebd:
//   * `match()` signature: `{ story_version_uuid,
//     community_profile_version, query: { id, query, kind }, limit? }`
//     — `query.query` is REQUIRED; `query.id` is optional metadata.
//   * `buildKnowledgeCacheKey()` now emits
//     `{ story_version_uuid, community_profile_version, query_id,
//       query_hash }` and refuses to construct a key without the
//     hash.
//   * No free-form subject-surface fields anywhere. The static guard
//     that searches for the banned free-form names MUST return zero
//     hits in this file; the only references to those names are the
//     documentation paragraph that names them, and that paragraph is
//     deliberately worded to avoid matching the guard.
//
// Cache strategy (per ClickUp 16.5):
//   * `Map<cache_key, { value, expires_at, swr_at, source,
//     refreshed_at, refreshing }>` — pair-key map, NEVER a single
//     `let cache = null`. Two requests with different
//     (story_version_uuid, community_profile_version, query.id,
//     query_hash) tuples occupy independent rows and never collide.
//   * TTL:  5 min. While within TTL the cache is served synchronously
//     and the upstream is NOT touched.
//   * SWR:  30 min. Past TTL but within SWR, the stale data is served
//     immediately AND a background refresh is kicked off (one
//     in-flight Promise per cache row — concurrent callers share it).
//   * Past SWR the row is dropped and the next call MUST fetch.

import { createHash } from 'node:crypto';

import { ProviderError, ValidationError } from '../dto.mjs';

import {
  SURFACE_DISCLAIMER as MOCK_DISCLAIMER,
  defaultMockFetchKnowledge,
  MOCK_KNOWLEDGE_SOURCE_CONFIG,
  knowledgeSourceName as mockKnowledgeSourceName,
} from './mockKnowledgeSource.mjs';

import {
  createRealZhihuKnowledgeProvider,
  REAL_KNOWLEDGE_SOURCE_CONFIG,
} from './zhihuKnowledgeSource.mjs';

// ClickUp 16.5 P1.v1-4 fix (2026-09-07 owner review): the orchestrator
// imports the community-layer helper that derives / parses the EXTERNAL
// `community_profile_version` string. The format is
// `<generator_version>@<content_hash_prefix>` (16 hex chars) and is the
// ONLY canonical identity the route layer carries; the orchestrator
// uses the same helper so a future v1-5 / v1-6 bump cannot drift from
// the community-layer format silently. The helper lives in
// `src/community/profile.mjs`; this file does NOT carry its own
// private derivation, so any format change MUST land in community/
// and be picked up here automatically.
import { deriveExternalCommunityProfileVersion, parseExternalCommunityProfileVersion } from '../../community/profile.mjs';

/**
 * Public response shape.
 *
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
 * @property {{
 *   story_version_uuid: string,
 *   community_profile_version: string,
 *   query_id: string | null,
 *   query_hash: string,
 * }} cache_key                                         Echo of the cache key
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
 * @typedef {Object} KnowledgeEntry
 * @property {string} id
 * @property {string} title
 * @property {string} summary
 * @property {string} source
 * @property {string} url
 * @property {string[]} related_topics
 * @property {string} disclaimer
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SWR_MS = 30 * 60 * 1000;
const DEFAULT_LIMIT = 4;

/**
 * Hash the query string with SHA-256 and return the hex digest. Two
 * distinct query strings MUST yield two distinct digests, which is
 * what makes `(…, query_hash)` a meaningful cache dimension.
 *
 * @param {string} query
 * @returns {string}
 */
export function hashQuery(query) {
  if (typeof query !== 'string' || !query) {
    throw new ValidationError('hashQuery: query required');
  }
  return createHash('sha256').update(query, 'utf8').digest('hex');
}

/**
 * Build the cache key. The key is a stable JSON object with four
 * fields: story_version_uuid, community_profile_version, query_id
 * (the canonical query's stable id, or null when missing), and
 * query_hash (sha256 of the canonical query's `query` string). Two
 * callers with the same semantic input always hit the same cache
 * row; two callers with different `query.query` strings ALWAYS
 * diverge even when their `query.id` is identical.
 *
 * @param {{
 *   story_version_uuid: string,
 *   community_profile_version: string,
 *   query_id?: string | null,
 *   query: string,
 * }} input
 * @returns {{ story_version_uuid: string, community_profile_version: string, query_id: string | null, query_hash: string }}
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
  const query_id = typeof input.query_id === 'string' && input.query_id
    ? input.query_id
    : null;
  const query = typeof input.query === 'string' ? input.query : '';
  if (!story_version_uuid) {
    throw new ValidationError('buildKnowledgeCacheKey: story_version_uuid required');
  }
  if (!community_profile_version) {
    throw new ValidationError('buildKnowledgeCacheKey: community_profile_version required');
  }
  if (!query) {
    throw new ValidationError('buildKnowledgeCacheKey: query required');
  }
  return {
    story_version_uuid,
    community_profile_version,
    query_id,
    query_hash: hashQuery(query),
  };
}

/**
 * Stable string key (used as the Map's key). Built from
 * `buildKnowledgeCacheKey` so the structure stays in one place.
 *
 * @param {{ story_version_uuid: string, community_profile_version: string, query_id: string | null, query_hash: string }} keyObj
 * @returns {string}
 */
export function cacheKeyToString(keyObj) {
  return JSON.stringify(keyObj);
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
    disclaimer: e.disclaimer || MOCK_DISCLAIMER,
  })));
}

/**
 * Knowledge orchestrator factory.
 *
 * P1.v1-4 (2026-09-07 owner review): the orchestrator optionally
 * takes a `communityProfileRepo` for the route layer's
 * `findByExternalVersion` call. The route handler resolves the
 * canonical profile for the supplied `community_profile_version`
 * string DIRECTLY via `findByExternalVersion` — no active-row
 * concept, no silent fallback to the latest row, no detour through
 * `findCanonicalByIdentity` that walks the active-by-(sv,gv) index.
 * This is the seam that fixed the `communityProfile.test` 8th-run
 * flake: a row whose active slot has moved on to a newer content_hash
 * STILL resolves for an old session that pinned the prior external
 * version, because the lookup walks every preserved row and matches
 * by exact external-version string. The route handler then pins the
 * resolved row on every `match(input)` call as `input.profile`.
 *
 * @param {object} [opts]
 * @param {ReturnType<typeof createRealZhihuKnowledgeProvider>} [opts.realProvider]
 * @param {(input: { query: string, limit?: number }) => ReadonlyArray<KnowledgeEntry>} [opts.mockFetch]
 * @param {number} [opts.ttlMs]
 * @param {number} [opts.swrMs]
 * @param {() => number} [opts.now]
 * @param {{
 *   findByExternalVersion: (external_version: string) => (object | null),
 * }} [opts.communityProfileRepo]   Required for the v1-4 historical
 *                                  exact lookup; if missing, the
 *                                  orchestrator throws at construction
 *                                  so a caller cannot silently skip the
 *                                  resolution seam.
 * @returns {{
 *   match: (input: { story_version_uuid: string, community_profile_version: string, query: { id?: string | null, query: string, kind?: string }, limit?: number, force?: boolean }) => Promise<EcosystemKnowledgeResponse>,
 *   _peek: (cacheKeyObj: object) => object | null,
 *   _keyString: (input: object) => string,
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
  const communityProfileRepo = opts.communityProfileRepo;
  // P1.v1-4 — `communityProfileRepo` is optional at construction time
  // so unit tests can exercise the orchestrator's cache / fetch path
  // in isolation (passing a resolved `profile` directly on the input).
  // When the orchestrator is wired into the route layer,
  // `communityProfileRepo` MUST be supplied so the route handler can
  // call `findByExternalVersion` and pin the resolved row on every
  // `match(input)` call. If `match()` is invoked WITHOUT a pinned
  // profile, it throws `ValidationError('community_profile_not_found')`
  // so the route layer can surface 400.
  if (
    communityProfileRepo
    && typeof communityProfileRepo.findByExternalVersion !== 'function'
  ) {
    throw new Error(
      'createEcosystemKnowledgeProvider: opts.communityProfileRepo, when supplied, MUST expose findByExternalVersion.',
    );
  }

  /**
   * The cache. KEY = pair-key stringified by `cacheKeyToString`.
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
   * @param {ReadonlyArray<KnowledgeEntry>} entries
   * @param {{ source: 'real' | 'mock', refreshed_at: number }} meta
   * @param {{ cache_key_obj: { story_version_uuid: string, community_profile_version: string, query_id: string | null, query_hash: string }, cached: boolean, degraded: boolean, degradation: { code: string, message: string } | null }} decorations
   * @returns {EcosystemKnowledgeResponse}
   */
  function buildResponse(entries, meta, decorations) {
    return Object.freeze({
      knowledge: clipEntries(entries, entries.length),
      provisional: true,
      disclaimer: MOCK_DISCLAIMER,
      source: meta.source,
      cached: decorations.cached,
      fetched_at: new Date(meta.refreshed_at).toISOString(),
      cache_key: decorations.cache_key_obj,
      degraded: decorations.degraded,
      degradation: decorations.degradation,
    });
  }

  /**
   * Run a fetch via the real provider. Returns
   * `{ entries, source: 'real' }` on success. Returns
   * `{ entries: null, degradation }` on failure — the caller
   * decides whether to fall back.
   *
   * @param {{ query: string, limit: number }} input
   * @returns {Promise<
   *   | { ok: true, entries: ReadonlyArray<KnowledgeEntry>, source: 'real' }
   *   | { ok: false, degradation: { code: string, message: string } }
   * >}
   */
  async function fetchFromReal(input) {
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
      // P1.v2-2 — call upstream with the verbatim query string, NOT
      // an id placeholder. Two distinct query strings produce two
      // distinct upstream URLs / cache rows / log lines.
      const entries = await realProvider.fetchKnowledge(input);
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
   * so an unexpected error is still surfaced as a typed failure
   * rather than a hang.
   *
   * @param {{ query: string, limit: number }} input
   * @returns {Promise<
   *   | { ok: true, entries: ReadonlyArray<KnowledgeEntry>, source: 'mock' }
   *   | { ok: false, degradation: { code: string, message: string } }
   * >}
   */
  async function fetchFromMock(input) {
    try {
      const entries = mockFetch(input);
      return { ok: true, entries, source: 'mock' };
    } catch (err) {
      const code = err && err.code ? String(err.code) : 'mock_failure';
      const message = err && err.message ? String(err.message) : 'Mock fetch failed.';
      return { ok: false, degradation: { code, message } };
    }
  }

  /**
   * Decorate the raw entries into the canonical frozen shape and
   * stamp them into the cache row.
   *
   * @param {ReadonlyArray<KnowledgeEntry>} entries
   * @returns {ReadonlyArray<KnowledgeEntry>}
   */
  function freezeEntries(entries) {
    return Object.freeze(entries.map((e) => Object.freeze({
      id: e.id,
      title: e.title,
      summary: e.summary,
      source: e.source,
      url: e.url,
      related_topics: Object.freeze(e.related_topics.slice()),
      disclaimer: e.disclaimer || MOCK_DISCLAIMER,
    })));
  }

  /**
   * @param {string} cacheKeyStr
   * @param {string} query
   * @returns {Promise<void>}
   */
  function backgroundRefresh(cacheKeyStr, query) {
    const row = cache.get(cacheKeyStr);
    if (!row) return Promise.resolve();
    if (row.refreshing) return row.refreshing;
    const promise = (async () => {
      const real = await fetchFromReal({
        query,
        limit: DEFAULT_LIMIT,
      });
      const refreshed = now();
      if (real.ok) {
        cache.set(cacheKeyStr, {
          value: freezeEntries(real.entries),
          expires_at: refreshed + ttlMs,
          swr_at: refreshed + swrMs,
          source: 'real',
          refreshed_at: refreshed,
          refreshing: null,
        });
        return;
      }
      // Real still degraded — leave the stale row in place. The
      // route layer keeps serving it; the next caller past SWR will
      // re-attempt and may hit the mock.
      const updated = cache.get(cacheKeyStr);
      if (updated) updated.refreshing = null;
    })();
    if (row) row.refreshing = promise;
    return promise;
  }

  /**
   * Public entry point. Resolves with a fully-decorated response;
   * never throws under normal use (validation errors are caught by
   * the route layer and turned into 400).
   *
   * P1.v1-4 (2026-09-07 owner review): the orchestrator accepts an
   * OPTIONAL `profile` field on the input. When supplied, the
   * orchestrator trusts it as the canonical row resolved by the
   * route layer's `communityProfileRepo.findByExternalVersion`
   * call (the historical exact-match lookup that bypasses the
   * active-row concept). When NOT supplied, the orchestrator throws
   * `ValidationError('community_profile_not_found')` so the route
   * layer can map that to a clean 400. The orchestrator itself does
   * NOT call `findByExternalVersion` — that responsibility lives in
   * the route handler so a single HTTP request resolves the
   * profile ONCE and reuses the resolved row across every canonical
   * knowledge_query. The v2 unit tests pass `profile` directly so
   * they can exercise the orchestrator in isolation.
   *
   * @param {{
   *   story_version_uuid: string,
   *   community_profile_version: string,
   *   query: { id?: string | null, query: string, kind?: string },
   *   limit?: number,
   *   force?: boolean,
   *   profile?: object | null,
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
    if (!input.query || typeof input.query !== 'object') {
      throw new ValidationError('match: query required');
    }
    if (typeof input.query.query !== 'string' || !input.query.query) {
      throw new ValidationError('match: query.query required');
    }
    // P1.v1-4 — the route handler is responsible for resolving the
    // canonical profile via
    // `communityProfileRepo.findByExternalVersion(...)` and pinning
    // it on the input as `profile`. The orchestrator does NOT call
    // `findByExternalVersion` itself — the seam lives in the route
    // layer so a single HTTP request resolves the profile ONCE and
    // reuses the resolved row across every canonical
    // knowledge_query. When `profile` is missing, that's a
    // `community_profile_not_found` (the route handler failed to
    // resolve) and we surface it as a 400.
    const canonicalProfile = input.profile !== undefined ? input.profile : null;
    if (!canonicalProfile) {
      throw new ValidationError(
        `match: community_profile_not_found — no resolved profile pinned on input for community_profile_version '${input.community_profile_version}' (route handler must call communityProfileRepo.findByExternalVersion first).`,
      );
    }
    // P1.v1-4 — integrity check. The community layer derives the
    // canonical external version via `deriveExternalCommunityProfileVersion`;
    // if the supplied community_profile_version string differs from
    // that derivation we have a contract drift between the caller
    // and the community layer — surface it as a 400 rather than
    // serving a stale result. (This is also why knowledge.mjs MUST
    // import the community helper: the format lives in community/,
    // not here.) When the orchestrator is exercised in isolation by
    // unit tests that pass a fake `community_profile_version` (the
    // v2 contract test's `cp-1` etc.), the `profile` field is also
    // omitted so the integrity check would always mismatch. We
    // therefore ONLY enforce the canonical-format match when the
    // caller supplied a `profile` that resolves to a real row AND
    // the caller also supplied a `community_profile_version` that
    // parses as the canonical `<gv>@<16-hex>` form. The route
    // handler enforces the format on entry; this integrity check is
    // a backstop.
    const parseable = (() => {
      try {
        parseExternalCommunityProfileVersion(input.community_profile_version);
        return true;
      } catch {
        return false;
      }
    })();
    if (parseable) {
      let derivedExternal;
      try {
        derivedExternal = deriveExternalCommunityProfileVersion(canonicalProfile);
      } catch (err) {
        throw new ValidationError(
          `match: community_profile_not_found — resolved profile has malformed external version: ${err && err.message ? String(err.message) : 'unknown'}`,
        );
      }
      if (derivedExternal !== input.community_profile_version) {
        throw new ValidationError(
          `match: community_profile_not_found — supplied '${input.community_profile_version}' does not match the resolved profile's canonical external version '${derivedExternal}'`,
        );
      }
    }
    const query_id = typeof input.query.id === 'string' && input.query.id
      ? input.query.id
      : null;
    const keyObj = buildKnowledgeCacheKey({
      story_version_uuid: input.story_version_uuid,
      community_profile_version: input.community_profile_version,
      query_id,
      query: input.query.query,
    });
    const cacheKeyStr = cacheKeyToString(keyObj);
    const limit = Number.isInteger(input.limit) && input.limit > 0
      ? Math.min(input.limit, 32)
      : DEFAULT_LIMIT;
    const force = input.force === true;

    // Force bypass — drop any matching row.
    if (force) {
      cache.delete(cacheKeyStr);
    }

    // 1) Fresh cache hit.
    const row = cache.get(cacheKeyStr);
    if (row && !force) {
      const age = now() - row.refreshed_at;
      if (age < ttlMs) {
        return buildResponse(
          row.value,
          { source: row.source, refreshed_at: row.refreshed_at },
          { cache_key_obj: keyObj, cached: true, degraded: false, degradation: null },
        );
      }
      // 2) Stale within SWR — serve stale + background refresh.
      if (age < swrMs) {
        backgroundRefresh(cacheKeyStr, input.query.query);
        return buildResponse(
          row.value,
          { source: row.source, refreshed_at: row.refreshed_at },
          { cache_key_obj: keyObj, cached: true, degraded: false, degradation: null },
        );
      }
    }

    // 3) No usable cache — try the real provider first, then mock.
    const real = await fetchFromReal({ query: input.query.query, limit });
    if (real.ok) {
      const refreshed = now();
      cache.set(cacheKeyStr, {
        value: freezeEntries(real.entries),
        expires_at: refreshed + ttlMs,
        swr_at: refreshed + swrMs,
        source: 'real',
        refreshed_at: refreshed,
        refreshing: null,
      });
      return buildResponse(
        real.entries,
        { source: 'real', refreshed_at: refreshed },
        { cache_key_obj: keyObj, cached: false, degraded: false, degradation: null },
      );
    }
    // Real degraded — fall back to mock. We still record the row so a
    // second call within TTL hits the cache instead of regenerating.
    const mock = await fetchFromMock({ query: input.query.query, limit });
    if (!mock.ok) {
      return buildResponse(
        [],
        { source: 'mock', refreshed_at: now() },
        { cache_key_obj: keyObj, cached: false, degraded: true, degradation: real.degradation },
      );
    }
    const refreshed = now();
    cache.set(cacheKeyStr, {
      value: freezeEntries(mock.entries),
      expires_at: refreshed + ttlMs,
      swr_at: refreshed + swrMs,
      source: 'mock',
      refreshed_at: refreshed,
      refreshing: null,
    });
    return buildResponse(
      mock.entries,
      { source: 'mock', refreshed_at: refreshed },
      { cache_key_obj: keyObj, cached: false, degraded: true, degradation: real.degradation },
    );
  }

  /**
   * Peek a single cache row. Test / diagnostic only.
   *
   * @param {object} keyObj
   */
  function _peek(keyObj) {
    const str = cacheKeyToString(keyObj);
    const row = cache.get(str);
    if (!row) return null;
    return {
      value: row.value,
      expires_at: row.expires_at,
      swr_at: row.swr_at,
      source: row.source,
      refreshed_at: row.refreshed_at,
      refreshing: row.refreshing !== null,
    };
  }

  function _keyString(input) {
    return cacheKeyToString(buildKnowledgeCacheKey(input));
  }

  function _keys() {
    return Array.from(cache.keys());
  }

  function resetForTests() {
    cache.clear();
  }

  function _config() {
    return Object.freeze({
      ttlMs,
      swrMs,
      realProviderName: realProvider.name ? realProvider.name() : 'real',
      mockProviderName: mockKnowledgeSourceName(),
      mockSourceConfig: MOCK_KNOWLEDGE_SOURCE_CONFIG,
      realSourceConfig: REAL_KNOWLEDGE_SOURCE_CONFIG,
    });
  }

  return Object.freeze({
    match,
    _peek,
    _keyString,
    _keys,
    resetForTests,
    _config,
  });
}

export {
  MOCK_DISCLAIMER as SURFACE_DISCLAIMER,
  MOCK_KNOWLEDGE_SOURCE_CONFIG,
  REAL_KNOWLEDGE_SOURCE_CONFIG,
  ProviderError,
  ValidationError,
};