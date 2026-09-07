// src/community/repository.mjs — in-memory store for story_version-scoped
// community profiles (ClickUp 16.1).
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
// The module does not read env vars that look like credentials and
// does not call any external API.

import {
  assertCommunityProfileShape,
  findCommunityProfileBoundsViolations,
} from './profile.mjs';

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
 * @property {(input: { story_version_uuid: string }) => StoryCommunityProfile[]} listByStoryVersion
 * @property {(input: StoryCommunityProfile) => StoryCommunityProfile} setCommunityProfile
 * @property {() => { profile_count: number }} stats
 * @property {() => void} _resetForTests
 */

/**
 * Build a fresh in-memory state. Pure factory.
 * @returns {{
 *   profiles: Map<string, StoryCommunityProfile>,                 // keyed by profile_uuid
 *   activeByStoryVersion: Map<string, string>,                    // story_version_uuid|generator_version → profile_uuid
 *   byUuid: Map<string, StoryCommunityProfile>,
 *   latestByStoryVersion: Map<string, string>,                    // story_version_uuid → profile_uuid of the most recently inserted row (PRIVATE; not a row field)
 * }}
 */
function createEmptyState() {
  return {
    profiles: new Map(),
    activeByStoryVersion: new Map(),
    byUuid: new Map(),
    // ClickUp 16.2 P1.v1-5 fix (2026-09-07): the monotonic/latest
    // metadata that drives active-row selection lives in PRIVATE
    // repository state. The previous v1-4 implementation stamped a
    // numeric `insert_seq` onto every row and made it part of the
    // canonical schema (which is owned by ClickUp 16.1 / main), turning
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
 * ClickUp 16.2 P1.v2 fix (2026-09-07): this helper is the SINGLE
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
 * Build a fresh in-memory CommunityProfileRepository. Pure factory.
 * @returns {CommunityProfileRepository}
 */
export function createInMemoryCommunityProfileRepository() {
  const state = createEmptyState();
  /** @type {CommunityProfileRepository} */
  const repo = {
    findActiveByStoryVersion(story_version_uuid) {
      assertUuid('story_version_uuid', story_version_uuid);
      // ClickUp 16.2 P1.v1-5 fix (2026-09-07 主人巡检 + ChatGPT
      // 复核): the previous v1-4 implementation walked
      // `state.profiles` and compared per-row `insert_seq` fields
      // to pick the active row. v1-5 replaces that surface-level
      // computation with a single private lookup:
      //
      //   active_row = state.latestByStoryVersion.get(story_version_uuid)
      //
      // `latestByStoryVersion` is updated ONLY when
      // `setCommunityProfile` accepts a NEW row (one that does not
      // collapse on the existing-row same-content-hash idempotency
      // contract). Idempotent re-inserts do NOT touch it, so the
      // active row stays pinned across retries. This makes the
      // "second new insert wins under same generated_at" contract
      // robust against:
      //
      //   * caller-supplied randomness in `profile_uuid` (UUID v4),
      //   * lexicographic ties on `generated_at` (Date#toISOString
      //     has millisecond resolution),
      //   * free-form `generator_version` strings.
      //
      // The previous v1-4 row-stamped `insert_seq` field is GONE:
      // monotonic/latest metadata is no longer carried on the row.
      // The canonical 13-field profile schema is preserved end-to-
      // end. The Map lives in PRIVATE repository state and is never
      // exposed through any public API.
      const latestUuid = state.latestByStoryVersion.get(story_version_uuid);
      if (!latestUuid) return null;
      return state.profiles.get(latestUuid) || null;
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
     * ClickUp 16.2 P1.v2 fix (2026-09-07) — REVISED 2026-09-07 04:21
     * (主人巡检): server-authoritative, IMMUTABLE lookup of a
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
      if (!UUID_PATTERN.test(storyUuid) || !UUID_PATTERN.test(storyVersionUuid) || !cpv) {
        return {
          ok: false,
          code: 'community_profile_not_found',
          message: 'story_uuid, story_version_uuid, community_profile_version are all required and must be valid',
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
      //    return the existing one instead. This is the critical
      //    P1.v1-5 contract: an idempotent hit MUST NOT move the
      //    `latestByStoryVersion` pointer. If it did, the "second
      //    new insert wins under same generated_at" guarantee would
      //    be undone by any caller that retries `findOrCreate`
      //    against the already-active row.
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
      // 4. Insert. ClickUp 16.2 P1.v1-5 (2026-09-07): the row is
      //    stored AS-IS (no `insert_seq` stamp; the canonical
      //    13-field schema is preserved). The
      //    `latestByStoryVersion` private Map is moved to the
      //    newly-inserted row's `profile_uuid`, so a subsequent
      //    `findActiveByStoryVersion` returns this row regardless
      //    of `generated_at` ties or UUID v4 randomness. A row
      //    inserted under a fresh `generator_version` still moves
      //    the latest pointer past any earlier row's value
      //    (regardless of generator_version), because the pointer
      //    is scoped to `story_version_uuid`, not to
      //    `(story_version, generator_version)`. This guarantees
      //    the "second new insert wins" contract no matter how
      //    the caller partitions the active slot.
      const stored = /** @type {any} */ ({ ...profile });
      state.profiles.set(stored.profile_uuid, stored);
      state.byUuid.set(stored.profile_uuid, stored);
      state.activeByStoryVersion.set(key, stored.profile_uuid);
      // Move the private latest pointer to the freshly-inserted
      // row. Idempotent hits (handled above) DO NOT touch this Map
      // — that is the entire point of separating it from the row
      // surface.
      state.latestByStoryVersion.set(stored.story_version_uuid, stored.profile_uuid);
      return stored;
    },
    stats() {
      return { profile_count: state.profiles.size };
    },
    _resetForTests() {
      const fresh = createEmptyState();
      state.profiles = fresh.profiles;
      state.activeByStoryVersion = fresh.activeByStoryVersion;
      state.byUuid = fresh.byUuid;
      state.latestByStoryVersion = fresh.latestByStoryVersion;
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
