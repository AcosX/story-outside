// src/stories/index.mjs — public surface of the stories application layer.
//
// Other modules should import from here, not from the individual files.
// This indirection lets us reorganise internals without breaking call sites.
//
// Story 08 contract:
//
//   * The canonical session store lives in src/stories/sessionService.mjs.
//     It owns history, revision, cursor, state, requestIds, and the
//     active pending batch. There is exactly one history per session.
//
//   * src/stories/pendingLifecycle.mjs is a thin facade over sessionService.
//     It does not own its own history; every commit goes through
//     sessionService.append.
//
// The `stageNarrativeBatch` and `commitDisplayedEvent` /
// `commitNarrativeEvent` names are exposed through both surfaces; the
// pendingLifecycle facade accepts the legacy `events:` alias and forwards
// to sessionService.

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
  importStoryAndEnsureCache,
  markFirstChoiceConsumed,
  rebuildOpeningCache,
  startSessionSnapshot,
} from './storyService.mjs';
export { createSeededRepository, FIXTURE_UUIDS } from './fixture.mjs';

// sessionService — the canonical store. `commitNarrativeEvent` is the
// authoritative commit hook (Story 08 contract name); pendingLifecycle
// exposes `commitDisplayedEvent` as an alias. The Story 10 compact
// functions are re-exported here too so callers of the application layer
// do not have to reach into sessionService.mjs directly.
export {
  bindSessionOwner,
  bootstrapSessionFromWork,
  commitNarrativeEvent,
  commitOpeningEvent,
  createSession,
  discardPendingTail,
  findOwnerBySession,
  getSession,
  getSessionCompact,
  interruptWithPlayerInput,
  listSessionEvents,
  lookupTurnRequest,
  recordCompact,
  recordCompactFailure,
  rebuildCompactFromHistory,
  recoverSession,
  registerTurnRequest,
} from './sessionService.mjs';

// pendingLifecycle — strict facade. `stageNarrativeBatch` accepts both
// `items:` (Story 08) and `events:` (legacy) so existing callers do not
// have to change.
export {
  commitDisplayedEvent,
  dropPendingAfterLegacyInterrupt,
  interruptWithPlayerInputFromPending,
  listPendingSessionUuids,
  recoverPendingSession,
  stageNarrativeBatch,
} from './pendingLifecycle.mjs';