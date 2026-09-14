// src/community/service.mjs — application-layer facade for community profiles.
//
// Story 16.1 contract:
//   * `ensureCommunityProfile({ repository, profileRepository, story,
//     story_version, options })` is the single import-time entry point.
//     When called for a story_version that already has an active
//     profile, it returns the existing profile (idempotent). When the
//     story_version is new OR the generator_version changed, a new
//     profile row is generated and stored. The previous row is kept.
//   * `getCommunityProfile({ profileRepository, story_version_uuid })`
//     is the read-side seam used by the four ecology capabilities
//     (Zhihu search, hot-list matching, Zhihu Knowledge, ending-page
//     search). It never re-runs the understanding pass; it just
//     returns the cached active profile for the story_version.
//   * `setCommunityProfile(...)` is the explicit admin/dev entry point
//     used by tests and operator tooling to install a hand-curated
//     profile. It routes through the repository's defensive
//     validation.
//
// The service does NOT call any external API and does NOT read any
// environment variable that looks like a credential.

import {
  buildCommunityProfileFromSeed,
  buildStubCommunityProfile,
  COMMUNITY_PROFILE_GENERATOR_VERSION,
  assertCommunityProfileShape,
} from './profile.mjs';

/**
 * @typedef {import('./profile.mjs').StoryCommunityProfile} StoryCommunityProfile
 * @typedef {import('./repository.mjs').CommunityProfileRepository} CommunityProfileRepository
 * @typedef {import('../stories/repository.mjs').StoryRepository} StoryRepository
 */

/**
 * @typedef {Object} CommunityProfileServiceOptions
 * @property {string} [locale]                      Default 'zh-CN'.
 * @property {string} [generator_version]           Override the rule version.
 * @property {object} [seed]                        Hand-curated seed. When
 *                                                 supplied, the seed is used
 *                                                 verbatim (mock-fixture
 *                                                 path). When omitted, a
 *                                                 stub profile is generated
 *                                                 from the story detail.
 * @property {'mock-fixture' | 'mock-generated' | 'real-generated' | 'manual'} [source]
 */

/**
 * Resolve the active community profile for a story_version. Pure
 * read; never re-runs the understanding pass.
 *
 * @param {object} input
 * @param {CommunityProfileRepository} input.profileRepository
 * @param {string} input.story_version_uuid
 * @param {string} [input.generator_version]   When supplied, narrows to a
 *                                             specific rule version. When
 *                                             omitted, returns the most
 *                                             recently generated active row.
 * @returns {StoryCommunityProfile | null}
 */
export function getCommunityProfile({ profileRepository, story_version_uuid, generator_version }) {
  if (!profileRepository) throw new Error('getCommunityProfile: profileRepository required');
  if (typeof story_version_uuid !== 'string') {
    throw new Error('getCommunityProfile: story_version_uuid required');
  }
  if (typeof generator_version === 'string' && generator_version) {
    return profileRepository.findActiveByStoryVersionAndGenerator(
      story_version_uuid,
      generator_version,
    );
  }
  return profileRepository.findActiveByStoryVersion(story_version_uuid);
}

/**
 * Ensure a community profile exists for a story_version. When one
 * already exists, returns it (idempotent). When none exists, generates
 * a new profile from the supplied seed (mock-fixture path) OR from
 * a stub built off the story detail (real-provider fallback path).
 *
 * This function is the only entry point that creates profiles.
 * Callers in `storyService.importStoryAndEnsureCache` invoke it once
 * after a successful story_version import so the four ecology
 * capabilities can read from a shared cache instead of re-running the
 * understanding pass per request.
 *
 * @param {object} input
 * @param {StoryRepository} input.repository              Story repository for
 *                                                       reading story_version
 *                                                       + checksum.
 * @param {CommunityProfileRepository} input.profileRepository
 * @param {string} input.story_version_uuid
 * @param {{ id: string, title: string, hook: string, [k: string]: unknown }} [input.story]
 * @param {CommunityProfileServiceOptions} [input.options]
 * @returns {StoryCommunityProfile}
 */
export function ensureCommunityProfile({
  repository,
  profileRepository,
  story_version_uuid,
  story,
  options,
}) {
  if (!repository) throw new Error('ensureCommunityProfile: repository required');
  if (!profileRepository) {
    throw new Error('ensureCommunityProfile: profileRepository required');
  }
  if (typeof story_version_uuid !== 'string') {
    throw new Error('ensureCommunityProfile: story_version_uuid required');
  }
  const version = repository.findVersion(story_version_uuid);
  if (!version) {
    throw new Error(`ensureCommunityProfile: unknown story_version '${story_version_uuid}'`);
  }
  const generator_version =
    (options && options.generator_version)
    || `${COMMUNITY_PROFILE_GENERATOR_VERSION.identifier}@${COMMUNITY_PROFILE_GENERATOR_VERSION.rules_version}`;
  // 1. Idempotent return when an active profile already exists AND its
  //    content_hash matches what the caller would produce. When the
  //    caller passes a seed that hashes to a DIFFERENT content_hash
  //    than the active row, we generate a new profile so a content
  //    change (e.g. a curated fixture edit) takes effect without an
  //    explicit admin step.
  const existing = profileRepository.findActiveByStoryVersionAndGenerator(
    story_version_uuid,
    generator_version,
  );
  if (existing && options && options.seed) {
    // Probe-build the would-be content so we can compare hashes
    // WITHOUT storing anything.
    const probe = buildCommunityProfileFromSeed({
      story_uuid: version.story_uuid,
      story_version_uuid: version.version_uuid,
      story_version_checksum: version.checksum,
      locale: options.locale,
      source: options.source || 'mock-fixture',
      generator_version,
      topics: options.seed.topics,
      queries: options.seed.queries,
      knowledge_queries: options.seed.knowledge_queries,
      hot_keywords: options.seed.hot_keywords,
    });
    if (existing.hash.content_hash === probe.hash.content_hash) {
      return existing;
    }
  } else if (existing) {
    return existing;
  }
  // 2. Generate. Two paths:
  //    a. Seed path (mock-fixture / admin): verbatim seed → known ids.
  //    b. Stub path (real-provider without curated seed): derive a
  //       deterministic stub from the story title/hook.
  let profile;
  if (options && options.seed) {
    profile = buildCommunityProfileFromSeed({
      story_uuid: version.story_uuid,
      story_version_uuid: version.version_uuid,
      story_version_checksum: version.checksum,
      locale: options.locale,
      source: (options && options.source) || 'mock-fixture',
      generator_version,
      topics: options.seed.topics,
      queries: options.seed.queries,
      knowledge_queries: options.seed.knowledge_queries,
      hot_keywords: options.seed.hot_keywords,
    });
  } else {
    if (!story || typeof story !== 'object') {
      throw new Error(
        'ensureCommunityProfile: story required when no seed is supplied',
      );
    }
    profile = buildStubCommunityProfile({
      story_uuid: version.story_uuid,
      story_version_uuid: version.version_uuid,
      story_version_checksum: version.checksum,
      story,
      generator_version,
      locale: options && options.locale,
      // Story 16.1 P2 fix (2026-09-06): propagate the caller's
      // `options.source` to the stub builder so a real-provider
      // import surfaces as `source: 'real-generated'`, not the
      // hard-coded 'mock-generated' default.
      source: options && options.source,
    });
  }
  return profileRepository.setCommunityProfile(profile);
}

/**
 * Explicit admin/dev install path. Mirrors `setOpeningCache` from the
 * stories module: the supplied profile must already satisfy the
 * public shape (handled by the repository). Used by tests and by
 * operator tooling to install a hand-curated profile out-of-band.
 *
 * @param {object} input
 * @param {CommunityProfileRepository} input.profileRepository
 * @param {StoryCommunityProfile} input.profile
 * @returns {StoryCommunityProfile}
 */
export function setCommunityProfile({ profileRepository, profile }) {
  if (!profileRepository) {
    throw new Error('setCommunityProfile: profileRepository required');
  }
  // The repository's `setCommunityProfile` enforces shape + bounds +
  // forbidden-key rejection; we still call `assertCommunityProfileShape`
  // here so a programmer error (typo, wrong type) is caught before
  // reaching the repository and gives a clearer stack trace.
  assertCommunityProfileShape(profile);
  return profileRepository.setCommunityProfile(profile);
}

/**
 * Story 16.5 P1.v2 server-authoritative canonical lookup. The route
 * layer must resolve a single profile row from the
 * (story_uuid, story_version_uuid, community_profile_version) tuple
 * and use that profile's `knowledge_queries` to drive the matcher.
 * The caller is NEVER allowed to supply `knowledge_queries` /
 * `topic_id` / `topic_label` / `topic` / `theme` / `subject` — those
 * fields are caller-coerced and would let the AI pick its own
 * subject matter, defeating the whole "community profile owns the
 * subject list" contract.
 *
 * Returns the canonical row or `null` when the identity is invalid.
 * The route layer maps `null` to a typed 400 (`community_profile_not_found`
 * / `community_profile_version_mismatch` / `story_version_mismatch`)
 * based on the failure shape — see src/server.mjs POST
 * /v1/ecosystem/knowledge.
 *
 * @param {object} input
 * @param {CommunityProfileRepository} input.profileRepository
 * @param {string} input.story_uuid                          UUID, optional but recommended.
 * @param {string} input.story_version_uuid                  UUID, required.
 * @param {string} [input.community_profile_version]         Optional. When supplied,
 *                                                            narrows to the row whose
 *                                                            `generator_version` equals
 *                                                            this string. The mismatch
 *                                                            path returns `null`.
 * @returns {StoryCommunityProfile | null}
 */
export function findCanonicalByIdentity({
  profileRepository,
  story_uuid,
  story_version_uuid,
  community_profile_version,
}) {
  if (!profileRepository) {
    throw new Error('findCanonicalByIdentity: profileRepository required');
  }
  if (typeof story_version_uuid !== 'string' || !story_version_uuid) {
    throw new Error('findCanonicalByIdentity: story_version_uuid required');
  }
  if (typeof story_uuid === 'string' && story_uuid) {
    if (typeof community_profile_version === 'string' && community_profile_version) {
      return profileRepository.findCanonicalByIdentity({
        story_uuid,
        story_version_uuid,
        community_profile_version,
      });
    }
    // story_uuid supplied but no community_profile_version — fall back
    // to the most recent active row for that story_version, but still
    // gate it on the supplied story_uuid so a wrong pair is rejected.
    return profileRepository.findCanonicalByIdentity({
      story_uuid,
      story_version_uuid,
      community_profile_version: null,
    });
  }
  if (typeof community_profile_version === 'string' && community_profile_version) {
    return profileRepository.findCanonicalByIdentity({
      story_version_uuid,
      community_profile_version,
    });
  }
  return profileRepository.findCanonicalByIdentity({
    story_version_uuid,
    community_profile_version: null,
  });
}

export {
  buildCommunityProfileFromSeed,
  buildStubCommunityProfile,
  assertCommunityProfileShape,
  COMMUNITY_PROFILE_GENERATOR_VERSION,
} from './profile.mjs';

export {
  createInMemoryCommunityProfileRepository,
  _forbiddenCommunityProfileDimensions,
} from './repository.mjs';

export {
  COMMUNITY_FIXTURE_SEEDS,
  getCommunityFixtureSeed,
  listCommunityFixtureSlugs,
} from './fixtures.mjs';
