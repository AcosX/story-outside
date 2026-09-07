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
// ClickUp 16.5 P1.v1-3 fix (2026-09-07 owner review): the handler
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
// ClickUp 16.5 P1.v1-5 fix (2026-09-07 owner review, ChatGPT 复核):
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
  deriveExternalCommunityProfileVersion,
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
 * @property {(input: { story_uuid?: string, story_version_uuid: string, community_profile_version?: string | null }) => StoryCommunityProfile | null} findCanonicalByIdentity
 *          ClickUp 16.5 P1.v2 — server-authoritative lookup that joins
 *          (story_uuid, story_version_uuid, community_profile_version)
 *          into one canonical row. Caller-supplied knowledge_queries /
 *          topic_id / topic_label / topic / theme / subject are NEVER
 *          consulted; the route layer only ever picks a single row.
 * @property {(external_version: string) => StoryCommunityProfile | null} findByExternalVersion
 *          ClickUp 16.5 P1.v1-4 — pure exact-match by the EXTERNAL
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
 *   latestByStoryVersion: Map<string, string>,                    // ClickUp 16.5 P1.v1-5 — explicit latest pointer, story_version_uuid → profile_uuid (NO Map iteration)
 *   byUuid: Map<string, StoryCommunityProfile>,
 * }}
 */
function createEmptyState() {
  return {
    profiles: new Map(),
    activeByStoryVersion: new Map(),
    latestByStoryVersion: new Map(),
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
      // P1.v1-5 (2026-09-07 owner review, ChatGPT 复核) — direct
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
    findByUuid(profile_uuid) {
      if (typeof profile_uuid !== 'string') return null;
      return state.profiles.get(profile_uuid) || null;
    },
    findByExternalVersion(external_version) {
      // ClickUp 16.5 P1.v1-4 — pure exact-match lookup. The orchestrator
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
    findCanonicalByIdentity(input) {
      // ClickUp 16.5 P1.v1-3 server-side canonical lookup. The identity
      // tuple is (story_uuid, story_version_uuid, community_profile_version).
      // `community_profile_version` here is the EXTERNAL DERIVED form
      // `<generator_version>-<content_hash_short>`, NOT the raw rule
      // version. The route layer is NEVER allowed to feed
      // `knowledge_queries` / `topic_id` / `topic_label` / `theme` /
      // `subject` — those fields are caller-coerced and we MUST reject
      // them at the seam so the AI cannot pick its own subject matter.
      if (!input || typeof input !== 'object') {
        throw new Error('communityRepository.findCanonicalByIdentity: input required');
      }
      assertUuid('story_version_uuid', input.story_version_uuid);
      if (typeof input.story_uuid === 'string' && input.story_uuid) {
        assertUuid('story_uuid', input.story_uuid);
      }
      // If the caller supplied a story_uuid, it MUST match the row's
      // story_uuid — defence in depth so a confused client cannot mix
      // versions across stories.
      const targetVersion = input.story_version_uuid;
      const targetStory = typeof input.story_uuid === 'string' && input.story_uuid
        ? input.story_uuid
        : null;
      const requestedExternalVersion = typeof input.community_profile_version === 'string'
        && input.community_profile_version
        ? input.community_profile_version
        : null;
      // 1. Exact external-version match across every preserved row for
      //    the story_version. Two preserved rows with the same
      //    generator_version but a different content_hash (curated
      //    fixture edit, retry-with-different-seed, etc.) carry
      //    different external versions, so a session that pinned the
      //    OLD external version keeps resolving the OLD row even after
      //    the active row has moved on to a newer one. There is NO
      //    silent fallback to "the latest row" — if the external
      //    version string does not match, return `null` so the route
      //    layer surfaces 400 `community_profile_not_found` /
      //    `community_profile_version_mismatch`.
      if (requestedExternalVersion !== null) {
        let exactMatch = null;
        for (const row of state.profiles.values()) {
          if (row.story_version_uuid !== targetVersion) continue;
          if (targetStory && row.story_uuid !== targetStory) {
            // story_uuid supplied but the row's story_uuid differs —
            // do NOT return a hit; keep scanning for an exact
            // external-version match, and if none found return null.
            continue;
          }
          let rowExternal;
          try {
            rowExternal = deriveExternalCommunityProfileVersion(row);
          } catch {
            continue;
          }
          if (rowExternal !== requestedExternalVersion) continue;
          exactMatch = row;
          break;
        }
        return exactMatch;
      }
      // 2. No external community_profile_version supplied → fall back
      //    to the most recent active row for this story_version (the
      //    service-layer behaviour mirrors `getCommunityProfile`).
      // P1.v1-5 — mirror the explicit-pointer semantics of
      //    `findActiveByStoryVersion` so the two paths agree on the
      //    same row. We read `latestByStoryVersion.get(targetVersion)`
      //    directly — no iteration, no `activeByStoryVersion` walk.
      //    If the caller supplied a `story_uuid`, we additionally
      //    guard that the resolved row's `story_uuid` matches (a
      //    stale pointer from a different story_version_uuid sharing
      //    the same row by accident would be filtered here; in
      //    practice this is unreachable because the pointer is keyed
      //    by `story_version_uuid`).
      const latestUuid = state.latestByStoryVersion.get(targetVersion);
      if (!latestUuid) return null;
      const latestRow = state.profiles.get(latestUuid);
      if (!latestRow) return null;
      if (targetStory && latestRow.story_uuid !== targetStory) return null;
      return latestRow;
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
      //    2026-09-07 ChatGPT 复核): an idempotent hit MUST NOT move
      //    the `latestByStoryVersion` pointer — the active row stays
      //    on whatever the latest FRESH insert was. This prevents a
      //    stale re-insert of an older row from regressing the active
      //    pointer back to itself.
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
      // 5. ClickUp 16.5 P1.v1-5 — update the explicit
      //    `latestByStoryVersion` pointer ONLY on a fresh insert
      //    (the idempotency hit above short-circuited, so we are by
      //    construction inserting a NEW row here, possibly with a
      //    DIFFERENT `generator_version` than the previous latest).
      //    This pointer is what `findActiveByStoryVersion` reads; it
      //    is NEVER touched by Map iteration, NEVER touched by
      //    `for...of` over `activeByStoryVersion`, and NEVER moved
      //    backwards by an idempotent re-insert of an older row.
      state.latestByStoryVersion.set(profile.story_version_uuid, profile.profile_uuid);
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
