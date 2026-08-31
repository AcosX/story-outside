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
//   * recordCacheInvalidation marks a row invalidated but does NOT remove
//     it; the canonical history keeps it visible.
//   * The repository never persists user/role/session identifiers anywhere
//     on story_versions or story_opening_caches (no such column exists).
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
 * @property {string} generation_hash
 * @property {number} use_count
 * @property {string|null} last_used_at
 * @property {string|null} invalidated_at
 * @property {string|null} invalidated_reason
 * @property {string|null} expires_at
 * @property {string} created_at
 * @property {string} updated_at
 */

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * @property {(cache_uuid: string) => void} markCacheFailed
 * @property {() => { story_count: number, version_count: number, cache_count: number }} stats
 * @property {(row: StoryVersionRow) => void} _seedVersion
 * @property {() => void} _resetForTests
 */

/**
 * Build a new repository. Pure factory; safe to construct multiple instances.
 * @returns {StoryRepository}
 */
export function createInMemoryStoryRepository() {
  const state = createEmptyState();

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
        existing.use_count = input.use_count ?? existing.use_count;
        existing.last_used_at = input.last_used_at ?? existing.last_used_at;
        existing.invalidated_at = input.invalidated_at ?? existing.invalidated_at;
        existing.invalidated_reason = input.invalidated_reason ?? existing.invalidated_reason;
        existing.expires_at = input.expires_at ?? existing.expires_at;
        existing.updated_at = now;
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
        generation_hash: input.generation_hash,
        use_count: input.use_count ?? 0,
        last_used_at: input.last_used_at ?? null,
        invalidated_at: input.invalidated_at ?? null,
        invalidated_reason: input.invalidated_reason ?? null,
        expires_at: input.expires_at ?? null,
        created_at: now,
        updated_at: now,
      };
      state.openingCaches.set(cache_uuid, row);
      // Only the valid row participates in scope-based lookup so that a
      // failed attempt does not mask a freshly-generated valid row.
      if (row.status === 'valid') {
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
    },
  };

  return repo;
}