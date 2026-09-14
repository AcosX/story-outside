import { encodeRuntimePayload, decodeRuntimePayload } from './runtimePayloadCodec.mjs';
// MariaDB persistence adapter for the synchronous application repositories.
//
// The service layer intentionally keeps its existing synchronous contract.
// This module makes the in-process projection durable: it hydrates the
// projection before the server accepts traffic and flushes a complete
// transaction before JSON responses are sent. Canonical history is written
// to session_events; runtime_payload carries bounded idempotency/pending
// state that has no normalized equivalent in the current service API.

import { createHash } from 'node:crypto';
import { info as logInfo } from '../observability/logger.mjs';
import { appendSessionEvent, pendingRequestFingerprint } from './sessionEventPersistence.mjs';

import { canonicalJsonStringify, canonicalSha256 } from '../stories/canonicalHash.mjs';
import {
  exportSessionPersistenceSnapshot,
  hydrateSessionPersistence,
  registerPersistentSessionRepository,
  repositoryState,
} from '../stories/sessionService.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function iso(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function dateValue(value) {
  const valueIso = iso(value);
  return valueIso ? new Date(valueIso) : null;
}

function comparableSession(session) {
  // LRU touches are process-local cache bookkeeping, not gameplay writes.
  // Persist the latest value opportunistically with the next real mutation.
  const { lastTouchedAt, ...runtime } = session.runtime_payload || {};
  return { ...session, runtime_payload: runtime };
}

function snapshotHash(snapshot) {
  return createHash('sha256').update(JSON.stringify({ ...snapshot,
    sessions: snapshot.sessions.map(comparableSession),
  })).digest('hex');
}

// Compare against the last COMMITTED snapshot, never the in-flight one.
// Changed old events still go through appendSessionEvent's conflict checks.
function changedRows(rows = [], previous = [], key, comparable = row => row) {
  const before = new Map(previous.map(row => [row[key], JSON.stringify(comparable(row))]));
  return rows.filter(row => before.get(row[key]) !== JSON.stringify(comparable(row)));
}

function stableUuid(input) {
  const hex = createHash('sha256').update(String(input)).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ['8', '9', 'a', 'b'][parseInt(hex[16], 16) % 4];
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20, 32).join('')}`;
}

function json(value) {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function wrapRepository(repository, mutationNames, persistence) {
  return new Proxy(repository, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (!mutationNames.has(property) || typeof value !== 'function') return value;
      return (...args) => {
        const result = value.apply(target, args);
        persistence.markDirty();
        return result;
      };
    },
  });
}

function storyStatusForSession(state) {
  return state === 'finished' ? 'ended' : 'active';
}

function openingStateForSession(state) {
  return state === 'opening' || state === 'awaiting_first_choice' || state === 'realtime'
    ? state
    : 'realtime';
}

function eventRowsBySession(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const sessionUuid = row.session_uuid;
    if (!sessionUuid) continue;
    const list = grouped.get(sessionUuid) || [];
    list.push({
      event_id: row.event_id,
      event_type: row.event_type,
      origin: row.origin,
      source: row.source,
      source_sequence: Number(row.source_sequence),
      payload: parseJson(row.payload, {}),
      client_request_id: row.client_request_id || null,
      hash: row.hash,
      event_seq: Number(row.event_seq),
      prev_event_seq: row.prev_event_seq === null ? null : Number(row.prev_event_seq),
      occurred_at: iso(row.occurred_at),
      created_at: iso(row.created_at),
    });
    grouped.set(sessionUuid, list);
  }
  for (const list of grouped.values()) list.sort((a, b) => a.event_seq - b.event_seq);
  return grouped;
}

function pendingRowsBySession(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!row.session_uuid || !['queued', 'reserved'].includes(row.status)) continue;
    const payload = parseJson(row.request_payload, {});
    grouped.set(row.session_uuid, {
      pending_id: row.batch_uuid,
      events: Array.isArray(payload.items) ? payload.items : [],
      tool_call: payload.tool_call || null,
      committed_count: Number(row.committed_count || 0),
      source: row.source || 'runtime',
      produced_at: iso(row.created_at),
      revision_at_stage: Number(row.expected_revision || 0),
      request_id: payload.request_id || null,
    });
  }
  return grouped;
}

export async function createMariaDbRepositories({
  pool,
  storyRepository,
  communityProfileRepository,
  followingRepository,
  ecosystemSearchCacheRepository,
  ecosystemHotCacheRepository = null,
}) {
  if (!pool) throw new Error('createMariaDbRepositories: pool required');
  if (!storyRepository || !communityProfileRepository || !followingRepository || !ecosystemSearchCacheRepository) {
    throw new Error('createMariaDbRepositories: all repositories are required');
  }

  let dirty = true;
  let lastHash = null;
  let lastSnapshot = null;
  let writeChain = Promise.resolve();
  const persistence = {
    markDirty() {
      dirty = true;
    },
  };

  const story = wrapRepository(storyRepository, new Set([
    'upsertStory',
    'importVersion',
    'upsertOpeningCache',
    'recordCacheInvalidation',
    'recordSessionFirstChoice',
    'markCacheFailed',
    '_seedVersion',
    '_resetForTests',
  ]), persistence);
  registerPersistentSessionRepository(story);
  const community = wrapRepository(communityProfileRepository, new Set([
    'setCommunityProfile',
    '_resetForTests',
    '_hydrateSnapshot',
  ]), persistence);
  const following = wrapRepository(followingRepository, new Set([
    'setVisibility',
    'rememberAccount',
    'upsertFollow',
    'removeFollow',
    'upsertBlock',
    'removeBlock',
    'upsertSharedSession',
    'removeSharedSession',
  ]), persistence);

  const search = {
    name: 'mariadb-ecosystem-search-cache',
    ttlMs: ecosystemSearchCacheRepository.ttlMs,
    swrMs: ecosystemSearchCacheRepository.swrMs,
    get: (...args) => ecosystemSearchCacheRepository.get(...args),
    put: (...args) => {
      const result = ecosystemSearchCacheRepository.put(...args);
      persistence.markDirty();
      return result;
    },
    hasInflight: (...args) => ecosystemSearchCacheRepository.hasInflight(...args),
    getInflight: (...args) => ecosystemSearchCacheRepository.getInflight(...args),
    setInflight: (...args) => ecosystemSearchCacheRepository.setInflight(...args),
    clearInflight: (...args) => ecosystemSearchCacheRepository.clearInflight(...args),
    isFresh: (...args) => ecosystemSearchCacheRepository.isFresh(...args),
    isStaleButUsable: (...args) => ecosystemSearchCacheRepository.isStaleButUsable(...args),
    isExpired: (...args) => ecosystemSearchCacheRepository.isExpired(...args),
    _size: (...args) => ecosystemSearchCacheRepository._size(...args),
    _clear: (...args) => {
      const result = ecosystemSearchCacheRepository._clear(...args);
      persistence.markDirty();
      return result;
    },
    _inflightSize: (...args) => ecosystemSearchCacheRepository._inflightSize(...args),
    _exportSnapshot: (...args) => ecosystemSearchCacheRepository._exportSnapshot(...args),
    _hydrateSnapshot: (...args) => ecosystemSearchCacheRepository._hydrateSnapshot(...args),
  };

  const hot = ecosystemHotCacheRepository ? {
    name: 'mariadb-ecosystem-hot-cache',
    ttlMs: ecosystemHotCacheRepository.ttlMs,
    swrMs: ecosystemHotCacheRepository.swrMs,
    get: (...args) => ecosystemHotCacheRepository.get(...args),
    put: (...args) => {
      const result = ecosystemHotCacheRepository.put(...args);
      persistence.markDirty();
      return result;
    },
    isFresh: (...args) => ecosystemHotCacheRepository.isFresh(...args),
    isStaleButUsable: (...args) => ecosystemHotCacheRepository.isStaleButUsable(...args),
    isExpired: (...args) => ecosystemHotCacheRepository.isExpired(...args),
    hasInflight: (...args) => ecosystemHotCacheRepository.hasInflight(...args),
    getInflight: (...args) => ecosystemHotCacheRepository.getInflight(...args),
    setInflight: (...args) => ecosystemHotCacheRepository.setInflight(...args),
    clearInflight: (...args) => ecosystemHotCacheRepository.clearInflight(...args),
    _size: (...args) => ecosystemHotCacheRepository._size(...args),
    _clear: (...args) => {
      const result = ecosystemHotCacheRepository._clear(...args);
      persistence.markDirty();
      return result;
    },
    _exportSnapshot: (...args) => ecosystemHotCacheRepository._exportSnapshot(...args),
    _hydrateSnapshot: (...args) => ecosystemHotCacheRepository._hydrateSnapshot(...args),
  } : null;

  function captureSnapshot() {
    return {
      stories: typeof story._exportSnapshot === 'function' ? story._exportSnapshot() : null,
      sessions: exportSessionPersistenceSnapshot(story),
      community: typeof community._exportSnapshot === 'function' ? community._exportSnapshot() : [],
      following: typeof following._exportSnapshot === 'function' ? following._exportSnapshot() : null,
      search: typeof search._exportSnapshot === 'function' ? search._exportSnapshot() : [],
      hot: hot ? hot._exportSnapshot() : null,
    };
  }

  async function hydrate() {
    try {
      const [storyRows] = await pool.query(
        'SELECT story_uuid, slug, title, hook, locale, status, published_at, created_at, updated_at FROM stories ORDER BY id',
      );
      if (storyRows.length > 0) {
        const [versionRows] = await pool.query(
          `SELECT s.story_uuid, sv.version_uuid, sv.version_no, sv.title, sv.hook,
                  sv.content_payload, sv.roles_payload, sv.checksum, sv.source_ref,
                  sv.status, sv.published_at, sv.created_at, sv.updated_at
             FROM story_versions sv
             JOIN stories s ON s.id = sv.story_id
            ORDER BY sv.story_id, sv.version_no`,
        );
        const [cacheRows] = await pool.query(
          `SELECT s.story_uuid, sv.version_uuid AS story_version_uuid,
                  c.cache_uuid, c.opening_key, c.status, c.content_payload,
                  c.content_hash, c.generation_profile, c.generation_hash,
                  c.use_count, c.last_used_at, c.invalidated_at,
                  c.invalidated_reason, c.expires_at, c.created_at, c.updated_at
             FROM story_opening_caches c
             JOIN stories s ON s.id = c.story_id
             JOIN story_versions sv ON sv.id = c.story_version_id
            ORDER BY c.id`,
        );
        const [choiceRows] = await pool.query(
          `SELECT gs.session_uuid, oc.cache_uuid AS opening_cache_uuid,
                  gs.first_choice_at
             FROM game_sessions gs
             LEFT JOIN story_opening_caches oc ON oc.id = gs.opening_cache_id
            WHERE gs.first_choice_at IS NOT NULL`,
        );
        story._hydrateSnapshot({
          stories: storyRows.map((row) => ({
            story_uuid: row.story_uuid,
            slug: row.slug,
            title: row.title,
            hook: row.hook,
            locale: row.locale,
            status: row.status,
            published_at: iso(row.published_at),
            created_at: iso(row.created_at),
            updated_at: iso(row.updated_at),
          })),
          versions: versionRows.map((row) => ({
            version_uuid: row.version_uuid,
            story_uuid: row.story_uuid,
            version_no: Number(row.version_no),
            title: row.title,
            hook: row.hook,
            content_payload: parseJson(row.content_payload, {}),
            roles_payload: parseJson(row.roles_payload, []),
            checksum: row.checksum,
            source_ref: row.source_ref,
            status: row.status,
            published_at: iso(row.published_at),
            created_at: iso(row.created_at),
            updated_at: iso(row.updated_at),
          })),
          openingCaches: cacheRows.map((row) => ({
            cache_uuid: row.cache_uuid,
            story_uuid: row.story_uuid,
            story_version_uuid: row.story_version_uuid,
            opening_key: row.opening_key,
            status: row.status,
            content_payload: parseJson(row.content_payload, {}),
            content_hash: row.content_hash,
            generation_profile: parseJson(row.generation_profile, {}),
            generation_hash: row.generation_hash,
            use_count: Number(row.use_count || 0),
            last_used_at: iso(row.last_used_at),
            invalidated_at: iso(row.invalidated_at),
            invalidated_reason: row.invalidated_reason,
            expires_at: iso(row.expires_at),
            created_at: iso(row.created_at),
            updated_at: iso(row.updated_at),
          })),
          sessionFirstChoices: choiceRows.map((row) => ({
            session_uuid: row.session_uuid,
            opening_cache_uuid: row.opening_cache_uuid || null,
            status: 'consumed',
            first_choice_at: iso(row.first_choice_at),
            reason: 'first_ask_player_choice',
          })),
        });
      }

      const [profileRows] = await pool.query(
        `SELECT profile_payload
           FROM story_community_profiles
          ORDER BY generated_at, id`,
      );
      if (profileRows.length > 0) {
        community._hydrateSnapshot(profileRows
          .map((row) => parseJson(row.profile_payload, null))
          .filter(Boolean));
      }

      const [accountRows] = await pool.query('SELECT user_uuid, url_token, visible FROM ecosystem_account_preferences');
      const [followRows] = await pool.query('SELECT follower_uuid, target_user_uuid, created_at FROM ecosystem_follow_edges');
      const [blockRows] = await pool.query('SELECT owner_uuid, target_user_uuid, created_at FROM ecosystem_block_edges');
      const [shareRows] = await pool.query(
        'SELECT session_uuid, owner_user_uuid, title, story_uuid, story_version_uuid, created_at, updated_at FROM ecosystem_shared_sessions',
      );
      if (accountRows.length || followRows.length || blockRows.length || shareRows.length) {
        following._hydrateSnapshot({
          accounts: accountRows.map(row => ({ ...row, visible: Boolean(row.visible) })),
          follows: followRows.map((row) => ({ ...row, created_at: iso(row.created_at) })),
          blocks: blockRows.map((row) => ({ ...row, created_at: iso(row.created_at) })),
          sharedSessions: shareRows.map((row) => ({
            ...row,
            title: row.title || undefined,
            story_uuid: row.story_uuid || undefined,
            story_version_uuid: row.story_version_uuid || undefined,
            created_at: iso(row.created_at),
            updated_at: iso(row.updated_at),
          })),
        });
      }

      const [searchRows] = await pool.query(
        `SELECT cache_key, story_uuid, story_version_uuid,
                community_profile_version, query_id, query_text, value,
                fetched_at_ms, expires_at_ms, swr_expires_at_ms
           FROM ecosystem_search_cache`,
      );
      if (searchRows.length > 0) {
        search._hydrateSnapshot(searchRows.map((row) => ({
          cache_key: row.cache_key,
          story_uuid: row.story_uuid,
          story_version_uuid: row.story_version_uuid,
          community_profile_version: row.community_profile_version,
          query_id: row.query_id,
          query_text: row.query_text,
          value: parseJson(row.value, []),
          fetched_at_ms: Number(row.fetched_at_ms),
          expires_at_ms: Number(row.expires_at_ms),
          swr_expires_at_ms: Number(row.swr_expires_at_ms),
        })));
      }

      if (hot) {
        const [hotRows] = await pool.query(
          `SELECT cache_key, value, fetched_at_ms, expires_at_ms,
                  swr_expires_at_ms, source
             FROM ecosystem_hot_cache`,
        );
        if (hotRows.length > 0) {
          hot._hydrateSnapshot(hotRows.map((row) => ({
            cache_key: row.cache_key,
            value: parseJson(row.value, []),
            fetched_at_ms: Number(row.fetched_at_ms),
            expires_at_ms: Number(row.expires_at_ms),
            swr_expires_at_ms: Number(row.swr_expires_at_ms),
            source: row.source || null,
          })));
        }
      }

      const [sessionRows] = await pool.query(
        `SELECT gs.session_uuid, s.story_uuid, sv.version_uuid AS story_version_uuid,
                sv.checksum AS story_version_checksum,
                oc.cache_uuid, oc.status AS opening_cache_status,
                gs.user_uuid, gs.user_ref, gs.role_id, gs.model, gs.prompt,
                gs.generation_profile, gs.status, gs.opening_state,
                gs.opening_cursor, gs.session_revision, gs.first_choice_at,
                gs.context_compact_text, gs.context_compact_payload,
                gs.compacted_through_seq, gs.compacted_event_count,
                gs.token_estimate, gs.context_window, gs.context_safety_ratio,
                gs.reserved_completion_tokens, gs.context_schema_version,
                gs.prompt_version, gs.last_compact_at,
                gs.last_compact_attempt_at, gs.last_compact_status,
                gs.last_compact_error, gs.runtime_payload, gs.updated_at
           FROM game_sessions gs
           JOIN stories s ON s.id = gs.story_id
           JOIN story_versions sv ON sv.id = gs.story_version_id
           LEFT JOIN story_opening_caches oc ON oc.id = gs.opening_cache_id
          ORDER BY gs.id`,
      );
      const [eventRows] = await pool.query(
        `SELECT gs.session_uuid, se.event_id, se.event_type, se.origin,
                se.source, se.source_sequence, se.payload,
                se.client_request_id, se.hash, se.event_seq,
                se.prev_event_seq, se.occurred_at, se.created_at
           FROM session_events se
           JOIN game_sessions gs ON gs.id = se.session_id
          ORDER BY se.session_id, se.event_seq`,
      );
      const [pendingRows] = await pool.query(
        `SELECT gs.session_uuid, pb.batch_uuid, pb.status,
                pb.expected_revision, pb.source, pb.request_payload,
                pb.committed_count, pb.created_at
           FROM pending_batches pb
           JOIN game_sessions gs ON gs.id = pb.session_id
          WHERE pb.status IN ('queued', 'reserved')
          ORDER BY pb.id`,
      );
      const history = eventRowsBySession(eventRows);
      const pending = pendingRowsBySession(pendingRows);
      const legacyFinished = new Set();
      for (const row of sessionRows) {
        const runtime = decodeRuntimePayload(parseJson(row.runtime_payload, {}) || {});
        if (runtime.finish_envelope?.tool_call?.name === 'finish_story' && row.status !== 'ended') legacyFinished.add(row.session_uuid);
        hydrateSessionPersistence({
          repository: story,
          row: {
            session_uuid: row.session_uuid,
            story_uuid: row.story_uuid,
            story_version_uuid: row.story_version_uuid,
            story_version_checksum: row.story_version_checksum,
            cache_uuid: row.cache_uuid,
            opening_cache_status: row.opening_cache_status,
            generation_profile: parseJson(row.generation_profile, {}),
            user_uuid: row.user_uuid,
            user_ref: row.user_ref,
            role_id: row.role_id,
            model: row.model,
            prompt: row.prompt,
            state: row.opening_state,
            cursor: Number((history.get(row.session_uuid) || []).length),
            opening_cursor: Number(row.opening_cursor || 0),
            revision: Number(row.session_revision || 0),
            status: row.status,
            context_compact_text: row.context_compact_text,
            context_compact_payload: parseJson(row.context_compact_payload, null),
            compacted_through_seq: row.compacted_through_seq == null ? null : Number(row.compacted_through_seq),
            compacted_event_count: row.compacted_event_count == null ? null : Number(row.compacted_event_count),
            token_estimate: row.token_estimate == null ? null : Number(row.token_estimate),
            context_window: row.context_window == null ? null : Number(row.context_window),
            context_safety_ratio: row.context_safety_ratio == null ? null : Number(row.context_safety_ratio),
            reserved_completion_tokens: row.reserved_completion_tokens == null ? null : Number(row.reserved_completion_tokens),
            context_schema_version: row.context_schema_version == null ? null : Number(row.context_schema_version),
            prompt_version: row.prompt_version == null ? null : Number(row.prompt_version),
            last_compact_at: iso(row.last_compact_at),
            last_compact_attempt_at: iso(row.last_compact_attempt_at),
            last_compact_status: row.last_compact_status,
            last_compact_error: row.last_compact_error,
            updated_at: iso(row.updated_at),
          },
          history: history.get(row.session_uuid) || [],
          runtime_payload: runtime,
          pending: pending.get(row.session_uuid) || null,
        });
      }
      dirty = false;
      lastSnapshot = storyRows.length ? captureSnapshot() : null;
      if (lastSnapshot && legacyFinished.size) {
        lastSnapshot.sessions = lastSnapshot.sessions.map(row => legacyFinished.has(row.session_uuid) ? { ...row, state: 'realtime' } : row);
        dirty = true;
      }
      lastHash = lastSnapshot ? snapshotHash(lastSnapshot) : null;
    } catch (error) {
      if (error && (error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_BAD_FIELD_ERROR')) {
        throw new Error('MariaDB business schema is incomplete; run npm run db:migrate before starting the server');
      }
      throw error;
    }
  }

  async function syncStories(connection, snapshot) {
    const storyRows = snapshot.stories?.stories || [];
    for (const row of storyRows) {
      await connection.query(
        `INSERT INTO stories
          (story_uuid, slug, title, hook, locale, status, published_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           title = VALUES(title), hook = VALUES(hook), locale = VALUES(locale),
           status = VALUES(status), published_at = VALUES(published_at), updated_at = VALUES(updated_at)`,
        [row.story_uuid, row.slug, row.title, row.hook, row.locale || 'zh-CN', row.status || 'published', dateValue(row.published_at), dateValue(row.created_at), dateValue(row.updated_at)],
      );
    }
    const [storyIds] = await connection.query('SELECT id, story_uuid, slug FROM stories');
    const storyIdByUuid = new Map(storyIds.map((row) => [row.story_uuid, Number(row.id)]));
    // slug is UNIQUE in `stories`, so it is a stable fallback key when the
    // in-memory story_uuid never landed a row of its own. This happens when
    // a process starts with an un-hydrated story repo (e.g. an upstream
    // outage during boot) and allocates a fresh randomUUID() for a slug that
    // already exists under a different uuid: the `ON DUPLICATE KEY (slug)`
    // upsert updates the existing row, so `storyIdByUuid.get(newUuid)` misses.
    // Without this fallback the version write throws forever and wedges every
    // subsequent flush (see the 2026-09-14 uuid-split persistence incident).
    const storyIdBySlug = new Map(storyIds.map((row) => [row.slug, Number(row.id)]));
    const slugByStoryUuid = new Map(
      (snapshot.stories?.stories || []).map((row) => [row.story_uuid, row.slug]),
    );
    for (const row of snapshot.stories?.versions || []) {
      let storyId = storyIdByUuid.get(row.story_uuid);
      if (!storyId) {
        const slug = slugByStoryUuid.get(row.story_uuid);
        storyId = slug ? storyIdBySlug.get(slug) : undefined;
        if (storyId) {
          // eslint-disable-next-line no-console
          console.warn(`[story-outside] MariaDB persistence: story_uuid ${row.story_uuid} split from persisted slug '${slug}'; binding version ${row.version_uuid} to the existing story row.`);
        }
      }
      if (!storyId) throw new Error(`MariaDB persistence: story ${row.story_uuid} is missing before version ${row.version_uuid}`);
      await connection.query(
        `INSERT INTO story_versions
          (version_uuid, story_id, version_no, title, hook, content_payload, roles_payload,
           checksum, source_ref, status, published_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           title = VALUES(title), hook = VALUES(hook), source_ref = VALUES(source_ref),
           status = VALUES(status), published_at = VALUES(published_at), updated_at = VALUES(updated_at)`,
        [row.version_uuid, storyId, row.version_no, row.title, row.hook, json(row.content_payload), json(row.roles_payload || []), row.checksum, row.source_ref || null, row.status || 'published', dateValue(row.published_at), dateValue(row.created_at), dateValue(row.updated_at)],
      );
    }
    const [versionIds] = await connection.query(
      `SELECT sv.id, sv.version_uuid, sv.story_id FROM story_versions sv`,
    );
    const versionIdByUuid = new Map(versionIds.map((row) => [row.version_uuid, Number(row.id)]));
    const cacheRows = snapshot.stories?.openingCaches || [];
    for (const row of cacheRows) {
      let storyId = storyIdByUuid.get(row.story_uuid);
      if (!storyId) {
        // Same uuid-split fallback as the version write above.
        const slug = slugByStoryUuid.get(row.story_uuid);
        storyId = slug ? storyIdBySlug.get(slug) : undefined;
      }
      const versionId = versionIdByUuid.get(row.story_version_uuid);
      if (!storyId || !versionId) throw new Error(`MariaDB persistence: cache ${row.cache_uuid} has missing story/version`);
      const contentHash = /^[0-9a-f]{64}$/i.test(String(row.content_hash || ''))
        ? row.content_hash
        : canonicalSha256(row.content_payload || {});
      await connection.query(
        `INSERT INTO story_opening_caches
          (cache_uuid, story_id, story_version_id, opening_key, generation_profile,
           generation_hash, status, content_payload, content_hash, use_count,
           last_used_at, invalidated_at, invalidated_reason, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           status = VALUES(status), content_payload = VALUES(content_payload),
           content_hash = VALUES(content_hash), generation_profile = VALUES(generation_profile),
           generation_hash = VALUES(generation_hash), use_count = VALUES(use_count),
           last_used_at = VALUES(last_used_at), invalidated_at = VALUES(invalidated_at),
           invalidated_reason = VALUES(invalidated_reason), expires_at = VALUES(expires_at),
           updated_at = VALUES(updated_at)`,
        [row.cache_uuid, storyId, versionId, row.opening_key || 'default', json(row.generation_profile || {}), row.generation_hash, row.status || 'valid', json(row.content_payload || {}), contentHash, row.use_count || 0, dateValue(row.last_used_at), dateValue(row.invalidated_at), row.invalidated_reason || null, dateValue(row.expires_at), dateValue(row.created_at), dateValue(row.updated_at)],
      );
    }
    const [cacheIds] = await connection.query('SELECT id, cache_uuid FROM story_opening_caches');
    return {
      storyIdByUuid,
      versionIdByUuid,
      cacheIdByUuid: new Map(cacheIds.map((row) => [row.cache_uuid, Number(row.id)])),
    };
  }

  async function syncCommunity(connection, snapshot, ids) {
    for (const profile of snapshot.community || []) {
      const storyId = ids.storyIdByUuid.get(profile.story_uuid);
      const versionId = ids.versionIdByUuid.get(profile.story_version_uuid);
      if (!storyId || !versionId) continue;
      await connection.query(
        `INSERT INTO story_community_profiles
          (profile_uuid, story_id, story_version_id, generator_version,
           content_hash, profile_payload, source, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           profile_payload = VALUES(profile_payload), source = VALUES(source),
           generated_at = VALUES(generated_at), updated_at = CURRENT_TIMESTAMP(6)`,
        [profile.profile_uuid, storyId, versionId, profile.generator_version, profile.hash.content_hash, json(profile), profile.source, dateValue(profile.generated_at)],
      );
    }
  }

  function promotedEventsForBatch(history, batchRow) {
    const requestPayload = parseJson(batchRow.request_payload, {}) || {};
    const stagedItems = Array.isArray(requestPayload.items) ? requestPayload.items : [];
    const minimumEventSeq = Number(batchRow.expected_revision || 0);
    const candidates = history
      .filter((event) => event
        && event.event_type === 'narrative_beat'
        && event.source === (batchRow.source || 'runtime')
        && Number(event.event_seq) > minimumEventSeq)
      .slice();
    return stagedItems.map((payload) => {
      const index = candidates.findIndex((event) => (
        canonicalJsonStringify(event.payload || {}) === canonicalJsonStringify(payload || {})
      ));
      if (index < 0) return null;
      return candidates.splice(index, 1)[0];
    });
  }

  async function syncPendingItems(connection, batchId, sessionId, itemRows, promotedEvents, { active = false } = {}) {
    await connection.query(
      `UPDATE pending_batch_items
          SET status = 'discarded', promoted_event_id = NULL,
              occurred_at = NULL, updated_at = CURRENT_TIMESTAMP(6)
        WHERE batch_id = ? AND session_id = ?`,
      [batchId, sessionId],
    );
    for (const item of itemRows) {
      const promoted = promotedEvents[item.index] || null;
      const status = promoted ? 'committed' : active ? 'pending' : 'discarded';
      await connection.query(
        `INSERT INTO pending_batch_items
          (batch_id, session_id, item_uuid, item_seq, item_type, status,
           payload, promoted_event_id, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           payload = VALUES(payload), status = VALUES(status),
           promoted_event_id = VALUES(promoted_event_id), occurred_at = VALUES(occurred_at),
           updated_at = CURRENT_TIMESTAMP(6)`,
        [
          batchId,
          sessionId,
          stableUuid(`${item.batch_uuid}:${item.index}`),
          item.index,
          item.item_type,
          status,
          json(item.payload),
          promoted ? promoted.event_id : null,
          promoted ? dateValue(promoted.occurred_at) : null,
        ],
      );
    }
  }

  async function syncSessions(connection, snapshot, ids, previous) {
    const priorSessions = new Map((previous?.sessions || []).map(row => [row.session_uuid, row]));
    const sessionIdByUuid = new Map();
    // CHECK(first_choice_at >= created_at) is evaluated before duplicate-key
    // resolution; retain the existing creation time on the INSERT candidate.
    const [creationRows] = snapshot.sessions.length
      ? await connection.query('SELECT session_uuid, created_at FROM game_sessions') : [[]];
    const createdAt = new Map(creationRows.map(row => [row.session_uuid, row.created_at]));
    for (const item of snapshot.sessions || []) {
      const storyId = ids.storyIdByUuid.get(item.story_uuid);
      const versionId = ids.versionIdByUuid.get(item.story_version_uuid);
      if (!storyId || !versionId) throw new Error(`MariaDB persistence: session ${item.session_uuid} has missing story/version`);
      const marker = story.findSessionFirstChoice(item.session_uuid);
      const runtimePayload = {
        ...(item.runtime_payload || {}),
        state: item.state,
        cursor: item.cursor,
        opening_cursor: item.opening_cursor,
        revision: item.revision,
        user_uuid: item.user_uuid || null,
      };
      const status = storyStatusForSession(item.state);
      const openingState = openingStateForSession(item.state);
      const creationTime = dateValue(createdAt.get(item.session_uuid) || marker?.first_choice_at) || new Date();
      await connection.query(
        `INSERT INTO game_sessions
          (session_uuid, story_id, story_version_id, user_uuid, user_ref, role_id,
           model, prompt, generation_profile, status, opening_cache_id,
           first_choice_at, opening_cursor, opening_state, session_revision,
           context_compact_text, context_compact_payload, compacted_through_seq,
           compacted_event_count, token_estimate, context_window,
           context_safety_ratio, reserved_completion_tokens, context_schema_version,
           prompt_version, last_compact_at, last_compact_attempt_at,
           last_compact_status, last_compact_error, runtime_payload, ended_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           story_id = VALUES(story_id), story_version_id = VALUES(story_version_id),
           user_uuid = VALUES(user_uuid), user_ref = VALUES(user_ref), role_id = VALUES(role_id),
           model = VALUES(model), prompt = VALUES(prompt), generation_profile = VALUES(generation_profile),
           status = VALUES(status), opening_cache_id = VALUES(opening_cache_id),
           first_choice_at = VALUES(first_choice_at), opening_cursor = VALUES(opening_cursor),
           opening_state = VALUES(opening_state), session_revision = VALUES(session_revision),
           context_compact_text = VALUES(context_compact_text), context_compact_payload = VALUES(context_compact_payload),
           compacted_through_seq = VALUES(compacted_through_seq), compacted_event_count = VALUES(compacted_event_count),
           token_estimate = VALUES(token_estimate), context_window = VALUES(context_window),
           context_safety_ratio = VALUES(context_safety_ratio), reserved_completion_tokens = VALUES(reserved_completion_tokens),
           context_schema_version = VALUES(context_schema_version), prompt_version = VALUES(prompt_version),
           last_compact_at = VALUES(last_compact_at), last_compact_attempt_at = VALUES(last_compact_attempt_at),
           last_compact_status = VALUES(last_compact_status), last_compact_error = VALUES(last_compact_error),
           runtime_payload = VALUES(runtime_payload), ended_at = VALUES(ended_at)`,
        [item.session_uuid, storyId, versionId, item.user_uuid || null, item.user_ref, item.role_id, item.model, item.prompt, json(item.generation_profile || {}), status, ids.cacheIdByUuid.get(item.cache_uuid) || null, dateValue(marker && marker.first_choice_at), item.opening_cursor || 0, openingState, item.revision || 0, item.compact?.context_compact_text || null, json(item.compact?.context_compact_payload || null), item.compact?.compacted_through_seq ?? null, item.compact?.compacted_event_count ?? null, item.compact?.token_estimate ?? null, item.compact?.context_window ?? null, item.compact?.context_safety_ratio ?? null, item.compact?.reserved_completion_tokens ?? null, item.compact?.context_schema_version ?? 1, item.compact?.prompt_version ?? 1, dateValue(item.compact?.last_compact_at), dateValue(item.compact?.last_compact_attempt_at), item.compact?.last_compact_status || 'idle', item.compact?.last_compact_error || null, json(encodeRuntimePayload(runtimePayload)), status === 'ended' ? new Date() : null, creationTime],
      );
    }
    const [sessionRows] = await connection.query('SELECT id, session_uuid FROM game_sessions');
    for (const row of sessionRows) sessionIdByUuid.set(row.session_uuid, Number(row.id));

    for (const item of snapshot.sessions || []) {
      const sessionId = sessionIdByUuid.get(item.session_uuid);
      if (!sessionId) continue;

      const history = Array.isArray(item.history) ? item.history : [];
      const pending = item.runtime_payload && item.runtime_payload.pending;
      const activePendingId = pending && pending.pending_id && UUID_PATTERN.test(pending.pending_id)
        ? pending.pending_id
        : null;

      for (const event of changedRows(item.history, priorSessions.get(item.session_uuid)?.history, 'event_id')) {
        await appendSessionEvent(connection, sessionId, event);
      }

      const [activeBatchRows] = await connection.query(
        `SELECT id, batch_uuid, expected_revision, source, request_payload,
                committed_count, item_count
           FROM pending_batches
          WHERE session_id = ? AND status IN ('queued', 'reserved')
          ORDER BY id`,
        [sessionId],
      );
      for (const batchRow of activeBatchRows) {
        if (batchRow.batch_uuid === activePendingId) continue;
        const requestPayload = parseJson(batchRow.request_payload, {}) || {};
        const stagedItems = Array.isArray(requestPayload.items) ? requestPayload.items : [];
        const promoted = promotedEventsForBatch(history, batchRow);
        const committed = promoted.filter(Boolean);
        const completed = stagedItems.length > 0 && committed.length === stagedItems.length;
        await connection.query(
          `UPDATE pending_batches
              SET status = ?, item_count = ?, committed_count = ?,
                  promoted_event_id = ?, completed_at = CURRENT_TIMESTAMP(6),
                  updated_at = CURRENT_TIMESTAMP(6)
            WHERE id = ?`,
          [completed ? 'succeeded' : 'superseded', stagedItems.length, committed.length, completed ? committed[committed.length - 1].event_id : null, batchRow.id],
        );
        const itemRows = stagedItems.map((payload, index) => ({
          batch_uuid: batchRow.batch_uuid,
          payload,
          item_type: 'narrative_beat',
          index,
        }));
        if (requestPayload.tool_call) {
          itemRows.push({
            batch_uuid: batchRow.batch_uuid,
            payload: requestPayload.tool_call,
            item_type: 'tool_call',
            index: itemRows.length,
          });
        }
        await syncPendingItems(connection, batchRow.id, sessionId, itemRows, promoted);
      }

      if (activePendingId) {
        const requestPayload = {
          items: Array.isArray(pending.events) ? pending.events : [],
          tool_call: pending.tool_call || null,
          request_id: pending.request_id || null,
        };
        await connection.query(
          `INSERT INTO pending_batches
            (batch_uuid, session_id, batch_type, status, expected_revision,
             request_uuid, source, request_payload, request_fingerprint,
             committed_count, item_count, available_at)
           VALUES (?, ?, 'narrative_beat', 'queued', ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             status = 'queued', expected_revision = VALUES(expected_revision),
             source = VALUES(source), request_payload = VALUES(request_payload),
             request_fingerprint = VALUES(request_fingerprint),
             committed_count = VALUES(committed_count), item_count = VALUES(item_count),
             completed_at = NULL, updated_at = CURRENT_TIMESTAMP(6)`,
          [pending.pending_id, sessionId, pending.revision_at_stage || 0, pending.pending_id, pending.source || 'runtime', json(requestPayload), pendingRequestFingerprint(item.session_uuid, pending.pending_id, requestPayload), pending.committed_count || 0, Array.isArray(pending.events) ? pending.events.length : 0, dateValue(pending.produced_at)],
        );
        const [batchRows] = await connection.query('SELECT id, session_id FROM pending_batches WHERE batch_uuid = ?', [pending.pending_id]);
        const batchId = batchRows[0] && Number(batchRows[0].id);
        if (!batchId || Number(batchRows[0].session_id) !== sessionId) {
          throw new Error(`MariaDB persistence: conflicting pending batch ${pending.pending_id}`);
        }
        if (batchId) {
          const itemRows = Array.isArray(pending.events)
            ? pending.events.map((event, index) => ({ batch_uuid: pending.pending_id, payload: event, item_type: 'narrative_beat', index }))
            : [];
          if (pending.tool_call) itemRows.push({ batch_uuid: pending.pending_id, payload: pending.tool_call, item_type: 'tool_call', index: itemRows.length });
          const pendingRow = {
            batch_uuid: pending.pending_id,
            expected_revision: pending.revision_at_stage || 0,
            source: pending.source || 'runtime',
            request_payload: json(requestPayload),
          };
          const promoted = promotedEventsForBatch(history, pendingRow)
            .map((event, index) => (index < (pending.committed_count || 0) ? event : null));
          await syncPendingItems(connection, batchId, sessionId, itemRows, promoted, { active: true });
        }
      }

      const lastEvent = history.length ? history[history.length - 1] : null;
      const runtimeState = {
        state: item.state,
        cursor: item.cursor,
        opening_cursor: item.opening_cursor,
        revision: item.revision,
      };
      await connection.query(
        `INSERT INTO session_checkpoints
          (session_id, checkpoint_uuid, last_event_id, last_event_seq, event_count,
           context_digest, summary_text, state_payload, projection_status, is_dirty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'synced', 0)
         ON DUPLICATE KEY UPDATE
           last_event_id = VALUES(last_event_id), last_event_seq = VALUES(last_event_seq),
           event_count = VALUES(event_count), context_digest = VALUES(context_digest),
           summary_text = VALUES(summary_text), state_payload = VALUES(state_payload),
           projection_status = 'synced', is_dirty = 0, updated_at = CURRENT_TIMESTAMP(6)`,
        [sessionId, stableUuid(`checkpoint:${item.session_uuid}`), lastEvent ? lastEvent.event_id : null, lastEvent ? lastEvent.event_seq : null, history.length, canonicalSha256(history), item.compact?.context_compact_text || null, json(runtimeState)],
      );

      for (const record of changedRows(item.runtime_payload?.compact_history, priorSessions.get(item.session_uuid)?.runtime_payload?.compact_history, 'attempt_uuid')) {
        if (!record || !record.attempt_uuid || !UUID_PATTERN.test(record.attempt_uuid)) continue;
        await connection.query(
          `INSERT IGNORE INTO compact_compacted_events
            (session_id, attempt_uuid, status, compacted_through_seq, event_count,
             skipped_protected, estimated_tokens, context_window, prompt_version,
             context_schema_version, error_code, error_message, folded_event_seqs,
             summary_excerpt, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [sessionId, record.attempt_uuid, record.status || 'failed', record.compacted_through_seq || 0, record.event_count || 0, record.skipped_protected || 0, record.estimated_tokens ?? null, record.context_window ?? null, record.prompt_version || 1, record.context_schema_version || 1, record.error_code || null, record.error_message || null, json(record.folded_event_seqs || []), record.summary_excerpt || null, dateValue(record.created_at)],
        );
      }
    }
  }

  async function syncFollowing(connection, snapshot) {
    await connection.query('DELETE FROM ecosystem_account_preferences');
    for (const row of snapshot.following?.accounts || []) {
      await connection.query('INSERT INTO ecosystem_account_preferences (user_uuid, url_token, visible) VALUES (?, ?, ?)',
        [row.user_uuid, row.url_token || null, row.visible !== false]);
    }
    await connection.query('DELETE FROM ecosystem_follow_edges');
    for (const row of snapshot.following?.follows || []) {
      await connection.query(
        'INSERT INTO ecosystem_follow_edges (follower_uuid, target_user_uuid, created_at) VALUES (?, ?, ?)',
        [row.follower_uuid, row.target_user_uuid, dateValue(row.created_at)],
      );
    }
    await connection.query('DELETE FROM ecosystem_block_edges');
    for (const row of snapshot.following?.blocks || []) {
      await connection.query(
        'INSERT INTO ecosystem_block_edges (owner_uuid, target_user_uuid, created_at) VALUES (?, ?, ?)',
        [row.owner_uuid, row.target_user_uuid, dateValue(row.created_at)],
      );
    }
    await connection.query('DELETE FROM ecosystem_shared_sessions');
    for (const row of snapshot.following?.sharedSessions || []) {
      await connection.query(
        `INSERT INTO ecosystem_shared_sessions
          (session_uuid, owner_user_uuid, title, story_uuid, story_version_uuid, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [row.session_uuid, row.owner_user_uuid, row.title || null, row.story_uuid || null, row.story_version_uuid || null, dateValue(row.created_at), dateValue(row.updated_at)],
      );
    }
  }

  async function syncSearch(connection, snapshot) {
    await connection.query('DELETE FROM ecosystem_search_cache');
    for (const row of snapshot.search || []) {
      if (!row.story_uuid || !row.story_version_uuid || !row.community_profile_version || !row.query_id || !row.query_text) continue;
      await connection.query(
        `INSERT INTO ecosystem_search_cache
          (cache_key, story_uuid, story_version_uuid, community_profile_version,
           query_id, query_text, value, fetched_at_ms, expires_at_ms, swr_expires_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.cache_key, row.story_uuid, row.story_version_uuid, row.community_profile_version, row.query_id, row.query_text, json(row.value || []), row.fetched_at_ms, row.expires_at_ms, row.swr_expires_at_ms],
      );
    }
  }

  async function syncHot(connection, snapshot) {
    await connection.query('DELETE FROM ecosystem_hot_cache');
    for (const row of snapshot.hot || []) {
      if (!row.cache_key || !Number.isFinite(Number(row.fetched_at_ms))) continue;
      await connection.query(
        `INSERT INTO ecosystem_hot_cache
          (cache_key, value, fetched_at_ms, expires_at_ms, swr_expires_at_ms, source)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [row.cache_key, json(row.value || []), row.fetched_at_ms, row.expires_at_ms,
          row.swr_expires_at_ms, row.source || 'unknown'],
      );
    }
  }

  async function flush() {
    const queuedAt = performance.now();
    const write = writeChain.then(async () => {
      const startedAt = performance.now();
      const snapshot = captureSnapshot();
      const currentHash = snapshotHash(snapshot);
      if (!dirty && currentHash === lastHash) return;
      if (currentHash === lastHash) { dirty = false; return; }
      const previous = lastSnapshot;
      const markerChanges = new Set(changedRows(snapshot.stories?.sessionFirstChoices, previous?.stories?.sessionFirstChoices, 'session_uuid').map(row => row.session_uuid));
      const changedSessions = changedRows(snapshot.sessions, previous?.sessions, 'session_uuid', comparableSession);
      const changedSessionIds = new Set(changedSessions.map(row => row.session_uuid));
      const delta = {
        stories: {
          stories: changedRows(snapshot.stories?.stories, previous?.stories?.stories, 'story_uuid'),
          versions: changedRows(snapshot.stories?.versions, previous?.stories?.versions, 'version_uuid'),
          openingCaches: changedRows(snapshot.stories?.openingCaches, previous?.stories?.openingCaches, 'cache_uuid'),
        },
        sessions: snapshot.sessions.filter(row => changedSessionIds.has(row.session_uuid) || markerChanges.has(row.session_uuid)),
        community: changedRows(snapshot.community, previous?.community, 'profile_uuid'),
      };
      const connection = await pool.getConnection();
      let sqlMs = 0;
      let commitMs = 0;
      let committed = false;
      try {
        const sqlStart = performance.now();
        await connection.beginTransaction();
        const ids = await syncStories(connection, delta);
        await syncCommunity(connection, delta, ids);
        await syncSessions(connection, delta, ids, previous);
        if (JSON.stringify(snapshot.following) !== JSON.stringify(previous?.following)) {
          await syncFollowing(connection, snapshot);
        }
        if (JSON.stringify(snapshot.search) !== JSON.stringify(previous?.search)) {
          await syncSearch(connection, snapshot);
        }
        if (hot && JSON.stringify(snapshot.hot) !== JSON.stringify(previous?.hot)) {
          await syncHot(connection, snapshot);
        }
        sqlMs = performance.now() - sqlStart;
        const commitStart = performance.now();
        await connection.commit();
        commitMs = performance.now() - commitStart;
        committed = true;
        lastHash = currentHash;
        lastSnapshot = snapshot;
        dirty = false;
      } catch (error) {
        await connection.rollback().catch(() => {});
        throw error;
      } finally {
        connection.release();
        logInfo('database.flush', { component: 'database', latency_ms: Math.round(performance.now() - startedAt),
          extra: { queue_ms: Math.round(startedAt - queuedAt), sql_ms: Math.round(sqlMs),
            commit_ms: Math.round(commitMs), committed, sessions: delta.sessions.length,
            stories: delta.stories.stories.length, versions: delta.stories.versions.length,
            hot_cache_rows: snapshot.hot?.length || 0 } });
      }
    });
    // A failed transaction must reject its caller, but must not poison the
    // queue or advance the baseline. Mutations during a write are captured
    // by the next flush even if markDirty ran before this write committed.
    writeChain = write.catch(() => {});
    return write;
  }

  await hydrate();

  return {
    storyRepository: story,
    communityProfileRepository: community,
    followingRepository: following,
    ecosystemSearchCacheRepository: search,
    ecosystemHotCacheRepository: hot,
    hydrate,
    flush,
    captureSnapshot,
    get persistent() { return true; },
  };
}

void canonicalJsonStringify;
void repositoryState;
