// src/stories/storyService.mjs — application-layer facade for story import,
// version creation, opening-cache generation, and session snapshot pinning.
//
// ClickUp 04 contract:
//   * importStoryFromProvider takes a provider DTO, normalises it, computes
//     the canonical hash, and creates a new story_version only when the
//     hash differs from any existing row for that story. Old versions stay.
//   * ensureOpeningCache makes sure the (story, version, profile) has a
//     valid public opening cache, generating it lazily if missing. The
//     function is idempotent and safe to call from many concurrent reads.
//   * Failure during generation is captured and recorded on a `failed` row;
//     the previously-valid cache (if any) is left untouched. Subsequent
//     retries reuse the same generation_hash and overwrite the failed row.
//   * startSessionSnapshot pins story_version_id (and the opening cache
//     that the session will read). Subsequent reads MUST go through this
//     snapshot — never against the latest upstream DTO.
//   * markFirstChoiceConsumed records the first ask_player_choice on a
//     SESSION and returns a session-local consumed marker. It NEVER
//     invalidates the shared story/version opening cache: another session
//     may still read and cache the same public opening.
//
// This module is the seam between the provider layer and the application
// state. It does not write to MariaDB and does not load any secrets.

import { canonicalStoryContent, canonicalStoryHash } from './canonicalHash.mjs';
import { deriveOpeningCacheKey } from './cacheKey.mjs';
import { generateOpeningCache } from './openingGenerator.mjs';

/**
 * @typedef {import('../providers/dto.mjs').StoryDetail} StoryDetail
 * @typedef {import('../providers/dto.mjs').StorySummary} StorySummary
 * @typedef {import('./openingGenerator.mjs').OpeningCachePayload} OpeningCachePayload
 * @typedef {import('./repository.mjs').StoryRepository} StoryRepository
 */

/**
 * @typedef {Object} GenerationProfile
 * @property {string} identifier
 * @property {string} rules_version
 * @property {string} [locale]
 * @property {string} [variant]        Public allow-listed cache variant.
 */

/**
 * @typedef {Object} SessionSnapshot
 * @property {string} session_uuid
 * @property {string} story_uuid
 * @property {string} story_version_uuid
 * @property {string} story_version_checksum
 * @property {string} opening_cache_uuid     nullable until ensureOpeningCache runs
 * @property {string|null} opening_cache_status
 * @property {string|null} opening_cache_content_hash
 * @property {string} role_id
 * @property {string} user_ref
 * @property {string} created_at
 */

/**
 * @typedef {Object} ImportStoryResult
 * @property {string} story_uuid
 * @property {string} story_version_uuid
 * @property {number} version_no
 * @property {string} checksum
 * @property {boolean} version_reused
 * @property {boolean} cache_reused
 * @property {string|null} opening_cache_uuid
 * @property {string|null} opening_cache_status
 */

/**
 * Default generation profile used for the public opening cache.
 * @returns {GenerationProfile}
 */
export function defaultGenerationProfile() {
  return {
    identifier: 'opening-default',
    rules_version: 'opening-rules/1',
    locale: 'zh-CN',
    variant: 'default',
  };
}

/**
 * @param {object} input
 * @param {StoryRepository} input.repository
 * @param {object} [input.provider]       Object exposing `getStory` (StoryProvider). Optional.
 * @param {string} input.slug
 * @param {string} input.story_uuid
 * @param {GenerationProfile} [input.profile]
 * @returns {Promise<ImportStoryResult>}
 */
export async function importStory({ repository, provider, slug, story_uuid, profile }) {
  if (!repository) throw new Error('importStory: repository required');
  if (!provider || typeof provider.getStory !== 'function') {
    throw new Error('importStory: provider with getStory required');
  }
  if (typeof slug !== 'string' || !slug) {
    throw new Error('importStory: slug required');
  }
  if (typeof story_uuid !== 'string' || !story_uuid) {
    throw new Error('importStory: story_uuid required');
  }
  const detail = await provider.getStory(slug);
  const canonical = canonicalStoryContent(detail);
  if (canonical.id !== slug) {
    throw new Error(
      `importStory: provider returned story id '${canonical.id}' but slug '${slug}' was requested`,
    );
  }
  // Upsert story catalog row (idempotent; same UUID + slug).
  repository.upsertStory({
    story_uuid,
    slug,
    title: canonical.title,
    hook: canonical.hook,
    locale: 'zh-CN',
  });
  const { version, reused } = repository.importVersion({
    story_uuid,
    story_detail: canonical,
    roles_payload: canonical.roles,
    source_ref: provider.name || null,
  });

  // Touch the cache so callers can verify whether the import produced a
  // brand-new public opening or hit the existing one. We do NOT generate
  // here — generation is explicit (ensureOpeningCache) so admin can choose.
  let cache = repository.findOpeningCacheByScope(
    version.story_uuid,
    version.version_uuid,
    'default',
    deriveOpeningCacheKey({
      story_uuid: version.story_uuid,
      story_version_uuid: version.version_uuid,
      opening_key: 'default',
      profile: profile || defaultGenerationProfile(),
    }),
  );
  const cache_reused = !!cache;
  /** @type {ImportStoryResult} */
  const result = {
    story_uuid: version.story_uuid,
    story_version_uuid: version.version_uuid,
    version_no: version.version_no,
    checksum: version.checksum,
    version_reused: reused,
    cache_reused,
    opening_cache_uuid: cache ? cache.cache_uuid : null,
    opening_cache_status: cache ? cache.status : null,
  };
  return result;
}

/**
 * @typedef {Object} ImportStoryWithCacheResult
 * @property {string} story_uuid
 * @property {string} story_version_uuid
 * @property {number} version_no
 * @property {string} checksum
 * @property {boolean} version_reused
 * @property {string} opening_cache_uuid
 * @property {string} opening_cache_status
 * @property {boolean} cache_reused       true if the cache already existed (reused) vs newly generated.
 */

/**
 * Application-layer flow that closes the "import → bootstrap session" loop.
 *
 * 1. Runs the same canonical import pipeline as importStory().
 * 2. Then runs ensureOpeningCache() so the returned result always carries
 *    a non-null opening_cache_uuid / status.
 *
 * Without this closure the import route returned cache_reused=true but a
 * null opening_cache_uuid, and the frontend bootstrap (which needs the
 * cache_uuid to start a session) failed with `invalid_cache`.
 *
 * @param {object} input
 * @param {StoryRepository} input.repository
 * @param {object} input.provider          Object exposing `getStory` (StoryProvider).
 * @param {string} input.slug
 * @param {string} input.story_uuid
 * @param {GenerationProfile} [input.profile]
 * @returns {Promise<ImportStoryWithCacheResult>}
 */
export async function importStoryAndEnsureCache({ repository, provider, slug, story_uuid, profile }) {
  if (!repository) throw new Error('importStoryAndEnsureCache: repository required');
  if (!provider || typeof provider.getStory !== 'function') {
    throw new Error('importStoryAndEnsureCache: provider with getStory required');
  }
  if (typeof slug !== 'string' || !slug) {
    throw new Error('importStoryAndEnsureCache: slug required');
  }
  if (typeof story_uuid !== 'string' || !story_uuid) {
    throw new Error('importStoryAndEnsureCache: story_uuid required');
  }
  const imported = await importStory({
    repository,
    provider,
    slug,
    story_uuid,
    profile,
  });
  const ensured = await ensureOpeningCache({
    repository,
    story_version_uuid: imported.story_version_uuid,
    options: { profile: profile || defaultGenerationProfile() },
  });
  /** @type {ImportStoryWithCacheResult} */
  const result = {
    story_uuid: imported.story_uuid,
    story_version_uuid: imported.story_version_uuid,
    version_no: imported.version_no,
    checksum: imported.checksum,
    version_reused: imported.version_reused,
    opening_cache_uuid: ensured.cache.cache_uuid,
    opening_cache_status: ensured.cache.status,
    cache_reused: ensured.reused,
  };
  return result;
}

/**
 * @typedef {Object} EnsureOpeningOptions
 * @property {GenerationProfile} [profile]
 * @property {string} [opening_key]
 * @property {(input: { story: StoryDetail, profile: GenerationProfile }) => OpeningCachePayload} [generator]
 *           Optional generator override (for tests / future LLM). Defaults
 *           to the built-in pure generator.
 * @property {boolean} [force]          When true, replace the existing cache
 *                                     (admin rebuild). Requires a fresh
 *                                     generation_hash (i.e. different
 *                                     rules_version/identifier/locale) OR
 *                                     an explicit replace strategy.
 * @property {'in_place' | 'new_generation'} [replace_strategy]
 *                                     When force=true and a valid cache
 *                                     already exists:
 *                                       'new_generation' → caller must pass
 *                                       a profile with a different
 *                                       identifier or rules_version.
 *                                       'in_place' → caller is asserting
 *                                       the new payload is the SAME
 *                                       generation; we verify the content
 *                                       hash and update last_used_at only.
 */

/**
 * @param {object} input
 * @param {StoryRepository} input.repository
 * @param {string} input.story_version_uuid
 * @param {EnsureOpeningOptions} [input.options]
 * @returns {Promise<{ cache: object, reused: boolean, regenerated: boolean }>}
 */
export async function ensureOpeningCache({ repository, story_version_uuid, options }) {
  if (!repository) throw new Error('ensureOpeningCache: repository required');
  if (typeof story_version_uuid !== 'string') {
    throw new Error('ensureOpeningCache: story_version_uuid required');
  }
  const version = repository.findVersion(story_version_uuid);
  if (!version) throw new Error('ensureOpeningCache: unknown story_version');
  const profile = (options && options.profile) || defaultGenerationProfile();
  const opening_key = (options && options.opening_key) || 'default';
  const generation_hash = deriveOpeningCacheKey({
    story_uuid: version.story_uuid,
    story_version_uuid: version.version_uuid,
    opening_key,
    profile,
  });
  const existing = repository.findOpeningCacheByScope(
    version.story_uuid,
    version.version_uuid,
    opening_key,
    generation_hash,
  );
  if (existing && existing.status === 'valid' && !(options && options.force)) {
    return { cache: existing, reused: true, regenerated: false };
  }

  // Build a "story" object shaped for the generator. The generator only
  // needs { id, title, hook, roles, beats }; we pass the canonical content.
  /** @type {any} */
  const story = version.content_payload;
  const generator =
    (options && options.generator) ||
    ((args) =>
      generateOpeningCache({
        story_uuid: args.profile ? version.story_uuid : version.story_uuid,
        story_version_uuid: version.version_uuid,
        opening_key,
        profile: args.profile || profile,
        story: args.story,
      }));
  let payload;
  try {
    payload = await generator({ story, profile });
  } catch (err) {
    // Record the failure so subsequent retries can observe it. The valid
    // cache (if any) for this scope is NOT overwritten: the call will throw
    // and the caller is expected to retry.
    repository.upsertOpeningCache({
      story_uuid: version.story_uuid,
      story_version_uuid: version.version_uuid,
      opening_key,
      status: 'failed',
      content_payload: { error: 'generation_failed', message: String(err && err.message || err) },
      content_hash: '',
      generation_profile: profile,
      generation_hash,
      use_count: 0,
      last_used_at: null,
      invalidated_at: null,
      invalidated_reason: null,
      expires_at: null,
    });
    const e = new Error(
      `ensureOpeningCache: generation failed: ${err && err.message ? err.message : err}`,
    );
    e.cause = err;
    throw e;
  }

  if (options && options.force) {
    const strategy = options.replace_strategy || 'new_generation';
    if (strategy === 'new_generation') {
      // Caller already chose a different profile/identifier (which means
      // generation_hash above is different from the existing one). The
      // existing valid row stays in the table; we add a new valid row.
    } else if (strategy === 'in_place') {
      if (existing && existing.status === 'valid') {
        if (existing.content_hash !== payload.hash.content_hash) {
          throw new Error(
            'ensureOpeningCache: in_place replace requires identical content_hash. ' +
              'Use replace_strategy=new_generation with a different rules_version.',
          );
        }
        existing.last_used_at = new Date().toISOString();
        return { cache: existing, reused: true, regenerated: false };
      }
    } else {
      throw new Error(`ensureOpeningCache: unknown replace_strategy '${strategy}'`);
    }
  }

  const cache = repository.upsertOpeningCache({
    story_uuid: version.story_uuid,
    story_version_uuid: version.version_uuid,
    opening_key,
    status: 'valid',
    content_payload: payload,
    content_hash: payload.hash.content_hash,
    generation_profile: profile,
    generation_hash,
    use_count: existing && existing.status === 'valid' ? existing.use_count : 0,
    last_used_at: null,
    invalidated_at: null,
    invalidated_reason: null,
    expires_at: null,
  });
  return { cache, reused: !!existing && existing.status === 'valid', regenerated: !!existing && existing.status !== 'valid' };
}

/**
 * Start a session snapshot. Pins story_version_id and the current opening
 * cache uuid so subsequent reads on this session are isolated from later
 * upstream changes.
 *
 * Fail-closed validation: the supplied story_uuid MUST match the version
 * row and the role MUST exist in that pinned version. Invalid identifiers
 * are rejected before any state is captured.
 *
 * @param {object} input
 * @param {StoryRepository} input.repository
 * @param {string} input.session_uuid
 * @param {string} input.story_uuid
 * @param {string} input.story_version_uuid
 * @param {string} input.user_ref
 * @param {string} input.role_id
 * @returns {SessionSnapshot}
 */
export function startSessionSnapshot({ repository, session_uuid, story_uuid, story_version_uuid, user_ref, role_id }) {
  if (!repository) throw new Error('startSessionSnapshot: repository required');
  if (!session_uuid || !story_uuid || !story_version_uuid || !user_ref || !role_id) {
    throw new Error('startSessionSnapshot: session_uuid, story_uuid, story_version_uuid, user_ref, role_id required');
  }
  if (!UUID_PATTERN.test(session_uuid)) {
    throw new Error('startSessionSnapshot: session_uuid must be a UUID');
  }
  if (!UUID_PATTERN.test(story_uuid)) {
    throw new Error('startSessionSnapshot: story_uuid must be a UUID');
  }
  if (!UUID_PATTERN.test(story_version_uuid)) {
    throw new Error('startSessionSnapshot: story_version_uuid must be a UUID');
  }
  const version = repository.findVersion(story_version_uuid);
  if (!version) throw new Error('startSessionSnapshot: unknown story_version');
  if (version.story_uuid !== story_uuid) {
    throw new Error(
      `startSessionSnapshot: story_uuid '${story_uuid}' does not match story_version '${version.story_uuid}'`,
    );
  }
  const roles = Array.isArray(version.roles_payload) ? version.roles_payload : [];
  if (!roles.some((r) => r && r.id === role_id)) {
    throw new Error(`startSessionSnapshot: role_id '${role_id}' is not a role of the pinned story_version`);
  }
  const profile = defaultGenerationProfile();
  const generation_hash = deriveOpeningCacheKey({
    story_uuid,
    story_version_uuid,
    opening_key: 'default',
    profile,
  });
  const openingCache = repository.findOpeningCacheByScope(
    story_uuid,
    story_version_uuid,
    'default',
    generation_hash,
  );
  /** @type {SessionSnapshot} */
  return {
    session_uuid,
    story_uuid,
    story_version_uuid,
    story_version_checksum: version.checksum,
    opening_cache_uuid: openingCache ? openingCache.cache_uuid : null,
    opening_cache_status: openingCache ? openingCache.status : null,
    opening_cache_content_hash: openingCache ? openingCache.content_hash : null,
    role_id,
    user_ref,
    created_at: new Date().toISOString(),
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mark the first ask_player_choice consumed by a session. The shared
 * opening cache stays valid for every other session; this marker only stops
 * THIS session from continuing to import/advance the public opening.
 *
 * The in-memory repository has no persistent game_sessions table, so it
 * returns an explicit session-local consumed marker with the snapshot's
 * cache uuid for observability. A MariaDB DAO can persist the same marker
 * to game_sessions.first_choice_at.
 *
 * @param {object} input
 * @param {StoryRepository} input.repository
 * @param {SessionSnapshot} input.snapshot
 * @param {string} [input.reason]      Defaults to 'first_ask_player_choice'.
 */
export function markFirstChoiceConsumed({ repository, snapshot, reason }) {
  if (!repository) throw new Error('markFirstChoiceConsumed: repository required');
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('markFirstChoiceConsumed: snapshot required');
  }
  if (!snapshot.session_uuid || typeof snapshot.session_uuid !== 'string') {
    throw new Error('markFirstChoiceConsumed: snapshot.session_uuid required');
  }
  return repository.recordSessionFirstChoice({
    session_uuid: snapshot.session_uuid,
    opening_cache_uuid: snapshot.opening_cache_uuid || null,
    reason: reason || 'first_ask_player_choice',
  });
}

/**
 * Admin/dev entrypoint: rebuild an opening cache for a story_version. The
 * new cache lives alongside the old one under a new generation_hash, so the
 * rebuild is non-destructive: old cached openings remain available until
 * naturally invalidated by first-choice events.
 *
 * @param {object} input
 * @param {StoryRepository} input.repository
 * @param {string} input.story_version_uuid
 * @param {GenerationProfile} input.profile
 * @returns {Promise<object>}
 */
export async function rebuildOpeningCache({ repository, story_version_uuid, profile }) {
  if (!repository) throw new Error('rebuildOpeningCache: repository required');
  if (!story_version_uuid) throw new Error('rebuildOpeningCache: story_version_uuid required');
  if (!profile) throw new Error('rebuildOpeningCache: profile required');
  return ensureOpeningCache({
    repository,
    story_version_uuid,
    options: { profile, force: true, replace_strategy: 'new_generation' },
  });
}

export { canonicalStoryContent, canonicalStoryHash };