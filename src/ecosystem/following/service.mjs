// Official followees intersect with account-visible session activity in production.
// Legacy explicit sharing remains available when no activity reader is injected.
// Owners always come from canonical sessions; blocks and privacy apply at read time.

import { findOwnerBySession as findCanonicalOwnerBySession } from '../../stories/sessionService.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(label, value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`followingService: ${label} must be a UUID`);
  }
}

/**
 * Story 16.3 P1 domain error. The route layer maps `code` to an HTTP
 * status; the message is safe for player-facing responses.
 */
export class FollowingError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'FollowingError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const FOLLOWING_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * 由「已解析出的本站账号集合」计算关注流。纯函数，便于把输出钉死在测试里。
 *
 * @param {object} args
 * @param {{ findBlock: Function, listSharedSessionsByOwner: Function }} args.repository
 * @param {string} args.followerUuid
 * @param {string[]} args.ownerUuids   在知乎被关注、且已映射到本站的账号。
 * @param {(share: object) => object} [args.decorate] 附加展示字段（故事名等）。
 * @param {string | null} [args.since]
 * @param {number} [args.limit]
 */
export function computeFriendTimelines({
  repository,
  followerUuid,
  ownerUuids = [],
  decorate = null,
  since = null,
  limit = 50,
  listActivities = null,
}) {
  assertUuid('followerUuid', followerUuid);
  /** @type {Array<Record<string, unknown>>} */
  const items = [];
  const visited = new Set();
  for (const ownerUuid of ownerUuids) {
    if (typeof ownerUuid !== 'string' || !UUID_PATTERN.test(ownerUuid)) continue;
    // 自己的世界线不进自己的关注流。
    if (ownerUuid === followerUuid) continue;
    if (visited.has(ownerUuid)) continue;
    visited.add(ownerUuid);
    if (repository.isVisible?.(ownerUuid) === false) continue;
    const shares = listActivities ? listActivities(ownerUuid) : repository.listSharedSessionsByOwner(ownerUuid);
    for (const share of shares) {
      // 对方屏蔽了我，或我屏蔽了对方，都不展示。
      if (repository.findBlock(share.owner_user_uuid, followerUuid)) continue;
      if (repository.findBlock(followerUuid, share.owner_user_uuid)) continue;
      if (since && share.updated_at <= since) continue;
      items.push(decorate ? decorate({ ...share }) : { ...share });
    }
  }
  items.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  const sliced = items.slice(0, Math.max(1, Math.min(200, Number.isInteger(limit) && limit > 0 ? limit : 50)));
  return {
    items: Object.freeze(sliced.map((s) => Object.freeze({ ...s }))),
    cursor: sliced.length > 0 ? sliced[sliced.length - 1].updated_at : null,
    follower_uuid: followerUuid,
  };
}

/**
 * @typedef {Object} FollowingService
 * @property {(input: { followerUuid: string, oauthToken?: string | null, storyRepository?: object, since?: string | null, limit?: number }) => Promise<object>} friendTimelinesSafe
 * @property {(input: { storyRepository: object, sessionUuid: string, ownerUuid: string, title?: string, story_uuid?: string, story_version_uuid?: string }) => object} shareSession
 * @property {(input: { storyRepository: object, sessionUuid: string, ownerUuid: string }) => object | null} unshareSession
 * @property {(input: { storyRepository: object, sessionUuid: string, ownerUuid: string }) => object | null} findOwnShare
 */

/**
 * Create a FollowingService.
 *
 * @param {object} input
 * @param {ReturnType<typeof import('./repository.mjs').createInMemoryFollowingRepository>} input.repository
 * @param {{ resolve: (urlToken: string) => string | null }} [input.accountDirectory]
 *        知乎 url_token → 本站账号的映射目录（登录时登记）。
 * @param {(args: { oauthToken: string, limit?: number }) => Promise<{ items: Array<{ url_token: string, fullname: string, url: string, avatar_url: string, headline: string }>, total: number | null, truncated: boolean }>} [input.fetchFollowees]
 *        知乎官方关注接口适配层。缺省时关注流为「未配置」降级态。
 * @param {(ownerUuid: string) => Array<object>} [input.listActivities] Canonical activity projection.
 * @returns {FollowingService}
 */
export function createFollowingService({ repository, accountDirectory = null, fetchFollowees = null, listActivities = null }) {
  if (!repository) throw new Error('createFollowingService: repository required');
  const repo = repository;

  /** @type {Map<string, { expiresAt: number, payload: object }>} */
  const feedCache = new Map();

  function invalidateAllFeeds() {
    feedCache.clear();
  }

  return {
    invalidateAllFeeds,
    /**
     * 读取「我在知乎关注的人，在这里公开了哪些世界线」。
     *
     * 任何失败都降级：返回空列表 + 明确的 `status`，让前端说清为什么空，
     * 而不是抛 5xx 或假装有数据。
     */
    async friendTimelinesSafe({ followerUuid, oauthToken = null, storyRepository = null, since = null, limit = 50 }) {
      assertUuid('followerUuid', followerUuid);
      // 缓存键必须区分登录态：同一账号「已登录」与「会话已过期」的结果不同，
      // 混用会让退出后仍看到上一次的关注流。token 本身是凭据，不能进键，
      // 因此只用「有/无」这一位。
      const cacheKey = `${followerUuid}\u0000${typeof oauthToken === 'string' && oauthToken ? '1' : '0'}\u0000${since || ''}\u0000${limit}`;
      const cached = feedCache.get(cacheKey);
      if (!listActivities && cached && cached.expiresAt > Date.now()) return cached.payload;

      const empty = (status, extra = {}) => ({
        items: Object.freeze([]),
        cursor: null,
        follower_uuid: followerUuid,
        status,
        followee_count: 0,
        matched_count: 0,
        ...extra,
      });

      if (typeof fetchFollowees !== 'function') return empty('unconfigured');
      if (!accountDirectory || typeof accountDirectory.resolve !== 'function') return empty('unconfigured');
      if (typeof oauthToken !== 'string' || !oauthToken) return empty('login_required');

      let followees;
      try {
        followees = await fetchFollowees({ oauthToken, limit: 50 });
      } catch (error) {
        // 上游失败只降级，不影响「我的」页面其余部分。错误码来自适配层，
        // 已确保不含任何凭证内容。
        const code = error && typeof error.code === 'string' ? error.code : 'upstream_error';
        return empty(code === 'unconfigured' || code === 'missing_oauth_token' ? code : 'unavailable');
      }

      const followeeItems = Array.isArray(followees?.items) ? followees.items : [];
      // 知乎关注的人里，哪些也在本站登录过 —— 只有这些人才可能有世界线。
      const ownerUuids = [];
      /** @type {Map<string, object>} */
      const profileByUuid = new Map();
      for (const followee of followeeItems) {
        const ownerUuid = accountDirectory.resolve(followee.url_token);
        if (!ownerUuid) continue;
        ownerUuids.push(ownerUuid);
        if (!profileByUuid.has(ownerUuid)) profileByUuid.set(ownerUuid, followee);
      }

      const decorate = (share) => {
        const profile = profileByUuid.get(share.owner_user_uuid) || null;
        const item = {
          session_uuid: share.session_uuid,
          state: share.state || null,
          shared_at: share.updated_at,
          updated_at: share.updated_at,
          created_at: share.created_at,
          story_title: typeof share.title === 'string' && share.title ? share.title : null,
          story_uuid: share.story_uuid || null,
        };
        if (profile) {
          // 只投影公开资料；不带 uid，也不带本站内部账号标识。
          item.author = {
            fullname: profile.fullname,
            url: profile.url,
            avatar_url: profile.avatar_url,
            headline: profile.headline,
          };
        }
        if (!item.story_title && storyRepository && item.story_uuid) {
          try {
            const story = storyRepository.findStoryByUuid(item.story_uuid);
            if (story && typeof story.title === 'string') item.story_title = story.title;
          } catch { /* 标题只是展示增强，取不到就留空 */ }
        }
        return item;
      };

      let payload;
      try {
        const computed = computeFriendTimelines({
          repository: repo,
          followerUuid,
          ownerUuids,
          listActivities,
          decorate,
          since,
          limit,
        });
        payload = {
          ...computed,
          status: 'ok',
          followee_count: followeeItems.length,
          matched_count: ownerUuids.length,
          followee_truncated: Boolean(followees?.truncated),
        };
      } catch (error) {
        return empty('unavailable');
      }
      feedCache.set(cacheKey, { expiresAt: Date.now() + FOLLOWING_CACHE_TTL_MS, payload });
      return payload;
    },
    /** 当前会话是否已被本人公开。供前端决定显示「公开」还是「撤回」。 */
    findOwnShare({ storyRepository, sessionUuid, ownerUuid }) {
      assertUuid('sessionUuid', sessionUuid);
      assertUuid('ownerUuid', ownerUuid);
      if (!storyRepository) return null;
      const canonicalOwner = findCanonicalOwnerBySession({
        repository: storyRepository,
        session_uuid: sessionUuid,
      });
      if (canonicalOwner === null || canonicalOwner !== ownerUuid) return null;
      return repo.findSharedSession(sessionUuid);
    },
    shareSession({ storyRepository, sessionUuid, ownerUuid, title, story_uuid, story_version_uuid }) {
      assertUuid('sessionUuid', sessionUuid);
      assertUuid('ownerUuid', ownerUuid);
      if (!storyRepository) {
        throw new FollowingError('invalid_input', 'storyRepository required.', null);
      }
      // Story 16.3 P1.2 canonical owner binding (code review 2026-09-07
      // re-review). The handler passes the cookie-derived `ownerUuid`
      // and we compare it to the canonical owner persisted by
      // sessionService.createSession. The body NEVER carries the owner.
      const canonicalOwner = findCanonicalOwnerBySession({
        repository: storyRepository,
        session_uuid: sessionUuid,
      });
      if (canonicalOwner === null) {
        throw new FollowingError(
          'session_not_found',
          'Session does not exist or has no canonical owner.',
          { session_uuid: sessionUuid },
        );
      }
      if (canonicalOwner !== ownerUuid) {
        throw new FollowingError(
          'not_session_owner',
          'Only the canonical session owner can share this session.',
          { session_uuid: sessionUuid, owner_uuid: ownerUuid },
        );
      }
      // Refuse rebinding an existing share to a different owner.
      const existing = repo.findSharedSession(sessionUuid);
      if (existing && existing.owner_user_uuid !== canonicalOwner) {
        throw new FollowingError(
          'not_session_owner',
          'Only the canonical session owner can share this session.',
          { session_uuid: sessionUuid, owner_uuid: ownerUuid },
        );
      }
      /** @type {{ session_uuid: string, owner_user_uuid: string, title?: string, story_uuid?: string, story_version_uuid?: string }} */
      const input = { session_uuid: sessionUuid, owner_user_uuid: canonicalOwner };
      if (typeof title === 'string' && title) input.title = title;
      if (typeof story_uuid === 'string' && story_uuid) input.story_uuid = story_uuid;
      if (typeof story_version_uuid === 'string' && story_version_uuid) input.story_version_uuid = story_version_uuid;
      const row = repo.upsertSharedSession(input);
      // 公开一段世界线会影响「所有关注了这个人的人」的关注流。关注关系现在
      // 由知乎持有，本站无法枚举关注者，因此直接整体失效关注流缓存——它只是
      // 一层 5 分钟的读缓存，重建代价可接受，正确性优先。
      invalidateAllFeeds();
      return { ...row };
    },
    unshareSession({ storyRepository, sessionUuid, ownerUuid }) {
      assertUuid('sessionUuid', sessionUuid);
      assertUuid('ownerUuid', ownerUuid);
      if (!storyRepository) {
        throw new FollowingError('invalid_input', 'storyRepository required.', null);
      }
      const canonicalOwner = findCanonicalOwnerBySession({
        repository: storyRepository,
        session_uuid: sessionUuid,
      });
      if (canonicalOwner === null) {
        throw new FollowingError(
          'session_not_found',
          'Session does not exist or has no canonical owner.',
          { session_uuid: sessionUuid },
        );
      }
      if (canonicalOwner !== ownerUuid) {
        throw new FollowingError(
          'not_session_owner',
          'Only the canonical session owner can unshare this session.',
          { session_uuid: sessionUuid, owner_uuid: ownerUuid },
        );
      }
      const existing = repo.findSharedSession(sessionUuid);
      if (!existing) return null;
      repo.removeSharedSession(sessionUuid);
      // 撤回必须立刻从所有人的关注流里消失，不能等缓存自然过期。
      invalidateAllFeeds();
      return { ...existing };
    },
  };
}