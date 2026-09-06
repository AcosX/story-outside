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
 * }}
 */
function createEmptyState() {
  return {
    profiles: new Map(),
    activeByStoryVersion: new Map(),
    byUuid: new Map(),
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
      // Walk the activeByStoryVersion index; pick the most recently
      // generated profile when multiple generator versions exist.
      let bestProfile = null;
      for (const [key, profileUuid] of state.activeByStoryVersion.entries()) {
        const [sv, generator] = key.split('|');
        if (sv !== story_version_uuid) continue;
        const row = state.profiles.get(profileUuid);
        if (!row) continue;
        if (bestProfile === null) {
          bestProfile = row;
          continue;
        }
        if (row.generated_at > bestProfile.generated_at) {
          bestProfile = row;
        }
        // Tie-break: larger generator_version wins so a rule bump
        // immediately retires the previous generation for new reads.
        if (
          row.generated_at === bestProfile.generated_at
          && row.generator_version > bestProfile.generator_version
        ) {
          bestProfile = row;
        }
      }
      return bestProfile;
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
     * ClickUp 16.2 P1.v2 fix (2026-09-07): server-authoritative
     * resolution of the canonical StoryCommunityProfile.
     *
     * Returns the row whose:
     *   * `profile.story_version_uuid === story_version_uuid`
     *   * `profile.story_uuid === story_uuid` (defence in depth:
     *     client cannot point one story's version at another story's
     *     profile)
     *   * `${profile.generator_version}@${profile.hash.content_hash[:16]}`
     *     matches `community_profile_version` byte-for-byte.
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
      // 2. Walk every profile row bound to the requested
      //    story_version_uuid. The index is keyed by
      //    `${story_version_uuid}|${generator_version}` so this is
      //    O(active_generator_versions_for_this_version).
      let candidate = null;
      for (const [key, profileUuid] of state.activeByStoryVersion.entries()) {
        const [sv] = key.split('|');
        if (sv !== storyVersionUuid) continue;
        const row = state.profiles.get(profileUuid);
        if (!row) continue;
        if (row.story_uuid !== storyUuid) {
          // Client tried to point a story_version at a profile bound
          // to a DIFFERENT story — refuse loudly.
          return {
            ok: false,
            code: 'story_version_mismatch',
            message: 'story_uuid does not match the canonical profile bound to story_version_uuid',
          };
        }
        if (candidate === null || row.generated_at > candidate.generated_at) {
          candidate = row;
        }
      }
      if (candidate === null) {
        return {
          ok: false,
          code: 'community_profile_not_found',
          message: 'no canonical community profile bound to the supplied story_version_uuid',
        };
      }
      const canonicalVersion = buildCanonicalCommunityProfileVersion(candidate);
      if (canonicalVersion !== cpv) {
        return {
          ok: false,
          code: 'community_profile_version_mismatch',
          message: 'community_profile_version does not match the canonical version for the bound profile',
        };
      }
      return { ok: true, profile: candidate };
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
      //    return the existing one instead.
      const key = activeKey(profile.story_version_uuid, profile.generator_version);
      const existingUuid = state.activeByStoryVersion.get(key);
      if (existingUuid) {
        const existing = state.profiles.get(existingUuid);
        if (existing && existing.hash.content_hash === profile.hash.content_hash) {
          return existing;
        }
      }
      // 4. Insert. New row wins the active slot for its scope.
      state.profiles.set(profile.profile_uuid, profile);
      state.byUuid.set(profile.profile_uuid, profile);
      state.activeByStoryVersion.set(key, profile.profile_uuid);
      return profile;
    },
    stats() {
      return { profile_count: state.profiles.size };
    },
    _resetForTests() {
      const fresh = createEmptyState();
      state.profiles = fresh.profiles;
      state.activeByStoryVersion = fresh.activeByStoryVersion;
      state.byUuid = fresh.byUuid;
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
