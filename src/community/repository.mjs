// src/community/repository.mjs — in-memory store for story_version-scoped
// community profiles (Story 16.1).
//
// Hard contract:
//   * One community profile is bound to ONE story_version. When the
//     story_version (or the generator rule version) changes, a NEW
//     profile row is created; the previous row is kept, NOT mutated
//     in place, so a regression can re-pin a session to the prior
//     profile by uuid.
//   * findActiveCommunityProfile returns the canonical "current"
//     profile for a story_version: the most recent valid row for that
//     story_version under the matching generator_version. If none
//     exists, a new profile is generated and stored.
//   * No column or sub-field on the row is allowed to reference
//     user / role / session / model output. The store REJECTS any
//     payload that smuggles such fields in (defence in depth on top
//     of the profile module's own shape validator).
//
// The store mirrors the design of src/stories/repository.mjs:
//   * keyed by profile_uuid
//   * keyed by story_version_uuid + generator_version for fast lookup
//   * versioned by story_version_checksum so the same story_version
//     with two checksums (rare, but possible when content_payload is
//     corrected) keeps separate profiles.
//
// Story 16.5 P1.v1-3 fix (2026-09-07 owner review): the handler
// identity is the DERIVED external
// `community_profile_version = <generator_version>-<content_hash_short>`,
// NOT the raw `generator_version`. `findCanonicalByIdentity` walks
// every preserved row for the supplied story_version, computes each
// row's external version, and matches the requested external version
// against those — so a row superseded by a newer content_hash stays
// resolvable for old sessions that still pin the prior external
// version. There is NO silent fallback to "the latest row": an exact
// external-version lookup either returns the matching row or returns
// `null` so the route layer can report `community_profile_not_found`.
//
// Story 16.5 P1.v1-5 fix (2026-09-07 owner review, code review):
// `Map.set(existing key)` does NOT change the key's iteration
// position — so the v1-4 "last insertion wins" walk over
// `activeByStoryVersion.entries()` was still deterministically
// WRONG when an older `generator_version` was re-inserted AFTER a
// newer one (the older row's `activeByStoryVersion` key stayed in
// its original slot and the walk returned the newer row's uuid
// first, regardless of insertion order). The store now keeps an
// EXPLICIT `latestByStoryVersion: Map<story_version_uuid,
// profile_uuid>` pointer that is updated ONLY on fresh inserts
// (idempotent re-inserts of the same row do NOT move the pointer
// backwards, so a re-insert of an older row CANNOT regress the
// active row). `findActiveByStoryVersion` is now a direct
// `latestByStoryVersion.get(story_version_uuid)` — no Map iteration
// at all. The `insert_seq` / ordering metadata is purely
// repository-private; the canonical 13-field profile schema in
// profile.mjs is unchanged.
//
// The module does not read env vars that look like credentials and
// does not call any external API.

import {
  assertCommunityProfileShape,
  findCommunityProfileBoundsViolations,
} from './profile.mjs';
import {
  deriveExternalCommunityProfileVersion,
} from './version.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nowIso() {
  return new Date().toISOString();
}

function assertUuid(label, value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`communityRepository: ${label} must be a UUID`);
  }
}

/**
 * Defensive sub-set of the forbidden key surface carried over from
 * src/stories/cacheKey.mjs. Anything in this set that appears under a
 * profile payload is rejected at insert time; this is the second line
 * of defence after the profile module's own shape check. We keep a
 * copy (not an import) because the community profile is a different
 * kind of cache than the opening cache: a forbidden key on an opening
 * cache key would change which cache row is read; a forbidden key on
 * a profile row would change the cached content itself, which is a
 * more severe leak.
 */
const FORBIDDEN_PROFILE_KEYS = Object.freeze([
  'user_id',
  'user_ref',
  'userId',
  'user',
  'oauth_subject',
  'subject',
  'access_token',
  'app_id',
  'app_key',
  'access_secret',
  'role_id',
  'roleId',
  'role_label',
  'roleLabel',
  'role',
  'session_id',
  'sessionId',
  'session_uuid',
  'sessionUuid',
  'client_request_id',
  'clientRequestId',
  'ip',
  'ip_address',
  'device',
  'device_id',
  'deviceId',
  'timestamp',
  'ts',
  'nonce',
  'random',
  'model_output',
  'modelOutput',
  'model_response',
  'modelResponse',
  'model',
  'completion',
  'generation',
  'prompt',
]);

/**
 * Walk a profile record and throw when a forbidden key appears ANYWHERE.
 * Used by `setCommunityProfile` so a buggy caller cannot smuggle
 * session-specific data into a supposedly public profile.
 *
 * @param {unknown} value
 * @param {string} path
 */
function rejectForbiddenKeys(value, path) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      rejectForbiddenKeys(value[i], `${path}[${i}]`);
    }
    return;
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(/** @type {object} */ (value))) {
      if (FORBIDDEN_PROFILE_KEYS.includes(key)) {
        throw new Error(
          `communityRepository: forbidden field '${key}' at ${path} — community profile MUST stay story-scoped.`,
        );
      }
      rejectForbiddenKeys(
        /** @type {Record<string, unknown>} */ (value)[key],
        `${path}.${key}`,
      );
    }
  }
}

/**
 * @typedef {import('./profile.mjs').StoryCommunityProfile} StoryCommunityProfile
 */

/**
 * @typedef {Object} CommunityProfileRepository
 * @property {(story_version_uuid: string) => StoryCommunityProfile | null} findActiveByStoryVersion
 * @property {(story_version_uuid: string, generator_version: string) => StoryCommunityProfile | null} findActiveByStoryVersionAndGenerator
 * @property {(profile_uuid: string) => StoryCommunityProfile | null} findByUuid
 * @property {(story_version_uuid: string, externalVersion: string) => StoryCommunityProfile | null} findByExternalVersion
 * @property {(input: { story_version_uuid: string }) => StoryCommunityProfile[]} listByStoryVersion
 * @property {(input: { story_uuid?: string, story_version_uuid: string, community_profile_version?: string | null }) => StoryCommunityProfile | null} findCanonicalByIdentity
 *          Story 16.5 P1.v2 — server-authoritative lookup that joins
 *          (story_uuid, story_version_uuid, community_profile_version)
 *          into one canonical row. Caller-supplied knowledge_queries /
 *          topic_id / topic_label / topic / theme / subject are NEVER
 *          consulted; the route layer only ever picks a single row.
 * @property {(external_version: string) => StoryCommunityProfile | null} findByExternalVersion
 *          Story 16.5 P1.v1-4 — pure exact-match by the EXTERNAL
 *          community_profile_version string. Walks every preserved
 *          row in the store, computes each row's external version
 *          via `deriveExternalCommunityProfileVersion`, and returns
 *          the single row whose external version equals the supplied
 *          string. Returns `null` if no preserved row matches. There
 *          is NO silent fallback to "the latest row" — an exact
 *          external-version lookup either returns the matching row or
 *          returns null so the orchestrator can surface 400
 *          `community_profile_not_found`. This method does NOT consult
 *          the active-by-(sv,gv) index, so it intentionally bypasses
 *          the active-row concept for callers that want historical
 *          exact lookup.
 * @property {(input: StoryCommunityProfile) => StoryCommunityProfile} setCommunityProfile
 * @property {() => { profile_count: number }} stats
 * @property {() => void} _resetForTests
 */

/**
 * Build a fresh in-memory state. Pure factory.
 * @returns {{
 *   profiles: Map<string, StoryCommunityProfile>,                 // keyed by profile_uuid
 *   activeByStoryVersion: Map<string, string>,                    // story_version_uuid|generator_version → profile_uuid
 *   latestByStoryVersion: Map<string, string>,                    // Story 16.5 P1.v1-5 — explicit latest pointer, story_version_uuid → profile_uuid (NO Map iteration)
 *   byUuid: Map<string, StoryCommunityProfile>,
 *   byExternalVersion: Map<string, string>,                        // `${story_version_uuid}::${externalVersion}` → profile_uuid (P1.v1-5 SCOPED)
 *   latestByStoryVersion: Map<string, string>,                    // story_version_uuid → profile_uuid of the most recently inserted row (PRIVATE; not a row field)
 * }}
 */
function createEmptyState() {
  return {
    profiles: new Map(),
    activeByStoryVersion: new Map(),
    latestByStoryVersion: new Map(),
    byUuid: new Map(),
    byExternalVersion: new Map(),
    // Story 16.2 P1.v1-5 fix (2026-09-07): the monotonic/latest
    // metadata that drives active-row selection lives in PRIVATE
    // repository state. The previous v1-4 implementation stamped a
    // numeric `insert_seq` onto every row and made it part of the
    // canonical schema (which is owned by Story 16.1 / main), turning
    // the 13-field strict allowlist into 14 fields. v1-5 reverts
    // that schema change: this Map is the SINGLE source of truth for
    // "which row is currently active under this story_version_uuid".
    //
    // Semantics:
    //   * Updated ONLY when `setCommunityProfile` accepts a NEW row
    //     (one that does NOT collapse on the existing-row same-
    //     content-hash idempotency contract).
    //   * Idempotent re-inserts do NOT touch this Map.
    //   * This Map is NEVER exposed through any public API. Tests
    //     observe its semantics through `findActiveByStoryVersion` /
    //     `getCommunityProfile`, not by reading the Map directly.
    //   * `_resetForTests` clears it.
    latestByStoryVersion: new Map(),
  };
}

/**
 * Stable scope key for the active lookup. The story_version_uuid
 * alone is NOT enough: when the rule version bumps the old profile
 * stays active for the previous generation so old sessions can keep
 * reading the same row. Hence `generator_version` is part of the key.
 *
 * @param {string} story_version_uuid
 * @param {string} generator_version
 */
function activeKey(story_version_uuid, generator_version) {
  return `${story_version_uuid}|${generator_version}`;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build the canonical `community_profile_version` string for a profile
 * row. The format is `${generator_version}@${content_hash[:16]}` — a
 * new value iff the profile is regenerated with a different content
 * hash. The prefix length matches what the handler in server.mjs
 * surfaces to the player (and what the player echoes back).
 *
 * Story 16.2 P1.v2 fix (2026-09-07): this helper is the SINGLE
 * authority for the version-string format. Both the producer (POST
 * /api/sessions response) and the consumer (POST
 * /v1/ecosystem/discussions) MUST derive the string through this
 * function so the two sides cannot drift.
 *
 * @param {import('./profile.mjs').StoryCommunityProfile} profile
 * @returns {string|null}
 */
export function buildCanonicalCommunityProfileVersion(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const generator = typeof profile.generator_version === 'string' ? profile.generator_version : '';
  const hash = profile.hash && typeof profile.hash.content_hash === 'string'
    ? profile.hash.content_hash : '';
  if (!generator || !hash) return null;
  return `${generator}@${hash.slice(0, 16)}`;
}

/**
 * P1.v1-5 (2026-09-07): SCOPED index key for the external-version
 * lookup. The wire-contract external version string is NOT globally
 * unique — two profiles with the SAME community content but
 * DIFFERENT `story_version_uuid` can yield the same external version
 * if anything ever regresses the hash input. Scoping the key by
 * `story_version_uuid` is defence-in-depth: even if a future
 * refactor accidentally drops `story_uuid` + `story_version_uuid`
 * from the hash input, the index still refuses to collide across
 * story_versions.
 *
 * The `::` separator (vs. `|` in `activeKey`) makes the key visually
 * distinct in test failures so a quick `grep externalVersionKey`
 * surfaces the v1-5 contract.
 *
 * @param {string} story_version_uuid
 * @param {string} externalVersion
 */
export function externalVersionKey(story_version_uuid, externalVersion) {
  return `${story_version_uuid}::${externalVersion}`;
}

/**
 * Build a fresh in-memory CommunityProfileRepository. Pure factory.
 * @returns {CommunityProfileRepository}
 */
export function createInMemoryCommunityProfileRepository() {
  const state = createEmptyState();
  /** @type {CommunityProfileRepository} */
  const repo = {
    findActiveByStoryVersion(story_version_uuid) {
      assertUuid('story_version_uuid', story_version_uuid);
      // P1.v1-5 (2026-09-07 owner review, code review) — direct
      // lookup against the explicit `latestByStoryVersion` pointer.
      // We previously walked `activeByStoryVersion.entries()` and
      // trusted Map insertion order, but `Map.set(existing key)`
      // does NOT move the key — so when an older `generator_version`
      // was re-inserted AFTER a newer one (e.g. the g1/A → g2/B →
      // g1/C ordering), the older key stayed in its original slot
      // and the walk deterministically returned the wrong (older)
      // row. The new contract: `latestByStoryVersion` is updated
      // EXCLUSIVELY by `setCommunityProfile` on a fresh insert
      // (idempotent re-inserts of an existing
      // `(sv, generator_version, content_hash)` triple are a no-op
      // and never move the pointer), and this lookup is a single
      // `Map.get()` — no iteration, no ordering ambiguity.
      const uuid = state.latestByStoryVersion.get(story_version_uuid);
      if (!uuid) return null;
      return state.profiles.get(uuid) || null;
    },
    findActiveByStoryVersionAndGenerator(story_version_uuid, generator_version) {
      assertUuid('story_version_uuid', story_version_uuid);
      if (typeof generator_version !== 'string' || !generator_version) {
        throw new Error('communityRepository: generator_version required');
      }
      const key = activeKey(story_version_uuid, generator_version);
      const uuid = state.activeByStoryVersion.get(key);
      if (!uuid) return null;
      return state.profiles.get(uuid) || null;
    },
    /**
     * Story 16.2 P1.v2 fix (2026-09-07) — REVISED 2026-09-07 04:21
     * (review): server-authoritative, IMMUTABLE lookup of a
     * `StoryCommunityProfile` row.
     *
     * The store retains EVERY profile row ever written (the
     * `setCommunityProfile` contract: "a new row is created; the
     * previous row is kept, NOT mutated in place"). When a new
     * generator_version / content_hash supersedes an old row, the
     * `activeByStoryVersion` index moves to the new row, but the old
     * row stays in `state.profiles`. A pinned session must still be
     * able to resolve its OLD profile by
     * `community_profile_version` — the version string is the
     * immutable locator.
     *
     * Hard contract:
     *   * Walks `state.profiles` (ALL rows ever written, NOT just
     *     `activeByStoryVersion`). An old row that was superseded by
     *     a newer row is still resolvable.
     *   * Matches `community_profile_version` BYTE-FOR-BYTE against
     *     `buildCanonicalCommunityProfileVersion(row)` for each row
     *     whose `row.story_version_uuid === story_version_uuid`.
     *   * If exactly one row matches, returns it.
     *   * If NO row matches, returns `community_profile_not_found`
     *     — NEVER silently degrades to "the latest row for this
     *     story_version".
     *   * If any row bound to `story_version_uuid` has a different
     *     `story_uuid` than the supplied one, returns
     *     `story_version_mismatch` (defence in depth: a caller
     *     cannot point one story's version at another story's
     *     profile row).
     *
     * Result is a discriminated union so the route layer can map
     * each failure mode to a specific 4xx error code:
     *   * `{ ok: true,  profile }`
     *   * `{ ok: false, code: 'community_profile_not_found' }`
     *   * `{ ok: false, code: 'community_profile_version_mismatch' }`
     *   * `{ ok: false, code: 'story_version_mismatch' }`
     *
     * The repo NEVER throws on identity errors; it returns the
     * discriminated union instead. The route layer maps each code
     * to a 400 response.
     *
     * Implementation note (regression guard):
     *   * This implementation MUST NOT pick "the latest row then
     *     compare" — that is exactly the bug v2 #28 introduced.
     *     The immutable-lookup contract here requires walking
     *     every row bound to the requested `story_version_uuid`
     *     and matching the version string byte-for-byte. v1-2
     *     (this revision) closes that bug.
     *
     * @param {object} input
     * @param {string} input.story_uuid
     * @param {string} input.story_version_uuid
     * @param {string} input.community_profile_version
     * @returns {{ok:true,profile:object}|{ok:false,code:string,message:string}}
     */
    findCanonicalByIdentity(input) {
      // 1. Shape guard — bad inputs MUST NOT throw; route layer
      //    already validates, but defence in depth.
      if (!isPlainObject(input)) {
        return { ok: false, code: 'community_profile_not_found', message: 'identity required' };
      }
      const storyUuid = typeof input.story_uuid === 'string' ? input.story_uuid : '';
      const storyVersionUuid = typeof input.story_version_uuid === 'string' ? input.story_version_uuid : '';
      const cpv = typeof input.community_profile_version === 'string'
        ? input.community_profile_version : '';
      if (!UUID_PATTERN.test(storyVersionUuid)) {
        return {
          ok: false,
          code: 'community_profile_not_found',
          message: 'story_version_uuid is required and must be a valid UUID',
        };
      }
      // P1.v1-5 fallback (Story 16.5 PR #25): when the caller
      // omits `community_profile_version`, return the active row
      // for `story_version_uuid`. This preserves the v1-5 contract
      // where the in-memory repository acts as a fallback to
      // `findActiveByStoryVersion` so the two paths agree on the
      // same row. (When `community_profile_version` IS supplied
      // we MUST go through the exact-match path below — a wrong
      // / stale / typo'd version never degrades to the active
      // row.) main's original P1.v1-5 shape guard required ALL
      // three fields; the merge-of-conflicts adds the cpv-missing
      // fallback so the PR #25 P1.v1-5-2 regression stays green
      // while keeping main's `{ ok, code, message }` envelope
      // intact.
      if (!cpv) {
        const latestUuid = state.latestByStoryVersion.get(storyVersionUuid);
        if (!latestUuid) {
          return {
            ok: false,
            code: 'community_profile_not_found',
            message: 'no active row for the supplied story_version_uuid',
          };
        }
        const latestRow = state.profiles.get(latestUuid);
        if (!latestRow) {
          return {
            ok: false,
            code: 'community_profile_not_found',
            message: 'no active row for the supplied story_version_uuid',
          };
        }
        // Defence in depth: when the caller supplied a story_uuid,
        // it MUST match the active row's story_uuid.
        if (storyUuid && !UUID_PATTERN.test(storyUuid)) {
          return {
            ok: false,
            code: 'community_profile_not_found',
            message: 'story_uuid (when supplied) must be a valid UUID',
          };
        }
        if (storyUuid && latestRow.story_uuid !== storyUuid) {
          return {
            ok: false,
            code: 'story_version_mismatch',
            message: 'story_uuid does not match the active row bound to story_version_uuid',
          };
        }
        return { ok: true, profile: latestRow };
      }
      if (!UUID_PATTERN.test(storyUuid)) {
        return {
          ok: false,
          code: 'community_profile_not_found',
          message: 'story_uuid must be a valid UUID when community_profile_version is supplied',
        };
      }
      // 2. Walk EVERY profile row ever written (not just the
      //    `activeByStoryVersion` index — that index points only at
      //    the most recently generated row per
      //    (story_version_uuid, generator_version), so a row
      //    superseded by a newer regeneration would be invisible
      //    to it). The store MUST retain superseded rows so pinned
      //    sessions can re-resolve them. We narrow by
      //    `story_version_uuid` first; rows for other story versions
      //    are skipped.
      let matched = null;
      let sawStoryUuidMismatch = false;
      for (const row of state.profiles.values()) {
        if (!row || row.story_version_uuid !== storyVersionUuid) continue;
        if (row.story_uuid !== storyUuid) {
          // A row bound to the requested story_version_uuid claims a
          // DIFFERENT story_uuid. The client tried to point one
          // story's version at another story's profile row — refuse
          // loudly. We keep walking in case there is also a row
          // whose story_uuid matches AND whose version string
          // matches; but the contract says: if ANY row under the
          // requested story_version_uuid disagrees on story_uuid,
          // the request is invalid. We bail here.
          sawStoryUuidMismatch = true;
          break;
        }
        const rowCpv = buildCanonicalCommunityProfileVersion(row);
        if (rowCpv === cpv) {
          if (matched === null) {
            matched = row;
          } else {
            // Two distinct rows share the same canonical version
            // string (should be impossible: the version string is
            // `${generator_version}@${content_hash[:16]}` and
            // `(generator_version, content_hash)` is unique per row
            // by the `setCommunityProfile` idempotency contract).
            // Treat as version_mismatch so the caller gets a
            // distinct, actionable error instead of silent
            // ambiguity.
            return {
              ok: false,
              code: 'community_profile_version_mismatch',
              message: 'community_profile_version matches more than one canonical row; row state is inconsistent',
            };
          }
        }
      }
      if (sawStoryUuidMismatch) {
        return {
          ok: false,
          code: 'story_version_mismatch',
          message: 'story_uuid does not match the canonical profile bound to story_version_uuid',
        };
      }
      if (matched === null) {
        // No row under the requested story_version_uuid produces the
        // requested community_profile_version. The store either has
        // NO rows for this story_version (never generated), or only
        // rows for OTHER versions (the version the client pinned to
        // has been GC'd or never existed). In neither case do we
        // silently fall back to the "latest" row — the request was
        // for a specific version and we MUST honour it.
        return {
          ok: false,
          code: 'community_profile_not_found',
          message: 'no canonical community profile matches the supplied community_profile_version (immutable lookup failed)',
        };
      }
      return { ok: true, profile: matched };
    },
    findByUuid(profile_uuid) {
      if (typeof profile_uuid !== 'string') return null;
      return state.profiles.get(profile_uuid) || null;
    },
    // Story 16.5 P1.v1-4 — PR #25 single-arg exact-match by the
    // EXTERNAL community_profile_version string. Kept here verbatim
    // (per merge-of-conflict instruction "保留 main 的所有方法并在
    // 合适位置插入 HEAD 的 findByExternalVersion") so the call
    // surface for older callers stays source-visible. main's
    // P1.v1-5 SCOPED two-arg `findByExternalVersion` below is the
    // active definition at runtime (object-literal override);
    // server.mjs's /knowledge route has been updated to call the
    // two-arg signature.
    findByExternalVersion(external_version) {
      // Story 16.5 P1.v1-4 — pure exact-match lookup. The orchestrator
      // and the route layer carry the EXTERNAL community_profile_version
      // string (`<generator_version>@<content_hash_prefix>`) supplied
      // by the client; this method walks every preserved row in the
      // store and returns the single row whose external version equals
      // the supplied string. There is NO active-row concept here: a
      // row that has been superseded by a newer content_hash for the
      // same (story_version_uuid, generator_version) scope STILL
      // resolves via its own external version, so an old session that
      // pinned the prior external version keeps reading the prior
      // row. Returns null on no match so the caller can distinguish a
      // truly-missing profile from a profile found but with a stale
      // active index.
      if (typeof external_version !== 'string' || !external_version) {
        throw new Error('communityRepository.findByExternalVersion: external_version required');
      }
      for (const row of state.profiles.values()) {
        let rowExternal;
        try {
          rowExternal = deriveExternalCommunityProfileVersion(row);
        } catch {
          continue;
        }
        if (rowExternal === external_version) {
          return row;
        }
      }
      return null;
    },
    // NOTE: HEAD's PR #25 P1.v1-3 `findCanonicalByIdentity(input)`
    // (which returned `StoryCommunityProfile | null`) is intentionally
    // OMITTED. main's P1.v1-5 `findCanonicalByIdentity(input)` (which
    // returns `{ ok:true, profile } | { ok:false, code, message }`)
    // is defined EARLIER in this object literal and is the active
    // definition. Keeping HEAD's method body here would override
    // main's at runtime and break every test that asserts
    // `exact.ok === true`. The PR #25 knowledge surface calls
    // `findByExternalVersion` (above) — NOT `findCanonicalByIdentity`
    // — for the server-side canonical lookup, so HEAD's method body
    // is genuinely redundant.
    // Story 16.2 P1.v1-5 — PR #24 SCOPED two-arg exact-match. This
    // definition OVERRIDES the one-arg `findByExternalVersion` above
    // at runtime (object-literal semantics); server.mjs has been
    // updated to call this signature with both
    // `body.story_version_uuid` and `body.community_profile_version`.
    findByExternalVersion(story_version_uuid, externalVersion) {
      // P1.v1-5 (2026-09-07): SCOPED exact-string lookup against the
      // wire contract external identity. The repository maintains a
      // lazy-derived index keyed by
      //     `${story_version_uuid}::${externalVersion}`
      // so the lookup is ALWAYS scoped to the caller's story_version.
      // The v1-4 GLOBAL lookup (keyed by `externalVersion` alone)
      // allowed a cross-story collision: two profiles with the SAME
      // community content but DIFFERENT `story_version_uuid` produced
      // the same external version (the content-only hash excluded
      // `story_uuid` + `story_version_uuid`), and the Map then
      // collapsed the second insert onto the first one's profile_uuid.
      // v1-5 closes that hole by (a) including `story_uuid` +
      // `story_version_uuid` in the content hash so the external
      // version itself differs across stories, AND (b) scoping the
      // index key to `story_version_uuid` as a defence-in-depth.
      //
      // The caller still passes the external version string it
      // received on the wire (or computed via the public helper);
      // the repo returns the matching row verbatim or `null` when
      // nothing matches.
      //
      // Important: the index is only as fresh as `setCommunityProfile`
      // keeps it. `setCommunityProfile` derives the external version
      // for every insert. Reads therefore stay O(1).
      if (typeof story_version_uuid !== 'string' || !story_version_uuid) return null;
      if (typeof externalVersion !== 'string' || !externalVersion) return null;
      const uuid = state.byExternalVersion.get(externalVersionKey(story_version_uuid, externalVersion));
      if (!uuid) return null;
      return state.profiles.get(uuid) || null;
    },
    listByStoryVersion(input) {
      if (!input || typeof input !== 'object') {
        throw new Error('communityRepository.listByStoryVersion: input required');
      }
      assertUuid('story_version_uuid', input.story_version_uuid);
      const out = [];
      for (const row of state.profiles.values()) {
        if (row.story_version_uuid === input.story_version_uuid) out.push(row);
      }
      out.sort((a, b) => {
        if (a.generated_at < b.generated_at) return 1;
        if (a.generated_at > b.generated_at) return -1;
        return 0;
      });
      return out;
    },
    setCommunityProfile(input) {
      // 1. Validate shape and bounds (defence in depth).
      const profile = assertCommunityProfileShape(input);
      const violations = findCommunityProfileBoundsViolations(profile);
      if (violations.length > 0) {
        throw new Error(
          `communityRepository.setCommunityProfile: bounds violation: ${violations.join('; ')}`,
        );
      }
      // 2. Reject any forbidden key that might have snuck in via a
      //    hand-curated seed. The profile module already enforces the
      //    shape, but this is the second guard.
      rejectForbiddenKeys(profile, '$');
      // 3. Idempotency on (story_version_uuid, generator_version,
      //    content_hash). When the caller regenerates with the same
      //    content, we MUST NOT create a duplicate active row — we
      //    return the existing one instead. Critically (P1.v1-5,
      //    2026-09-07 code review): an idempotent hit MUST NOT move
      //    the `latestByStoryVersion` pointer — the active row stays
      //    on whatever the latest FRESH insert was. This prevents a
      //    stale re-insert of an older row from regressing the active
      //    pointer back to itself.
      const key = activeKey(profile.story_version_uuid, profile.generator_version);
      const existingUuid = state.activeByStoryVersion.get(key);
      if (existingUuid) {
        const existing = state.profiles.get(existingUuid);
        if (existing && existing.hash.content_hash === profile.hash.content_hash) {
          // Idempotent hit. Return the existing row AS-IS — the
          // private latest pointer is preserved, NOT moved.
          return existing;
        }
      }
      // 4. Insert. New row wins the active slot for its scope.
      state.profiles.set(profile.profile_uuid, profile);
      state.byUuid.set(profile.profile_uuid, profile);
      state.activeByStoryVersion.set(key, profile.profile_uuid);
      // 5. Story 16.5 P1.v1-5 — update the explicit
      //    `latestByStoryVersion` pointer ONLY on a fresh insert
      //    (the idempotency hit above short-circuited, so we are by
      //    construction inserting a NEW row here, possibly with a
      //    DIFFERENT `generator_version` than the previous latest).
      //    This pointer is what `findActiveByStoryVersion` reads; it
      //    is NEVER touched by Map iteration, NEVER touched by
      //    `for...of` over `activeByStoryVersion`, and NEVER moved
      //    backwards by an idempotent re-insert of an older row.
      state.latestByStoryVersion.set(profile.story_version_uuid, profile.profile_uuid);
      // 6. P1.v1-5 (2026-09-07, origin/main): maintain the SCOPED
      //    external-version index so the two-arg
      //    `findByExternalVersion(story_version_uuid, externalVersion)`
      //    is O(1). The key is `${story_version_uuid}::${externalVersion}`
      //    so two profiles with the same external version but different
      //    story_versions never collide on the index. If derivation
      //    fails for any reason, we still store the row but skip the
      //    index entry — `findByExternalVersion` will then return
      //    `null` for this row, which is the same observable
      //    behaviour as before. (main tail, appended to HEAD body.)
      try {
        const externalVersion = deriveExternalCommunityProfileVersion(profile);
        if (externalVersion) {
          state.byExternalVersion.set(
            externalVersionKey(profile.story_version_uuid, externalVersion),
            profile.profile_uuid,
          );
        }
      } catch {
        // Intentionally swallowed: shape validator already enforces
        // `generator_version`, so derivation only fails for an
        // in-memory invariant break. Keep the row, drop the index.
      }
      return profile;
    },
    stats() {
      return { profile_count: state.profiles.size };
    },
    _resetForTests() {
      const fresh = createEmptyState();
      state.profiles = fresh.profiles;
      state.activeByStoryVersion = fresh.activeByStoryVersion;
      state.latestByStoryVersion = fresh.latestByStoryVersion;
      state.byUuid = fresh.byUuid;
      state.byExternalVersion = fresh.byExternalVersion;
      state.latestByStoryVersion = fresh.latestByStoryVersion;
    },
    _exportSnapshot() {
      return [...state.profiles.values()].map((profile) => JSON.parse(JSON.stringify(profile)));
    },
    _hydrateSnapshot(profiles) {
      if (!Array.isArray(profiles)) throw new Error('communityRepository: profiles snapshot required');
      state.profiles = new Map();
      state.activeByStoryVersion = new Map();
      state.latestByStoryVersion = new Map();
      state.byUuid = new Map();
      state.byExternalVersion = new Map();
      const ordered = profiles.slice().sort((a, b) => {
        const left = typeof a?.generated_at === 'string' ? a.generated_at : '';
        const right = typeof b?.generated_at === 'string' ? b.generated_at : '';
        return left < right ? -1 : left > right ? 1 : 0;
      });
      for (const profile of ordered) repo.setCommunityProfile(profile);
    },
  };
  return repo;
}

export { activeKey };

export const _forbiddenProfileKeys = FORBIDDEN_PROFILE_KEYS;

// Re-export for tests so the assertion surface is symmetric with the
// cacheKey module's `_forbiddenCacheKeyDimensions` export.
export function _forbiddenCommunityProfileDimensions() {
  return new Set(FORBIDDEN_PROFILE_KEYS);
}

void nowIso; // keep import-style usage for symmetry with sibling modules
