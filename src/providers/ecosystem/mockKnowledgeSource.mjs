// src/providers/ecosystem/mockKnowledgeSource.mjs — Story 16.5 (v2
// rebuild on current main, NOT a54aebd).
//
// Mock knowledge provider. Default fallback for the public
// POST /v1/ecosystem/knowledge façade. The v2 contract changes from
// PR #25 / a54aebd in two ways:
//
//   P1.v2-1 (code review 2026-09-07 02:23): the orchestrator's
//   `match()` NO LONGER accepts a caller-supplied `knowledge_queries[]`.
//   It only takes a single canonical `query` string + its derived
//   `query_hash`. This module therefore treats the input as a single
//   query and returns ONE bundle of entries that is uniquely shaped by
//   that query — two different query strings MUST return different
//   results (different entries, not the same set with a different id).
//
//   P1.v2-2 (code review 2026-09-07 02:23): the cache key MUST
//   include `query_hash = sha256(query)`, NOT just `query.id`. This
//   module does not own the cache key — see knowledge.mjs — but the
//   mock returns a deterministic bundle per query string so the cache
//   layer can demonstrate that the cache key actually segregates
//   queries.
//
// Design goals:
//   1. Pure data. No external API call, no env var, no fetch, no fs.
//      The bundle has zero side effects on import.
//   2. Query-driven. The mock is parameterised on the query string;
//      the returned entries are deterministically chosen from the
//      generic knowledge fixture and each entry's `summary` echoes
//      the query string verbatim so a test can prove the query was
//      consumed (not just the id).
//   3. Knowledge 区 vs 讨论区 independence. These entries are GENERIC
//      知乎 Knowledge samples (写作技巧 / 城市文学 / 历史 / 科普 …) —
//      they do NOT mirror the mock discussion surface (which talks
//      about the protagonist arcs of cafe-rain / night-shift).
//   4. Disclaimer surface. Every normalised entry carries the 知识区
//      disclaimer text in `disclaimer`; the route layer echoes it on
//      every response so a UI / client can render the
//      "现实/知乎知识延伸，不是原作设定或 AI 世界线事实" banner.
//   5. Provisional flag. The orchestrator (not this module) attaches
//      `provisional: true` to the response payload. The mock itself
//      stays a pure data source.
//
// This module does NOT import any other file under src/providers/*
// so it can be required standalone by tests.

/**
 * @typedef {Object} MockKnowledgeEntry
 * @property {string} id             Stable identifier within this list.
 * @property {string} title          Knowledge entry title (zh-CN).
 * @property {string} summary        Short snippet (zh-CN). MUST echo
 *                                   the query string verbatim so a
 *                                   test can prove the query was
 *                                   consumed.
 * @property {string} source         Display name for the source surface.
 * @property {string} url            Outbound link to zhihu.com.
 * @property {string[]} related_topics Content labels / topics.
 * @property {string} disclaimer     Surface disclaimer text (知识区 vs 讨论区).
 */

/**
 * The default mock fixture. Fixed and stable so tests can pin byte-for-byte.
 * Each entry is intentionally generic across stories — the orchestrator
 * (knowledge.mjs) intersects this set with the query string so two
 * different queries produce two different bundles.
 *
 * @type {ReadonlyArray<MockKnowledgeEntry>}
 */
export const MOCK_KNOWLEDGE_ENTRIES = Object.freeze([
  Object.freeze({
    id: 'mock-know-001',
    title: '短篇叙事中的雨夜与咖啡馆场景',
    summary: '知乎社区对"短篇 + 凌晨时空"叙事技巧的常见总结：紧凑时空、极简对白和环境暗示的叠加使用。',
    source: 'zhihu-knowledge-mock',
    url: 'https://www.zhihu.com/knowledge/mock-001',
    related_topics: ['写作技巧', '短篇叙事', '场景设定'],
  }),
  Object.freeze({
    id: 'mock-know-002',
    title: '便利店夜班文学的城市叙事切口',
    summary: '从便利店夜班到"不属于今天的饮料"和"零钱"，知乎用户经常讨论这种城市夜班叙事的常见隐喻。',
    source: 'zhihu-knowledge-mock',
    url: 'https://www.zhihu.com/knowledge/mock-002',
    related_topics: ['写作技巧', '城市文学', '夜班'],
  }),
  Object.freeze({
    id: 'mock-know-003',
    title: '咖啡因摄入对成年人睡眠与情绪的常见影响',
    summary: '关于咖啡因半衰期、个体差异、饮用时段对入睡和日间情绪的常见总结，附带适用人群提示。',
    source: 'zhihu-knowledge-mock',
    url: 'https://www.zhihu.com/knowledge/mock-003',
    related_topics: ['健康', '咖啡因', '睡眠'],
  }),
  Object.freeze({
    id: 'mock-know-004',
    title: '小红书咖啡店榜单的常见筛选维度',
    summary: '对小红书"咖啡店"内容生态常见的城市、装修风格、营业时长、宠物友好等筛选维度的总结。',
    source: 'zhihu-knowledge-mock',
    url: 'https://www.zhihu.com/knowledge/mock-004',
    related_topics: ['城市探索', '小红书', '咖啡店'],
  }),
  Object.freeze({
    id: 'mock-know-005',
    title: '叙事学视角下的极简对话与潜文本',
    summary: '极简对话通过留白、节奏、标点与场景细节让读者重构未说出口的内容，是当代短篇常见手法。',
    source: 'zhihu-knowledge-mock',
    url: 'https://www.zhihu.com/knowledge/mock-005',
    related_topics: ['叙事学', '潜文本', '对话'],
  }),
  Object.freeze({
    id: 'mock-know-006',
    title: '城市夜班叙事中的孤独感与共情',
    summary: '城市夜班叙事常以孤独、节制、零交流为核心情绪，并通过小物件（零钱 / 饮料）承载共情。',
    source: 'zhihu-knowledge-mock',
    url: 'https://www.zhihu.com/knowledge/mock-006',
    related_topics: ['城市文学', '孤独', '共情'],
  }),
]);

/**
 * Stable, deterministic 32-bit hash of a string. We do not need
 * cryptographic strength here — the value only has to (a) be a
 * pure function of the query string and (b) vary between two
 * distinct query strings. FNV-1a is enough.
 *
 * @param {string} str
 * @returns {number}
 */
function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The default mock fetch. Given a query string, return a slice of
 * MOCK_KNOWLEDGE_ENTRIES that is uniquely determined by the query:
 *   * The slice start offset is `fnv1a(query) % entries.length`.
 *   * The slice length is `3` (bounded by the available length).
 *   * Each entry's summary is rebuilt so it carries a visible
 *     `「${query}」` echo — this is the smoking-gun for tests that
 *     the query string was consumed (not just the id).
 *   * Each entry's `related_topics` is also rebuilt so the FIRST
 *     topic is `query:${query}` so two distinct query strings
 *     produce structurally distinct bundles.
 *
 * @param {{ query: string, limit?: number }} input
 * @returns {ReadonlyArray<MockKnowledgeEntry>}
 */
export function defaultMockFetchKnowledge(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('defaultMockFetchKnowledge: input required');
  }
  if (typeof input.query !== 'string' || !input.query) {
    throw new Error('defaultMockFetchKnowledge: query required');
  }
  const limit = Number.isInteger(input.limit) && input.limit > 0
    ? Math.min(input.limit, 32)
    : 4;
  const offset = fnv1a(input.query) % MOCK_KNOWLEDGE_ENTRIES.length;
  const sliceLen = Math.min(limit, MOCK_KNOWLEDGE_ENTRIES.length);
  const out = [];
  for (let i = 0; i < sliceLen; i += 1) {
    const idx = (offset + i) % MOCK_KNOWLEDGE_ENTRIES.length;
    const base = MOCK_KNOWLEDGE_ENTRIES[idx];
    out.push({
      id: `${base.id}::q:${fnv1a(input.query).toString(16)}`,
      title: `${base.title} · 视角：${input.query}`,
      summary: `${base.summary}\n（消费 query 字符串：${input.query}）`,
      source: base.source,
      url: base.url,
      related_topics: [`query:${input.query}`, ...base.related_topics],
      disclaimer: SURFACE_DISCLAIMER,
    });
  }
  return Object.freeze(out.map((e) => Object.freeze(e)));
}

/**
 * Surface disclaimer text. The route layer echoes this on every
 * response so a UI / client can render the
 * "现实/知乎知识延伸，不是原作设定或 AI 世界线事实" banner.
 */
export const SURFACE_DISCLAIMER = Object.freeze(
  '以下内容属于现实/知乎知识延伸，不是原作设定或 AI 世界线事实',
);

/**
 * Mock provider config (frozen for tests).
 */
export const MOCK_KNOWLEDGE_SOURCE_CONFIG = Object.freeze({
  name: 'mock',
  surface_disclaimer: SURFACE_DISCLAIMER,
  default_limit: 4,
  max_limit: 32,
});

/**
 * Identity string of this source for diagnostics.
 * @returns {string}
 */
export function knowledgeSourceName() {
  return 'mock';
}