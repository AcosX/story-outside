// src/providers/ecosystem/index.mjs — ClickUp 16.2 知乎搜索公共面。
//
// 其他模块（route 层、测试、CLI）应该 import 这个，而不是单个文件。
// 模拟 src/community/index.mjs 的间接导出模式。

export {
  buildEcosystemSearchCacheKey,
  clampDiscussions,
  dedupeAndRankZhihuDiscussions,
  ECOSYSTEM_FORBIDDEN_KEYS,
  ECOSYSTEM_SEARCH_DEFAULT_LIMIT,
  ECOSYSTEM_SEARCH_MAX_LIMIT,
  ECOSYSTEM_SEARCH_MIN_LIMIT,
  ECOSYSTEM_SEARCH_MAX_QUERIES,
  isDiscussionShape,
  isPlainObject,
  normaliseDiscussionsRequest,
  normaliseSearchQueryRecord,
  VALID_KINDS,
} from './dto.mjs';

export {
  buildEcosystemUnavailableOutcome,
  createInMemoryEcosystemSearchCacheRepository,
  ECOSYSTEM_SEARCH_DEFAULT_SWR_MS,
  ECOSYSTEM_SEARCH_DEFAULT_TTL_MS,
  searchEcosystemDiscussions,
} from './search.mjs';

export {
  createMockZhihuSearchSource,
  buildMockDiscussions,
  MOCK_FIXTURE_TAGS,
} from './mockZhihuSearchSource.mjs';

export {
  createRealZhihuSearchSource,
  EcosystemUpstreamError,
  hasRealSearchCredentials,
  isAllowedUpstreamBaseUrl as isAllowedZhihuUpstreamBaseUrl,
} from './zhihuSearchSource.mjs';
