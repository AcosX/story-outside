// src/providers/ecosystem/mockProvider.mjs — ClickUp 16.3 ecosystem
// (follow + friend timeline) Mock provider.
//
// 默认 provider；确定性 in-memory；不调用网络、不读形如凭证的环境变量。
//
// ClickUp 16.3 描述要求：
//   * Mock 至少模拟：当前用户关注 2–3 个测试身份，其中一人有公开世界线、
//     一人无本产品账号 / 无公开世界线。
//   * DTO 不依赖原始 API JSON；adapter 在 following.mjs 完成。
//   * 默认 private；只返回 share=shared 的 FriendTimeline。

import {
  normaliseFollowIdentity,
  normaliseFollowingFeedItem,
  normaliseFollowingListItem,
  normaliseFriendTimeline,
} from './following.mjs';
import {
  ECOSYSTEM_FIXTURE_FEED,
  ECOSYSTEM_FIXTURE_FOLLOWINGS,
  ECOSYSTEM_FIXTURE_IDENTITIES,
  ECOSYSTEM_FIXTURE_TIMELINES,
} from './fixtures.mjs';

/**
 * @typedef {import('./following.mjs').FollowingFeedItem} FollowingFeedItem
 * @typedef {import('./following.mjs').FollowIdentity} FollowIdentity
 * @typedef {import('./following.mjs').FriendTimeline} FriendTimeline
 * @typedef {import('./following.mjs').FollowingListItem} FollowingListItem
 */

/**
 * @typedef {Object} MockEcosystemProviderOptions
 * @property {FollowingListItem[]} [followingsByUserRef]     覆盖关注列表。
 * @property {FollowingFeedItem[]} [feedByUserRef]           覆盖 feed。
 * @property {Array<object>} [timelines]                     覆盖世界线池。
 * @property {FollowIdentity[]} [localIdentities]            覆盖本地映射。
 */

/**
 * 工厂函数。返回一个冻结的 EcosystemProvider。
 *
 * @param {MockEcosystemProviderOptions} [opts]
 */
export function createMockEcosystemProvider(opts) {
  const options = opts || {};
  /** @type {Map<string, FollowingListItem[]>} */
  const followingsMap = new Map();
  for (const [userRef, list] of Object.entries(ECOSYSTEM_FIXTURE_FOLLOWINGS)) {
    followingsMap.set(userRef, list.map(normaliseFollowingListItem));
  }
  /** @type {Map<string, FollowingFeedItem[]>} */
  const feedMap = new Map();
  for (const [userRef, items] of Object.entries(ECOSYSTEM_FIXTURE_FEED)) {
    feedMap.set(userRef, items.map((raw) => normaliseFollowingFeedItem(raw)));
  }
  const timelinesPool = (options.timelines || ECOSYSTEM_FIXTURE_TIMELINES).map((raw) => {
    try {
      // normaliseFriendTimeline 在 shared_state !== 'shared' 时会抛——
      // 这正是我们要的"默认 private"行为。
      return normaliseFriendTimeline(raw);
    } catch {
      return null;
    }
  }).filter(Boolean);
  const localIdentities = (options.localIdentities || ECOSYSTEM_FIXTURE_IDENTITIES).map(
    normaliseFollowIdentity,
  );

  return Object.freeze({
    name: 'mock',
    async getFollowing(userRef, options2) {
      if (typeof userRef !== 'string' || !userRef) return [];
      const list = followingsMap.get(userRef);
      if (!list) return [];
      const limit = options2 && Number.isInteger(options2.limit) ? options2.limit : list.length;
      return list.slice(0, Math.max(0, Math.min(limit, list.length)));
    },
    async getFollowingFeed(userRef, options2) {
      if (typeof userRef !== 'string' || !userRef) return [];
      const items = feedMap.get(userRef);
      if (!items) return [];
      const limit = options2 && Number.isInteger(options2.limit) ? options2.limit : items.length;
      return items.slice(0, Math.max(0, Math.min(limit, items.length)));
    },
    async getFriendTimelines(userRef, options2) {
      if (typeof userRef !== 'string' || !userRef) return [];
      const identityIds = options2 && Array.isArray(options2.identityIds)
        ? options2.identityIds
        : [];
      const storyVersionUuid = options2 && typeof options2.storyVersionUuid === 'string'
        ? options2.storyVersionUuid
        : undefined;
      const idSet = new Set(identityIds);
      const out = [];
      for (const t of timelinesPool) {
        if (!idSet.has(t.identity_id)) continue;
        if (storyVersionUuid && t.story_version_uuid !== storyVersionUuid) continue;
        out.push(t);
      }
      return out;
    },
    /**
     * 测试 / 运维用：暴露本地映射集合（默认 3 个）。
     * 不属于 EcosystemProvider 接口；按 name + 属性约定导出。
     */
    _localIdentities: Object.freeze(localIdentities),
    _timelinesPool: Object.freeze(timelinesPool),
  });
}