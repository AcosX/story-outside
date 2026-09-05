// src/stories/repository.mjs — in-memory, credential-free repository for
// story import, versioned content, and opening-cache state.
//
// ClickUp 04 contract:
//   * findVersionByChecksum / createVersion are the version-import seam:
//     same checksum → reuse; different checksum → new version_no on the
//     same story; old versions are kept (no UPDATE on content/checksum).
//   * upsertOpeningCache is idempotent on (story_id, story_version_id,
//     opening_key, generation_hash). A failed generation does NOT pollute
//     the valid cache: it is written with status='failed' and never served
//     as the public opening.
//   * recordCacheInvalidation is an admin-level audit action only. It marks
//     a row invalidated but does NOT remove it. First-choice consumption is
//     SESSION-LOCAL and must call recordSessionFirstChoice instead; it must
//     never invalidate the shared opening cache for other sessions.
//   * The repository never persists user/role/session identifiers anywhere
//     on story_versions or story_opening_caches (no such column exists).
//     Session-local first-choice state lives in the session map only.
//
// This module is intentionally free of MariaDB calls. It mirrors the SQL
// surface in db/migrations/0001_initial_story_outside.sql so a future
// MariaDB-backed DAO can replace it without changing the service layer.
// See docs/data-model.md → "Application-layer mapping" for the table-level
// correspondence.

import { canonicalStoryHash } from './canonicalHash.mjs';

/**
 * @typedef {Object} StoryRow
 * @property {string} story_uuid
 * @property {string} slug
 * @property {string} title
 * @property {string} hook
 * @property {string} locale
 * @property {string} status             'draft' | 'published' | 'archived'.
 * @property {string|null} published_at
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} StoryVersionRow
 * @property {string} version_uuid
 * @property {string} story_uuid
 * @property {number} version_no
 * @property {string} title
 * @property {string} hook
 * @property {object} content_payload
 * @property {Array<object>} roles_payload
 * @property {string} checksum
 * @property {string|null} source_ref
 * @property {string} status
 * @property {string|null} published_at
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} OpeningCacheRow
 * @property {string} cache_uuid
 * @property {string} story_uuid
 * @property {string} story_version_uuid
 * @property {string} opening_key
 * @property {string} status             'valid' | 'invalidated' | 'failed'.
 * @property {object} content_payload
 * @property {string} content_hash
 * @property {object} generation_profile
 * @property {string} generation_hash
 * @property {number} use_count
 * @property {string|null} last_used_at
 * @property {string|null} invalidated_at
 * @property {string|null} invalidated_reason
 * @property {string|null} expires_at
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} SessionFirstChoiceMarker
 * @property {string} session_uuid
 * @property {string|null} opening_cache_uuid
 * @property {string} status           'consumed'.
 * @property {string} first_choice_at
 * @property {string} reason
 */

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Opening-cache store bound. PR #7 capped three auxiliary Maps but the
// openingCaches map could still grow without limit (each rebuild attempt
// under a fresh generation_profile / scope produces a new cache row).
//
// Eviction policy (PR #7 follow-up, ChatGPT re-review fix 2026-09-05,
// Blocker 1 + Blocker 2):
//   1. Drop rows whose status is 'failed' or 'invalidated' first; those
//      are useless for future lookups and the scope index is pruned so
//      a rebuild can republish under the same scope key.
//   2. If no such row exists, drop the OLDEST UNPINNED valid row.
//      "Pinned" means: at least one active canonical session has this
//      cache_uuid in `session.cache_uuid`. A pinned valid row is
//      NEVER dropped — the previous behaviour evicted valid rows
//      blindly, which broke `commitOpeningEvent` on any active session
//      whose pinned cache was the eviction target.
//   3. If EVERY row is currently pinned (or the only candidates left
//      are all pinned), upsertOpeningCache's reservation seam refuses
//      the insert with a stable `too_many_pinned_caches` error instead
//      of silently dropping a live session's cache. The MariaDB-backed
//      DAO will replace this branch with TTL + per-scope GC; in the
//      in-memory demo there is no TTL so we hard-fail instead of
//      silently losing a live session's cache.
// The scope index (openingCachesByScope) is pruned of the evicted rows
// so future lookups still find a valid replacement if one exists.
// Documented as a demo bound in docs/observability.md.
const MAX_OPENING_CACHES = 5000;

function uuidv4() {
  // Deterministic-ish enough for in-memory fixtures. Real backends generate
  // server-side UUIDs; this is fine because the repository is documented as
  // an in-memory placeholder, not a UUID authority.
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function assertUuid(label, value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`repository: ${label} must be a UUID`);
  }
}

function assertSlug(label, value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new Error(`repository: ${label} must match ${ID_PATTERN}`);
  }
}

/**
 * @returns {{
 *   stories: Map<string, StoryRow>,
 *   versions: Map<string, StoryVersionRow>,        // keyed by version_uuid
 *   versionsByChecksum: Map<string, string>,       // checksum → version_uuid
 *   versionsByStory: Map<string, Set<string>>,      // story_uuid → set of version_uuids
 *   versionsNoByStory: Map<string, number>,        // next version_no per story
 *   openingCaches: Map<string, OpeningCacheRow>,   // keyed by cache_uuid
 *   openingCachesByScope: Map<string, string>,     // scope key → cache_uuid (valid only)
 *   sessionFirstChoices: Map<string, SessionFirstChoiceMarker>,  // session_uuid → marker
 *   _pinnedCacheResolver: () => Set<string>,
 * }}
 */
function createEmptyState() {
  return {
    stories: new Map(),
    versions: new Map(),
    versionsByChecksum: new Map(),
    versionsByStory: new Map(),
    versionsNoByStory: new Map(),
    openingCaches: new Map(),
    openingCachesByScope: new Map(),
    sessionFirstChoices: new Map(),
    // Wired by createInMemoryStoryRepository so the eviction loop can see
    // which cache_uuids are still pinned by an active canonical session.
    _pinnedCacheResolver: defaultPinnedCacheResolver,
  };
}

/**
 * Stable scope identifier used for fast cache lookup. The repository does
 * NOT include user/role/session in this string; doing so is a programming
 * error that should be caught at the call site.
 *
 * @param {string} story_uuid
 * @param {string} story_version_uuid
 * @param {string} opening_key
 * @param {string} generation_hash
 */
export function makeOpeningScopeKey(story_uuid, story_version_uuid, opening_key, generation_hash) {
  return `${story_uuid}|${story_version_uuid}|${opening_key}|${generation_hash}`;
}

/**
 * @typedef {Object} StoryRepository
 * @property {(slug: string) => StoryRow | null} findStoryBySlug
 * @property {(story_uuid: string) => StoryRow | null} findStoryByUuid
 * @property {(input: { story_uuid: string, slug: string, title: string, hook: string, locale?: string }) => StoryRow} upsertStory
 * @property {(checksum: string) => StoryVersionRow | null} findVersionByChecksum
 * @property {(story_uuid: string) => StoryVersionRow[]} listVersionsByStory
 * @property {(input: {
 *    story_uuid: string,
 *    story_detail: object,
 *    roles_payload: Array<object>,
 *    source_ref?: string | null,
 * }) => { version: StoryVersionRow, reused: boolean }} importVersion
 * @property {(story_version_uuid: string) => StoryVersionRow | null} findVersion
 * @property {(story_uuid: string, story_version_uuid: string, opening_key: string, generation_hash: string) => OpeningCacheRow | null} findOpeningCacheByScope
 * @property {(cache_uuid: string) => OpeningCacheRow | null} findOpeningCacheByUuid
 * @property {(input: Omit<OpeningCacheRow, 'cache_uuid'|'created_at'|'updated_at'>) => OpeningCacheRow} upsertOpeningCache
 * @property {(cache_uuid: string, reason: string) => OpeningCacheRow | null} recordCacheInvalidation
 * @property {(input: { session_uuid: string, opening_cache_uuid?: string|null, reason?: string }) => SessionFirstChoiceMarker} recordSessionFirstChoice
 * @property {(session_uuid: string) => SessionFirstChoiceMarker | null} findSessionFirstChoice
 * @property {(cache_uuid: string) => void} markCacheFailed
 * @property {() => { story_count: number, version_count: number, cache_count: number }} stats
 * @property {(row: StoryVersionRow) => void} _seedVersion
 * @property {() => void} _evictOpeningCachesIfFull
 * @property {() => void} _resetForTests
 * @property {(resolver: () => Set<string>) => void} _setPinnedCacheResolver
 */

/**
 * Hook to let the repository know which cache_uuids are currently pinned
 * by at least one active canonical session. The session layer registers a
 * resolver that returns a Set<cache_uuid>; the resolver is queried during
 * eviction so pinned valid rows are NEVER dropped. Without this hook the
 * eviction loop would happily drop the very cache a live session needs
 * for `commitOpeningEvent`, surfacing as `pinned cache is no longer
 * valid` mid-stream (the ChatGPT 2026-09-05 re-review flagged this).
 */
function defaultPinnedCacheResolver() {
  // Resolver set per-repository inside createInMemoryStoryRepository; the
  // module-level fallback returns an empty set so the file can be loaded
  // and unit-tested without booting the session layer.
  return new Set();
}

/**
 * Drop opening-cache rows to keep the store at or below MAX_OPENING_CACHES.
 * Returns the count of rows actually evicted; returns 0 when the only
 * remaining candidates are pinned and the caller cannot make progress
 * (so the caller can refuse the insert with a stable error code).
 *
 * Eviction policy (PR #7 follow-up, ChatGPT 2026-09-05):
 *   1. Drop rows whose status is 'failed' or 'invalidated' first; those
 *      are useless for future lookups and the scope index is pruned so
 *      a rebuild can republish under the same scope key.
 *   2. Once no such row exists, drop the OLDEST UNPINNED valid row. A
 *      pinned valid row (referenced by an active canonical session via
 *      `session.cache_uuid`) is SKIPPED — evicting it would break
 *      `commitOpeningEvent` for that session. The least-recently-updated
 *      valid row is dropped when multiple unpinned candidates exist.
 *   3. As a last resort (every row is currently pinned), the function
 *      returns 0 and the caller is expected to refuse the insert with a
 *      stable `too_many_pinned_caches` error.
 *
 * @returns {number} rows actually evicted in this pass
 */
function evictOpeningCachesIfFull(state) {
  let evicted = 0;
  while (state.openingCaches.size > MAX_OPENING_CACHES) {
    const pinned = state._pinnedCacheResolver();
    let targetUuid = null;
    let targetTier = Infinity;
    let targetUpdatedAt = null;
    for (const [uuid, row] of state.openingCaches.entries()) {
      // Skip pinned valid rows — they are still in use by an active
      // session. failed / invalidated rows are always eviction candidates
      // regardless of pinning (they cannot be served any more).
      if (row.status === 'valid' && pinned.has(uuid)) continue;
      const tier = row.status === 'failed' ? 0
        : row.status === 'invalidated' ? 1
          : row.status === 'valid' ? 3 : 2;
      const updatedAt = typeof row.updated_at === 'string' ? row.updated_at : null;
      if (tier < targetTier || (tier === targetTier && (targetUpdatedAt === null || (updatedAt !== null && updatedAt < targetUpdatedAt)))) {
        targetUuid = uuid;
        targetTier = tier;
        targetUpdatedAt = updatedAt;
      }
    }
    if (targetUuid === null) return evicted;
    const removed = state.openingCaches.get(targetUuid);
    state.openingCaches.delete(targetUuid);
    evicted += 1;
    if (removed) {
      const key = makeOpeningScopeKey(
        removed.story_uuid,
        removed.story_version_uuid,
        removed.opening_key,
        removed.generation_hash,
      );
      if (state.openingCachesByScope.get(key) === targetUuid) {
        state.openingCachesByScope.delete(key);
      }
    }
  }
  return evicted;
}

/**
 * Reserve a slot in the cache store before inserting a new row. If the
 * store is at the cap and we cannot evict a single row (every row is
 * pinned), refuse with a stable `too_many_pinned_caches` error so the
 * caller never sees a "ghost row" — an inserted row that the very next
 * eviction pass removes (PR #7 ChatGPT 2026-09-05 re-review, Blocker 2).
 *
 * The reservation runs `evictOpeningCacheOnce` — a one-shot eviction
 * that drops AT MOST ONE row even when the store is at exactly the
 * cap (the existing `evictOpeningCachesIfFull` only loops when strictly
 * above the cap, so it is a no-op when the store is exactly full). The
 * pinned-aware filter from B1 makes the one-shot eviction skip any
 * valid cache that an active session still needs.
 *
 * Concurrent batches in a single tick can therefore exceed the cap by
 * at most N-1 before the next batch's first insert observes the cap
 * and refuses; that is acceptable for an in-memory demo (the
 * production DAO will replace this with a SQL UNIQUE + TTL story).
 */
function reserveOpeningCacheSlot(state) {
  if (state.openingCaches.size < MAX_OPENING_CACHES) return;
  // Drop ONE eviction candidate. If we cannot drop any (every row is
  // pinned), refuse — the new row would otherwise be inserted and
  // immediately evicted on the next insertion (the B2 ghost-row bug).
  evictOpeningCacheOnce(state);
  if (state.openingCaches.size >= MAX_OPENING_CACHES) {
    const err = new Error(
      `repository: cannot insert opening cache — store is at MAX_OPENING_CACHES=${MAX_OPENING_CACHES} and ` +
      'every existing row is currently pinned by an active session; evict or finish a session first.',
    );
    err.code = 'too_many_pinned_caches';
    throw err;
  }
}

/**
 * One-shot eviction: drop the BEST eviction candidate and return the
 * uuid that was removed, or null when nothing is evictable (every row
 * is pinned). Best candidate is the same one the bulk
 * `evictOpeningCachesIfFull` loop would pick on its first iteration
 * (failed > invalidated > unpinned-valid, oldest first within a tier).
 */
function evictOpeningCacheOnce(state) {
  const pinned = state._pinnedCacheResolver();
  let targetUuid = null;
  let targetTier = Infinity;
  let targetUpdatedAt = null;
  for (const [uuid, row] of state.openingCaches.entries()) {
    // Skip pinned valid rows — they are still in use by an active
    // session. failed / invalidated rows are always eviction candidates
    // regardless of pinning (they cannot be served any more).
    if (row.status === 'valid' && pinned.has(uuid)) continue;
    const tier = row.status === 'failed' ? 0
      : row.status === 'invalidated' ? 1
        : row.status === 'valid' ? 3 : 2;
    const updatedAt = typeof row.updated_at === 'string' ? row.updated_at : null;
    if (tier < targetTier || (tier === targetTier && (targetUpdatedAt === null || (updatedAt !== null && updatedAt < targetUpdatedAt)))) {
      targetUuid = uuid;
      targetTier = tier;
      targetUpdatedAt = updatedAt;
    }
  }
  if (targetUuid === null) return null;
  const removed = state.openingCaches.get(targetUuid);
  state.openingCaches.delete(targetUuid);
  if (removed) {
    const key = makeOpeningScopeKey(
      removed.story_uuid,
      removed.story_version_uuid,
      removed.opening_key,
      removed.generation_hash,
    );
    if (state.openingCachesByScope.get(key) === targetUuid) {
      state.openingCachesByScope.delete(key);
    }
  }
  return targetUuid;
}

/**
 * Build a new repository. Pure factory; safe to construct multiple instances.
 * @returns {StoryRepository}
 */
export function createInMemoryStoryRepository() {
  const state = createEmptyState();
  // The session layer owns the canonical session map; it knows which
  // cache_uuids are currently pinned via `session.cache_uuid`. The
  // repository needs to consult that set during eviction so a live
  // session's cache is never dropped. The session layer wires this hook
  // through sessionService.bindPinnedCacheResolver; the fallback returns
  // an empty set so the repository can be exercised in unit tests
  // without booting the session layer.
  state._pinnedCacheResolver = () => new Set();

  /** @type {StoryRepository} */
  const repo = {
    findStoryByUuid(story_uuid) {
      if (typeof story_uuid !== 'string') return null;
      return state.stories.get(story_uuid) || null;
    },
    findStoryBySlug(slug) {
      assertSlug('slug', slug);
      for (const row of state.stories.values()) {
        if (row.slug === slug) return row;
      }
      return null;
    },
    upsertStory(input) {
      if (!input || typeof input !== 'object') {
        throw new Error('upsertStory: input required');
      }
      assertUuid('story_uuid', input.story_uuid);
      assertSlug('slug', input.slug);
      if (typeof input.title !== 'string' || !input.title) {
        throw new Error('upsertStory: title required');
      }
      if (typeof input.hook !== 'string' || !input.hook) {
        throw new Error('upsertStory: hook required');
      }
      const existing = state.stories.get(input.story_uuid);
      if (existing) {
        // Slug must remain stable for the same story_uuid. Title/hook can be
        // updated (catalog metadata), but content/versioning lives in
        // story_versions, not here.
        if (existing.slug !== input.slug) {
          throw new Error('upsertStory: slug must remain stable for an existing story');
        }
        existing.title = input.title;
        existing.hook = input.hook;
        existing.locale = input.locale || existing.locale || 'zh-CN';
        existing.updated_at = nowIso();
        return existing;
      }
      for (const row of state.stories.values()) {
        if (row.slug === input.slug) {
          throw new Error('upsertStory: slug already in use by another story');
        }
      }
      /** @type {StoryRow} */
      const row = {
        story_uuid: input.story_uuid,
        slug: input.slug,
        title: input.title,
        hook: input.hook,
        locale: input.locale || 'zh-CN',
        status: 'published',
        published_at: nowIso(),
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      state.stories.set(input.story_uuid, row);
      return row;
    },
    findVersionByChecksum(checksum) {
      if (typeof checksum !== 'string') return null;
      const uuid = state.versionsByChecksum.get(checksum);
      if (!uuid) return null;
      return state.versions.get(uuid) || null;
    },
    findVersion(version_uuid) {
      if (typeof version_uuid !== 'string') return null;
      return state.versions.get(version_uuid) || null;
    },
    listVersionsByStory(story_uuid) {
      assertUuid('story_uuid', story_uuid);
      const ids = state.versionsByStory.get(story_uuid);
      if (!ids) return [];
      const out = [];
      for (const id of ids) {
        const v = state.versions.get(id);
        if (v) out.push(v);
      }
      out.sort((a, b) => a.version_no - b.version_no);
      return out;
    },
    importVersion(input) {
      if (!input || typeof input !== 'object') {
        throw new Error('importVersion: input required');
      }
      assertUuid('story_uuid', input.story_uuid);
      if (!input.story_detail || typeof input.story_detail !== 'object') {
        throw new Error('importVersion: story_detail required');
      }
      if (!Array.isArray(input.roles_payload)) {
        throw new Error('importVersion: roles_payload[] required');
      }
      const checksum = canonicalStoryHash(input.story_detail);
      const existing = state.versionsByChecksum.get(checksum);
      if (existing) {
        const row = state.versions.get(existing);
        if (!row) throw new Error('importVersion: index corruption (checksum hit, row missing)');
        return { version: row, reused: true };
      }
      // New version: bump version_no on this story.
      const set = state.versionsByStory.get(input.story_uuid) || new Set();
      const nextNo = (state.versionsNoByStory.get(input.story_uuid) || 0) + 1;
      const detail = /** @type {any} */ (input.story_detail);
      const version_uuid = uuidv4();
      /** @type {StoryVersionRow} */
      const row = {
        version_uuid,
        story_uuid: input.story_uuid,
        version_no: nextNo,
        title: detail.title,
        hook: detail.hook,
        content_payload: detail,
        roles_payload: input.roles_payload,
        checksum,
        source_ref: input.source_ref || null,
        status: 'published',
        published_at: nowIso(),
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      state.versions.set(version_uuid, row);
      state.versionsByChecksum.set(checksum, version_uuid);
      set.add(version_uuid);
      state.versionsByStory.set(input.story_uuid, set);
      state.versionsNoByStory.set(input.story_uuid, nextNo);
      return { version: row, reused: false };
    },
    findOpeningCacheByScope(story_uuid, story_version_uuid, opening_key, generation_hash) {
      assertUuid('story_uuid', story_uuid);
      assertUuid('story_version_uuid', story_version_uuid);
      const key = makeOpeningScopeKey(story_uuid, story_version_uuid, opening_key, generation_hash);
      const cache_uuid = state.openingCachesByScope.get(key);
      if (!cache_uuid) return null;
      return state.openingCaches.get(cache_uuid) || null;
    },
    findOpeningCacheByUuid(cache_uuid) {
      if (typeof cache_uuid !== 'string') return null;
      return state.openingCaches.get(cache_uuid) || null;
    },
    upsertOpeningCache(input) {
      // Strict contract: never let a `failed` row overwrite a `valid` row at
      // the same scope. Generation can retry safely.
      const existing = repo.findOpeningCacheByScope(
        input.story_uuid,
        input.story_version_uuid,
        input.opening_key,
        input.generation_hash,
      );
      if (existing && existing.status === 'valid' && input.status !== 'valid') {
        return existing;
      }
      if (existing && existing.status === 'valid' && input.status === 'valid') {
        // Cache is immutable once valid; subsequent generation must rebuild
        // via a new generation_hash OR an explicit replace strategy.
        if (existing.content_hash !== input.content_hash) {
          throw new Error(
            'upsertOpeningCache: valid cache is immutable; rebuild via new generation_hash ' +
              'or explicit replace strategy.',
          );
        }
        return existing;
      }
      const now = nowIso();
      if (existing) {
        existing.status = input.status;
        existing.content_payload = input.content_payload;
        existing.content_hash = input.content_hash;
        existing.generation_profile = input.generation_profile;
        existing.generation_hash = input.generation_hash;
        existing.use_count = input.use_count ?? existing.use_count;
        existing.last_used_at = input.last_used_at ?? existing.last_used_at;
        existing.invalidated_at = input.invalidated_at ?? existing.invalidated_at;
        existing.invalidated_reason = input.invalidated_reason ?? existing.invalidated_reason;
        existing.expires_at = input.expires_at ?? existing.expires_at;
        existing.updated_at = now;
        // A previously failed/invalidated row that is now valid must join
        // the scope index so a later lookup/retry sees it under the same
        // generation_hash instead of accumulating orphan rows.
        if (existing.status === 'valid') {
          const key = makeOpeningScopeKey(
            existing.story_uuid,
            existing.story_version_uuid,
            existing.opening_key,
            existing.generation_hash,
          );
          state.openingCachesByScope.set(key, existing.cache_uuid);
        }
        return existing;
      }
      const cache_uuid = uuidv4();
      /** @type {OpeningCacheRow} */
      const row = {
        cache_uuid,
        story_uuid: input.story_uuid,
        story_version_uuid: input.story_version_uuid,
        opening_key: input.opening_key,
        status: input.status,
        content_payload: input.content_payload,
        content_hash: input.content_hash,
        generation_profile: input.generation_profile,
        generation_hash: input.generation_hash,
        use_count: input.use_count ?? 0,
        last_used_at: input.last_used_at ?? null,
        invalidated_at: input.invalidated_at ?? null,
        invalidated_reason: input.invalidated_reason ?? null,
        expires_at: input.expires_at ?? null,
        created_at: now,
        updated_at: now,
      };
      // PR #7 ChatGPT follow-up (2026-09-05, B2): reserve the slot BEFORE
      // insertion so a freshly inserted row can never be evicted by the
      // very same call. If the cap cannot be freed (every row is
      // pinned), reserveOpeningCacheSlot throws a stable
      // `too_many_pinned_caches` error and we never reach the `set`
      // below — so the returned row is guaranteed to be findable by
      // both cache_uuid AND by scope key. The pinned-aware filter in
      // B1 makes the one-shot eviction here actually succeed when
      // there is any failed / invalidated / unpinned valid row to drop.
      reserveOpeningCacheSlot(state);
      state.openingCaches.set(cache_uuid, row);
      // Belt-and-braces: drop any pre-existing overshoot (e.g. when the
      // session layer recently evicted a session and unpinned a cache,
      // leaving the store temporarily above the cap). This pass MUST NOT
      // pick the row we just inserted (it has the newest updated_at and
      // is at most the lone candidate in the worst case).
      evictOpeningCachesIfFull(state);
      // A failed attempt can be re-found by the SAME generation_hash so a
      // retry reuses/updates the row instead of leaving an orphan. A valid
      // row is still the only row that "wins" the scope key over an older
      // failed row.
      if (row.status === 'valid' || row.status === 'failed') {
        const key = makeOpeningScopeKey(
          input.story_uuid,
          input.story_version_uuid,
          input.opening_key,
          input.generation_hash,
        );
        state.openingCachesByScope.set(key, cache_uuid);
      }
      return row;
    },
    recordCacheInvalidation(cache_uuid, reason) {
      const row = state.openingCaches.get(cache_uuid);
      if (!row) return null;
      if (row.status === 'invalidated') return row;
      row.status = 'invalidated';
      row.invalidated_at = nowIso();
      row.invalidated_reason = reason || 'invalidated';
      row.updated_at = row.invalidated_at;
      // Drop scope index so a future rebuild can re-publish a row under the
      // same key without colliding with the invalidated one.
      const key = makeOpeningScopeKey(
        row.story_uuid,
        row.story_version_uuid,
        row.opening_key,
        row.generation_hash,
      );
      state.openingCachesByScope.delete(key);
      return row;
    },
    recordSessionFirstChoice(input) {
      if (!input || typeof input !== 'object') {
        throw new Error('recordSessionFirstChoice: input required');
      }
      if (typeof input.session_uuid !== 'string' || !input.session_uuid) {
        throw new Error('recordSessionFirstChoice: session_uuid required');
      }
      const existing = state.sessionFirstChoices.get(input.session_uuid);
      if (existing) return existing;
      const marker = {
        session_uuid: input.session_uuid,
        opening_cache_uuid: input.opening_cache_uuid || null,
        status: 'consumed',
        first_choice_at: nowIso(),
        reason: input.reason || 'first_ask_player_choice',
      };
      state.sessionFirstChoices.set(input.session_uuid, marker);
      return marker;
    },
    findSessionFirstChoice(session_uuid) {
      if (typeof session_uuid !== 'string') return null;
      return state.sessionFirstChoices.get(session_uuid) || null;
    },
    markCacheFailed(cache_uuid) {
      const row = state.openingCaches.get(cache_uuid);
      if (!row) return;
      row.status = 'failed';
      row.updated_at = nowIso();
    },
    stats() {
      return {
        story_count: state.stories.size,
        version_count: state.versions.size,
        cache_count: state.openingCaches.size,
      };
    },
    _evictOpeningCachesIfFull() {
      evictOpeningCachesIfFull(state);
    },
    _setPinnedCacheResolver(resolver) {
      if (typeof resolver !== 'function') {
        throw new Error('repository: _setPinnedCacheResolver requires a function');
      }
      state._pinnedCacheResolver = resolver;
    },
    _seedVersion(row) {
      // Test/dev-only: insert a pre-built version row verbatim. Bypasses
      // importVersion's random UUID so fixtures can keep stable UUIDs.
      if (!row || !row.version_uuid) throw new Error('_seedVersion: row.version_uuid required');
      assertUuid('story_uuid', row.story_uuid);
      if (state.versions.has(row.version_uuid)) {
        throw new Error('_seedVersion: version_uuid already present');
      }
      if (state.versionsByChecksum.has(row.checksum)) {
        throw new Error('_seedVersion: checksum already present');
      }
      state.versions.set(row.version_uuid, row);
      state.versionsByChecksum.set(row.checksum, row.version_uuid);
      const set = state.versionsByStory.get(row.story_uuid) || new Set();
      set.add(row.version_uuid);
      state.versionsByStory.set(row.story_uuid, set);
      if (row.version_no > (state.versionsNoByStory.get(row.story_uuid) || 0)) {
        state.versionsNoByStory.set(row.story_uuid, row.version_no);
      }
    },
    _resetForTests() {
      const fresh = createEmptyState();
      state.stories = fresh.stories;
      state.versions = fresh.versions;
      state.versionsByChecksum = fresh.versionsByChecksum;
      state.versionsByStory = fresh.versionsByStory;
      state.versionsNoByStory = fresh.versionsNoByStory;
      state.openingCaches = fresh.openingCaches;
      state.openingCachesByScope = fresh.openingCachesByScope;
      state.sessionFirstChoices = fresh.sessionFirstChoices;
      state._pinnedCacheResolver = fresh._pinnedCacheResolver;
    },
  };

  return repo;
}