// src/ecosystem/following/repository.mjs — in-memory store for the
// follow / share surface (ClickUp 16.3 rebuild).
//
// ClickUp 16.3 P1 invariants:
//   * Follow relation is keyed by (follower_uuid, target_user_uuid). Same
//     pair can only be set once; a second `POST /follow` is idempotent
//     (returns the existing row, never a duplicate).
//   * Share is keyed by (session_uuid). The store holds at most one row
//     per session; subsequent `share` calls update the existing row, and
//     `unshare` deletes it.
//   * Follow graph and share graph are separate maps. Sharing is NEVER
//     derived from the follow graph — the public contract requires an
//     explicit `POST /share` per session.
//   * Block list is keyed by (owner_uuid, target_user_uuid). A blocked
//     target can never be followed by the owner and never appears in the
//     owner's `friend-timelines` feed. Bidirectional: a blocked user
//     also stops seeing the owner's sessions in their feed (visibility
//     is per-owner-per-target, not just one-way).
//
// No external API calls, no credential reads, no env vars.
//
// The module does NOT do any HTTP routing or auth — those live in
// src/server.mjs. The repository is a pure data layer; the service layer
// applies business rules on top of it.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nowIso() {
  return new Date().toISOString();
}

function assertUuid(label, value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`followingRepository: ${label} must be a UUID`);
  }
}

function assertSessionUuid(label, value) {
  assertUuid(label, value);
}

/**
 * @typedef {Object} FollowRow
 * @property {string} follower_uuid
 * @property {string} target_user_uuid
 * @property {string} created_at
 */

/**
 * @typedef {Object} BlockRow
 * @property {string} owner_uuid
 * @property {string} target_user_uuid
 * @property {string} created_at
 */

/**
 * @typedef {Object} SharedSessionRow
 * @property {string} session_uuid
 * @property {string} owner_user_uuid
 * @property {string} shared_at
 * @property {string} [title]
 * @property {string} [story_uuid]
 * @property {string} [story_version_uuid]
 */

/**
 * @typedef {Object} FollowingRepository
 * @property {(follower_uuid: string, target_user_uuid: string) => FollowRow | null} findFollow
 * @property {(follower_uuid: string, target_user_uuid: string) => FollowRow} upsertFollow
 * @property {(follower_uuid: string, target_user_uuid: string) => boolean} removeFollow
 * @property {(follower_uuid: string) => FollowRow[]} listFollowedBy
 * @property {(target_user_uuid: string) => FollowRow[]} listFollowersOf
 * @property {(owner_uuid: string, target_user_uuid: string) => BlockRow | null} findBlock
 * @property {(owner_uuid: string, target_user_uuid: string) => BlockRow} upsertBlock
 * @property {(owner_uuid: string, target_user_uuid: string) => boolean} removeBlock
 * @property {(session_uuid: string) => SharedSessionRow | null} findSharedSession
 * @property {(input: { session_uuid: string, owner_user_uuid: string, title?: string, story_uuid?: string, story_version_uuid?: string }) => SharedSessionRow} upsertSharedSession
 * @property {(session_uuid: string) => boolean} removeSharedSession
 * @property {(user_uuid: string) => SharedSessionRow[]} listSharedSessionsByOwner
 * @property {() => { follow_count: number, block_count: number, shared_session_count: number }} stats
 * @property {() => void} _resetForTests
 */

function createEmptyState() {
  return {
    // follower_uuid → Set<target_user_uuid>
    followedByFollower: new Map(),
    // target_user_uuid → Set<follower_uuid>
    followersOfTarget: new Map(),
    // "follower|target" → FollowRow
    followRows: new Map(),
    // owner_uuid → Set<target_user_uuid>
    blockedByOwner: new Map(),
    // "owner|target" → BlockRow
    blockRows: new Map(),
    // session_uuid → SharedSessionRow
    sharedSessions: new Map(),
  };
}

function followKey(follower_uuid, target_user_uuid) {
  return `${follower_uuid}|${target_user_uuid}`;
}

function blockKey(owner_uuid, target_user_uuid) {
  return `${owner_uuid}|${target_user_uuid}`;
}

/**
 * Build a fresh in-memory FollowingRepository. Pure factory.
 * @returns {FollowingRepository}
 */
export function createInMemoryFollowingRepository() {
  const state = createEmptyState();

  function _setFollowedBy(follower_uuid, target_user_uuid) {
    let set = state.followedByFollower.get(follower_uuid);
    if (!set) {
      set = new Set();
      state.followedByFollower.set(follower_uuid, set);
    }
    set.add(target_user_uuid);
  }
  function _setFollowersOf(target_user_uuid, follower_uuid) {
    let set = state.followersOfTarget.get(target_user_uuid);
    if (!set) {
      set = new Set();
      state.followersOfTarget.set(target_user_uuid, set);
    }
    set.add(follower_uuid);
  }
  function _deleteFollowedBy(follower_uuid, target_user_uuid) {
    const set = state.followedByFollower.get(follower_uuid);
    if (set) {
      set.delete(target_user_uuid);
      if (set.size === 0) state.followedByFollower.delete(follower_uuid);
    }
  }
  function _deleteFollowersOf(target_user_uuid, follower_uuid) {
    const set = state.followersOfTarget.get(target_user_uuid);
    if (set) {
      set.delete(follower_uuid);
      if (set.size === 0) state.followersOfTarget.delete(target_user_uuid);
    }
  }
  function _setBlockedBy(owner_uuid, target_user_uuid) {
    let set = state.blockedByOwner.get(owner_uuid);
    if (!set) {
      set = new Set();
      state.blockedByOwner.set(owner_uuid, set);
    }
    set.add(target_user_uuid);
  }
  function _deleteBlockedBy(owner_uuid, target_user_uuid) {
    const set = state.blockedByOwner.get(owner_uuid);
    if (set) {
      set.delete(target_user_uuid);
      if (set.size === 0) state.blockedByOwner.delete(owner_uuid);
    }
  }

  /** @type {FollowingRepository} */
  const repo = {
    findFollow(follower_uuid, target_user_uuid) {
      assertUuid('follower_uuid', follower_uuid);
      assertUuid('target_user_uuid', target_user_uuid);
      return state.followRows.get(followKey(follower_uuid, target_user_uuid)) || null;
    },
    upsertFollow(follower_uuid, target_user_uuid) {
      assertUuid('follower_uuid', follower_uuid);
      assertUuid('target_user_uuid', target_user_uuid);
      const key = followKey(follower_uuid, target_user_uuid);
      const existing = state.followRows.get(key);
      if (existing) return existing;
      const row = {
        follower_uuid,
        target_user_uuid,
        created_at: nowIso(),
      };
      state.followRows.set(key, row);
      _setFollowedBy(follower_uuid, target_user_uuid);
      _setFollowersOf(target_user_uuid, follower_uuid);
      return row;
    },
    removeFollow(follower_uuid, target_user_uuid) {
      assertUuid('follower_uuid', follower_uuid);
      assertUuid('target_user_uuid', target_user_uuid);
      const key = followKey(follower_uuid, target_user_uuid);
      const had = state.followRows.delete(key);
      _deleteFollowedBy(follower_uuid, target_user_uuid);
      _deleteFollowersOf(target_user_uuid, follower_uuid);
      return had;
    },
    listFollowedBy(follower_uuid) {
      assertUuid('follower_uuid', follower_uuid);
      const set = state.followedByFollower.get(follower_uuid);
      if (!set) return [];
      const out = [];
      for (const target of set) {
        const row = state.followRows.get(followKey(follower_uuid, target));
        if (row) out.push(row);
      }
      out.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
      return out;
    },
    listFollowersOf(target_user_uuid) {
      assertUuid('target_user_uuid', target_user_uuid);
      const set = state.followersOfTarget.get(target_user_uuid);
      if (!set) return [];
      const out = [];
      for (const follower of set) {
        const row = state.followRows.get(followKey(follower, target_user_uuid));
        if (row) out.push(row);
      }
      out.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
      return out;
    },
    findBlock(owner_uuid, target_user_uuid) {
      assertUuid('owner_uuid', owner_uuid);
      assertUuid('target_user_uuid', target_user_uuid);
      return state.blockRows.get(blockKey(owner_uuid, target_user_uuid)) || null;
    },
    upsertBlock(owner_uuid, target_user_uuid) {
      assertUuid('owner_uuid', owner_uuid);
      assertUuid('target_user_uuid', target_user_uuid);
      const key = blockKey(owner_uuid, target_user_uuid);
      const existing = state.blockRows.get(key);
      if (existing) return existing;
      const row = {
        owner_uuid,
        target_user_uuid,
        created_at: nowIso(),
      };
      state.blockRows.set(key, row);
      _setBlockedBy(owner_uuid, target_user_uuid);
      return row;
    },
    removeBlock(owner_uuid, target_user_uuid) {
      assertUuid('owner_uuid', owner_uuid);
      assertUuid('target_user_uuid', target_user_uuid);
      const key = blockKey(owner_uuid, target_user_uuid);
      const had = state.blockRows.delete(key);
      _deleteBlockedBy(owner_uuid, target_user_uuid);
      return had;
    },
    findSharedSession(session_uuid) {
      assertSessionUuid('session_uuid', session_uuid);
      return state.sharedSessions.get(session_uuid) || null;
    },
    upsertSharedSession(input) {
      if (!input || typeof input !== 'object') {
        throw new Error('followingRepository.upsertSharedSession: input required');
      }
      assertSessionUuid('session_uuid', input.session_uuid);
      assertUuid('owner_user_uuid', input.owner_user_uuid);
      const existing = state.sharedSessions.get(input.session_uuid);
      // ClickUp 16.3 owner-check P1 (ChatGPT 2026-09-06): the existing row's
      // owner_user_uuid is the authoritative owner. If a caller tries to
      // re-share with a different owner, the repository refuses — that
      // scenario should never happen because the SERVICE layer guards
      // ownership before reaching this method, but the defensive check
      // here makes the invariant loud at the data seam too.
      if (existing && existing.owner_user_uuid !== input.owner_user_uuid) {
        throw new Error(
          'followingRepository.upsertSharedSession: owner_user_uuid mismatch — '
          + 'cannot transfer ownership of an existing share row.',
        );
      }
      const row = {
        session_uuid: input.session_uuid,
        owner_user_uuid: input.owner_user_uuid,
        shared_at: existing ? existing.shared_at : nowIso(),
      };
      if (typeof input.title === 'string') row.title = input.title;
      if (typeof input.story_uuid === 'string') {
        assertUuid('story_uuid', input.story_uuid);
        row.story_uuid = input.story_uuid;
      }
      if (typeof input.story_version_uuid === 'string') {
        assertUuid('story_version_uuid', input.story_version_uuid);
        row.story_version_uuid = input.story_version_uuid;
      }
      state.sharedSessions.set(input.session_uuid, row);
      return row;
    },
    removeSharedSession(session_uuid) {
      assertSessionUuid('session_uuid', session_uuid);
      return state.sharedSessions.delete(session_uuid);
    },
    listSharedSessionsByOwner(user_uuid) {
      assertUuid('user_uuid', user_uuid);
      const out = [];
      for (const row of state.sharedSessions.values()) {
        if (row.owner_user_uuid === user_uuid) out.push(row);
      }
      out.sort((a, b) => (a.shared_at < b.shared_at ? 1 : a.shared_at > b.shared_at ? -1 : 0));
      return out;
    },
    stats() {
      return {
        follow_count: state.followRows.size,
        block_count: state.blockRows.size,
        shared_session_count: state.sharedSessions.size,
      };
    },
    _resetForTests() {
      const fresh = createEmptyState();
      state.followedByFollower = fresh.followedByFollower;
      state.followersOfTarget = fresh.followersOfTarget;
      state.followRows = fresh.followRows;
      state.blockedByOwner = fresh.blockedByOwner;
      state.blockRows = fresh.blockRows;
      state.sharedSessions = fresh.sharedSessions;
    },
  };
  return repo;
}

void assertSessionUuid; // exported for symmetry with other repository modules