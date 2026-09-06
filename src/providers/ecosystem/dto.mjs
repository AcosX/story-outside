// src/providers/ecosystem/dto.mjs — ClickUp 16.2 知乎搜索 DTO 与契约守卫。
//
// 公共契约（POST /v1/ecosystem/discussions）:
//   request:                                    // ClickUp 16.2 P1 fix
//     {
//       search_queries: [                       // REQUIRED, non-empty array
//         {
//           id: string,                         // stable id within profile
//           query: string,                      // non-empty, ≤256 chars
//           kind: 'web' | 'knowledge' | 'hot' | 'mixed',
//         },
//         ...
//       ],
//       story_uuid?: string,                    // optional UUID
//       story_version_uuid?: string,            // optional UUID
//       community_profile_version?: string,     // optional
//       limit?: number,                         // 1..20, default 8 (per-query)
//     }
//   response:
//     {
//       results: [                              // aggregated per query id
//         {
//           id: string,                         // echoes search_queries[i].id
//           query: string,                      // echoes search_queries[i].query
//           kind: 'web' | 'knowledge' | 'hot' | 'mixed',
//           discussions: DiscussionDTO[],
//           cached: boolean,
//           provenance: 'live' | 'cache' | 'mock' | 'unavailable',
//           ecosystem_status?: 'ok' | 'unavailable',
//           error?: { code: string, message: string },
//         },
//         ...
//       ],
//       provenance: 'live' | 'cache' | 'mock' | 'unavailable',
//       cached: boolean,
//       ecosystem_status: 'ok' | 'unavailable',
//     }
//
// 安全契约:
//   * 不接受 session / role / user / oauth_* 任何字段
//   * 不接受 AI-derived 字段 ending_title / key_choices / outcome
//   * 不 echo DEV_FLAG / demo 字段
//   * 公共响应绝不出现 /api/dev/ /api/admin/ 引用
//
// This module is pure: no I/O, no env reads, no network.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ECOSYSTEM_SEARCH_DEFAULT_LIMIT = 8;
export const ECOSYSTEM_SEARCH_MAX_LIMIT = 20;
export const ECOSYSTEM_SEARCH_MIN_LIMIT = 1;

// Per-query cap so a profile with 50 queries cannot DOS the orchestrator.
export const ECOSYSTEM_SEARCH_MAX_QUERIES = 20;

const VALID_KINDS = Object.freeze(['web', 'knowledge', 'hot', 'mixed']);
export { VALID_KINDS };

/**
 * ClickUp 16.2 P1 fix (2026-09-07):
 *   AI-derived fields are FORBIDDEN at the seam. The search query
 *   MUST come from `StoryCommunityProfile.queries[]` — never from
 *   the AI-generated ending (ending_title / key_choices / outcome
 *   / character_outcomes). The handler rejects these so a future
 *   regression cannot silently re-introduce session-derived search
 *   queries.
 */
export const ECOSYSTEM_FORBIDDEN_KEYS = Object.freeze([
  'user_id', 'user_ref', 'userId', 'user',
  'oauth_subject', 'subject',
  'access_token', 'app_id', 'app_key', 'access_secret',
  'role_id', 'roleId', 'role_label', 'roleLabel', 'role',
  'session_id', 'sessionId', 'session_uuid', 'sessionUuid',
  'client_request_id', 'clientRequestId',
  'ip', 'ip_address',
  'device_id', 'deviceId',
  'cookie', 'authorization',
  // AI-derived fields (ClickUp 16.2 P1 fix).
  'ending_title',
  'key_choices',
  'outcome',
  'character_outcomes',
  'original_difference',
  'query', // legacy single-string query — replaced by search_queries[]
]);

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate one search-query record. Returns ok=false with code/field
 * on the first violation; the route layer surfaces the error to the
 * client. The validations mirror PROFILE_QUERY_KEYS so a profile row
 * that already passed assertCommunityProfileShape always passes here.
 *
 * @param {unknown} raw
 * @param {number} index
 * @returns {{ ok: true, value: { id: string, query: string, kind: string } }
 *           | { ok: false, code: string, message: string, field: string }}
 */
export function normaliseSearchQueryRecord(raw, index) {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      code: 'invalid_search_queries_item',
      message: `search_queries[${index}] must be an object`,
      field: `search_queries[${index}]`,
    };
  }
  const seen = Object.keys(raw);
  const allowed = ['id', 'query', 'kind'];
  for (const key of seen) {
    if (!allowed.includes(key)) {
      return {
        ok: false,
        code: 'invalid_search_queries_item',
        message: `search_queries[${index}] has unknown key '${key}' (allowed: id, query, kind)`,
        field: `search_queries[${index}].${key}`,
      };
    }
  }
  if (typeof raw.id !== 'string' || !raw.id) {
    return {
      ok: false,
      code: 'invalid_search_queries_id',
      message: `search_queries[${index}].id must be a non-empty string`,
      field: `search_queries[${index}].id`,
    };
  }
  if (typeof raw.query !== 'string' || !raw.query.trim()) {
    return {
      ok: false,
      code: 'empty_query',
      message: `search_queries[${index}].query must be a non-empty string`,
      field: `search_queries[${index}].query`,
    };
  }
  const query = raw.query.trim();
  if (query.length > 256) {
    return {
      ok: false,
      code: 'query_too_long',
      message: `search_queries[${index}].query exceeds 256 chars`,
      field: `search_queries[${index}].query`,
    };
  }
  if (!VALID_KINDS.includes(raw.kind)) {
    return {
      ok: false,
      code: 'invalid_search_queries_kind',
      message: `search_queries[${index}].kind must be one of ${VALID_KINDS.join('|')}`,
      field: `search_queries[${index}].kind`,
    };
  }
  return { ok: true, value: { id: raw.id, query, kind: raw.kind } };
}

/**
 * Normalise the inbound search request body.
 *
 * ClickUp 16.2 P1 fix (2026-09-07): the request now carries
 * `search_queries: [{id, query, kind}][]` — the SAME shape as
 * `StoryCommunityProfile.queries[]`. The handler enforces:
 *   * `search_queries` is required and non-empty
 *   * at most ECOSYSTEM_SEARCH_MAX_QUERIES items
 *   * AI-derived `query` (single-string) is FORBIDDEN — the seam
 *     rejects with code 'forbidden_field' so a regression cannot
 *     smuggle an AI-picked query back in
 *
 * Identity (story_uuid / story_version_uuid / community_profile_version)
 * is REQUIRED: missing identity is a 400 'missing_identity' so the
 * sentinel pair-key fallback that PR #19 used is removed.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, value: { search_queries, story_uuid, story_version_uuid, community_profile_version, limit } }
 *           | { ok: false, code: string, message: string, field?: string }}
 */
export function normaliseDiscussionsRequest(raw) {
  if (!isPlainObject(raw)) {
    return { ok: false, code: 'validation_failed', message: 'request body must be an object' };
  }
  for (const key of Object.keys(raw)) {
    if (ECOSYSTEM_FORBIDDEN_KEYS.includes(key)) {
      return { ok: false, code: 'forbidden_field', message: `field "${key}" is not allowed`, field: key };
    }
  }
  // search_queries is REQUIRED.
  if (!Array.isArray(raw.search_queries)) {
    return {
      ok: false,
      code: 'missing_search_queries',
      message: 'search_queries is required and must be a non-empty array',
      field: 'search_queries',
    };
  }
  if (raw.search_queries.length === 0) {
    return {
      ok: false,
      code: 'empty_search_queries',
      message: 'search_queries must contain at least one item',
      field: 'search_queries',
    };
  }
  if (raw.search_queries.length > ECOSYSTEM_SEARCH_MAX_QUERIES) {
    return {
      ok: false,
      code: 'too_many_search_queries',
      message: `search_queries must contain at most ${ECOSYSTEM_SEARCH_MAX_QUERIES} items`,
      field: 'search_queries',
    };
  }
  const normalisedQueries = [];
  const seenIds = new Set();
  for (let i = 0; i < raw.search_queries.length; i += 1) {
    const r = normaliseSearchQueryRecord(raw.search_queries[i], i);
    if (!r.ok) return r;
    if (seenIds.has(r.value.id)) {
      return {
        ok: false,
        code: 'duplicate_search_query_id',
        message: `search_queries[${i}].id '${r.value.id}' is duplicated`,
        field: `search_queries[${i}].id`,
      };
    }
    seenIds.add(r.value.id);
    normalisedQueries.push(r.value);
  }

  // Identity is REQUIRED (ClickUp 16.2 P1 fix: no more sentinel pair-key).
  if (!isUuid(raw.story_uuid)) {
    return {
      ok: false,
      code: 'missing_story_uuid',
      message: 'story_uuid is required and must be a UUID',
      field: 'story_uuid',
    };
  }
  if (!isUuid(raw.story_version_uuid)) {
    return {
      ok: false,
      code: 'missing_story_version_uuid',
      message: 'story_version_uuid is required and must be a UUID',
      field: 'story_version_uuid',
    };
  }
  if (typeof raw.community_profile_version !== 'string' || !raw.community_profile_version) {
    return {
      ok: false,
      code: 'missing_community_profile_version',
      message: 'community_profile_version is required and must be a non-empty string',
      field: 'community_profile_version',
    };
  }
  if (raw.community_profile_version.length > 128) {
    return {
      ok: false,
      code: 'community_profile_version_too_long',
      message: 'community_profile_version exceeds 128 chars',
      field: 'community_profile_version',
    };
  }

  let limit = ECOSYSTEM_SEARCH_DEFAULT_LIMIT;
  if (raw.limit !== undefined) {
    if (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit)) {
      return { ok: false, code: 'invalid_limit', message: 'limit must be an integer', field: 'limit' };
    }
    if (raw.limit < ECOSYSTEM_SEARCH_MIN_LIMIT || raw.limit > ECOSYSTEM_SEARCH_MAX_LIMIT) {
      return {
        ok: false,
        code: 'limit_out_of_range',
        message: `limit must be in [${ECOSYSTEM_SEARCH_MIN_LIMIT}, ${ECOSYSTEM_SEARCH_MAX_LIMIT}]`,
        field: 'limit',
      };
    }
    limit = raw.limit;
  }

  return {
    ok: true,
    value: {
      search_queries: normalisedQueries,
      story_uuid: raw.story_uuid,
      story_version_uuid: raw.story_version_uuid,
      community_profile_version: raw.community_profile_version,
      limit,
    },
  };
}

/**
 * Build a deterministic pair-key cache key for one
 * `(story_version_uuid, community_profile_version, query)` tuple.
 *
 * ClickUp 16.2 P1 fix (2026-09-07): the sentinel fallback
 * (`__no_story_version__` / `__no_profile__`) is REMOVED. Callers
 * MUST pass valid story_version_uuid + community_profile_version;
 * the handler validates them before this function is reached, so
 * the sentinel branch is unreachable in normal operation.
 *
 * @param {object} input
 * @param {string} input.query
 * @param {string} input.story_version_uuid
 * @param {string} input.community_profile_version
 * @param {string} [input.query_id]      Stable id within the profile.
 * @returns {string}
 */
export function buildEcosystemSearchCacheKey(input) {
  const versionPart = typeof input.story_version_uuid === 'string' && input.story_version_uuid
    ? input.story_version_uuid
    : '__no_story_version__';
  const profilePart = typeof input.community_profile_version === 'string' && input.community_profile_version
    ? input.community_profile_version
    : '__no_profile__';
  const idPart = typeof input.query_id === 'string' && input.query_id
    ? input.query_id
    : 'no-id';
  const queryHash = hashQuery(input.query || '');
  return `ecosystem:discuss:${versionPart}:${profilePart}:${idPart}:${queryHash}`;
}

function hashQuery(query) {
  // FNV-1a 32-bit — stable, no native deps, fits in URL-safe key.
  let h = 0x811c9dc5;
  for (let i = 0; i < query.length; i += 1) {
    h ^= query.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Validate the shape of a normalised discussion DTO. Used by both mock
 * and real adapters before handing results to the route layer.
 */
export function isDiscussionShape(value) {
  if (!isPlainObject(value)) return false;
  if (typeof value.thread_uuid !== 'string' || !value.thread_uuid) return false;
  if (typeof value.title !== 'string') return false;
  if (typeof value.snippet !== 'string') return false;
  if (typeof value.url !== 'string' || !value.url) return false;
  if (typeof value.score !== 'number' || !Number.isFinite(value.score)) return false;
  if (typeof value.source !== 'string' || !value.source) return false;
  return true;
}

/**
 * Trim a discussion list to a given limit, filtering out malformed
 * entries. Returns a NEW array — never mutates the input.
 */
export function clampDiscussions(list, limit) {
  const arr = Array.isArray(list) ? list : [];
  const out = [];
  for (const item of arr) {
    if (out.length >= limit) break;
    if (isDiscussionShape(item)) out.push(item);
  }
  return out;
}

/**
 * Stable, content-derived ranking: higher score first; ties broken by
 * url lexicographically. Mutates a clone, not the input.
 */
export function dedupeAndRankZhihuDiscussions(list) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const seen = new Set();
  const unique = [];
  for (const item of arr) {
    if (!isDiscussionShape(item)) continue;
    const k = item.url + '|' + item.thread_uuid;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(item);
  }
  unique.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.url < b.url) return -1;
    if (a.url > b.url) return 1;
    return 0;
  });
  return unique;
}
