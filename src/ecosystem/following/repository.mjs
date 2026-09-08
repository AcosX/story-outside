// src/ecosystem/following/repository.mjs — in-memory store for the
// follow / share surface (ClickUp 16.3 P1 rebuild on `44343b2`).
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
//   * The share row carries the canonical `owner_user_uuid` (persisted by
//     sessionService.createSession at session creation time) and is
//     NEVER overwritten with a caller-supplied identity. The service
//     layer enforces owner match before any upsert.
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
 * @property {string} [title]
 * @property {string} [story_uuid]
 * @property {string} [story_version_uuid]
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} FollowingRepository
 * @property {(follower_uuid: string, target_user_uuid: string) => FollowRow | null} findFollow
 * @property {(follower_uuid: string, target_user_uuid: string) => FollowRow} upsertFollow
 * @property {(follower_uuid: string, target_user_uuid: string) => boolean} removeFollow
 * @property {(target_user_uuid: string) => FollowRow[]} listFollowersOf
 * @property {(follower_uuid: string) => FollowRow[]} listFollowingOf
 * @property {(target_user_uuid: string) => BlockRow | null} findBlock
 * @property {(owner_uuid: string, target_user_uuid: string) => BlockRow} upsertBlock
 * @property {(owner_uuid: string, target_user_uuid: string) => boolean} removeBlock
 * @property {(session_uuid: string) => SharedSessionRow | null} findSharedSession
 * @property {(input: { session_uuid: string, owner_user_uuid: string, title?: string, story_uuid?: string, story_version_uuid?: string }) => SharedSessionRow} upsertSharedSession
 * @property {(session_uuid: string) => boolean} removeSharedSession
 * @property {(user_uuid: string) => SharedSessionRow[]} listSharedSessionsByOwner
 * @property {() => SharedSessionRow[]} listAllSharedSessions
 * @property {() => { follows: number, blocks: number, shares: number }} stats
 */

/**
 * @returns {FollowingRepository}
 */
export function createInMemoryFollowingRepository() {
  /** @type {Map<string, FollowRow>} */
  const follows = new Map();
  /** @type {Map<string, BlockRow>} */
  const blocks = new Map();
  /** @type {Map<string, SharedSessionRow>} */
  const sharedSessions = new Map();

  function followKey(follower, target) {
    return `${follower}\u0000${target}`;
  }

  return {
    findFollow(follower_uuid, target_user_uuid) {
      assertUuid('follower_uuid', follower_uuid);
      assertUuid('target_user_uuid', target_user_uuid);
      return follows.get(followKey(follower_uuid, target_user_uuid)) || null;
    },
    upsertFollow(follower_uuid, target_user_uuid) {
      assertUuid('follower_uuid', follower_uuid);
      assertUuid('target_user_uuid', target_user_uuid);
      if (follower_uuid === target_user_uuid) {
        throw new Error('followingRepository.upsertFollow: cannot follow self');
      }
      const key = followKey(follower_uuid, target_user_uuid);
      const existing = follows.get(key);
      if (existing) return existing;
      /** @type {FollowRow} */
      const row = Object.freeze({
        follower_uuid,
        target_user_uuid,
        created_at: nowIso(),
      });
      follows.set(key, row);
      return row;
    },
    removeFollow(follower_uuid, target_user_uuid) {
      assertUuid('follower_uuid', follower_uuid);
      assertUuid('target_user_uuid', target_user_uuid);
      return follows.delete(followKey(follower_uuid, target_user_uuid));
    },
    listFollowersOf(target_user_uuid) {
      assertUuid('target_user_uuid', target_user_uuid);
      /** @type {FollowRow[]} */
      const out = [];
      for (const row of follows.values()) {
        if (row.target_user_uuid === target_user_uuid) out.push(row);
      }
      return Object.freeze(out.map((r) => Object.freeze({ ...r })));
    },
    listFollowingOf(follower_uuid) {
      assertUuid('follower_uuid', follower_uuid);
      /** @type {FollowRow[]} */
      const out = [];
      for (const row of follows.values()) {
        if (row.follower_uuid === follower_uuid) out.push(row);
      }
      return Object.freeze(out.map((r) => Object.freeze({ ...r })));
    },
    findBlock(owner_uuid, target_user_uuid) {
      assertUuid('owner_uuid', owner_uuid);
      assertUuid('target_user_uuid', target_user_uuid);
      return blocks.get(`${owner_uuid}\u0000${target_user_uuid}`) || null;
    },
    upsertBlock(owner_uuid, target_user_uuid) {
      assertUuid('owner_uuid', owner_uuid);
      assertUuid('target_user_uuid', target_user_uuid);
      if (owner_uuid === target_user_uuid) {
        throw new Error('followingRepository.upsertBlock: cannot block self');
      }
      const key = `${owner_uuid}\u0000${target_user_uuid}`;
      const existing = blocks.get(key);
      if (existing) return existing;
      /** @type {BlockRow} */
      const row = Object.freeze({
        owner_uuid,
        target_user_uuid,
        created_at: nowIso(),
      });
      blocks.set(key, row);
      return row;
    },
    removeBlock(owner_uuid, target_user_uuid) {
      assertUuid('owner_uuid', owner_uuid);
      assertUuid('target_user_uuid', target_user_uuid);
      return blocks.delete(`${owner_uuid}\u0000${target_user_uuid}`);
    },
    findSharedSession(session_uuid) {
      assertUuid('session_uuid', session_uuid);
      const row = sharedSessions.get(session_uuid);
      if (!row) return null;
      return Object.freeze({ ...row });
    },
    upsertSharedSession(input) {
      if (!input || typeof input !== 'object') {
        throw new Error('followingRepository.upsertSharedSession: input required');
      }
      assertUuid('session_uuid', input.session_uuid);
      assertUuid('owner_user_uuid', input.owner_user_uuid);
      const existing = sharedSessions.get(input.session_uuid);
      // ClickUp 16.3 P1.2 owner invariant (ChatGPT 2026-09-07 review):
      // the canonical owner_user_uuid comes from sessionService internal
      // state, NOT from the request. The repository refuses to silently
      // rebind an existing row to a different owner — the service layer
      // already does this check, but enforcing it at the data layer too
      // protects against future bugs where the service omits the check.
      if (existing && existing.owner_user_uuid !== input.owner_user_uuid) {
        throw new Error(
          'followingRepository.upsertSharedSession: owner_user_uuid mismatch — '
            + 'refusing to rebind share row to a new owner',
        );
      }
      const ts = existing ? existing.created_at : nowIso();
      /** @type {SharedSessionRow} */
      const row = {
        session_uuid: input.session_uuid,
        owner_user_uuid: input.owner_user_uuid,
        created_at: ts,
        updated_at: nowIso(),
      };
      if (typeof input.title === 'string' && input.title) row.title = input.title;
      if (typeof input.story_uuid === 'string' && input.story_uuid) row.story_uuid = input.story_uuid;
      if (typeof input.story_version_uuid === 'string' && input.story_version_uuid) row.story_version_uuid = input.story_version_uuid;
      const frozen = Object.freeze(row);
      sharedSessions.set(input.session_uuid, frozen);
      return frozen;
    },
    removeSharedSession(session_uuid) {
      assertUuid('session_uuid', session_uuid);
      return sharedSessions.delete(session_uuid);
    },
    listSharedSessionsByOwner(user_uuid) {
      assertUuid('user_uuid', user_uuid);
      /** @type {SharedSessionRow[]} */
      const out = [];
      for (const row of sharedSessions.values()) {
        if (row.owner_user_uuid === user_uuid) out.push(row);
      }
      return Object.freeze(
        out
          .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
          .map((r) => Object.freeze({ ...r })),
      );
    },
    listAllSharedSessions() {
      /** @type {SharedSessionRow[]} */
      const out = [];
      for (const row of sharedSessions.values()) out.push(row);
      return Object.freeze(
        out
          .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
          .map((r) => Object.freeze({ ...r })),
      );
    },
    stats() {
      return Object.freeze({
        follows: follows.size,
        blocks: blocks.size,
        shares: sharedSessions.size,
      });
    },
    _exportSnapshot() {
      return {
        follows: [...follows.values()].map((row) => ({ ...row })),
        blocks: [...blocks.values()].map((row) => ({ ...row })),
        sharedSessions: [...sharedSessions.values()].map((row) => ({ ...row })),
      };
    },
    _hydrateSnapshot(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') throw new Error('followingRepository: snapshot required');
      follows.clear();
      blocks.clear();
      sharedSessions.clear();
      for (const row of Array.isArray(snapshot.follows) ? snapshot.follows : []) {
        if (!row || typeof row.follower_uuid !== 'string' || typeof row.target_user_uuid !== 'string') continue;
        follows.set(followKey(row.follower_uuid, row.target_user_uuid), Object.freeze({ ...row }));
      }
      for (const row of Array.isArray(snapshot.blocks) ? snapshot.blocks : []) {
        if (!row || typeof row.owner_uuid !== 'string' || typeof row.target_user_uuid !== 'string') continue;
        blocks.set(`${row.owner_uuid}\u0000${row.target_user_uuid}`, Object.freeze({ ...row }));
      }
      for (const row of Array.isArray(snapshot.sharedSessions) ? snapshot.sharedSessions : []) {
        if (!row || typeof row.session_uuid !== 'string') continue;
        sharedSessions.set(row.session_uuid, Object.freeze({ ...row }));
      }
    },
  };
}
