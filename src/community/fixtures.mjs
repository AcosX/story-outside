// src/community/fixtures.mjs — pre-baked community profiles for the mock
// catalog. CI uses these as the canonical assertion surface; any change
// here changes what tests/communityProfile.test.mjs expects.
//
// Story 16.1 contract:
//   * 3-5 discussion topics about the ORIGINAL story itself (no
//     references to AI parallel-world lines, no session/user/role).
//   * 3-5 Zhihu search queries about the original story.
//   * 2-4 Zhihu Knowledge queries.
//   * Several hot-list match keywords.
//   * Stable, hand-curated so tests can assert byte-for-byte.
//
// IMPORTANT: This file does NOT call any external API and does NOT
// read any environment variable that looks like a credential.

import { FIXTURE_UUIDS } from '../stories/fixture.mjs';

/**
 * @typedef {import('./profile.mjs').StoryCommunityProfile} StoryCommunityProfile
 */

/**
 * Hand-curated profiles for the bundled mock catalog. Keys are story
 * slugs (matching the keys of FIXTURE_UUIDS). Each entry is the full
 * pre-generation shape — ids are derived deterministically from
 * (story_version_checksum, label/query/keyword) by the profile module.
 */
export const COMMUNITY_FIXTURE_SEEDS = Object.freeze({
  'cafe-rain': Object.freeze({
    topics: Object.freeze([
      {
        label: '雨夜咖啡馆的空间与孤独感',
        summary: '原作用雨声、玻璃窗、咖啡机的细节建立凌晨的孤独感与两个人之间的距离。',
      },
      {
        label: '「旧友」与「陌生人」的双线解读',
        summary: '原作在两个角色身份之间摆动，留给读者判断对方到底是旧识还是陌生的关键线索。',
      },
      {
        label: '咖啡作为关系媒介的意象',
        summary: '原作反复用"换一杯热咖啡"的动作传递关系温度，读者普遍讨论这种意象是否成立。',
      },
      {
        label: '极简对话与潜文本',
        summary: '原作在极简对白里藏潜文本，读者讨论一句台词背后到底有多少没说出口的内容。',
      },
    ]),
    queries: Object.freeze([
      { query: '雨夜咖啡馆 故事 解读', kind: 'web' },
      { query: '雨夜咖啡馆 角色分析 旧友 陌生人', kind: 'web' },
      { query: '雨夜咖啡馆 意象 咖啡 关系', kind: 'mixed' },
      { query: '雨夜咖啡馆 极简对话 潜文本', kind: 'web' },
    ]),
    knowledge_queries: Object.freeze([
      { query: '雨夜咖啡馆 设定 百科', kind: 'knowledge' },
      { query: '雨夜咖啡馆 主题 释义', kind: 'knowledge' },
    ]),
    hot_keywords: Object.freeze([
      { keyword: '雨夜咖啡馆', rationale: '原作标题本身的热榜匹配关键词。' },
      { keyword: '凌晨 咖啡馆', rationale: '原作核心时空名词，常见热榜话题。' },
      { keyword: '旧友 陌生人', rationale: '原作双角色设定对应的热榜搜索热词。' },
    ]),
  }),
  'night-shift': Object.freeze({
    topics: Object.freeze([
      {
        label: '凌晨便利店的悬疑氛围',
        summary: '原作用闪灯、卷帘门、不属于今天的饮料建立一种悬疑与疏离的氛围。',
      },
      {
        label: '店员与夜行人的无声张力',
        summary: '原作把店员和夜行人放在同一货架两端，靠零钱的推动建立无声的张力。',
      },
      {
        label: '城市夜班叙事中的孤独',
        summary: '原作属于"城市夜班"叙事流派，读者讨论它在这一类型中的位置。',
      },
      {
        label: '零钱与商品作为隐喻',
        summary: '原作让零钱和"不属于今天的饮料"承担隐喻，读者讨论这种克制的象征手法。',
      },
    ]),
    queries: Object.freeze([
      { query: '凌晨便利店 故事 悬疑', kind: 'web' },
      { query: '凌晨便利店 角色 店员 夜行人', kind: 'web' },
      { query: '城市夜班 叙事 孤独', kind: 'mixed' },
      { query: '便利店 隐喻 零钱 饮料', kind: 'web' },
    ]),
    knowledge_queries: Object.freeze([
      { query: '凌晨便利店 设定 百科', kind: 'knowledge' },
      { query: '便利店 夜班 文学流派', kind: 'knowledge' },
    ]),
    hot_keywords: Object.freeze([
      { keyword: '凌晨便利店', rationale: '原作标题本身的热榜匹配关键词。' },
      { keyword: '夜班 便利店', rationale: '原作核心时空名词，常见热榜话题。' },
      { keyword: '店员 夜行人', rationale: '原作双角色设定对应的热榜搜索热词。' },
    ]),
  }),
});

/**
 * Convenience: get the seed for a slug. Throws when the slug is not
 * recognised by the mock catalog.
 *
 * @param {string} slug
 */
export function getCommunityFixtureSeed(slug) {
  if (typeof slug !== 'string' || !slug) {
    throw new Error('communityFixtures: slug required');
  }
  const seed = COMMUNITY_FIXTURE_SEEDS[slug];
  if (!seed) {
    throw new Error(`communityFixtures: no seed for slug '${slug}'`);
  }
  return seed;
}

/**
 * Convenience: list the slugs for which a hand-curated fixture exists.
 * @returns {string[]}
 */
export function listCommunityFixtureSlugs() {
  return Object.freeze(Object.keys(COMMUNITY_FIXTURE_SEEDS));
}

void FIXTURE_UUIDS;
