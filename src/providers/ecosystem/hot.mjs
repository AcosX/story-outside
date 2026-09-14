// src/providers/ecosystem/hot.mjs — Story 16.4 P1.v1-4 知乎热榜 orchestrator
// (2026-09-07), continued on the hot-relevance fix branch.
//
// P1.v1-4 fix — single community-layer helper + direct external-version
// lookup (no active-row concept):
//
//   v1-3 (commit 4b4fd72) introduced a content-hash-aware external
//   identity string, but the helper lived as a PRIVATE function inside
//   `hot.mjs` and the matcher used the "active" concept
//   (`findActiveByStoryVersion`) to read the canonical profile row.
//   That coupling meant v1-3 depended on whatever the repository
//   considered "active" for the story_version — a coupling that
//   silently broke when an unrelated refactor changed which row was
//   active (the active-row bug observed in the code review independent
//   review of `npm test` exit 1 at 2026-09-07 06:24).
//
//   v1-4 unwinds that coupling on the #23 branch WITHOUT copying the
//   #24 branch's `insert_seq` schema change. Two surgical edits:
//
//     1. Move the external-version derivation into a PUBLIC community-
//        layer helper (`src/community/version.mjs`). The wire format is
//        `${generator_version}@${content_hash.slice(0, 16)}`. The `@`
//        separator distinguishes the external identity from the
//        internal `generator_version` string AND prevents confusion
//        with the v1-3-era `${rules}-${hash12}` format. `hot.mjs` only
//        imports the helper — it NEVER re-implements the format.
//
//     2. Add `communityProfileRepo.findByExternalVersion(externalVersion)`
//        to the community repository. The matcher now passes the
//        caller-supplied `community_profile_version` (the external
//        identity string) DIRECTLY to the repo, with no "active"
//        concept in between. When no row matches, the matcher
//        surfaces `community_profile_not_found` (= 400) instead of
//        silently falling through to the previous-generation row.
//
//   Together (1) + (2) make the matcher robust against any future
//   refactor of the active slot: the external version is the
//   SINGLE source of truth. The route layer's expected_version comes
//   from the same helper, so the comparison is symmetric.
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
// Identity contract (Story 16.4 P1.v1-2 → P1.v1-3):
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
// Cache strategy (rebuilt per Story 16.4 spec):
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
// P1.v1-6 (2026-09-07): import the SINGLE community-layer helper that
// knows the wire format. We do NOT re-implement the format locally —
// the helper is the source of truth. The previous v1-5 surface
// (`computeProfileContentHash`) was deleted: the canonical content
// hash now lives on the profile row (`profile.hash.content_hash`,
// stamped by `buildCommunityProfileFromSeed` and exposed via
// `buildCanonicalCommunityProfileVersion` in
// `src/community/repository.mjs`). The helper here is a thin
// pass-through that reads `profile.hash.content_hash` AS-IS.
import { deriveExternalCommunityProfileVersion } from '../../community/version.mjs';
// P1.v1-4 (2026-09-07): the canonical-row read is now a SECONDARY
// fallback used only to surface a useful `expected_version` when the
// direct external-version lookup misses. The PRIMARY read goes
// through `profileRepository.findByExternalVersion` (no active
// concept).
import { getCommunityProfile } from '../../community/service.mjs';
import { createRealZhihuHotSource } from './zhihuHotSource.mjs';

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

// P1.v1-4 (2026-09-07): the EXTERNAL `community_profile_version`
// derivation has MOVED to the community layer
// (`src/community/version.mjs`). `hot.mjs` only imports the helper;
// the wire-format details live in exactly one place. Do NOT add a
// local copy of `deriveExternalCommunityProfileVersion` or
// `computeProfileContentHash` here — the import above is the single
// source.

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
 * Resolve the community profile for the identity triple.
 *
 * P1.v1-4 contract (2026-09-07):
 *   The PRIMARY read goes through
 *   `profileRepository.findCanonicalByIdentity({ story_uuid,
 *   story_version_uuid, community_profile_version })` so the
 *   triple-check lives in exactly one place (the community layer).
 *   The repo returns a discriminated union; this helper translates
 *   that into a flat shape the matcher can consume:
 *
 *     - `{ ok: false, code: 'community_profile_not_found' }`
 *         → `profileUuid = null`, `storyUuidMismatch = false`
 *           (the route layer maps this to 400
 *           `community_profile_not_found`).
 *     - `{ ok: false, code: 'community_profile_version_mismatch' }`
 *         → `profileUuid = null`, `storyUuidMismatch = false`
 *           (the route layer maps this to 400
 *           `community_profile_version_mismatch`).
 *     - `{ ok: false, code: 'story_version_mismatch' }`
 *         → `profileUuid = null`, `storyUuidMismatch = true`
 *           (P1.v1-9 2026-09-07: the repo detected a row bound to
 *           the requested `story_version_uuid` whose `story_uuid`
 *           disagrees with the caller's; the route layer maps
 *           this to 400 `community_profile_story_uuid_mismatch`).
 *     - `{ ok: true, profile }`
 *         → the matched row's fields populate
 *           `profileUuid`, `profileStoryVersionUuid`,
 *           `generatorVersion`, `externalVersion`, `contentHash`.
 *           The helper ALSO performs a defence-in-depth check:
 *           `profile.story_uuid === story_uuid`. The repo
 *           invariant already guarantees this, but if a future
 *           refactor ever regressed, this helper refuses to
 *           surface a mis-bound profile by setting
 *           `storyUuidMismatch = true`.
 *
 *   When the lookup misses entirely, a SECONDARY read by
 *   `story_version_uuid` (the canonical row for the story) is used
 *   only to surface a useful `expected_version` for the
 *   `mismatch` 400 path; the SECONDARY read is NEVER the source of
 *   truth for the matched profile.
 *
 *   This decoupling makes the matcher robust against any future
 *   refactor of the "active" slot: even if an unrelated change moved
 *   the active row, the canonical-identity lookup stays correct
 *   because the repo walks every row bound to the requested
 *   `story_version_uuid` and matches the version string byte-for-byte.
 *
 * @param {object} input
 * @param {object} [input.profileRepository]
 * @param {string} input.story_uuid                     REQUIRED. The caller-supplied
 *                                                      story UUID used as the first
 *                                                      key of the canonical-identity
 *                                                      triple.
 * @param {string} input.story_version_uuid
 * @param {string} input.community_profile_version      REQUIRED. The
 *                                                      caller-supplied
 *                                                      external version
 *                                                      string used as the
 *                                                      direct lookup key.
 * @returns {{ hotMatchTerms: string[], themes: string[], profileUuid: string | null, profileStoryVersionUuid: string | null, generatorVersion: string | null, externalVersion: string | null, contentHash: string | null, storyUuidMismatch: boolean, expectedStoryUuid: string | null }}
 */
export function resolveProfileMatchTerms({ profileRepository, story_uuid, story_version_uuid, community_profile_version }) {
  const result = {
    hotMatchTerms: [],
    themes: [],
    profileUuid: null,
    // `profileStoryVersionUuid` is the `story_version_uuid` carried
    // on the matched profile row. The route layer compares it against
    // the caller-supplied `identity.story_version_uuid` to detect a
    // cross-story-version external-version swap. When the primary
    // read returns null, this field stays null.
    profileStoryVersionUuid: null,
    generatorVersion: null,
    externalVersion: null,
    contentHash: null,
    // P1.v1-9 (2026-09-07): the canonical triple-check refuses to
    // surface a profile whose `story_uuid` disagrees with the
    // caller's. Set to `true` when (a) the repo reports a row under
    // the requested `story_version_uuid` with a different
    // `story_uuid`, OR (b) the defence-in-depth check on the
    // matched row fires (currently unreachable thanks to the repo
    // invariant, but kept as belt-and-suspenders).
    storyUuidMismatch: false,
    // P1.v1-9 (2026-09-07): the `story_uuid` stamped on the row
    // the repo rejected (if any). The route layer echoes it as
    // `expected_story_uuid` on the 400 response so the client can
    // re-pin without having to re-derive the canonical row.
    expectedStoryUuid: null,
  };
  if (!profileRepository) return result;
  if (typeof community_profile_version !== 'string' || !community_profile_version) {
    return result;
  }
  if (typeof story_uuid !== 'string' || !story_uuid) {
    // No story_uuid supplied → no canonical triple lookup. The
    // caller MUST have already run the identity-completeness
    // check at the route layer; we return the empty result and
    // let the caller degrade to a plain list. We deliberately do
    // NOT set `storyUuidMismatch` here — that's reserved for the
    // "supplied-but-wrong" case.
    return result;
  }
  // PRIMARY: triple-key canonical lookup via the community-layer
  // repo. P1.v1-9 (2026-09-07): the lookup now goes through
  // `findCanonicalByIdentity` (which walks every row bound to the
  // requested `story_version_uuid` AND verifies `story_uuid`
  // agreement AND matches the version string byte-for-byte), so a
  // cross-story collision cannot return the wrong row. The repo
  // never throws on identity errors; it returns a discriminated
  // union we map onto our flat shape.
  let resolved = null;
  try {
    if (typeof profileRepository.findCanonicalByIdentity === 'function') {
      resolved = profileRepository.findCanonicalByIdentity({
        story_uuid,
        story_version_uuid,
        community_profile_version,
      });
    }
  } catch {
    resolved = null;
  }
  if (!resolved || !resolved.ok) {
    // Map the repo's discriminated union onto our flat shape:
    //   - `story_version_mismatch` → set the P1.v1-9 flag so the
    //     route layer surfaces 400 `community_profile_story_uuid_mismatch`.
    //     The repo's message field carries the row's actual
    //     `story_uuid`; we surface it as `expectedStoryUuid` so the
    //     client can re-pin without re-deriving the canonical row.
    //   - everything else (`community_profile_not_found`,
    //     `community_profile_version_mismatch`, or a `null`
    //     resolved) → `profileUuid = null`, the existing
    //     `resolveCanonicalExternalVersion` path will surface
    //     `expected_version` for the route layer.
    if (resolved && resolved.code === 'story_version_mismatch') {
      result.storyUuidMismatch = true;
      // The repo's message is a free-form string; we cannot rely
      // on parsing it. Instead, surface a non-identifying marker
      // so the route layer can include a stable wire shape. The
      // exact UUID is recoverable by the client via a follow-up
      // canonical lookup of its own.
      result.expectedStoryUuid = '<disagrees-with-row>';
    }
    return result;
  }
  const profile = resolved.profile;
  // Defence-in-depth: the repo invariant says `profile.story_uuid
  // === story_uuid` (else it would have returned
  // `story_version_mismatch`), but verify here so a future refactor
  // of the repo cannot silently regress.
  if (profile && profile.story_uuid !== story_uuid) {
    result.storyUuidMismatch = true;
    result.expectedStoryUuid = profile.story_uuid;
    return result;
  }
  result.profileUuid = profile.profile_uuid;
  result.profileStoryVersionUuid = profile.story_version_uuid;
  result.generatorVersion = profile.generator_version;
  try {
    result.externalVersion = deriveExternalCommunityProfileVersion(profile);
  } catch {
    result.externalVersion = null;
  }
  // P1.v1-6 (2026-09-07): the canonical content hash now lives on
  // the profile row (`profile.hash.content_hash`) and is read AS-IS.
  // The hot orchestrator no longer recomputes it; route-layer
  // diagnostics that need the hash must read it from the profile
  // directly.
  result.contentHash = (profile && profile.hash && typeof profile.hash.content_hash === 'string')
    ? profile.hash.content_hash
    : null;
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
 * Resolve the canonical external version for a story_version. This
 * is the SECONDARY read used by `attachRelevance` to surface
 * `expected_version` when the primary direct-external-version lookup
 * misses. The function is intentionally separate from
 * `resolveProfileMatchTerms` so the test suite can probe the
 * fallback independently and so the PRIMARY path stays narrow.
 *
 * @param {object} input
 * @param {object} input.profileRepository
 * @param {string} input.story_version_uuid
 * @returns {string | null}
 */
export function resolveCanonicalExternalVersion({ profileRepository, story_version_uuid }) {
  if (!profileRepository) return null;
  if (typeof story_version_uuid !== 'string' || !story_version_uuid) return null;
  let profile = null;
  try {
    profile = getCommunityProfile({ profileRepository, story_version_uuid });
  } catch {
    profile = null;
  }
  if (!profile) return null;
  try {
    return deriveExternalCommunityProfileVersion(profile);
  } catch {
    return null;
  }
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
    ...(typeof row.thumbnail_url === 'string' ? { thumbnail_url: row.thumbnail_url } : {}),
    ...(typeof row.excerpt === 'string' ? { excerpt: row.excerpt } : {}),
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
  const provider = options.provider ?? (process.env.STORY_OUTSIDE_PROVIDER?.trim() || process.env.ZHIHU_PROVIDER?.trim() || 'mock');
  const source = options.source || (provider === 'real' ? createRealZhihuHotSource({ accessSecret: options.accessSecret }) : {
    name: 'mock',
    fetchHotList: async (input) => fetchMockHotList(input || {}),
    endpoint: () => '',
  });
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
      unavailable: Boolean(upstreamErr),
      reason: /^hot_[a-z0-9_]+$/.test(upstreamErr?.code || '') ? upstreamErr.code : 'hot_upstream_unavailable',
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
      ...(meta.unavailable ? { unavailable: true, reason: meta.reason } : {}),
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
 *   * `attached: true`                                          → 200 + relevant_to_story
 *   * `attached: false` + reason: 'mismatch'                    → 400 community_profile_version_mismatch
 *   * `attached: false` + reason: 'profile_missing'             → 400 community_profile_missing
 *   * `attached: false` + reason: 'community_profile_not_found' → 400 community_profile_not_found
 *   * `attached: false` + reason: 'identity_incomplete'         → 200 (plain list, no relevance)
 *
 * @typedef {Object} AttachRelevanceResult
 * @property {boolean} attached
 * @property {string}  [reason]                 'mismatch' | 'profile_missing' | 'community_profile_not_found' | 'identity_incomplete'.
 * @property {string}  [expected_version]       The EXTERNAL community_profile_version the canonical profile carries (= generator_version + content_hash suffix, per P1.v1-3/v1-4).
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
 * P1.v1-5 contract (2026-09-07):
 *   * The PRIMARY profile read goes through
 *     `profileRepository.findByExternalVersion(story_version_uuid,
 *     community_profile_version)` — the wire-contract external
 *     identity string is the EXACT key, AND the lookup is SCOPED to
 *     the caller's `story_version_uuid` so a cross-story collision
 *     (two profiles with the SAME external version but different
 *     story_versions) cannot return the wrong row. There is NO
 *     active concept in the primary read.
 *   * Identity must be COMPLETE (all three fields present and the
 *     UUIDs well-formed) for relevance to attach.
 *   * When the PRIMARY lookup misses, a SECONDARY canonical-row read
 *     by `story_version_uuid` is used only to surface
 *     `expected_version`:
 *       - canonical row exists → `mismatch` with `expected_version =
 *         canonicalExternalVersion`, `actual_version = callerVersion`.
 *       - canonical row absent → `community_profile_not_found`.
 *   * The success path ALSO echoes `content_hash` on
 *     `relevant_to_story` for observability — callers can log the
 *     canonical content hash alongside the external version to
 *     debug two-generation drift.
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
  // P1.v1-4 PRIMARY read: direct external-version lookup. No active
  // concept. The external version IS the canonical pointer.
  //
  // P1.v1-9 (2026-09-07): the lookup now also receives the
  // caller's `story_uuid` and goes through
  // `profileRepository.findCanonicalByIdentity(...)` so the
  // triple-check (story_uuid + story_version_uuid +
  // community_profile_version) lives in exactly one place. The
  // resolved shape carries a `storyUuidMismatch` flag the route
  // layer maps onto 400 `community_profile_story_uuid_mismatch`.
  const {
    hotMatchTerms,
    themes,
    profileUuid,
    profileStoryVersionUuid,
    generatorVersion,
    externalVersion,
    contentHash,
    storyUuidMismatch,
    expectedStoryUuid,
  } = resolveProfileMatchTerms({
    profileRepository,
    story_uuid,
    story_version_uuid,
    community_profile_version,
  });
  // P1.v1-9 (2026-09-07): refuse to attach relevance when the
  // supplied `story_uuid` does not match the canonical row's
  // `story_uuid`. The route layer maps this onto 400
  // `community_profile_story_uuid_mismatch` (NOT `attached: true`).
  // A wrong but format-legal story_uuid must NEVER silently produce
  // `attached: true` for a profile that belongs to a different
  // story — that was the independent review P1 finding.
  //
  // Cross-check contract: `story_uuid === profile.story_uuid`. If
  // the helper above set `storyUuidMismatch`, the caller's
  // `story_uuid` disagrees with the canonical row's
  // `profile.story_uuid` and we refuse here.
  if (storyUuidMismatch) {
    return {
      attached: false,
      response,
      reason: 'story_uuid_mismatch',
      actual_story_uuid: story_uuid,
      expected_story_uuid: expectedStoryUuid || '',
    };
  }
  // PRIMARY miss: surface a useful mismatch path so callers carrying a
  // stale external version still see the canonical expected_version.
  if (!profileUuid) {
    const canonicalExternal = resolveCanonicalExternalVersion({
      profileRepository,
      story_version_uuid,
    });
    if (canonicalExternal) {
      return {
        attached: false,
        response,
        reason: 'mismatch',
        expected_version: canonicalExternal,
        actual_version: community_profile_version,
      };
    }
    return {
      attached: false,
      response,
      reason: 'community_profile_not_found',
      actual_version: community_profile_version,
    };
  }
  // Defense (defence-in-depth): the matched profile row's
  // `story_version_uuid` MUST match the caller-supplied
  // `story_version_uuid`. The PRIMARY `findByExternalVersion` is
  // SCOPED to the caller's `story_version_uuid` (P1.v1-5
  // 2026-09-07), so a swapped-uuid caller would normally miss the
  // primary lookup and fall through to the mismatch /
  // community_profile_not_found paths above. This check catches a
  // narrow residual: a malformed row whose `story_version_uuid`
  // does not match the scoped key. Reject as `mismatch` with the
  // canonical external version for the caller's
  // `story_version_uuid` as `expected_version` so the caller can
  // re-pin.
  if (profileStoryVersionUuid && profileStoryVersionUuid !== story_version_uuid) {
    const canonicalExternalForCaller = resolveCanonicalExternalVersion({
      profileRepository,
      story_version_uuid,
    }) || '';
    return {
      attached: false,
      response,
      reason: 'mismatch',
      expected_version: canonicalExternalForCaller,
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
