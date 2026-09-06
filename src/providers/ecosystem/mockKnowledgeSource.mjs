// src/providers/ecosystem/mockKnowledgeSource.mjs — ClickUp 16.5 (rebuilt)
//
// Mock knowledge provider. Default fallback for the public
// POST /v1/ecosystem/knowledge façade.
//
// Design goals (per ChatGPT review P1 — see ClickUp 16.5 note):
//
//   1. Pure data. No external API call, no env var, no fetch, no fs.
//      The bundle has zero side effects on import.
//   2. Pair-key stable. The orchestrator keys its cache on
//      (story_version_uuid, community_profile_version, topic_id)
//      via JSON.stringify — see knowledge.mjs. The mock returns the
//      same set of entries for any pair-key so a player can browse
//      without upstream availability.
//   3. Knowledge 区 vs 讨论区 independence. These entries are
//      GENERIC 知乎 Knowledge samples (写作技巧 / 城市文学 / 历史
//      / 科普 …) — they do NOT mirror the mock discussion surface
//      (which talks about the protagonist arcs of cafe-rain /
//      night-shift). The two surfaces must remain independently
//      evolvable.
//   4. Disclaimer surface. Every normalised entry carries the
//      知识区 disclaimer text in `disclaimer`; the route layer echoes
//      it on every response so a UI / client can render the
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
 * @property {string} summary        Short snippet (zh-CN).
 * @property {string} source         Display name for the source surface.
 * @property {string} url            Outbound link to zhihu.com.
 * @property {string[]} related_topics Content labels / topics.
 * @property {string} disclaimer     Surface disclaimer text (知识区 vs 讨论区).
 */

/**
 * The default mock fixture. Fixed and stable so tests can pin byte-for-byte.
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
    related_topics: ['城市文学', '悬疑', '夜班叙事'],
  }),
  Object.freeze({
    id: 'mock-know-003',
    title: '一杯热咖啡作为关系温度的隐喻',
    summary: '读者反复讨论文学中"换一杯热咖啡"是否成立为关系温度的隐喻；这一类比常见于换季、久别与旧友场景。',
    source: 'zhihu-knowledge-mock',
    url: 'https://www.zhihu.com/knowledge/mock-003',
    related_topics: ['文学意象', '关系隐喻'],
  }),
  Object.freeze({
    id: 'mock-know-004',
    title: '短篇写作中的"陌生人"角色功能',
    summary: '在知乎短篇写作话题下，"陌生人"角色经常承担推动视角转换的功能，与"旧友"形成对照。',
    source: 'zhihu-knowledge-mock',
    url: 'https://www.zhihu.com/knowledge/mock-004',
    related_topics: ['角色功能', '视角', '写作技巧'],
  }),
  Object.freeze({
    id: 'mock-know-005',
    title: '原创短篇 vs AI 平行时间线的写作伦理',
    summary: '知乎社区对"基于原作的 AI 平行时间线创作"是否构成合理创作的常见讨论，涉及署名与素材边界。',
    source: 'zhihu-knowledge-mock',
    url: 'https://www.zhihu.com/knowledge/mock-005',
    related_topics: ['创作伦理', 'AI 写作', '平行时间线'],
  }),
  Object.freeze({
    id: 'mock-know-006',
    title: '现代短篇中的城市夜景观与人物心理',
    summary: '知乎读者对城市夜景、霓虹、便利店、晚点公交等元素如何映射人物心理的常见总结。',
    source: 'zhihu-knowledge-mock',
    url: 'https://www.zhihu.com/knowledge/mock-006',
    related_topics: ['城市夜景', '人物心理', '文学分析'],
  }),
]);

/**
 * Static surface disclaimer. Every normalised entry carries it on the
 * `disclaimer` field so the UI / client can verify the 知识区 vs
 * 讨论区 boundary at a glance.
 *
 * @returns {string}
 */
export function knowledgeSurfaceDisclaimer() {
  return '以下内容属于现实/知乎知识延伸，不是原作设定或 AI 世界线事实';
}

/**
 * Default fetchKnowledge implementation — returns a stable clone of
 * the mock fixture so callers cannot mutate the bundle by accident.
 *
 * @returns {ReadonlyArray<MockKnowledgeEntry>}
 */
export function defaultMockFetchKnowledge() {
  return MOCK_KNOWLEDGE_ENTRIES.map((e) => ({
    id: e.id,
    title: e.title,
    summary: e.summary,
    source: e.source,
    url: e.url,
    related_topics: e.related_topics.slice(),
    disclaimer: knowledgeSurfaceDisclaimer(),
  }));
}

/**
 * Count of mock knowledge entries. Exposed for the contract test.
 * @returns {number}
 */
export function mockKnowledgeEntryCount() {
  return MOCK_KNOWLEDGE_ENTRIES.length;
}