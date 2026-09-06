// src/providers/ecosystem/mockZhihuHotSource.mjs — fixed mock hot-list
// fixture for ClickUp 16.4 (rebuilt on current main 44343b2).
//
// IMPORTANT: This module does NOT call any external API and does NOT
// read any environment variable that looks like a credential.
//
// Layout:
//   * 8 hot topics spanning three categories: `total` (mixed), `tech`,
//     `finance`. The orchestrator clamps category to a safe allow-list
//     before forwarding; the fixture just supplies the rows.
//   * Each topic carries `category` so the orchestrator can tag it
//     without re-classifying upstream output.
//
// The structure mirrors what the future official Zhihu hot-list
// adapter will return after normalisation: id, title, url, hotness
// (heat), excerpt, answer_count, question_id, tags[]. The rebuilt
// DTO is provider-agnostic and lives in ./hot.mjs.

/**
 * @typedef {Object} MockHotTopicRaw
 * @property {string} id            Stable mock identifier (uuid-shaped
 *                                  so it doubles as a question_uuid).
 * @property {string} title         Display title (zh-CN).
 * @property {string} url           Outbound link to zhihu.com.
 * @property {number} hotness       Mock hotness score (0–1e7).
 * @property {string} excerpt       Mock 优质回答摘要 (short).
 * @property {number} answer_count  Mock 回答数.
 * @property {string} question_id   Mock question id (stringified number).
 * @property {string[]} tags        Mock tags (Chinese keywords).
 * @property {string} category      One of 'total' | 'tech' | 'finance'.
 */

/**
 * @type {ReadonlyArray<MockHotTopicRaw>}
 */
export const MOCK_HOT_TOPICS_RAW = Object.freeze([
  Object.freeze({
    id: 'mock-hot-001',
    title: '雨夜咖啡馆里的陌生人和旧友',
    url: 'https://www.zhihu.com/question/1000000001',
    hotness: 9876543,
    excerpt: '近期一篇短篇用雨夜咖啡馆写两个身份模糊的角色，读者在讨论"换一杯热咖啡"是不是关系温度的隐喻。',
    answer_count: 1287,
    question_id: '1000000001',
    tags: ['雨夜', '咖啡馆', '短篇', '文学'],
    category: 'total',
  }),
  Object.freeze({
    id: 'mock-hot-002',
    title: '凌晨便利店的夜班店员在货架尽头看见了谁',
    url: 'https://www.zhihu.com/question/1000000002',
    hotness: 7654321,
    excerpt: '短篇用"不属于今天的饮料"和"零钱"建立悬疑氛围，零成本的夜班孤独感写得很到位。',
    answer_count: 642,
    question_id: '1000000002',
    tags: ['夜班', '便利店', '悬疑'],
    category: 'total',
  }),
  Object.freeze({
    id: 'mock-hot-003',
    title: 'Apple Vision Pro 二代 评测汇总',
    url: 'https://www.zhihu.com/question/1000000003',
    hotness: 6543210,
    excerpt: '多家评测机构对新一代头显的重量、续航、应用生态给出了横向对比。',
    answer_count: 2105,
    question_id: '1000000003',
    tags: ['Vision Pro', '硬件', '评测'],
    category: 'tech',
  }),
  Object.freeze({
    id: 'mock-hot-004',
    title: '大模型 7B / 13B / 70B 部署成本对比',
    url: 'https://www.zhihu.com/question/1000000004',
    hotness: 5432109,
    excerpt: '从单卡推理到多机分布式推理，社区整理了一份 2026 年主流开源 LLM 的 TCO 对比表。',
    answer_count: 1842,
    question_id: '1000000004',
    tags: ['LLM', '推理', 'TCO'],
    category: 'tech',
  }),
  Object.freeze({
    id: 'mock-hot-005',
    title: 'A 股今日收盘点评与明日策略',
    url: 'https://www.zhihu.com/question/1000000005',
    hotness: 8765432,
    excerpt: '沪深 300 缩量震荡，北向资金净流入 23 亿，行业板块轮动特征明显。',
    answer_count: 4310,
    question_id: '1000000005',
    tags: ['A股', '收盘', '策略'],
    category: 'finance',
  }),
  Object.freeze({
    id: 'mock-hot-006',
    title: '央行 MLF 续作与 LPR 报价解读',
    url: 'https://www.zhihu.com/question/1000000006',
    hotness: 5432100,
    excerpt: '本周 MLF 续作 5000 亿，利率持平；市场关注下周一 LPR 是否会出现不对称调整。',
    answer_count: 1240,
    question_id: '1000000006',
    tags: ['MLF', 'LPR', '货币政策'],
    category: 'finance',
  }),
  Object.freeze({
    id: 'mock-hot-007',
    title: '世界杯预选赛国足 vs 韩国首发名单',
    url: 'https://www.zhihu.com/question/1000000007',
    hotness: 7654321,
    excerpt: '本场比赛首发名单预测与分析，张玉宁、韦世豪是否出场备受关注。',
    answer_count: 4310,
    question_id: '1000000007',
    tags: ['世界杯', '国足', '韩国'],
    category: 'total',
  }),
  Object.freeze({
    id: 'mock-hot-008',
    title: '为什么大家都在讨论雨夜咖啡馆里的旧友',
    url: 'https://www.zhihu.com/question/1000000008',
    hotness: 4321987,
    excerpt: '与 mock-hot-001 是同源话题，热度略低，是同一篇短篇的二轮讨论。',
    answer_count: 521,
    question_id: '1000000008',
    tags: ['雨夜', '咖啡馆'],
    category: 'total',
  }),
]);

/**
 * @returns {number}
 */
export function mockHotTopicCount() {
  return MOCK_HOT_TOPICS_RAW.length;
}

/**
 * Filter the fixture by category. Unknown categories fall back to
 * `total` so a misconfigured upstream never silently empties the
 * list. The returned array is a defensive shallow copy — the
 * underlying frozen constants are never mutated.
 *
 * @param {string} category
 * @returns {ReadonlyArray<MockHotTopicRaw>}
 */
export function filterMockHotByCategory(category) {
  const safe = (typeof category === 'string' && category) ? category : 'total';
  if (safe === 'total') return MOCK_HOT_TOPICS_RAW;
  return MOCK_HOT_TOPICS_RAW.filter((t) => t.category === safe);
}
