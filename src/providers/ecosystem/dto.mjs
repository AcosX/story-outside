// src/providers/ecosystem/dto.mjs — ClickUp 16.2 P1.v2 知乎搜索 DTO 与契约守卫。
//
// 公共契约（POST /v1/ecosystem/discussions）:
//
//   request:
//     {
//       story_uuid: string,                     // REQUIRED, UUID
//       story_version_uuid: string,             // REQUIRED, UUID
//       community_profile_version: string,      // REQUIRED, server resolves canonical profile
//       limit?: number,                         // 1..20, default 8 (per-query)
//     }
//
//   response:
//     {
//       results: [                              // aggregated per canonical profile.queries[i]
//         {
//           id: string,                         // echoes profile.queries[i].id
//           query: string,                      // echoes profile.queries[i].query
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
// 安全契约 (ClickUp 16.2 P1.v2 — 2026-09-07 ChatGPT review):
//   * **不**接受 body.search_queries (handler must take identity only and
//     resolve canonical queries server-side). 拒绝 → 400 'forbidden_field'.
//   * **不**接受任何 AI-derived 字段 (ending_title / key_choices /
//     outcome / character_outcomes). 拒绝 → 400 'forbidden_field'.
//   * **不**接受任何身份偷渡字段 (user_id / role / oauth_* / ...).
//   * **不** echo DEV_FLAG / demo 字段。
//   * 公共响应绝不出现 /api/dev/ /api/admin/ 引用。
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
 * ClickUp 16.2 P1.v2 fix (2026-09-07):
 *   The handler MUST stay server-authoritative. The body MUST NOT
 *   carry any client-picked search query — every one of these fields
 *   is a regression vector that lets a future caller smuggle a
 *   AI-picked / session-derived query back in. The seam rejects
 *   them with `forbidden_field` so a regression cannot silently
 *   re-introduce client-controlled queries.
 *
 *   Notes:
 *   * `search_queries` / `query` (singular): client-controlled query
 *     list/string. The whole point of P1.v2 is that the client does
 *     NOT supply queries.
 *   * AI-derived fields: `ending_title` / `key_choices` / `outcome` /
 *     `character_outcomes`. These were forbidden already in P1 fix;
 *     kept here so a regression cannot smuggle them either.
 *   * Identity-leakage fields: classic user/role/session leak vector
 *     even on the read side.
 */
export const ECOSYSTEM_FORBIDDEN_KEYS = Object.freeze([
  // Client-controlled queries (the regression P1.v2 closes).
  'search_queries',
  'query',
  'queries',
  // AI-derived fields (kept from P1; still forbidden).
  'ending_title',
  'key_choices',
  'outcome',
  'character_outcomes',
  'original_difference',
  // Identity / leakage (defence in depth on top of the public seam).
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

/**
 * ClickUp 16.2 P1.v2 fix (2026-09-07):
 *   The handler is allowed ONLY these top-level body keys. The body
 *   must be a plain object; any other key — including ones we have
 *   not yet enumerated — is a regression vector. The handler refuses
 *   unknown keys with `forbidden_field` so a future caller cannot
 *   silently widen the surface.
 */
export const ECOSYSTEM_ALLOWED_BODY_KEYS = Object.freeze([
  'story_uuid',
  'story_version_uuid',
  'community_profile_version',
  'limit',
]);

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate one canonical search-query record (the shape we accept
 * inside `StoryCommunityProfile.queries[]`). The validations mirror
 * `PROFILE_QUERY_KEYS` so a profile row that already passed
 * `assertCommunityProfileShape` always passes here.
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
 * ClickUp 16.2 P1.v2 fix (2026-09-07):
 *   Normalise the inbound identity-only body for
 *   POST /v1/ecosystem/discussions.
 *
 *   Hard contract:
 *     * body MUST be a plain object.
 *     * body MUST NOT contain any field outside
 *       `ECOSYSTEM_ALLOWED_BODY_KEYS` (forbidden_field on unknown).
 *     * `story_uuid` + `story_version_uuid` MUST be UUIDs.
 *     * `community_profile_version` MUST be a non-empty string
 *       (the server resolves the canonical profile; the client only
 *       proves it knows the canonical version string).
 *     * `limit` is optional integer in
 *       `[ECOSYSTEM_SEARCH_MIN_LIMIT, ECOSYSTEM_SEARCH_MAX_LIMIT]`.
 *
 *   Returns a discriminated union; the route layer maps each code to
 *   a 400. The orchestrator (search.mjs) receives ONLY the resolved
 *   identity triple + limit; it does NOT receive client-supplied
 *   search_queries (there are none — that is the whole point of v2).
 *
 * @param {unknown} raw
 * @returns {{ ok: true, value: { story_uuid: string, story_version_uuid: string, community_profile_version: string, limit: number } }
 *           | { ok: false, code: string, message: string, field?: string }}
 */
export function normaliseDiscussionsRequest(raw) {
  if (!isPlainObject(raw)) {
    return { ok: false, code: 'validation_failed', message: 'request body must be an object' };
  }
  // 1. Forbidden keys win first (defence in depth on top of the
  //    allowlist). If a caller passes a known-regression field, we
  //    want the specific code, not a generic `unknown_field`.
  for (const key of Object.keys(raw)) {
    if (ECOSYSTEM_FORBIDDEN_KEYS.includes(key)) {
      return { ok: false, code: 'forbidden_field', message: `field "${key}" is not allowed`, field: key };
    }
  }
  // 2. Allowlist pass — anything we have not explicitly blessed is
  //    rejected. This is the v2 seal: even an unknown non-dangerous
  //    key fails closed so a future caller cannot widen the surface.
  for (const key of Object.keys(raw)) {
    if (!ECOSYSTEM_ALLOWED_BODY_KEYS.includes(key)) {
      return { ok: false, code: 'forbidden_field', message: `field "${key}" is not allowed`, field: key };
    }
  }
  // 3. Identity triple — REQUIRED.
  if (!isUuid(raw.story_uuid)) {
    return {
      ok: false,
      code: 'community_profile_not_found',
      message: 'story_uuid is required and must be a UUID',
      field: 'story_uuid',
    };
  }
  if (!isUuid(raw.story_version_uuid)) {
    return {
      ok: false,
      code: 'community_profile_not_found',
      message: 'story_version_uuid is required and must be a UUID',
      field: 'story_version_uuid',
    };
  }
  if (typeof raw.community_profile_version !== 'string' || !raw.community_profile_version) {
    return {
      ok: false,
      code: 'community_profile_version_mismatch',
      message: 'community_profile_version is required and must be a non-empty string',
      field: 'community_profile_version',
    };
  }
  if (raw.community_profile_version.length > 128) {
    return {
      ok: false,
      code: 'community_profile_version_mismatch',
      message: 'community_profile_version exceeds 128 chars',
      field: 'community_profile_version',
    };
  }
  // 4. limit — optional integer in range.
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
      story_uuid: raw.story_uuid,
      story_version_uuid: raw.story_version_uuid,
      community_profile_version: raw.community_profile_version,
      limit,
    },
  };
}

/**
 * Validate a canonical `StoryCommunityProfile.queries[]` for the
 * orchestrator. The orchestrator takes the resolved profile and
 * walks `profile.queries[]` to build per-query results.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, value: { id: string, query: string, kind: string }[] }
 *           | { ok: false, code: string, message: string, field?: string }}
 */
export function normaliseCanonicalSearchQueries(raw) {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      code: 'community_profile_not_found',
      message: 'canonical profile has no queries[]',
      field: 'profile.queries',
    };
  }
  if (raw.length === 0) {
    return {
      ok: false,
      code: 'community_profile_not_found',
      message: 'canonical profile.queries[] is empty',
      field: 'profile.queries',
    };
  }
  if (raw.length > ECOSYSTEM_SEARCH_MAX_QUERIES) {
    return {
      ok: false,
      code: 'community_profile_not_found',
      message: `canonical profile.queries[] exceeds ${ECOSYSTEM_SEARCH_MAX_QUERIES} items`,
      field: 'profile.queries',
    };
  }
  const out = [];
  const seenIds = new Set();
  for (let i = 0; i < raw.length; i += 1) {
    const r = normaliseSearchQueryRecord(raw[i], i);
    if (!r.ok) return r;
    if (seenIds.has(r.value.id)) {
      return {
        ok: false,
        code: 'community_profile_not_found',
        message: `profile.queries[${i}].id '${r.value.id}' is duplicated`,
        field: `profile.queries[${i}].id`,
      };
    }
    seenIds.add(r.value.id);
    out.push(r.value);
  }
  return { ok: true, value: out };
}

/**
 * Build a deterministic pair-key cache key for one
 * `(story_version_uuid, community_profile_version, query_id, query)`.
 *
 * ClickUp 16.2 P1.v2 fix (2026-09-07): identity is ALWAYS resolved
 * by the handler before this function is called, so the sentinel
 * fallback is gone — keys are always anchored to a real
 * story_version_uuid + community_profile_version pair.
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
 * Build a stable 32-bit FNV-style hash of a string. Used for
 * deterministic scoring + fixture routing in the mock.
 */
export function stableStringHash(input) {
  let h = 0x811c9dc5;
  const s = typeof input === 'string' ? input : '';
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Defensive shape check for a DiscussionDTO. We accept both the
 * mock and the real (zhihu api v1) shapes.
 */
export function isDiscussionShape(value) {
  if (!isPlainObject(value)) return false;
  if (typeof value.url !== 'string' || !value.url) return false;
  if (typeof value.title !== 'string' || !value.title) return false;
  // id may be a string or a number (real adapter uses int64); allow both.
  if (!(typeof value.id === 'string' || typeof value.id === 'number')) return false;
  return true;
}

/**
 * Cap a discussions array to the per-query `limit`. Defensive only —
 * the adapter is supposed to cap internally.
 */
export function clampDiscussions(list, limit) {
  if (!Array.isArray(list)) return [];
  const cap = Number.isInteger(limit) && limit > 0 ? limit : ECOSYSTEM_SEARCH_DEFAULT_LIMIT;
  return list.slice(0, cap);
}

/**
 * Deduplicate + rank discussions across multiple sources. Real
 * adapter may emit more than one source per query; this collapses to
 * a stable, sorted, deduped view.
 */
export function dedupeAndRankZhihuDiscussions(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Map();
  for (const d of list) {
    if (!isDiscussionShape(d)) continue;
    const key = `${d.url}`;
    const cur = seen.get(key);
    if (!cur) {
      seen.set(key, d);
      continue;
    }
    // Prefer the higher score; break ties by url.
    const curScore = Number.isFinite(cur.score) ? cur.score : 0;
    const nextScore = Number.isFinite(d.score) ? d.score : 0;
    if (nextScore > curScore) seen.set(key, d);
  }
  const out = Array.from(seen.values());
  out.sort((a, b) => {
    const sa = Number.isFinite(a.score) ? a.score : 0;
    const sb = Number.isFinite(b.score) ? b.score : 0;
    if (sa !== sb) return sb - sa;
    return String(a.url).localeCompare(String(b.url));
  });
  return out;
}
