// src/providers/ecosystem/mockKnowledgeSource.mjs — fixed mock knowledge
// fixture for ClickUp 16.5. Hand-curated so tests can pin byte-for-byte.
//
// IMPORTANT: This module does NOT call any external API and does NOT
// read any environment variable that looks like a credential.
//
// Layout (knowledge 区 vs 讨论区 independent — these entries do NOT
// overlap with mockHotSource / mockDiscussion content):
//   * 6 knowledge entries total
//   * 2 are RELATED to bundled mock stories (cafe-rain + night-shift)
//     so tests can verify "related knowledge gets matched, unrelated
//     knowledge does not".
//   * 2 are PARTIAL-MATCH (one token overlap but not full) so tests can
//     verify the threshold.
//   * 2 are UNRELATED (history / science) so tests can verify that
//     unrelated entries do NOT get a fake match.
//
// The structure mirrors what the future official Zhihu hackathon
// knowledge adapter will return after normalisation: stable id, raw
// title, summary excerpt (摘要), labels, and the upstream work_id
// (stringified). We do NOT expose author_name / author_avatar —
// knowledge entries are content records, not author profiles.

/**
 * @typedef {Object} MockKnowledgeEntryRaw
 * @property {string} id            Stable mock identifier (within the mock fixture).
 * @property {string} work_id       Mock upstream work_id (stringified number).
 * @property {string} title         Display title (zh-CN).
 * @property {string} url           Outbound link to zhihu.com.
 * @property {string} excerpt       Mock summary / abstract (short).
 * @property {string[]} labels      Mock content labels.
 * @property {string} source_name   Display name for the source surface.
 */

/**
 * @type {ReadonlyArray<MockKnowledgeEntryRaw>}
 */
export const MOCK_KNOWLEDGE_ENTRIES_RAW = Object.freeze([
  Object.freeze({
    // RELATED to cafe-rain: shares keywords "雨夜 咖啡馆".
    id: 'mock-know-001',
    work_id: '9000000001',
    title: '雨夜咖啡馆类短篇的叙事技巧',
    url: 'https://www.zhihu.com/knowledge/mock-001',
    excerpt: '雨夜咖啡馆是知乎社区内对"短篇 + 凌晨时空"叙事的一种标签总结，常用作隐喻与极简对白的写作样本。',
    labels: ['写作技巧', '短篇叙事'],
    source_name: 'zhihu-knowledge-mock',
  }),
  Object.freeze({
    // RELATED to cafe-rain (secondary): shares the "咖啡" bigram and
    // touches on "旧友 / 陌生人" relational motifs.
    id: 'mock-know-002',
    work_id: '9000000002',
    title: '咖啡与关系温度：文学里的"换一杯热咖啡"',
    url: 'https://www.zhihu.com/knowledge/mock-002',
    excerpt: '从雨夜咖啡馆到旧友 / 陌生人结构，"一杯热咖啡"被读者反复讨论是否成立为关系温度的隐喻。',
    labels: ['文学意象', '咖啡'],
    source_name: 'zhihu-knowledge-mock',
  }),
  Object.freeze({
    // RELATED to night-shift: shares "凌晨 便利店 夜班".
    id: 'mock-know-003',
    work_id: '9000000003',
    title: '凌晨便利店的城市夜班叙事',
    url: 'https://www.zhihu.com/knowledge/mock-003',
    excerpt: '便利店夜班是城市夜班文学的常见切口，常以"不属于今天的饮料"和"零钱"建立悬疑与孤独感。',
    labels: ['城市文学', '悬疑'],
    source_name: 'zhihu-knowledge-mock',
  }),
  Object.freeze({
    // PARTIAL MATCH for night-shift: the entry mentions "小店"
    // supply-chain facts without sharing night-shift query bigrams.
    // The score is well below the night-shift threshold.
    id: 'mock-know-004',
    work_id: '9000000004',
    title: '鲜食供应链的当日报废率',
    url: 'https://www.zhihu.com/knowledge/mock-004',
    excerpt: '鲜食供应链中当日报废率与冷链节奏的商业科普，与任何文学叙事无直接关联。',
    labels: ['生活', '商业'],
    source_name: 'zhihu-knowledge-mock',
  }),
  Object.freeze({
    // UNRELATED — pure history.
    id: 'mock-know-005',
    work_id: '9000000005',
    title: '明清易代之际的市井生活',
    url: 'https://www.zhihu.com/knowledge/mock-005',
    excerpt: '从明清易代之际的市井史料看夜班与商铺制度的演变，与现代短篇叙事无直接关联。',
    labels: ['历史', '明清'],
    source_name: 'zhihu-knowledge-mock',
  }),
  Object.freeze({
    // UNRELATED — pure science.
    id: 'mock-know-006',
    work_id: '9000000006',
    title: '海洋深层水循环与碳汇',
    url: 'https://www.zhihu.com/knowledge/mock-006',
    excerpt: '介绍温盐环流驱动下的海洋碳汇机制，与任何短篇叙事无直接关联，仅作为知识延伸样本。',
    labels: ['地球科学', '科普'],
    source_name: 'zhihu-knowledge-mock',
  }),
]);

/**
 * Convenience: total number of mock knowledge entries.
 * @returns {number}
 */
export function mockKnowledgeEntryCount() {
  return MOCK_KNOWLEDGE_ENTRIES_RAW.length;
}