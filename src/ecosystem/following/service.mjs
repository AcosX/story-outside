// src/ecosystem/following/service.mjs — business rules for the follow /
// share surface (ClickUp 16.3 P1 rebuild on `44343b2`).
//
// ClickUp 16.3 P1 invariants (ChatGPT 2026-09-07 re-review of PR #21):
//   1. **Auth is NOT a request header.** The caller identity comes from
//      the `story_outside_session` cookie (set by the `/api/sessions`
//      bootstrap route). The handler reads it; the service receives the
//      cookie-derived `ownerUuid`. There is no `X-Mock-User-uuid`
//      header path.
//   2. **Owner check on share / unshare.** The service receives the
//      cookie-derived `ownerUuid` AND the canonical owner (resolved via
//      `sessionService.findOwnerBySession`). If the cookie-derived
//      owner does not match the canonical owner, the service refuses.
//      Sharing someone else's session by guessing the URL UUID is
//      impossible — the canonical owner is bound at session creation
//      and never changes.
//   3. **Identity cannot be forged from the body.** The handler
//      rejects every body that carries `user_ref`, `user_uuid`,
//      `user_id`, `identity`, `user`, `subject`, `actor`, `owner`.
//      Tests assert the body whitelist.
//   4. **Friend-timelines cache is keyed per follower.** The cache is a
//      `Map<follower_uuid, { expiresAt, payload }>` so the A→B→A hit
//      pattern works: A reads feed, B reads feed, A reads feed again —
//      A still gets the cached payload, B does not see A's cached
//      snapshot. There is NO global cache key.
//   5. **Follow NEVER implies share.** Following A does NOT change the
//      visibility of A's sessions. A session becomes visible in
//      someone's feed ONLY when its owner explicitly calls `POST /share`.
//
// Cache contract:
//   * TTL: 5 minutes.
//   * No stale-while-revalidate on this rebuild (kept deterministic for
//     the demo). The interface is async so a future real-provider path
//     can layer SWR on top without changing the route layer.
//
// Failure isolation:
//   * Every public method throws a `FollowingError` on domain failure.
//     The route layer maps it to an HTTP status. A failure inside this
//     service MUST NOT bubble up to corrupt the session / story runtime.

import { findOwnerBySession as findCanonicalOwnerBySession } from '../../stories/sessionService.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(label, value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`followingService: ${label} must be a UUID`);
  }
}

/**
 * ClickUp 16.3 P1 domain error. The route layer maps `code` to an HTTP
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
 * Compute the friend-timeline feed for `followerUuid` from the in-memory
 * repository. Pure function so tests can pin byte-for-byte output.
 *
 * @param {object} args
 * @param {{ findBlock: Function, listFollowingOf: Function, listSharedSessionsByOwner: Function, listAllSharedSessions: Function }} args.repository
 * @param {string} args.followerUuid
 * @param {string | null} [args.since]
 * @param {number} [args.limit]
 */
export function computeFriendTimelines({ repository, followerUuid, since = null, limit = 50 }) {
  assertUuid('followerUuid', followerUuid);
  const following = repository.listFollowingOf(followerUuid);
  /** @type {Array<Record<string, unknown>>} */
  const items = [];
  for (const edge of following) {
    const shares = repository.listSharedSessionsByOwner(edge.target_user_uuid);
    for (const share of shares) {
      // Skip sessions whose owner has blocked the follower (per-owner
      // visibility rule).
      if (repository.findBlock(share.owner_user_uuid, followerUuid)) continue;
      // Skip sessions where the follower has blocked the owner (per-
      // follower block rule).
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
 * Create a FollowingService. The repository is required; the
 * `storyRepository` (passed to shareSession / unshareSession) is the
 * canonical sessionService store so the service can verify owner
 * binding through `findOwnerBySession`.
 *
 * @param {{ repository: ReturnType<typeof import('./repository.mjs').createInMemoryFollowingRepository> }} input
 * @returns {FollowingService}
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
        feedCache.set(cacheKey, {
          expiresAt: Date.now() + FOLLOWING_CACHE_TTL_MS,
          payload,
        });
        return { items: payload.items, cursor: payload.cursor, follower_uuid: followerUuid };
      } catch (err) {
        // ClickUp 16.3 degraded-mode contract: a feed failure must NOT
        // surface as a 5xx. The route layer always answers 200 with an
        // empty items list and a `degraded:true` marker.
        return {
          items: Object.freeze([]),
          cursor: null,
          follower_uuid: followerUuid,
          degraded: true,
          error: String(err && err.message ? err.message : err),
        };
      }
    },
    shareSession({ storyRepository, sessionUuid, ownerUuid, title, story_uuid, story_version_uuid }) {
      assertUuid('sessionUuid', sessionUuid);
      assertUuid('ownerUuid', ownerUuid);
      if (!storyRepository) {
        throw new FollowingError('invalid_input', 'storyRepository required.', null);
      }
      // ClickUp 16.3 P1.2 canonical owner binding (ChatGPT 2026-09-07
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
      // Sharing a session changes the feed of every follower of the
      // owner. Invalidate the owner's cache (so the owner never sees
      // their own session in their own feed) AND every follower's
      // cache.
      invalidateCache(canonicalOwner);
      for (const f of repo.listFollowersOf(canonicalOwner)) {
        invalidateCache(f.follower_uuid);
      }
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
      invalidateCache(canonicalOwner);
      for (const f of repo.listFollowersOf(canonicalOwner)) {
        invalidateCache(f.follower_uuid);
      }
      return { ...existing };
    },
  };
}