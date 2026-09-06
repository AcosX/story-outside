// src/ecosystem/following/service.mjs — ClickUp 16.3 P1 v2 follow / share
// business rules.
//
// Differences from PR #22 (`10abc0a`):
//
//   * v2 receives the `ownerUuid` ONLY from a verified HMAC session
//     token (see `verifySessionToken` in src/sessionToken.mjs). The
//     route layer in server.mjs parses + verifies the cookie BEFORE
//     invoking the service; this service never reads `req.cookies`
//     directly and never accepts an `ownerUuid` from the request body.
//   * The HTTP layer maps the verify outcome to either:
//        ok           → call service with payload.user_uuid
//        invalid_session_token  → 401 (HMAC mismatch)
//        session_expired        → 401 (HMAC ok but exp <= now)
//
//   * Owner verification on share / unshare uses `findOwnerBySession`
//     (a new helper exported by sessionService.mjs). The canonical
//     owner is persisted by `createSession` from the verified
//     `payload.user_uuid` at session creation time; it can never be
//     forged by repeating the bootstrap call with a different cookie.
//
// ClickUp 16.3 P1 invariants:
//
//   1. Auth seam = HMAC-signed `story_outside_session` cookie. No
//      `X-Mock-User-uuid` header is read anywhere; missing /
//      malformed / expired cookies are 401.
//   2. Identity cannot be forged from the body. The route layer
//      rejects every body carrying `user_ref`, `user_uuid`,
//      `user_id`, `identity`, `user`, `subject`, `actor`, `owner`.
//   3. share / unshare are owner-only. The service refuses any
//      caller whose verified payload.user_uuid does not match the
//      canonical owner persisted by `createSession`.
//   4. Friend-timelines cache is keyed per follower (not global).
//   5. Follow NEVER implies share. Visibility requires an explicit
//      `POST /share` per session.

import { findOwnerBySession as findCanonicalOwnerBySession } from '../../stories/sessionService.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(label, value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`followingService: ${label} must be a UUID`);
  }
}

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
 * Pure function so tests can pin byte-for-byte output.
 */
export function computeFriendTimelines({ repository, followerUuid, since = null, limit = 50 }) {
  assertUuid('followerUuid', followerUuid);
  const following = repository.listFollowingOf(followerUuid);
  /** @type {Array<Record<string, unknown>>} */
  const items = [];
  for (const edge of following) {
    const shares = repository.listSharedSessionsByOwner(edge.target_user_uuid);
    for (const share of shares) {
      if (repository.findBlock(share.owner_user_uuid, followerUuid)) continue;
      if (repository.findBlock(followerUuid, share.owner_user_uuid)) continue;
      if (since && share.updated_at <= since) continue;
      items.push({ ...share });
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
 * @property {(input: { followerUuid: string, targetUserUuid: string }) => object} follow
 * @property {(input: { followerUuid: string, targetUserUuid: string }) => boolean} unfollow
 * @property {(input: { followerUuid: string, since?: string | null, limit?: number }) => { items: object[], cursor: string | null, follower_uuid: string, degraded?: boolean, error?: string }} friendTimelinesSafe
 * @property {(input: { storyRepository: object, sessionUuid: string, ownerUuid: string, title?: string, story_uuid?: string, story_version_uuid?: string }) => object} shareSession
 * @property {(input: { storyRepository: object, sessionUuid: string, ownerUuid: string }) => object | null} unshareSession
 */

/**
 * Create a FollowingService bound to a single in-memory repository.
 */
export function createFollowingService({ repository }) {
  if (!repository) throw new Error('createFollowingService: repository required');
  const repo = repository;

  /** @type {Map<string, { expiresAt: number, payload: ReturnType<typeof computeFriendTimelines> }>} */
  const feedCache = new Map();

  function invalidateCache(userUuid) {
    feedCache.delete(userUuid);
  }

  return {
    follow({ followerUuid, targetUserUuid }) {
      assertUuid('followerUuid', followerUuid);
      assertUuid('targetUserUuid', targetUserUuid);
      if (followerUuid === targetUserUuid) {
        throw new FollowingError('cannot_follow_self', 'Cannot follow yourself.', {
          follower_uuid: followerUuid,
        });
      }
      const row = repo.upsertFollow(followerUuid, targetUserUuid);
      invalidateCache(followerUuid);
      return { ...row };
    },

    unfollow({ followerUuid, targetUserUuid }) {
      assertUuid('followerUuid', followerUuid);
      assertUuid('targetUserUuid', targetUserUuid);
      const removed = repo.removeFollow(followerUuid, targetUserUuid);
      invalidateCache(followerUuid);
      return removed;
    },

    friendTimelinesSafe({ followerUuid, since = null, limit = 50 }) {
      assertUuid('followerUuid', followerUuid);
      const cacheKey = `${followerUuid}\u0000${since || ''}\u0000${limit}`;
      const cached = feedCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return { items: cached.payload.items, cursor: cached.payload.cursor, follower_uuid: followerUuid };
      }
      try {
        const payload = computeFriendTimelines({
          repository: repo,
          followerUuid,
          since,
          limit,
        });
        feedCache.set(cacheKey, { expiresAt: Date.now() + FOLLOWING_CACHE_TTL_MS, payload });
        return payload;
      } catch (err) {
        return {
          items: [],
          cursor: null,
          follower_uuid: followerUuid,
          degraded: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    /**
     * Mark a session as shared by its owner. `ownerUuid` MUST come from
     * a verified HMAC session token (server-side). The service refuses
     * any caller whose verified payload.user_uuid does not match the
     * canonical owner persisted by `createSession`.
     */
    shareSession({ storyRepository, sessionUuid, ownerUuid, title, story_uuid, story_version_uuid }) {
      assertUuid('sessionUuid', sessionUuid);
      assertUuid('ownerUuid', ownerUuid);
      if (!storyRepository) throw new Error('followingService.shareSession: storyRepository required');
      const canonicalOwner = findCanonicalOwnerBySession({ repository: storyRepository, session_uuid: sessionUuid });
      if (!canonicalOwner) {
        throw new FollowingError('session_not_found', 'Session has no canonical owner (legacy or unknown session).', {
          session_uuid: sessionUuid,
        });
      }
      if (canonicalOwner !== ownerUuid) {
        throw new FollowingError('not_session_owner', 'You are not the canonical owner of this session.', {
          session_uuid: sessionUuid,
          caller_uuid: ownerUuid,
        });
      }
      /** @type {{ session_uuid: string, owner_user_uuid: string, title?: string, story_uuid?: string, story_version_uuid?: string }} */
      const input = { session_uuid: sessionUuid, owner_user_uuid: canonicalOwner };
      if (typeof title === 'string' && title) input.title = title;
      if (typeof story_uuid === 'string' && story_uuid) input.story_uuid = story_uuid;
      if (typeof story_version_uuid === 'string' && story_version_uuid) input.story_version_uuid = story_version_uuid;
      return repo.upsertSharedSession(input);
    },

    unshareSession({ storyRepository, sessionUuid, ownerUuid }) {
      assertUuid('sessionUuid', sessionUuid);
      assertUuid('ownerUuid', ownerUuid);
      if (!storyRepository) throw new Error('followingService.unshareSession: storyRepository required');
      const canonicalOwner = findCanonicalOwnerBySession({ repository: storyRepository, session_uuid: sessionUuid });
      if (!canonicalOwner) {
        throw new FollowingError('session_not_found', 'Session has no canonical owner (legacy or unknown session).', {
          session_uuid: sessionUuid,
        });
      }
      if (canonicalOwner !== ownerUuid) {
        throw new FollowingError('not_session_owner', 'You are not the canonical owner of this session.', {
          session_uuid: sessionUuid,
          caller_uuid: ownerUuid,
        });
      }
      const existing = repo.findSharedSession(sessionUuid);
      if (!existing) return null;
      repo.removeSharedSession(sessionUuid);
      return existing;
    },
  };
}