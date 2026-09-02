// src/stories/index.mjs — public surface of the stories application layer.
//
// Other modules should import from here, not from the individual files.
// This indirection lets us reorganise internals without breaking call sites.

export {
  canonicalJsonStringify,
  canonicalSha256,
  canonicalStoryContent,
  canonicalStoryHash,
} from './canonicalHash.mjs';
export { deriveOpeningCacheKey, _forbiddenCacheKeyDimensions } from './cacheKey.mjs';
export { generateOpeningCache } from './openingGenerator.mjs';
export { createInMemoryStoryRepository, makeOpeningScopeKey } from './repository.mjs';
export {
  defaultGenerationProfile,
  ensureOpeningCache,
  importStory,
  markFirstChoiceConsumed,
  rebuildOpeningCache,
  startSessionSnapshot,
} from './storyService.mjs';
export { createSeededRepository, FIXTURE_UUIDS } from './fixture.mjs';
export {
  commitNarrativeEvent,
  commitOpeningEvent,
  createSession,
  discardPendingTail,
  getSession,
  interruptWithPlayerInput,
  listSessionEvents,
  lookupTurnRequest,
  recoverSession,
  registerTurnRequest,
  stageNarrativeBatch,
} from './sessionService.mjs';
