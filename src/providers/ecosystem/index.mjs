// src/providers/ecosystem/index.mjs — public surface of the ecosystem
// (ClickUp 16.3) module.
//
// Re-exports the DTO + service + cache + adapter + provider factories so
// the route layer imports a single namespace.

export {
  adaptZhihuFollowingFeedPayload,
  adaptZhihuFolloweesPayload,
  createShortTtlCache,
  ECOSYSTEM_ERROR_CODES,
  FOLLOWING_DEFAULT_TTL_MS,
  FOLLOWING_FEED_SOURCE,
  FOLLOWING_MAX_TTL_MS,
  FOLLOWING_MIN_TTL_MS,
  intersectFollowingsWithLocalIdentities,
  isTimelineShareable,
  normaliseFollowIdentity,
  normaliseFollowingFeedItem,
  normaliseFollowingListItem,
  normaliseFriendTimeline,
  shareSessionTimeline as _shareStateFn,
  unshareSessionTimeline as _unshareStateFn,
} from './following.mjs';

export { createEcosystemService } from './service.mjs';

export {
  ECOSYSTEM_FIXTURE_FOLLOWINGS,
  ECOSYSTEM_FIXTURE_FEED,
  ECOSYSTEM_FIXTURE_IDENTITIES,
  ECOSYSTEM_FIXTURE_TIMELINES,
  getEcosystemFixtureIdentity,
  getEcosystemFixtureTimeline,
} from './fixtures.mjs';

export { createMockEcosystemProvider } from './mockProvider.mjs';
export { createRealZhihuEcosystemProvider } from './realProvider.mjs';
export { resolveEcosystemProvider, __resetEcosystemProviderForTests } from './selector.mjs';

export {
  shareSessionTimeline,
  unshareSessionTimeline,
  getSessionShareState,
} from './sessionShare.mjs';