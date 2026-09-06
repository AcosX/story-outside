// src/community/index.mjs — public surface of the community-profile module.
//
// Other modules should import from here, not from the individual files.
// Mirrors the indirection pattern used by src/stories/index.mjs.
//
// ClickUp 16.1 contract:
//   * `ensureCommunityProfile` is the import-time entry point; the
//     four ecology capabilities call it via the application layer so
//     the profile is generated exactly once per story_version.
//   * `getCommunityProfile` is the read-side seam; never re-runs the
//     understanding pass.
//   * `setCommunityProfile` is the explicit install path (tests,
//     operator tooling).

export {
  assertCommunityProfileShape,
  buildCommunityProfileFromSeed,
  buildStubCommunityProfile,
  COMMUNITY_PROFILE_BOUNDS,
  COMMUNITY_PROFILE_GENERATOR_VERSION,
  deriveExternalCommunityProfileVersion,
  findCommunityProfileBoundsViolations,
} from './profile.mjs';

export {
  createInMemoryCommunityProfileRepository,
  _forbiddenCommunityProfileDimensions,
  _forbiddenProfileKeys,
  activeKey,
} from './repository.mjs';

export {
  COMMUNITY_FIXTURE_SEEDS,
  getCommunityFixtureSeed,
  listCommunityFixtureSlugs,
} from './fixtures.mjs';

export {
  ensureCommunityProfile,
  findCanonicalByIdentity,
  getCommunityProfile,
  setCommunityProfile,
} from './service.mjs';

export {
  ensureCommunityProfileForStoryVersion,
  seedCommunityProfiles,
} from './importHook.mjs';
