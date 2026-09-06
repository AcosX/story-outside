// src/providers/ecosystem/service.mjs — ClickUp 16.3 公共 facade。
//
// 关注流 + 关注关系 + 社区世界线对比的应用层入口。所有 cache / adapter
// / 降级 / 隐私守门都在这里集中，让上层 HTTP 路由不必关心细节。
//
// 设计原则（沿用 16.1 公共底座的设计）：
//   * 故障不影响主链：provider 抛错时返回空（除 getFriendTimelines 抛错以
//     让上层知道；但请求被降级）。
//   * session 默认 private；share=true 才进入 social 视图。
//   * 关注关系缓存采用短 TTL（5 分钟），不永久复制完整知乎社交图。
//   * 不读对方原始 Session 历史；只读对方**主动公开**的 FriendTimeline。

import {
  createShortTtlCache,
  FOLLOWING_DEFAULT_TTL_MS,
  intersectFollowingsWithLocalIdentities,
  normaliseFollowIdentity,
  normaliseFollowingFeedItem,
  normaliseFriendTimeline,
} from './following.mjs';

/**
 * @typedef {import('./following.mjs').FollowingFeedItem} FollowingFeedItem
 * @typedef {import('./following.mjs').FollowIdentity} FollowIdentity
 * @typedef {import('./following.mjs').FriendTimeline} FriendTimeline
 * @typedef {import('./following.mjs').FollowingListItem} FollowingListItem
 */

/**
 * @typedef {Object} EcosystemProvider
 * @property {string} name
 * @property {(userRef: string, options?: { limit?: number, ttlMs?: number }) => Promise<FollowingListItem[]>} getFollowing
 * @property {(userRef: string, options?: { limit?: number, ttlMs?: number }) => Promise<FollowingFeedItem[]>} getFollowingFeed
 * @property {(userRef: string, options?: { identityIds: string[] }) => Promise<FriendTimeline[]>} getFriendTimelines
 */

/**
 * @typedef {Object} EcosystemServiceOptions
 * @property {number} [defaultTtlMs]            默认短 TTL（默认 5 分钟）。
 * @property {() => number} [clock]             可注入的时钟（测试用）。
 */

/**
 * 构造关注流 service。所有缓存都在 service 内部创建；调用方无需关心 cache 生命周期。
 *
 * @param {EcosystemProvider} provider
 * @param {EcosystemServiceOptions} [opts]
 */
export function createEcosystemService(provider, opts) {
  if (!provider || typeof provider !== 'object') {
    throw new Error('ecosystem.service: provider required');
  }
  if (typeof provider.getFollowing !== 'function') {
    throw new Error('ecosystem.service: provider.getFollowing required');
  }
  if (typeof provider.getFollowingFeed !== 'function') {
    throw new Error('ecosystem.service: provider.getFollowingFeed required');
  }
  if (typeof provider.getFriendTimelines !== 'function') {
    throw new Error('ecosystem.service: provider.getFriendTimelines required');
  }
  const defaultTtlMs = (opts && Number.isInteger(opts.defaultTtlMs))
    ? opts.defaultTtlMs
    : FOLLOWING_DEFAULT_TTL_MS;
  const clock = (opts && typeof opts.clock === 'function') ? opts.clock : (() => Date.now());
  const followingCache = createShortTtlCache({ defaultTtlMs, name: 'following.list', clock });
  const feedCache = createShortTtlCache({ defaultTtlMs, name: 'following.feed', clock });
  const timelineCache = createShortTtlCache({ defaultTtlMs, name: 'friend.timelines', clock });

  /**
   * 内部：把 async provider 调用包成"故障降级"包装。失败时回 fallback。
   * @template T
   * @param {() => Promise<T>} fn
   * @param {T} fallback
   * @returns {Promise<T>}
   */
  async function withDegradation(fn, fallback) {
    try {
      return await fn();
    } catch {
      // 故障降级：返回 fallback；上层路由照样能响应。
      return fallback;
    }
  }

  /**
   * 关注列表。命中 cache 时直接返回缓存；否则调 provider。
   *
   * @param {string} userRef
   * @param {{ limit?: number, ttlMs?: number }} [options]
   * @returns {Promise<FollowingListItem[]>}
   */
  async function getFollowing(userRef, options) {
    if (typeof userRef !== 'string' || !userRef) {
      throw new Error('ecosystem.service: userRef required');
    }
    const limit = options && Number.isInteger(options.limit) ? options.limit : 20;
    const ttlMs = options && Number.isInteger(options.ttlMs) ? options.ttlMs : defaultTtlMs;
    const cacheKey = `followees|${userRef}|${limit}`;
    if (followingCache.has(cacheKey)) {
      return /** @type {FollowingListItem[]} */ (followingCache.get(cacheKey));
    }
    const list = await withDegradation(
      () => provider.getFollowing(userRef, { limit, ttlMs }),
      [],
    );
    followingCache.set(cacheKey, list, ttlMs);
    return list;
  }

  /**
   * 关注流条目（关注人动态）。
   *
   * @param {string} userRef
   * @param {{ limit?: number, ttlMs?: number }} [options]
   * @returns {Promise<FollowingFeedItem[]>}
   */
  async function getFollowingFeed(userRef, options) {
    if (typeof userRef !== 'string' || !userRef) {
      throw new Error('ecosystem.service: userRef required');
    }
    const limit = options && Number.isInteger(options.limit) ? options.limit : 20;
    const ttlMs = options && Number.isInteger(options.ttlMs) ? options.ttlMs : defaultTtlMs;
    const cacheKey = `feed|${userRef}|${limit}`;
    if (feedCache.has(cacheKey)) {
      return /** @type {FollowingFeedItem[]} */ (feedCache.get(cacheKey));
    }
    const items = await withDegradation(
      () => provider.getFollowingFeed(userRef, { limit, ttlMs }),
      [],
    );
    feedCache.set(cacheKey, items, ttlMs);
    return items;
  }

  /**
   * 好友世界线对比。
   *
   * 主流程：
   *   1. 取关注列表（短 TTL 缓存）。
   *   2. 与本地 FollowIdentity 集合求交集——只保留"既是真实关注、又绑定本地 user_ref"的。
   *   3. 把交集 identity_id 传给 provider.getFriendTimelines。
   *   4. provider 只返回**对方主动公开**的世界线；非公开 timeline 在 provider 端被拒。
   *   5. 返回的 FriendTimeline **不含** private_history（adapter 层拒绝）。
   *
   * 失败/降级：返回 []。**不**抛错。路由层据此判定 social 模块空载。
   *
   * @param {object} input
   * @param {string} input.userRef
   * @param {FollowIdentity[]} input.localIdentities       本地 user_ref ↔ 知乎 identity 映射。
   * @param {string} [input.storyVersionUuid]              限定到某个 story_version；不传时 provider 端自行处理。
   * @returns {Promise<FriendTimeline[]>}
   */
  async function getFriendTimelines(input) {
    if (!input || typeof input !== 'object') {
      throw new Error('ecosystem.service: input required');
    }
    const { userRef, localIdentities, storyVersionUuid } = input;
    if (typeof userRef !== 'string' || !userRef) {
      throw new Error('ecosystem.service: userRef required');
    }
    if (!Array.isArray(localIdentities)) {
      throw new Error('ecosystem.service: localIdentities[] required');
    }
    const followees = await getFollowing(userRef, { limit: 50 });
    const { matched } = intersectFollowingsWithLocalIdentities(followees, localIdentities);
    if (matched.length === 0) {
      return [];
    }
    const identityIds = matched.map((m) => m.identity_id);
    const cacheKey = `friend|${userRef}|${storyVersionUuid || ''}|${identityIds.slice().sort().join(',')}`;
    if (timelineCache.has(cacheKey)) {
      return /** @type {FriendTimeline[]} */ (timelineCache.get(cacheKey));
    }
    const items = await withDegradation(
      () => provider.getFriendTimelines(userRef, {
        identityIds,
        storyVersionUuid,
      }),
      [],
    );
    // 双层隐私守门：normaliseFriendTimeline 在 provider 端已拒绝 private；
    // 此处再 normalise 一次以防 provider 实现绕过。
    const out = [];
    for (const raw of items) {
      try {
        out.push(normaliseFriendTimeline(raw));
      } catch {
        // 不允许 private / 非法 timeline 进入社交视图。
      }
    }
    timelineCache.set(cacheKey, out, defaultTtlMs);
    return out;
  }

  /**
   * 暴露给测试 / 运维。
   * @returns {{
   *   following: { live: number, total: number },
   *   feed: { live: number, total: number },
   *   timelines: { live: number, total: number },
   * }}
   */
  function cacheStats() {
    return {
      following: followingCache.stats(),
      feed: feedCache.stats(),
      timelines: timelineCache.stats(),
    };
  }

  /**
   * 清空所有缓存（测试用 / 运维强制刷新）。
   */
  function clearAllCaches() {
    followingCache.clear();
    feedCache.clear();
    timelineCache.clear();
  }

  return Object.freeze({
    name: 'ecosystem',
    providerName: provider.name,
    defaultTtlMs,
    getFollowing,
    getFollowingFeed,
    getFriendTimelines,
    cacheStats,
    clearAllCaches,
  });
}

export { intersectFollowingsWithLocalIdentities, normaliseFollowIdentity, normaliseFollowingFeedItem, normaliseFriendTimeline };