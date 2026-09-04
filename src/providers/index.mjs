// src/providers/index.mjs — StoryProvider contract + provider selector.
//
// Any data source for /api/stories, /api/stories/:id, /api/stories/advance
// (and future endpoints) goes through a StoryProvider. Routes never touch
// the data layer directly. This is the seam where the official Zhihu
// Hackathon story adapter replaces the Mock without touching HTTP wiring.
//
// Selector rules:
//   * STORY_OUTSIDE_PROVIDER=mock       → mock (default; safe in dev & prod)
//   * STORY_OUTSIDE_PROVIDER=real       → real adapter (src/providers/realProvider.mjs)
//                                          bound to the zhihu_hackathon_2026_p2
//                                          story contract. Per that contract
//                                          no Access Secret, OAuth token or
//                                          other credential is required —
//                                          these endpoints are unauthenticated
//                                          during the hackathon window.
//   * STORY_OUTSIDE_PROVIDER=<unknown>  → throws at startup
//
// Real provider MUST live in src/providers/realProvider.mjs and MUST import
// nothing from vendor/zhihu-hackathon (those scripts are orchestration tools,
// not runtime deps).
//
// IMPORTANT: providers never log, store, or echo any credential value. The
// real adapter does not consume credentials today; if a future story API
// ever does require auth, the provider must receive already-loaded values
// from the bootstrap layer (out of scope for this revision).

import { createMockStoryProvider } from './mockProvider.mjs';
import { createRealZhihuStoryProvider } from './realProvider.mjs';

/**
 * @typedef {import('./dto.mjs').StorySummary} StorySummary
 * @typedef {import('./dto.mjs').StoryDetail} StoryDetail
 * @typedef {import('./dto.mjs').AdvanceResult} AdvanceResult
 */

/**
 * The contract every provider must satisfy.
 *
 * @typedef {Object} StoryProvider
 * @property {string} name                              Short identifier for logs.
 * @property {() => Promise<StorySummary[]>} listStories
 * @property {(id: string) => Promise<StoryDetail>} getStory
 * @property {(input: {storyId: string, roleId?: string|null, index?: number}) => Promise<AdvanceResult>} advanceStory
 */

const ENV_KEY = 'STORY_OUTSIDE_PROVIDER';

/**
 * Resolve and instantiate the active StoryProvider. Memoised.
 * @returns {StoryProvider}
 */
export function getStoryProvider() {
  const cached = _cache.get(ENV_KEY);
  if (cached) return cached;
  const requested = (process.env[ENV_KEY] || 'mock').trim().toLowerCase();
  /** @type {StoryProvider} */
  let provider;
  if (requested === 'mock') {
    provider = createMockStoryProvider();
  } else if (requested === 'real') {
    provider = createRealZhihuStoryProvider();
  } else {
    throw new Error(
      `Unknown STORY_OUTSIDE_PROVIDER="${requested}". Expected "mock" or "real".`,
    );
  }
  _cache.set(ENV_KEY, provider);
  return provider;
}

/**
 * Test-only: clear the memoised provider so a new env var is honoured.
 * Exported for tests in tests/providers.test.mjs.
 */
export function __resetStoryProviderForTests() {
  _cache.clear();
}

const _cache = new Map();

export { createMockStoryProvider } from './mockProvider.mjs';
export { createRealZhihuStoryProvider } from './realProvider.mjs';
export {
  ProviderError,
  StoryNotFoundError,
  ValidationError,
  normaliseStoryDetail,
  normaliseStorySummary,
} from './dto.mjs';