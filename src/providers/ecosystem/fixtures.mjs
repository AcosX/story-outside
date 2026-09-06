// src/providers/ecosystem/fixtures.mjs — pre-baked follow / feed /
// friend-timeline fixtures for the mock catalog (ClickUp 16.3).
//
// 设计原则（沿用 16.1 公共底座）：
//   * 关注流 mock：当前用户关注 2–3 个测试身份，其中一人有公开世界线、
//     一人无本产品账号 / 无公开世界线。
//   * fixture 是确定性数据；测试按 uuid / identity_id 精确断言。
//   * 本模块不调用网络、不读形如凭证的环境变量。

import { FIXTURE_UUIDS } from '../../stories/fixture.mjs';

/**
 * 测试关注的 3 个知乎身份（来自 mock 用户视角）：
 *   * friend-with-timeline  — 有公开世界线（cafe-rain）
 *   * friend-without-timeline — 有本产品账号但**未分享**世界线
 *   * stranger-without-account — 关注了，但本产品无账号/无世界线
 *
 * 注意：本模块只声明**知乎侧**的关注关系（userA → url_token）。
 * localIdentities 是**本地用户表**里 user_ref ↔ url_token 的稳定映射。
 */
export const ECOSYSTEM_FIXTURE_FOLLOWINGS = Object.freeze({
  // 本地视角 mock 用户（user_ref=test-user-001）关注的知乎身份。
  'test-user-001': Object.freeze([
    Object.freeze({
      identity_id: 'mock-followee-aaaa',
      name: 'A（已公开世界线）',
      avatar_url: 'https://www.zhihu.com/people/mock-followee-aaaa/avatar',
      bio: '本产品的早期用户之一；公开了雨夜咖啡馆的世界线。',
      followers_count: 1280,
      followed_at: '2026-08-12T03:21:00.000Z',
      url: 'https://www.zhihu.com/people/mock-followee-aaaa',
    }),
    Object.freeze({
      identity_id: 'mock-followee-bbbb',
      name: 'B（未公开世界线）',
      avatar_url: 'https://www.zhihu.com/people/mock-followee-bbbb/avatar',
      bio: '本产品的早期用户之一；尚未分享任何世界线。',
      followers_count: 256,
      followed_at: '2026-08-20T08:00:00.000Z',
      url: 'https://www.zhihu.com/people/mock-followee-bbbb',
    }),
    Object.freeze({
      identity_id: 'mock-followee-cccc',
      name: 'C（本产品无账号）',
      avatar_url: 'https://www.zhihu.com/people/mock-followee-cccc/avatar',
      bio: '只在知乎活跃，未注册本产品；不会进入好友世界线对比。',
      followers_count: 64,
      followed_at: '2026-09-01T11:11:00.000Z',
      url: 'https://www.zhihu.com/people/mock-followee-cccc',
    }),
  ]),
});

/**
 * 本地 user_ref ↔ 知乎 url_token 的稳定映射。
 * 注意：mock-followee-cccc 故意**不在**映射里——这就是"无本产品账号"场景。
 */
export const ECOSYSTEM_FIXTURE_IDENTITIES = Object.freeze([
  Object.freeze({
    identity_id: 'mock-followee-aaaa',
    user_ref: 'test-user-002',
    name: 'A（已公开世界线）',
    avatar_url: 'https://www.zhihu.com/people/mock-followee-aaaa/avatar',
    bio: '本地绑定身份 A',
    followers_count: 1280,
    linked_at: '2026-08-12T04:00:00.000Z',
    source: 'mock-fixture',
  }),
  Object.freeze({
    identity_id: 'mock-followee-bbbb',
    user_ref: 'test-user-003',
    name: 'B（未公开世界线）',
    avatar_url: 'https://www.zhihu.com/people/mock-followee-bbbb/avatar',
    bio: '本地绑定身份 B',
    followers_count: 256,
    linked_at: '2026-08-20T09:00:00.000Z',
    source: 'mock-fixture',
  }),
  // mock-followee-cccc 没有对应 user_ref → 不进入 friend_timelines。
]);

/**
 * 关注人动态 mock（仅 mock 用户 test-user-001 的视角）。
 * ClickUp 16.3 描述："feed/following 作为次级能力——可用于首页
 * '你关注的人最近在知乎关注/创作什么'的社区语境模块"。
 */
export const ECOSYSTEM_FIXTURE_FEED = Object.freeze({
  'test-user-001': Object.freeze([
    Object.freeze({
      identity_id: 'mock-followee-aaaa',
      kind: 'create_answer',
      title: '为什么"凌晨咖啡馆"叙事在中文文学里有特殊位置？',
      snippet: '从《雨夜咖啡馆》到近期一篇热门回答，谈谈凌晨时空书写的母题...',
      occurred_at: '2026-09-04T13:00:00.000Z',
      url: 'https://www.zhihu.com/question/123/answer/456',
    }),
    Object.freeze({
      identity_id: 'mock-followee-bbbb',
      kind: 'create_article',
      title: '如何写一个不会泄露对方原始历史的"好友世界线"功能',
      snippet: '从产品设计角度看 share=shared 字段的最小可用状态机...',
      occurred_at: '2026-09-03T09:30:00.000Z',
      url: 'https://zhuanlan.zhihu.com/p/789',
    }),
  ]),
});

/**
 * mock 公开世界线（已 share=true）。
 * 仅 mock-followee-aaaa 在 cafe-rain 上有 1 条公开世界线。
 * mock-followee-bbbb **不**在此处出现——因为 shared=false。
 */
export const ECOSYSTEM_FIXTURE_TIMELINES = Object.freeze([
  Object.freeze({
    identity_id: 'mock-followee-aaaa',
    identity_name: 'A（已公开世界线）',
    shared_state: 'shared',
    story_version_uuid: FIXTURE_UUIDS['cafe-rain'].story_version_uuid,
    ending_anchor: '你接受了那杯热咖啡。',
    choice_anchors: Object.freeze([
      '回应了旧友的寒暄',
      '把冷咖啡换成了热咖啡',
    ]),
    completed_at: '2026-09-02T12:34:00.000Z',
    source: 'mock-fixture',
  }),
]);

/**
 * 便捷：按 identity_id 取一条本地映射。
 * @param {string} identityId
 * @returns {object | null}
 */
export function getEcosystemFixtureIdentity(identityId) {
  if (typeof identityId !== 'string' || !identityId) return null;
  for (const ident of ECOSYSTEM_FIXTURE_IDENTITIES) {
    if (ident.identity_id === identityId) return ident;
  }
  return null;
}

/**
 * 便捷：取给定 story_version_uuid + identity_id 的公开世界线。
 * @param {string} identityId
 * @param {string} [storyVersionUuid]
 * @returns {object | null}
 */
export function getEcosystemFixtureTimeline(identityId, storyVersionUuid) {
  if (typeof identityId !== 'string' || !identityId) return null;
  for (const t of ECOSYSTEM_FIXTURE_TIMELINES) {
    if (t.identity_id !== identityId) continue;
    if (storyVersionUuid && t.story_version_uuid !== storyVersionUuid) continue;
    return t;
  }
  return null;
}