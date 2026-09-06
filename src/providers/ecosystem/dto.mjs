// src/providers/ecosystem/dto.mjs — ClickUp 16.2 知乎搜索 DTO 与契约守卫。
//
// 公共契约（POST /v1/ecosystem/discussions）:
//   request:
//     {
//       query: string,                        // required, non-empty
//       story_uuid?: string,                  // optional UUID
//       story_version_uuid?: string,          // optional UUID, 用于 cache pair-key
//       community_profile_version?: string,   // optional, 用于 cache pair-key
//       limit?: number,                       // 1..20, default 8
//     }
//   response:
//     {
//       discussions: [
//         {
//           thread_uuid: string,              // server-assigned
//           title: string,
//           snippet: string,
//           url: string,
//           score: number,
//           source: 'zhihu' | 'mock' | 'cache',
//         },
//       ],
//       provenance: 'live' | 'cache' | 'mock',
//       cached: boolean,
//       ecosystem_status?: 'ok' | 'unavailable',
//     }
//
// 安全契约:
//   * 不接受 session / role / user / oauth_* 任何字段
//   * 不 echo DEV_FLAG / demo 字段
//   * 公共响应绝不出现 /api/dev/ /api/admin/ 引用
//
// This module is pure: no I/O, no env reads, no network.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ECOSYSTEM_SEARCH_DEFAULT_LIMIT = 8;
export const ECOSYSTEM_SEARCH_MAX_LIMIT = 20;
export const ECOSYSTEM_SEARCH_MIN_LIMIT = 1;

/**
 * Forbidden keys that would convert the search endpoint into a
 * session-scoped query. Reject them at the seam.
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
]);

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalise the inbound search request body. Returns either:
 *   { ok: true, value: { query, story_uuid?, story_version_uuid?, community_profile_version?, limit } }
 *   { ok: false, code, message, field? }
 *
 * Never echoes the request body — returns only the cleaned subset.
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
  const query = typeof raw.query === 'string' ? raw.query.trim() : '';
  if (!query) {
    return { ok: false, code: 'empty_query', message: 'query is required and must be a non-empty string', field: 'query' };
  }
  if (query.length > 256) {
    return { ok: false, code: 'query_too_long', message: 'query exceeds 256 chars', field: 'query' };
  }
  const out = { query };
  if (raw.story_uuid !== undefined) {
    if (!isUuid(raw.story_uuid)) {
      return { ok: false, code: 'invalid_story_uuid', message: 'story_uuid must be a UUID', field: 'story_uuid' };
    }
    out.story_uuid = raw.story_uuid;
  }
  if (raw.story_version_uuid !== undefined) {
    if (!isUuid(raw.story_version_uuid)) {
      return { ok: false, code: 'invalid_story_version_uuid', message: 'story_version_uuid must be a UUID', field: 'story_version_uuid' };
    }
    out.story_version_uuid = raw.story_version_uuid;
  }
  if (raw.community_profile_version !== undefined) {
    if (typeof raw.community_profile_version !== 'string' || !raw.community_profile_version) {
      return { ok: false, code: 'invalid_community_profile_version', message: 'community_profile_version must be a non-empty string', field: 'community_profile_version' };
    }
    if (raw.community_profile_version.length > 128) {
      return { ok: false, code: 'community_profile_version_too_long', message: 'community_profile_version exceeds 128 chars', field: 'community_profile_version' };
    }
    out.community_profile_version = raw.community_profile_version;
  }
  if (raw.limit !== undefined) {
    if (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit)) {
      return { ok: false, code: 'invalid_limit', message: 'limit must be an integer', field: 'limit' };
    }
    if (raw.limit < ECOSYSTEM_SEARCH_MIN_LIMIT || raw.limit > ECOSYSTEM_SEARCH_MAX_LIMIT) {
      return { ok: false, code: 'limit_out_of_range', message: `limit must be in [${ECOSYSTEM_SEARCH_MIN_LIMIT}, ${ECOSYSTEM_SEARCH_MAX_LIMIT}]`, field: 'limit' };
    }
    out.limit = raw.limit;
  } else {
    out.limit = ECOSYSTEM_SEARCH_DEFAULT_LIMIT;
  }
  return { ok: true, value: out };
}

/**
 * Build a deterministic pair-key cache key for (story_version_uuid,
 * community_profile_version, query). The pair-key is mandatory: a
 * single global entry would silently cache across story_versions and
 * profile versions, leaking story-specific search results to other
 * stories' sessions.
 *
 * Falls back to a sentinel pair when story_version_uuid /
 * community_profile_version are missing — the cache is then scoped to
 * (sentinel, sentinel, query_hash) so it can never collide with a
 * legitimate pair row.
 */
export function buildEcosystemSearchCacheKey(input) {
  const versionPart = input.story_version_uuid || '__no_story_version__';
  const profilePart = input.community_profile_version || '__no_profile__';
  const queryHash = hashQuery(input.query);
  return `ecosystem:discuss:${versionPart}:${profilePart}:${queryHash}`;
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
