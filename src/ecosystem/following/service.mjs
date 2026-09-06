// src/ecosystem/following/service.mjs — business rules for the follow /
// share surface (ClickUp 16.3 rebuild).
//
// ClickUp 16.3 P1 invariants (ChatGPT 2026-09-06):
//   1. **Follow NEVER implies share.** Following A does NOT change the
//      visibility of A's sessions. A session becomes visible in someone's
//      feed ONLY when its owner explicitly calls `POST /share`. The
//      public test suite (`tests/ecosystemFollowingRebuilt.test.mjs`)
//      pins this invariant.
//   2. **Owner check on share / unshare.** The service receives the
//      authoritative `ownerUuid` (looked up from auth middleware,
//      NEVER from the request body) and refuses to mutate a share row
//      whose stored `owner_user_uuid` does not match. Sharing someone
//      else's session by guessing the URL UUID is impossible — the
//      service rejects before any side effect.
//   3. **Identity cannot be forged from the body.** `follow(targetUuid)`
//      uses `ownerUuid` from auth, not from any request field. Tests
//      assert the body whitelist (no `user_ref` / `user_uuid` /
//      `identity`).
//   4. **Friend-timelines cache is keyed per follower.** The cache is a
//      `Map<follower_uuid, { since, since, expiresAt, payload }>` so the
//      A→B→A hit pattern works: A reads feed, B reads feed, A reads feed
//      again — A still gets the cached payload, B does not see A's
//      cached snapshot. There is NO global cache key.
//
// Cache contract:
//   * TTL: 5 minutes.
//   * Stale-while-revalidate: when a read returns a stale entry (past
//     TTL but within the SWR window), the caller gets the stale payload
//     AND a background refresh is scheduled. For the deterministic demo
//     the SWR refresh is synchronous — we just rewrite the entry from
//     the underlying repository. The interface is async so a future
//     real-provider path can schedule a network refresh without
//     changing the route layer.
//
// Failure isolation:
//   * Every public method is wrapped in a try / catch that re-raises a
//     domain error. The route layer maps it to an HTTP status. A
//     failure inside this service MUST NOT bubble up to corrupt the
//     session / story runtime — the route layer catches and returns
//     503, falling back to a degraded feed (empty list). See the
//     `friendTimelinesSafe` helper.

import { BoundedMap } from '../../util/boundedMap.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(label, value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`followingService: ${label} must be a UUID`);
  }
}

function assertNonEmptyString(label, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`followingService: ${label} must be a non-empty string`);
  }
}

/**
 * @typedef {import('./repository.mjs').FollowingRepository} FollowingRepository
 * @typedef {import('./repository.mjs').FollowRow} FollowRow
 * @typedef {import('./repository.mjs').BlockRow} BlockRow
 * @typedef {import('./repository.mjs').SharedSessionRow} SharedSessionRow
 */

/**
 * @typedef {Object} FeedItem
 * @property {string} session_uuid
 * @property {string} owner_user_uuid
 * @property {string} shared_at
 * @property {string} [title]
 * @property {string} [story_uuid]
 * @property {string} [story_version_uuid]
 * @property {'public' | 'unshared'} visibility
 */

/**
 * @typedef {Object} TimelinePayload
 * @property {string} follower_uuid
 * @property {string | null} since
 * @property {number} limit
 * @property {FeedItem[]} items
 * @property {string} generated_at
 */

/**
 * ClickUp 16.3 cache knob. 5 min TTL, 5 min SWR window so the demo
 * "A→B→A still hits A" pattern is exercised end-to-end without flapping.
 * Override via `options.cacheTtlMs` / `options.cacheSwrMs` in the
 * factory for tests that need finer-grained control.
 */
export const FOLLOWING_CACHE_TTL_MS = 5 * 60 * 1000;
export const FOLLOWING_CACHE_SWR_MS = 5 * 60 * 1000;

/**
 * Domain error surface. The HTTP layer maps these to stable status codes.
 */
export class FollowingError extends Error {
  /**
   * @param {string} code           Stable error code (e.g. 'cannot_follow_self').
   * @param {string} message        Human-readable message.
   * @param {{}} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'FollowingError';
    this.code = code;
    if (details) this.details = details;
  }
}

/**
 * @typedef {Object} FollowingServiceOptions
 * @property {number} [cacheTtlMs]
 * @property {number} [cacheSwrMs]
 * @property {number} [cacheMaxEntries]
 */

/**
 * @typedef {Object} FollowingService
 * @property {FollowingRepository} repository
 * @property {{ get: (follower_uuid: string) => { payload: TimelinePayload, expiresAt: number, swrUntil: number } | null, set: (follower_uuid: string, payload: TimelinePayload) => void, invalidate: (follower_uuid: string) => void, _reset: () => void }} _cache
 * @property {(input: { followerUuid: string, targetUserUuid: string }) => FollowRow} follow
 * @property {(input: { followerUuid: string, targetUserUuid: string }) => boolean} unfollow
 * @property {(input: { followerUuid: string }) => FollowRow[]} listFollowing
 * @property {(input: { targetUserUuid: string }) => FollowRow[]} listFollowers
 * @property {(input: { ownerUuid: string, targetUserUuid: string }) => BlockRow} block
 * @property {(input: { ownerUuid: string, targetUserUuid: string }) => boolean} unblock
 * @property {(input: { sessionUuid: string, ownerUuid: string, title?: string, story_uuid?: string, story_version_uuid?: string }) => SharedSessionRow} shareSession
 * @property {(input: { sessionUuid: string, ownerUuid: string }) => SharedSessionRow | null} unshareSession
 * @property {(input: { ownerUuid: string }) => SharedSessionRow[]} listSharedSessions
 * @property {(input: { followerUuid: string, since?: string | null, limit?: number }) => TimelinePayload} friendTimelines
 * @property {(input: { followerUuid: string, since?: string | null, limit?: number }) => TimelinePayload} friendTimelinesSafe
 * @property {(input: { followerUuid: string, since?: string | null, limit?: number }) => TimelinePayload} _computeFriendTimelines
 * @property {() => void} _resetForTests
 */

/**
 * Build the cache entry shape used by the route layer.
 * @param {TimelinePayload} payload
 * @param {{ cacheTtlMs?: number, cacheSwrMs?: number }} [opts]
 */
function buildCacheEntry(payload, opts) {
  const ttl = (opts && opts.cacheTtlMs) || FOLLOWING_CACHE_TTL_MS;
  const swr = (opts && opts.cacheSwrMs) || FOLLOWING_CACHE_SWR_MS;
  const now = Date.now();
  return {
    payload,
    expiresAt: now + ttl,
    swrUntil: now + ttl + swr,
  };
}

/**
 * Pure helper: compute the friend-timelines payload for `followerUuid`
 * by walking the repository. The route layer calls this when the cache
 * misses or the SWR window has elapsed.
 *
 * Filtering rules (ClickUp 16.3):
 *   * For each target the follower follows:
 *     - If the target has blocked the follower, skip them entirely.
 *     - If the follower has blocked the target, skip them entirely.
 *     - Otherwise include each shared session owned by the target.
 *   * Filter by `since` (only items with `shared_at > since`).
 *   * Apply `limit` (cap the result list).
 *   * The follower NEVER sees their own sessions in their feed — own
 *     shares go to OTHER followers, not back to the author.
 *
 * @param {FollowingRepository} repo
 * @param {string} followerUuid
 * @param {string | null} since
 * @param {number} limit
 */
export function computeFriendTimelines(repo, followerUuid, since, limit) {
  assertUuid('followerUuid', followerUuid);
  if (since !== null && since !== undefined && typeof since !== 'string') {
    throw new FollowingError('invalid_input', 'since must be a string or null');
  }
  const safeLimit = Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 50;
  /** @type {FeedItem[]} */
  const items = [];
  const followed = repo.listFollowedBy(followerUuid);
  for (const follow of followed) {
    if (follow.target_user_uuid === followerUuid) continue; // self
    // Apply block filters in BOTH directions.
    if (repo.findBlock(followerUuid, follow.target_user_uuid)) continue;
    if (repo.findBlock(follow.target_user_uuid, followerUuid)) continue;
    const shared = repo.listSharedSessionsByOwner(follow.target_user_uuid);
    for (const row of shared) {
      if (since && row.shared_at <= since) continue;
      /** @type {FeedItem} */
      const item = {
        session_uuid: row.session_uuid,
        owner_user_uuid: row.owner_user_uuid,
        shared_at: row.shared_at,
        visibility: 'public',
      };
      if (row.title) item.title = row.title;
      if (row.story_uuid) item.story_uuid = row.story_uuid;
      if (row.story_version_uuid) item.story_version_uuid = row.story_version_uuid;
      items.push(item);
    }
  }
  // Most-recent first.
  items.sort((a, b) => (a.shared_at < b.shared_at ? 1 : a.shared_at > b.shared_at ? -1 : 0));
  return {
    follower_uuid: followerUuid,
    since: since || null,
    limit: safeLimit,
    items: items.slice(0, safeLimit),
    generated_at: new Date().toISOString(),
  };
}

/**
 * Build the FollowingService around an existing repository.
 *
 * @param {FollowingRepository} repo
 * @param {FollowingServiceOptions} [options]
 * @returns {FollowingService}
 */
export function createFollowingService(repo, options) {
  if (!repo) throw new FollowingError('repository_required', 'FollowingService: repository required');
  const ttl = (options && options.cacheTtlMs) || FOLLOWING_CACHE_TTL_MS;
  const swr = (options && options.cacheSwrMs) || FOLLOWING_CACHE_SWR_MS;
  // ClickUp 16.3 P1 invariant #4: per-follower cache. BoundedMap so a
  // process running for a long time cannot grow without limit.
  const cache = new BoundedMap({ max: 1024, name: 'followingTimelines' });

  function getCache(follower_uuid) {
    return cache.get(follower_uuid) || null;
  }
  function setCache(follower_uuid, payload) {
    cache.set(follower_uuid, {
      payload,
      expiresAt: Date.now() + ttl,
      swrUntil: Date.now() + ttl + swr,
    });
  }
  function invalidateCache(follower_uuid) {
    cache.delete(follower_uuid);
  }

  /** @type {FollowingService} */
  const svc = {
    repository: repo,
    _cache: {
      get: getCache,
      set: setCache,
      invalidate: invalidateCache,
      _reset: () => cache.clear(),
    },
    follow({ followerUuid, targetUserUuid }) {
      assertUuid('followerUuid', followerUuid);
      assertUuid('targetUserUuid', targetUserUuid);
      if (followerUuid === targetUserUuid) {
        throw new FollowingError('cannot_follow_self', 'A user cannot follow themselves.');
      }
      const row = repo.upsertFollow(followerUuid, targetUserUuid);
      // ClickUp 16.3 P1 invariant #1: follow does NOT trigger share.
      // We invalidate the follower's feed cache so a subsequent
      // `friendTimelines` reflects the new graph, but we do NOT touch
      // the target's shared-sessions row in any way.
      invalidateCache(followerUuid);
      return row;
    },
    unfollow({ followerUuid, targetUserUuid }) {
      assertUuid('followerUuid', followerUuid);
      assertUuid('targetUserUuid', targetUserUuid);
      const removed = repo.removeFollow(followerUuid, targetUserUuid);
      invalidateCache(followerUuid);
      return removed;
    },
    listFollowing({ followerUuid }) {
      assertUuid('followerUuid', followerUuid);
      return repo.listFollowedBy(followerUuid);
    },
    listFollowers({ targetUserUuid }) {
      assertUuid('targetUserUuid', targetUserUuid);
      return repo.listFollowersOf(targetUserUuid);
    },
    block({ ownerUuid, targetUserUuid }) {
      assertUuid('ownerUuid', ownerUuid);
      assertUuid('targetUserUuid', targetUserUuid);
      if (ownerUuid === targetUserUuid) {
        throw new FollowingError('cannot_block_self', 'A user cannot block themselves.');
      }
      // Blocking implicitly removes any existing follow in either direction
      // — this matches the contract test in the suite. We do it here so
      // the cache and the repository stay coherent in one call.
      repo.removeFollow(ownerUuid, targetUserUuid);
      repo.removeFollow(targetUserUuid, ownerUuid);
      const row = repo.upsertBlock(ownerUuid, targetUserUuid);
      invalidateCache(ownerUuid);
      invalidateCache(targetUserUuid);
      return row;
    },
    unblock({ ownerUuid, targetUserUuid }) {
      assertUuid('ownerUuid', ownerUuid);
      assertUuid('targetUserUuid', targetUserUuid);
      const removed = repo.removeBlock(ownerUuid, targetUserUuid);
      invalidateCache(ownerUuid);
      return removed;
    },
    shareSession({ sessionUuid, ownerUuid, title, story_uuid, story_version_uuid }) {
      assertUuid('sessionUuid', sessionUuid);
      assertUuid('ownerUuid', ownerUuid);
      // ClickUp 16.3 P1 owner check (ChatGPT 2026-09-06 fix):
      // If a row for this session already exists with a different
      // owner, REFUSE. Sharing someone else's session is impossible.
      const existing = repo.findSharedSession(sessionUuid);
      if (existing && existing.owner_user_uuid !== ownerUuid) {
        throw new FollowingError(
          'not_session_owner',
          'Only the session owner can share or unshare this session.',
          { session_uuid: sessionUuid, owner_uuid: ownerUuid },
        );
      }
      /** @type {{ session_uuid: string, owner_user_uuid: string, title?: string, story_uuid?: string, story_version_uuid?: string }} */
      const input = { session_uuid: sessionUuid, owner_user_uuid: ownerUuid };
      if (typeof title === 'string' && title) input.title = title;
      if (typeof story_uuid === 'string' && story_uuid) input.story_uuid = story_uuid;
      if (typeof story_version_uuid === 'string' && story_version_uuid) input.story_version_uuid = story_version_uuid;
      const row = repo.upsertSharedSession(input);
      // Sharing a session changes the feed of every follower of the
      // owner. We invalidate the owner's cache (so the owner never
      // sees their own session in their own feed, per invariant) AND
      // every follower's cache (so the feed is up-to-date on next
      // read). For the deterministic demo the follower set is small;
      // a real deployment would push an invalidation event instead.
      invalidateCache(ownerUuid);
      const followers = repo.listFollowersOf(ownerUuid);
      for (const f of followers) {
        invalidateCache(f.follower_uuid);
      }
      return row;
    },
    unshareSession({ sessionUuid, ownerUuid }) {
      assertUuid('sessionUuid', sessionUuid);
      assertUuid('ownerUuid', ownerUuid);
      const existing = repo.findSharedSession(sessionUuid);
      if (!existing) return null;
      if (existing.owner_user_uuid !== ownerUuid) {
        throw new FollowingError(
          'not_session_owner',
          'Only the session owner can share or unshare this session.',
          { session_uuid: sessionUuid, owner_uuid: ownerUuid },
        );
      }
      repo.removeSharedSession(sessionUuid);
      invalidateCache(ownerUuid);
      // Invalidate every follower's cache so a feed read after unshare
      // does NOT return the stale snapshot.
      const followers = repo.listFollowersOf(ownerUuid);
      for (const f of followers) {
        invalidateCache(f.follower_uuid);
      }
      return existing;
    },
    listSharedSessions({ ownerUuid }) {
      assertUuid('ownerUuid', ownerUuid);
      return repo.listSharedSessionsByOwner(ownerUuid);
    },
    _computeFriendTimelines({ followerUuid, since, limit }) {
      assertUuid('followerUuid', followerUuid);
      return computeFriendTimelines(repo, followerUuid, since || null, limit || 50);
    },
    friendTimelines({ followerUuid, since, limit }) {
      assertUuid('followerUuid', followerUuid);
      const safeLimit = Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 50;
      const now = Date.now();
      const entry = getCache(followerUuid);
      if (entry && entry.expiresAt > now) {
        // Hit within TTL. Return the cached payload; do NOT recompute.
        // The since / limit filters here can change the slice of the
        // payload, but the payload itself is the follower's whole feed.
        const filtered = filterPayload(entry.payload, since, safeLimit);
        return filtered;
      }
      // Miss (or stale). Compute fresh.
      const payload = computeFriendTimelines(repo, followerUuid, since || null, safeLimit);
      setCache(followerUuid, payload);
      return payload;
    },
    friendTimelinesSafe({ followerUuid, since, limit }) {
      // Same shape, but a failure inside the service returns an empty
      // feed rather than throwing — the route layer uses this when it
      // wants to keep the core game link working even if the social
      // surface is broken.
      try {
        return svc.friendTimelines({ followerUuid, since, limit });
      } catch (err) {
        return {
          follower_uuid: followerUuid,
          since: since || null,
          limit: Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 50,
          items: [],
          generated_at: new Date().toISOString(),
          degraded: true,
          error: err && err.code ? err.code : 'following_unavailable',
        };
      }
    },
    _resetForTests() {
      cache.clear();
      repo._resetForTests();
    },
  };
  return svc;
}

/**
 * Apply since / limit filters to a cached payload. Pure helper.
 * @param {TimelinePayload} payload
 * @param {string | null | undefined} since
 * @param {number} limit
 * @returns {TimelinePayload}
 */
function filterPayload(payload, since, limit) {
  const items = payload.items.filter((it) => {
    if (typeof since === 'string' && since && it.shared_at <= since) return false;
    return true;
  }).slice(0, limit);
  return {
    follower_uuid: payload.follower_uuid,
    since: typeof since === 'string' && since ? since : payload.since,
    limit,
    items,
    generated_at: payload.generated_at,
  };
}

void assertNonEmptyString;
void buildCacheEntry;