// src/providers/ecosystem/index.mjs — Story 16.2 P1.v2 知乎搜索公共面。
//
// 其他模块（route 层、测试、CLI）应该 import 这个，而不是单个文件。
// 模拟 src/community/index.mjs 的间接导出模式。

export {
  buildEcosystemSearchCacheKey,
  clampDiscussions,
  dedupeAndRankZhihuDiscussions,
  ECOSYSTEM_ALLOWED_BODY_KEYS,
  ECOSYSTEM_FORBIDDEN_KEYS,
  ECOSYSTEM_SEARCH_DEFAULT_LIMIT,
  ECOSYSTEM_SEARCH_MAX_LIMIT,
  ECOSYSTEM_SEARCH_MAX_QUERIES,
  ECOSYSTEM_SEARCH_MIN_LIMIT,
  isDiscussionShape,
  isPlainObject,
  normaliseCanonicalSearchQueries,
  normaliseDiscussionsRequest,
  normaliseSearchQueryRecord,
  stableStringHash,
} from './dto.mjs';

export {
  createInMemoryEcosystemSearchCacheRepository,
  ECOSYSTEM_SEARCH_DEFAULT_SWR_MS,
  ECOSYSTEM_SEARCH_DEFAULT_TTL_MS,
  buildEcosystemUnavailableOutcome,
  searchEcosystemDiscussions,
} from './search.mjs';

export {
  buildMockDiscussions,
  createMockZhihuSearchSource,
} from './mockZhihuSearchSource.mjs';

export {
  EcosystemUpstreamError,
  createRealZhihuSearchSource,
  hasRealSearchCredentials,
  isAllowedUpstreamBaseUrl,
  readZhihuOAuthCredentials,
} from './zhihuSearchSource.mjs';
