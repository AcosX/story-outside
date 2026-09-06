// src/providers/ecosystem/index.mjs — public surface of the ecosystem
// (ClickUp 16.2) module.
//
// Re-exports the DTO + outcome helpers + cache + adapter factories so
// the route layer imports a single namespace.

export {
  buildEcosystemSearchCacheKey,
  buildEcosystemUnavailableOutcome,
  createInMemoryEcosystemSearchCacheRepository,
  dedupeAndRankZhihuDiscussions,
  ECOSYSTEM_SEARCH_DEFAULT_LIMIT,
  ECOSYSTEM_SEARCH_DEFAULT_TTL_MS,
  normaliseZhihuDiscussionResult,
  PER_QUERY_COUNT,
  searchZhihuDiscussions,
} from './search.mjs';

export {
  createMockSearchAdapter,
  ECOSYSTEM_SEARCH_MOCK_FIXTURES,
} from './mockSearchAdapter.mjs';

export {
  createRealSearchAdapter,
} from './realSearchAdapter.mjs';