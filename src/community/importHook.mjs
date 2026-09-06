// src/community/importHook.mjs — glue between the story import flow and
// the community-profile module.
//
// ClickUp 16.1 contract:
//   * `seedCommunityProfiles(repository, profileRepository)` is the
//     mock-import-time entry point: it iterates over every seeded
//     story_version and ensures an active community profile exists
//     for each. Stories with a curated seed (in COMMUNITY_FIXTURE_SEEDS)
//     get a deterministic, hand-curated profile; stories without a
//     curated seed get a deterministic stub built from the story
//     title + hook. In both cases the profile is stored under the
//     canonical generator_version, so subsequent reads via
//     `getCommunityProfile` return the same instance.
//   * The function is idempotent: a second call returns the existing
//     profile for each story_version without re-generating.
//
// The glue does NOT modify `storyService.importStoryAndEnsureCache` —
// it lives in its own module so the story import seam stays
// session/role-free and the community-profile module stays a clean
// standalone package. Callers that want pre-populated community
// profiles (test bootstrap, dev runtime) call this helper explicitly.

import { ensureCommunityProfile } from './service.mjs';
import { COMMUNITY_FIXTURE_SEEDS } from './fixtures.mjs';

/**
 * @typedef {import('../stories/repository.mjs').StoryRepository} StoryRepository
 * @typedef {import('./repository.mjs').CommunityProfileRepository} CommunityProfileRepository
 * @typedef {import('./profile.mjs').StoryCommunityProfile} StoryCommunityProfile
 */

/**
 * Pre-populate community profiles for every story_version currently in
 * the story repository. Returns the list of profiles that were
 * generated (an empty list when every story_version already had an
 * active profile).
 *
 * Stories whose slug is present in COMMUNITY_FIXTURE_SEEDS use the
 * curated seed verbatim; stories without a curated seed get a
 * deterministic stub from the story title + hook.
 *
 * @param {StoryRepository} repository
 * @param {CommunityProfileRepository} profileRepository
 * @returns {{ generated: StoryCommunityProfile[], reused: StoryCommunityProfile[] }}
 */
export function seedCommunityProfiles(repository, profileRepository) {
  if (!repository) throw new Error('seedCommunityProfiles: repository required');
  if (!profileRepository) {
    throw new Error('seedCommunityProfiles: profileRepository required');
  }
  /** @type {StoryCommunityProfile[]} */
  const generated = [];
  /** @type {StoryCommunityProfile[]} */
  const reused = [];
  const stories = repository.listStories();
  for (const storyRow of stories) {
    const versions = repository.listVersionsByStory(storyRow.story_uuid);
    for (const version of versions) {
      const detail = /** @type {any} */ (version.content_payload);
      const slug = storyRow.slug;
      const seed = Object.prototype.hasOwnProperty.call(COMMUNITY_FIXTURE_SEEDS, slug)
        ? COMMUNITY_FIXTURE_SEEDS[slug]
        : null;
      const before = profileRepository.findActiveByStoryVersion(version.version_uuid);
      const profile = ensureCommunityProfile({
        repository,
        profileRepository,
        story_version_uuid: version.version_uuid,
        story: detail,
        options: seed
          ? {
              source: 'mock-fixture',
              seed,
            }
          : { source: 'mock-generated' },
      });
      if (before && before.profile_uuid === profile.profile_uuid) {
        reused.push(profile);
      } else {
        generated.push(profile);
      }
    }
  }
  return { generated, reused };
}

/**
 * Ensure the community profile exists for a single story_version,
 * using the curated seed when the slug matches a fixture. Useful for
 * the server.mjs route layer when handling `/api/admin/stories/:slug/import`
 * and `/api/stories/:workId/ensure` so a freshly imported story has a
 * pre-built profile ready for the four ecology capabilities.
 *
 * The function is a no-op when the supplied profileRepository is null
 * (so a deployment that has not yet wired the community module does
 * not break).
 *
 * @param {object} input
 * @param {StoryRepository} input.repository
 * @param {CommunityProfileRepository | null} input.profileRepository
 * @param {string} input.slug
 * @param {string} input.story_version_uuid
 * @param {{ id: string, title: string, hook: string, [k: string]: unknown }} input.story
 * @returns {StoryCommunityProfile | null}
 */
export function ensureCommunityProfileForStoryVersion({
  repository,
  profileRepository,
  slug,
  story_version_uuid,
  story,
}) {
  if (!repository) throw new Error('ensureCommunityProfileForStoryVersion: repository required');
  if (!profileRepository) return null; // community module not wired yet — no-op
  if (typeof slug !== 'string') throw new Error('ensureCommunityProfileForStoryVersion: slug required');
  if (typeof story_version_uuid !== 'string') {
    throw new Error('ensureCommunityProfileForStoryVersion: story_version_uuid required');
  }
  const seed = Object.prototype.hasOwnProperty.call(COMMUNITY_FIXTURE_SEEDS, slug)
    ? COMMUNITY_FIXTURE_SEEDS[slug]
    : null;
  return ensureCommunityProfile({
    repository,
    profileRepository,
    story_version_uuid,
    story,
    options: seed
      ? {
          source: 'mock-fixture',
          seed,
        }
      : { source: 'mock-generated' },
  });
}
