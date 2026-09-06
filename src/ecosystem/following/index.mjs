// src/ecosystem/following/index.mjs — public façade for the follow /
// share surface (ClickUp 16.3 P1 v2).

export {
  MOCK_FOLLOWING_FIXTURE_USERS,
  getMockFollowingIdentity,
  listMockFollowingIdentities,
  isValidUserUuid,
} from './fixtures.mjs';

export {
  createInMemoryFollowingRepository,
} from './repository.mjs';

export {
  FollowingError,
  FOLLOWING_CACHE_TTL_MS,
  computeFriendTimelines,
  createFollowingService,
} from './service.mjs';