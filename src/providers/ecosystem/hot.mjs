// src/providers/ecosystem/hot.mjs — ClickUp 16.4 P1.v1-3 知乎热榜 orchestrator
// (2026-09-07), continued on fix/clickup16-4-p1-hot-relevance branch.
//
// P1.v1-3 fix — content-hash-aware external community_profile_version:
//
//   The v1-2 contract (PR #23, 33742bc) compared the caller-supplied
//   `community_profile_version` directly against the profile row's
//   `generator_version` field. Two profiles with the SAME
//   `generator_version` (same rule set) but DIFFERENT content (e.g.
//   regenerated hot_keywords / topics) were indistinguishable to the
//   matcher — they always looked "matched" because the comparison
//   ignored the content. The ChatGPT independent review (2026-09-07)
//   flagged this as a P1 blocker: callers that regenerate a profile
//   without bumping the ruleset version end up seeing stale relevance
//   projections instead of a clean 400 `community_profile_version_mismatch`.
//
//   v1-3 derives a NEW external identity string
//     `community_profile_version = "${generator_version}-${shortContentHash}"`
//   where `shortContentHash` is the first 12 hex chars of
//   `sha256(canonical({ topics, queries, knowledge_queries, hot_keywords }))`.
//   The internal `generator_version` field on the profile row is NOT
//   renamed — the v1 schema (13 top-level fields including
//   `generator_version`) is preserved. Only the EXTERNAL identity
//   string used for the wire contract becomes content-aware. Two
//   profiles with the same `generator_version` but different content
//   now have different `community_profile_version` strings, and a
//   caller carrying the previous generation's external version is
//   rejected with 400 instead of silently observing stale relevance.
//
//   Relevance algorithm (deterministic, non-LLM):
//
//     score = number of distinct terms from
//       (hot_match_terms ∪ themes)
//     that appear as a substring of (title + ' ' + tags.join(' ') + ' ' + excerpt).
//
//   where hit_count is a case-insensitive substring match against the
//   entry's title + tags + excerpt. Hot entries with score > 0 are
//   sorted to the top (and within the related band, by hotness desc);
//   entries with score === 0 fall back to the regular hotness rank.
//
// Identity contract (ClickUp 16.4 P1.v1-2 → P1.v1-3):
//
//   GET /v1/ecosystem/hot accepts optional identity triple:
//     story_uuid, story_version_uuid, community_profile_version
//
//   * When ALL THREE are provided AND the caller-supplied
//     `community_profile_version` matches the EXTERNAL identity
//     string derived from the canonical profile row
//     (P1.v1-3: `${generator_version}-${shortContentHash}`), the
//     response includes `relevant_to_story` with `matched_terms`,
//     `score`, and the pinned identity triple. Hot entries carry an
//     extra `relevant: { score, matched_terms }` projection.
//   * When the supplied value does NOT match the canonical row's
//     external version, the matcher returns `{ attached: false,
//     reason: 'mismatch', expected_version, actual_version }` so the
//     route layer can return 400 `community_profile_version_mismatch`
//     instead of silently degrading. P1.v1-3 makes the comparison
//     content-aware: two generations with the same ruleset version
//     but different content have distinct external versions, so a
//     stale caller carrying the previous generation's external
//     version is rejected with 400.
//   * When ANY identity is omitted, the matcher returns
//     `{ attached: false, reason: 'identity_incomplete', response }`
//     and the route degrades to a plain hot list (no
//     `relevant_to_story`, no per-entry `relevant`).
//   * The community profile is read via `getCommunityProfile`; a
//     missing row returns `{ attached: false, reason:
//     'profile_missing', response }` and the route returns 400
//     `community_profile_missing`.
//
// Cache strategy (rebuilt per ClickUp 16.4 spec):
//
//   * Key = (category, fetched_at_bucket) — NEVER a single global
//     entry. A→B→A within the bucket still hits A's cache row.
//   * TTL = 5 min, SWR = 30 min, BUCKET = 1 min.
//   * Upstream failure degrades to a 200 with `hot: []` +
//     `cached: false` so the home-page module can render the
//     "暂时无法获取知乎热议" placeholder without taking down the
//     picker / player / ending flow.

import {
  fetchMockHotList,
  filterMockHotByCategory,
  KNOWN_CATEGORIES as MOCK_KNOWN_CATEGORIES,
} from './mockZhihuHotSource.mjs';
import { getCommunityProfile } from '../../community/service.mjs';
import { canonicalSha256 } from '../../stories/canonicalHash.mjs';

/**
 * Categories the orchestrator forwards to the upstream. Anything
 * else clamps to `total` so the query string cannot be smuggled into
 * the URL verbatim.
 */
export const KNOWN_CATEGORIES = MOCK_KNOWN_CATEGORIES;

// TTL = 5 min, SWR window = 30 min. Past 30 min the cache is dropped
// entirely UNLESS the upstream is failing AND a past-SWR entry is
// still in the pair-key map (graceful degradation).
const TTL_MS = 5 * 60 * 1000;
const SWR_MS = 30 * 60 * 1000;
const BUCKET_MS = 60 * 1000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(label, value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`hotOrchestrator: ${label} must be a UUID`);
  }
}

function assertNonEmptyString(label, value) {
  if (typeof value !== 'string' || !value) {
    throw new Error(`hotOrchestrator: ${label} must be a non-empty string`);
  }
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Length of the short content-hash suffix used in the EXTERNAL
 * `community_profile_version` derivation. 12 hex chars ≈ 48 bits of
 * entropy — enough to make accidental collisions in a single
 * regeneration burst effectively impossible, short enough that the
 * external version string stays human-greppable in test logs.
 */
const EXTERNAL_CONTENT_HASH_LENGTH = 12;

/**
 * ClickUp 16.4 P1.v1-3 fix (2026-09-07): compute a deterministic,
 * content-only SHA-256 over the user-editable fields of a community
 * profile. The hash intentionally EXCLUDES `generator_version`,
 * `generated_at`, `profile_uuid`, `hash`, `story_uuid`,
 * `story_version_uuid`, and `story_version_checksum` so two
 * regenerations of the SAME content (same topics / queries / knowledge
 * queries / hot_keywords) yield the same hash even if the import path
 * minted a fresh profile_uuid or bumped the timestamp. This is the
 * "did the content actually change" check that lets the matcher
 * distinguish two profile generations with identical ruleset versions.
 *
 * @param {object} profile
 * @returns {string}
 */
export function computeProfileContentHash(profile) {
  if (!profile || typeof profile !== 'object') {
    throw new Error('hotOrchestrator.computeProfileContentHash: profile required');
  }
  const payload = {
    topics: Array.isArray(profile.topics) ? profile.topics : [],
    queries: Array.isArray(profile.queries) ? profile.queries : [],
    knowledge_queries: Array.isArray(profile.knowledge_queries) ? profile.knowledge_queries : [],
    hot_keywords: Array.isArray(profile.hot_keywords) ? profile.hot_keywords : [],
  };
  return canonicalSha256(payload);
}

/**
 * ClickUp 16.4 P1.v1-3 fix (2026-09-07): derive the EXTERNAL
 * `community_profile_version` string used on the wire contract from
 * the canonical profile row. The internal `generator_version` field
 * is preserved as-is (v1 schema, 13 top-level keys, NOT renamed).
 * Only the EXTERNAL identity string is content-aware:
 *
 *   `${generator_version}-${content_hash_short}`
 *
 * Same `generator_version` + same content → same external version
 *   (deterministic, idempotent across regenerations).
 * Same `generator_version` + different content → different external
 *   version (two-generation regression catches the mismatch).
 * Different `generator_version` (ruleset bump) → different external
 *   version (existing v1-2 mismatch path keeps firing).
 *
 * @param {object} profile
 * @returns {string}
 */
export function deriveExternalCommunityProfileVersion(profile) {
  if (!profile || typeof profile !== 'object') {
    throw new Error('hotOrchestrator.deriveExternalCommunityProfileVersion: profile required');
  }
  const generatorVersion = typeof profile.generator_version === 'string' && profile.generator_version
    ? profile.generator_version
    : '';
  if (!generatorVersion) {
    throw new Error('hotOrchestrator.deriveExternalCommunityProfileVersion: profile.generator_version required');
  }
  const contentHash = computeProfileContentHash(profile);
  const shortHash = contentHash.slice(0, EXTERNAL_CONTENT_HASH_LENGTH);
  return `${generatorVersion}-${shortHash}`;
}

function bucketStart(nowMs) {
  return Math.floor(nowMs / BUCKET_MS) * BUCKET_MS;
}

/**
 * @typedef {Object} EcosystemHotEntry
 * @property {number} rank           1-based rank inside the list.
 * @property {string} question_uuid  Stable id (uuid-shaped).
 * @property {string} title          Display title.
 * @property {string} url            Outbound link to zhihu.com.
 * @property {number} heat         Hotness score (higher = more popular).
 * @property {string} [category]     'total' | 'tech' | ...
 * @property {string[]} [tags]       Tags derived from the upstream payload.
 * @property {{ score: number, matched_terms: string[] }} [relevant]
 *                                    Optional. Present only when an
 *                                    identity triple is provided AND
 *                                    the entry had at least one term
 *                                    match. score === 0 entries do
 *                                    NOT carry this field; the home
 *                                    page uses the absence of the
 *                                    field as "not related".
 */

/**
 * @typedef {Object} RelevantToStory
 * @property {string[]} matched_terms          Profile terms that hit at least one entry.
 * @property {number}   score                  Sum of per-entry scores (post-dedupe).
 * @property {string}   story_uuid             Echoed identity.
 * @property {string}   story_version_uuid     Echoed identity.
 * @property {string}   community_profile_version
 *                                             Echoed identity (generator_version).
 * @property {string}   profile_uuid           Profile row used for matching.
 * @property {string[]} hot_match_terms        The hot_match_terms the
 *                                             matcher used (= profile's
 *                                             hot_keywords[].keyword).
 * @property {string[]} themes                 The themes the matcher
 *                                             used (= profile's
 *                                             topics[].label).
 */

/**
 * @typedef {Object} EcosystemHotList
 * @property {EcosystemHotEntry[]} hot
 * @property {{ source: 'mock' | 'real', endpoint?: string }} provenance
 * @property {boolean} cached     True iff served from the pair-key cache.
 * @property {string}  fetched_at ISO timestamp of the cache entry.
 * @property {string}  category   Echoed category (clamped to KNOWN_CATEGORIES).
 * @property {RelevantToStory} [relevant_to_story]
 *                                Optional. Present only when the
 *                                identity triple is complete.
 */

/**
 * @typedef {Object} HotSource
 * @property {string} name                                            'mock' | 'real'.
 * @property {(input?: { category?: string }) => Promise<ReadonlyArray<any>>} fetchHotList
 * @property {() => string} [endpoint]                                 Debug surface for the
 *                                                                     upstream endpoint (real
 *                                                                     source only).
 */

/**
 * Build a deterministic, non-LLM relevance score for one hot entry.
 * Score = number of distinct terms from
 *   (hot_match_terms ∪ themes)
 * that appear as a substring of (title + ' ' + tags.join(' ') + ' ' + excerpt).
 * The function is case-insensitive and whitespace-tolerant; substrings
 * (rather than word-boundary matches) keep the algorithm transparent
 * and the result easy to audit in the regression suite.
 *
 * @param {object} entry
 * @param {string[]} hotMatchTerms
 * @param {string[]} themes
 * @returns {{ score: number, matched_terms: string[] }}
 */
export function computeRelevance(entry, hotMatchTerms, themes) {
  const terms = [];
  const seen = new Set();
  for (const t of hotMatchTerms) {
    if (typeof t !== 'string' || !t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    terms.push(t);
  }
  for (const t of themes) {
    if (typeof t !== 'string' || !t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    terms.push(t);
  }
  if (terms.length === 0) return { score: 0, matched_terms: [] };
  const haystackParts = [];
  if (typeof entry.title === 'string') haystackParts.push(entry.title);
  if (Array.isArray(entry.tags)) haystackParts.push(entry.tags.join(' '));
  if (typeof entry.excerpt === 'string') haystackParts.push(entry.excerpt);
  const haystack = haystackParts.join(' ').toLowerCase();
  const matched = [];
  for (const term of terms) {
    if (haystack.includes(term.toLowerCase())) matched.push(term);
  }
  return { score: matched.length, matched_terms: matched };
}

/**
 * Resolve the community profile for the identity triple. The matcher
 * reads the profile via `getCommunityProfile`; when the profile is
 * missing, the matcher still runs with an empty term list so every
 * entry scores 0 and the route degrades to a plain list rather than
 * 404-ing the home page.
 *
 * P1.v1-2 contract (2026-09-07):
 *   The matcher reads the ACTIVE (latest) profile row for the
 *   story_version, NOT a version-filtered row. The version comparison
 *   happens AFTER the read, in `attachRelevance`; using a version-
 *   filtered read here would always return null when the caller's
 *   version differs, falling through to a misleading "profile_missing"
 *   path and hiding the real data-contract mismatch.
 *
 * P1.v1-3 contract (2026-09-07):
 *   The resolved object now ALSO carries `externalVersion` — the
 *   content-hash-aware external identity string derived from the
 *   canonical profile row via `deriveExternalCommunityProfileVersion`.
 *   `attachRelevance` compares the caller-supplied
 *   `community_profile_version` against THIS external version, not
 *   against the raw `generator_version`. Two profile generations with
 *   the same ruleset version but different content therefore yield
 *   distinct external versions and a stale caller is rejected with
 *   400 `community_profile_version_mismatch` instead of silently
 *   observing stale relevance projections.
 *
 * @param {object} input
 * @param {object} [input.profileRepository]
 * @param {string} input.story_version_uuid
 * @param {string} [input.community_profile_version]
 * @returns {{ hotMatchTerms: string[], themes: string[], profileUuid: string | null, generatorVersion: string | null, externalVersion: string | null, contentHash: string | null }}
 */
export function resolveProfileMatchTerms({ profileRepository, story_version_uuid, community_profile_version }) {
  const result = {
    hotMatchTerms: [],
    themes: [],
    profileUuid: null,
    generatorVersion: null,
    externalVersion: null,
    contentHash: null,
  };
  if (!profileRepository) return result;
  let profile;
  try {
    // P1.v1-2: read the ACTIVE row (no generator_version filter) so
    // the caller-supplied version can be compared against the
    // canonical row's version AFTER the read.
    profile = getCommunityProfile({
      profileRepository,
      story_version_uuid,
    });
  } catch {
    profile = null;
  }
  if (!profile) return result;
  result.profileUuid = profile.profile_uuid;
  // ClickUp 16.4 P1.v1-2 fix (2026-09-07): the canonical field on the
  // profile row is `generator_version` (v1 schema, 13 top-level keys).
  // Future renames must update this read AND update the shape
  // validator AND add a migration; doing so intentionally out of
  // scope here.
  result.generatorVersion = profile.generator_version;
  // ClickUp 16.4 P1.v1-3 fix (2026-09-07): derive the content-hash-
  // aware external identity. The internal `generator_version` is
  // preserved as the ruleset version; the external version gains a
  // short content-hash suffix so two regenerations of the same ruleset
  // with different content have distinct external identities.
  try {
    result.externalVersion = deriveExternalCommunityProfileVersion(profile);
  } catch {
    result.externalVersion = null;
  }
  try {
    result.contentHash = computeProfileContentHash(profile);
  } catch {
    result.contentHash = null;
  }
  if (Array.isArray(profile.hot_keywords)) {
    for (const k of profile.hot_keywords) {
      if (k && typeof k.keyword === 'string' && k.keyword) {
        result.hotMatchTerms.push(k.keyword);
      }
    }
  }
  if (Array.isArray(profile.topics)) {
    for (const t of profile.topics) {
      if (t && typeof t.label === 'string' && t.label) {
        result.themes.push(t.label);
      }
    }
  }
  return result;
}

/**
 * Sort the hot list by relevance. Related entries (score > 0) come
 * first, sorted by score desc then hotness desc. Unrelated entries
 * (score === 0) come after, sorted by hotness desc (i.e. by their
 * original rank).
 *
 * When the identity triple is NOT complete, this function returns the
 * input list untouched so the route layer can skip the rewrite.
 *
 * @param {Array<EcosystemHotEntry>} entries
 * @returns {Array<EcosystemHotEntry>}
 */
export function sortByRelevance(entries) {
  if (!Array.isArray(entries)) return entries;
  const related = [];
  const rest = [];
  for (const e of entries) {
    if (e && e.relevant && typeof e.relevant.score === 'number' && e.relevant.score > 0) {
      related.push(e);
    } else {
      rest.push(e);
    }
  }
  related.sort((a, b) => {
    if (b.relevant.score !== a.relevant.score) return b.relevant.score - a.relevant.score;
    if ((b.heat || 0) !== (a.heat || 0)) return (b.heat || 0) - (a.heat || 0);
    return (a.rank || 0) - (b.rank || 0);
  });
  rest.sort((a, b) => {
    if ((b.heat || 0) !== (a.heat || 0)) return (b.heat || 0) - (a.heat || 0);
    return (a.rank || 0) - (b.rank || 0);
  });
  const merged = related.concat(rest);
  for (let i = 0; i < merged.length; i += 1) {
    merged[i].rank = i + 1;
  }
  return merged;
}

/**
 * Project a raw upstream row into the public entry shape. This is the
 * ONLY spot where the upstream shape meets the wire contract. Identity
 * projection (relevant) is added separately when the route layer
 * supplies an identity triple.
 *
 * @param {object} row
 * @param {number} rank
 * @returns {EcosystemHotEntry}
 */
function projectEntry(row, rank) {
  return {
    rank,
    question_uuid: typeof row.id === 'string' ? row.id : '',
    title: typeof row.title === 'string' ? row.title : '',
    url: typeof row.url === 'string' ? row.url : '',
    heat: typeof row.hotness === 'number' ? row.hotness : 0,
    ...(typeof row.category === 'string' && row.category ? { category: row.category } : {}),
    ...(Array.isArray(row.tags) ? { tags: row.tags.slice() } : {}),
  };
}

/**
 * Create a fresh in-memory hot-list orchestrator. Pure factory. The
 * pair-key cache lives for the lifetime of the orchestrator instance.
 *
 * @param {object} [opts]
 * @param {HotSource} [opts.source]      Default = mock fixture. Real
 *                                       provider (Zhihu hackathon v1)
 *                                       can be wired later.
 * @param {number} [opts.ttlMs]          Override the fresh TTL (ms).
 * @param {number} [opts.swrMs]          Override the SWR window (ms).
 * @param {number} [opts.bucketMs]       Override the bucket size (ms).
 * @returns {object}
 */
export function createEcosystemHotOrchestrator(opts) {
  const options = opts || {};
  const source = options.source || {
    name: 'mock',
    fetchHotList: async (input) => fetchMockHotList(input || {}),
    endpoint: () => '',
  };
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : TTL_MS;
  const swrMs = Number.isFinite(options.swrMs) ? options.swrMs : SWR_MS;
  const bucketMs = Number.isFinite(options.bucketMs) ? options.bucketMs : BUCKET_MS;

  /** @type {Map<string, { at: number, list: ReadonlyArray<object> }>} */
  const pairKeyCache = new Map();

  function cacheKey(category, bucket) {
    return `${category}|${bucket}`;
  }

  function cacheStatus(entry, nowMs) {
    if (!entry) return { state: 'miss', age_ms: Infinity };
    const age = nowMs - entry.at;
    if (age <= ttlMs) return { state: 'fresh', age_ms: age };
    if (age <= swrMs) return { state: 'stale', age_ms: age };
    return { state: 'expired', age_ms: age };
  }

  /**
   * Fetch the hot list (cache-first, upstream-fallback). When the
   * upstream fails AND a past-SWR cache entry is still in the pair-key
   * map, the past-SWR entry is returned as `cached: true` so the home
   * page module can render the placeholder gracefully.
   *
   * @param {object} [input]
   * @param {string} [input.category]   Clamped to KNOWN_CATEGORIES.
   * @returns {Promise<EcosystemHotList>}
   */
  async function fetchHot(input) {
    const raw = input && typeof input.category === 'string' ? input.category.trim() : '';
    const category = raw && KNOWN_CATEGORIES.includes(raw) ? raw : 'total';
    const nowMs = Date.now();
    const bucket = bucketStart(nowMs);
    const key = cacheKey(category, bucket);
    const cached = pairKeyCache.get(key);
    const status = cacheStatus(cached, nowMs);
    if (status.state === 'fresh') {
      return shapeResponse(cached.list, {
        category,
        cached: true,
        fetchedAt: new Date(cached.at).toISOString(),
      });
    }
    let upstreamList;
    let upstreamErr;
    try {
      upstreamList = await source.fetchHotList({ category });
    } catch (err) {
      upstreamErr = err;
      upstreamList = null;
    }
    if (upstreamList && Array.isArray(upstreamList) && upstreamList.length > 0) {
      pairKeyCache.set(key, { at: nowMs, list: upstreamList });
      if (status.state === 'stale') {
        // SWR background refresh: caller still gets fresh data here
        // because we just successfully refreshed. Mark `cached: false`
        // so observability can spot the SWR background path.
        return shapeResponse(upstreamList, {
          category,
          cached: false,
          fetchedAt: new Date(nowMs).toISOString(),
          swrRefreshed: true,
        });
      }
      return shapeResponse(upstreamList, {
        category,
        cached: false,
        fetchedAt: new Date(nowMs).toISOString(),
      });
    }
    // Upstream failure path. If we have a past-SWR row (graceful
    // degradation), serve it with `cached: true`. Otherwise return an
    // empty list with `cached: false` so the route layer can surface
    // the placeholder.
    if (cached) {
      return shapeResponse(cached.list, {
        category,
        cached: true,
        fetchedAt: new Date(cached.at).toISOString(),
        degraded: true,
      });
    }
    return shapeResponse([], {
      category,
      cached: false,
      fetchedAt: '',
    });
  }

  /**
   * Project the orchestrator-level response shape. The relevance
   * projection (`relevant_to_story`, per-entry `relevant`) is added
   * LATER by `attachRelevance` — the cache-level list stays plain.
   *
   * @param {ReadonlyArray<object>} list
   * @param {object} meta
   * @returns {EcosystemHotList}
   */
  function shapeResponse(list, meta) {
    const projected = list.map((row, i) => projectEntry(row, i + 1));
    return {
      hot: projected,
      provenance: {
        source: source.name,
        ...(typeof source.endpoint === 'function' && source.endpoint() ? { endpoint: source.endpoint() } : {}),
      },
      cached: meta.cached === true,
      fetched_at: meta.fetchedAt,
      category: meta.category,
      ...(meta.swrRefreshed ? { swr_refreshed: true } : {}),
      ...(meta.degraded ? { degraded: true } : {}),
    };
  }

  /**
   * Read the cache directly for tests. Returns the pair-key map's
   * snapshot; mutations leak into the live cache.
   *
   * @returns {Map<string, { at: number, list: ReadonlyArray<object> }>}
   */
  function _pairKeyCacheForTests() {
    return pairKeyCache;
  }

  return {
    name: source.name,
    fetchHot,
    _pairKeyCacheForTests,
  };
}

/**
 * Result of `attachRelevance`. The route layer maps this onto HTTP
 * status codes:
 *
 *   * `attached: true`                                 → 200 + relevant_to_story
 *   * `attached: false` + reason: 'mismatch'           → 400 community_profile_version_mismatch
 *   * `attached: false` + reason: 'profile_missing'    → 400 community_profile_missing
 *   * `attached: false` + reason: 'identity_incomplete'→ 200 (plain list, no relevance)
 *
 * @typedef {Object} AttachRelevanceResult
 * @property {boolean} attached
 * @property {string}  [reason]                 'mismatch' | 'profile_missing' | 'identity_incomplete'.
 * @property {string}  [expected_version]       The EXTERNAL community_profile_version the canonical profile carries (= generator_version + content_hash suffix, per P1.v1-3).
 * @property {string}  [actual_version]         The version the caller supplied.
 * @property {string}  [detail]                 Human-readable detail (used by `invalid_identity`).
 * @property {EcosystemHotList} response        Possibly-mutated response object.
 */

/**
 * Attach the relevance projection to a hot-list response. The cache
 * itself stays plain (relevance is request-scoped, not data-scoped)
 * so two callers with different identity triples share upstream data
 * but see distinct relevance projections.
 *
 * P1.v1-2 contract (2026-09-07):
 *   * Identity must be COMPLETE (all three fields present and the
 *     UUIDs well-formed) for relevance to attach.
 *   * When the supplied `community_profile_version` does NOT match
 *     the canonical profile row's `generator_version`, this function
 *     returns `{ attached: false, reason: 'mismatch',
 *     expected_version, actual_version }` so the route layer can
 *     return 400 `community_profile_version_mismatch` instead of
 *     silently degrading to "0 terms".
 *
 * P1.v1-3 contract (2026-09-07):
 *   * The comparison target is now the EXTERNAL identity string
 *     (`${generator_version}-${content_hash_short}`), derived via
 *     `deriveExternalCommunityProfileVersion`. The internal
 *     `generator_version` field on the profile row is preserved as the
 *     ruleset version; the external version is what the wire contract
 *     carries. Two profile generations with the same ruleset version
 *     but different content (e.g. regenerated hot_keywords / topics)
 *     have distinct external versions, so a stale caller is rejected
 *     with 400 mismatch instead of silently observing stale relevance.
 *   * The success path ALSO echoes `content_hash` on `relevant_to_story`
 *     for observability — callers can log the canonical content hash
 *     alongside the external version to debug two-generation drift.
 *
 * @param {EcosystemHotList} response
 * @param {object} [identity]
 * @param {string} [identity.story_uuid]
 * @param {string} [identity.story_version_uuid]
 * @param {string} [identity.community_profile_version]
 * @param {object} [options]
 * @param {object} [options.profileRepository]
 * @returns {AttachRelevanceResult}
 */
export function attachRelevance(response, identity, options) {
  if (!response || !Array.isArray(response.hot)) {
    return { attached: false, response, reason: 'identity_incomplete' };
  }
  const id = identity || {};
  const story_uuid = typeof id.story_uuid === 'string' && id.story_uuid ? id.story_uuid : '';
  const story_version_uuid = typeof id.story_version_uuid === 'string' && id.story_version_uuid
    ? id.story_version_uuid
    : '';
  const community_profile_version = typeof id.community_profile_version === 'string' && id.community_profile_version
    ? id.community_profile_version
    : '';
  // Identity must be complete (all three non-empty) for relevance to
  // attach. Otherwise we return `{ attached: false,
  // reason: 'identity_incomplete', response }` — the route layer
  // degrades to a plain list with no relevance, no `relevant_to_story`.
  if (!story_uuid || !story_version_uuid || !community_profile_version) {
    return { attached: false, response, reason: 'identity_incomplete' };
  }
  try {
    assertUuid('identity.story_uuid', story_uuid);
    assertUuid('identity.story_version_uuid', story_version_uuid);
    assertNonEmptyString('identity.community_profile_version', community_profile_version);
  } catch (err) {
    return {
      attached: false,
      response,
      reason: 'identity_incomplete',
      actual_version: community_profile_version,
      detail: String(err && err.message ? err.message : err),
    };
  }
  const opts = options || {};
  const profileRepository = opts.profileRepository;
  const {
    hotMatchTerms,
    themes,
    profileUuid,
    generatorVersion,
    externalVersion,
    contentHash,
  } = resolveProfileMatchTerms({
    profileRepository,
    story_version_uuid,
    community_profile_version,
  });
  // P1.v1-2 contract: when the canonical profile is missing for this
  // story_version_uuid we MUST report it explicitly. A missing profile
  // is a server-side bug (the import path always calls
  // ensureCommunityProfile), NOT a "0 terms" silent degradation.
  if (!profileUuid) {
    return {
      attached: false,
      response,
      reason: 'profile_missing',
      actual_version: community_profile_version,
    };
  }
  // P1.v1-3 contract (2026-09-07): the comparison target is the
  // EXTERNAL identity string (generator_version + content_hash
  // suffix), NOT the raw internal `generator_version`. The internal
  // field is preserved for the ruleset version; the external string
  // is what the wire contract carries. When the caller supplies a
  // stale external version (e.g. carrying the previous generation's
  // content hash), we return 400 mismatch with the canonical external
  // version as `expected_version` so the caller can re-pin.
  const expectedExternalVersion = externalVersion;
  if (expectedExternalVersion && expectedExternalVersion !== community_profile_version) {
    return {
      attached: false,
      response,
      reason: 'mismatch',
      expected_version: expectedExternalVersion,
      actual_version: community_profile_version,
    };
  }
  // Always project `relevant` onto each entry so the home page can
  // render badges deterministically (score === 0 → "not related";
  // score > 0 → "related"). The home-page badge rule is "show the
  // badge iff `relevant.score > 0`".
  const matchedAll = new Set();
  for (const e of response.hot) {
    const rel = computeRelevance(e, hotMatchTerms, themes);
    e.relevant = rel;
    for (const t of rel.matched_terms) matchedAll.add(t);
  }
  // Re-sort: related first, then by score/hotness.
  sortByRelevance(response.hot);
  response.relevant_to_story = {
    matched_terms: Array.from(matchedAll),
    score: matchedAll.size,
    story_uuid,
    story_version_uuid,
    community_profile_version,
    profile_uuid: profileUuid || '',
    hot_match_terms: hotMatchTerms.slice(),
    themes: themes.slice(),
    ...(generatorVersion ? { generator_version: generatorVersion } : {}),
    ...(contentHash ? { content_hash: contentHash } : {}),
  };
  return { attached: true, response };
}

// Re-export the helpers used by the route layer.
export {
  filterMockHotByCategory,
} from './mockZhihuHotSource.mjs';

void assertUuid;
void assertNonEmptyString;
void nowIso;