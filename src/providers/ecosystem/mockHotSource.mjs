// src/providers/ecosystem/mockHotSource.mjs — fixed mock hot-list fixture
// for ClickUp 16.4. Hand-curated so tests can pin byte-for-byte.
//
// IMPORTANT: This module does NOT call any external API and does NOT
// read any environment variable that looks like a credential.
//
// Layout:
//   * 5 hot topics total
//   * 2 of them are RELATED to bundled mock stories (cafe-rain +
//     night-shift) so tests can verify "related entries get matched,
//     unrelated entries do not".
//   * 3 of them are UNRELATED (sports / politics / pure tech) so the
//     test can verify that unrelated entries do NOT get a fake match.
//
// The structure mirrors what the future official Zhihu hot-list
// adapter will return after normalisation: hotness integer, raw title,
// answer excerpt (优质回答摘要), interaction counts. We do NOT expose
// upstream IDs or any field that would require OAuth to fetch.

/**
 * @typedef {Object} MockHotTopicRaw
 * @property {string} id            Stable mock identifier.
 * @property {string} title         Display title (zh-CN).
 * @property {string} url           Outbound link to zhihu.com.
 * @property {number} hotness       Mock hotness score (0–1e7).
 * @property {string} excerpt       Mock 优质回答摘要 (short).
 * @property {number} answer_count  Mock 回答数.
 * @property {string} question_id   Mock question id (stringified number).
 */

/**
 * @type {ReadonlyArray<MockHotTopicRaw>}
 */
export const MOCK_HOT_TOPICS_RAW = Object.freeze([
  Object.freeze({
    // RELATED to cafe-rain: shares keywords "雨夜 咖啡馆".
    id: 'mock-hot-001',
    title: '为什么大家都在讨论雨夜咖啡馆里的陌生人和旧友',
    url: 'https://www.zhihu.com/question/mock-001',
    hotness: 9876543,
    excerpt: '近期一篇短篇用雨夜咖啡馆写两个身份模糊的角色，读者在讨论"换一杯热咖啡"是不是关系温度的隐喻。',
    answer_count: 1287,
    question_id: '1000000001',
  }),
  Object.freeze({
    // RELATED to night-shift: shares keywords "凌晨 便利店 夜班 店员".
    id: 'mock-hot-002',
    title: '凌晨便利店的夜班店员在货架尽头看见了谁',
    url: 'https://www.zhihu.com/question/mock-002',
    hotness: 7654321,
    excerpt: '短篇用"不属于今天的饮料"和"零钱"建立悬疑氛围，零成本的夜班孤独感写得很到位。',
    answer_count: 642,
    question_id: '1000000002',
  }),
  Object.freeze({
    // UNRELATED — pure sports.
    id: 'mock-hot-003',
    title: '世界杯预选赛国足 vs 韩国首发名单',
    url: 'https://www.zhihu.com/question/mock-003',
    hotness: 8765432,
    excerpt: '本场比赛首发名单预测与分析，张玉宁、韦世豪是否出场备受关注。',
    answer_count: 4310,
    question_id: '1000000003',
  }),
  Object.freeze({
    // UNRELATED — pure tech.
    id: 'mock-hot-004',
    title: 'Apple Vision Pro 二代 评测汇总',
    url: 'https://www.zhihu.com/question/mock-004',
    hotness: 6543210,
    excerpt: '多家评测机构对新一代头显的重量、续航、应用生态给出了横向对比。',
    answer_count: 2105,
    question_id: '1000000004',
  }),
  Object.freeze({
    // UNRELATED — pure finance / policy.
    id: 'mock-hot-005',
    title: 'A 股今日收盘点评与明日策略',
    url: 'https://www.zhihu.com/question/mock-005',
    hotness: 5432109,
    excerpt: '沪深 300 缩量震荡，北向资金净流入 23 亿，行业板块轮动特征明显。',
    answer_count: 1842,
    question_id: '1000000005',
  }),
]);

/**
 * Convenience: total number of mock topics. Routes / tests can ask
 * without re-iterating the array.
 * @returns {number}
 */
export function mockHotTopicCount() {
  return MOCK_HOT_TOPICS_RAW.length;
}