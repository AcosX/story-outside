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
// Both STORY_OUTSIDE_PROVIDER and the legacy alias ZHIHU_PROVIDER are
// honoured. STORY_OUTSIDE_PROVIDER wins if both are set, so a deployment
// that already standardises on the project-wide name does not need to be
// touched. ZHIHU_PROVIDER remains a fallback for hackathon teams that
// wired their early environment variable before the project-wide name
// was settled.
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

const ENV_KEYS = Object.freeze(['STORY_OUTSIDE_PROVIDER', 'ZHIHU_PROVIDER']);
const DEFAULT_VALUE = 'mock';

/**
 * Resolve the configured provider name from process.env. The first env
 * var in ENV_KEYS wins; subsequent aliases are ignored. Empty / whitespace
 * values are skipped so a deployment can set one variable to empty to
 * fall through to the next.
 *
 * @returns {{ key: string, value: string }}
 */
export function readProviderEnv() {
  for (const key of ENV_KEYS) {
    const raw = process.env[key];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed) continue;
    return { key, value: trimmed };
  }
  return { key: 'default', value: DEFAULT_VALUE };
}

/**
 * Resolve and instantiate the active StoryProvider. Memoised.
 * @returns {StoryProvider}
 */
export function getStoryProvider() {
  // Cache key encodes BOTH the resolved value and the env key that won,
  // so that switching STORY_OUTSIDE_PROVIDER=mock back to default while
  // leaving ZHIHU_PROVIDER=real does not silently keep the old provider.
  const { key, value } = readProviderEnv();
  const cacheKey = `${key}::${value}`;
  const cached = _cache.get(cacheKey);
  if (cached) return cached;
  const requested = value;
  /** @type {StoryProvider} */
  let provider;
  if (requested === 'mock') {
    provider = createMockStoryProvider();
  } else if (requested === 'real') {
    provider = createRealZhihuStoryProvider();
  } else {
    throw new Error(
      `Unknown provider value="${requested}" (from env ${key}). Expected "mock" or "real".`,
    );
  }
  _cache.set(cacheKey, provider);
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