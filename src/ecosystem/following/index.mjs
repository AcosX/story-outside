// src/ecosystem/following/index.mjs — public surface of the follow /
// share module.
//
// Other modules should import from here, not from the individual files.
// Mirrors the indirection pattern used by src/community/index.mjs and
// src/stories/index.mjs.

export {
  MOCK_FOLLOWING_FIXTURE_USERS,
  getMockFollowingIdentity,
  listMockFollowingIdentities,
} from './fixtures.mjs';

export {
  createInMemoryFollowingRepository,
} from './repository.mjs';

export {
  FollowingError,
  FOLLOWING_CACHE_TTL_MS,
  FOLLOWING_CACHE_SWR_MS,
  computeFriendTimelines,
  createFollowingService,
} from './service.mjs';