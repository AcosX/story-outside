// src/stories/cacheKey.mjs — story-level opening cache key derivation.
//
// Hard contract (ClickUp 04):
//   * The opening cache key is the SAME for every (user, role, session)
//     that reads a given (story, story_version) at a given generation profile.
//   * The key MUST be derived only from:
//        - story_uuid (or stable slug)
//        - story_version_uuid
//        - opening_key (default 'default')
//        - generation_profile.identifier
//        - generation_profile.rules_version
//   * The key MUST NOT include any of:
//        - user_id / user_ref / oauth subject / ip / device
//        - role_id / role_label / role mood
//        - session_id / session_uuid / client_request_id
//        - timestamp / random nonce
//   * Any attempt to pass a forbidden dimension into the key derivation MUST
//     throw — we want the failure to be loud, not silent, so a future
//     regression that tries to add user-scoped caching cannot accidentally
//     produce a per-user cache that leaks cross-user data.
//
// The output is hex(SHA-256) of the canonical profile bytes. Length is 64.

import { createHash } from 'node:crypto';
import { canonicalJsonStringify } from './canonicalHash.mjs';

/**
 * @typedef {Object} GenerationProfile
 * @property {string} identifier       Free-form profile name, e.g. 'opening-default'.
 * @property {string} rules_version    Semantic rules version, e.g. 'opening-rules/1'.
 * @property {string} [locale]         Optional locale hint (e.g. 'zh-CN'). Defaults to 'zh-CN'.
 * @property {Record<string, string>} [tags] Optional tag set; included in the hash to
 *                                          allow side-by-band experiments that should NOT
 *                                          share a cache (e.g. 'narrator=internal').
 */

const FORBIDDEN_KEYS = new Set([
  'user_id',
  'user_ref',
  'userId',
  'user',
  'oauth_subject',
  'subject',
  'access_token',
  'app_id',
  'app_key',
  'access_secret',
  'role_id',
  'roleId',
  'role_label',
  'roleLabel',
  'role',
  'session_id',
  'sessionId',
  'session_uuid',
  'sessionUuid',
  'client_request_id',
  'clientRequestId',
  'ip',
  'ip_address',
  'device',
  'device_id',
  'deviceId',
  'timestamp',
  'ts',
  'nonce',
  'random',
]);

/**
 * @param {Record<string, unknown>} obj
 * @param {string} label
 */
function assertNoForbiddenKeys(obj, label) {
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error(
        `cacheKey: forbidden dimension '${key}' in ${label}. ` +
          `The opening cache MUST stay story/version-scoped.`,
      );
    }
  }
}

/**
 * @param {string} label
 * @param {string} value
 */
function assertNonEmptyString(label, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`cacheKey: ${label} must be a non-empty string`);
  }
}

/**
 * @param {GenerationProfile} profile
 * @returns {GenerationProfile}
 */
function normaliseProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    throw new Error('cacheKey: profile must be an object');
  }
  assertNonEmptyString('profile.identifier', profile.identifier);
  assertNonEmptyString('profile.rules_version', profile.rules_version);
  const out = {
    identifier: profile.identifier,
    rules_version: profile.rules_version,
    locale: typeof profile.locale === 'string' && profile.locale ? profile.locale : 'zh-CN',
  };
  if (profile.tags && typeof profile.tags === 'object') {
    assertNoForbiddenKeys(profile.tags, 'profile.tags');
    /** @type {Record<string, string>} */
    const tags = {};
    for (const k of Object.keys(profile.tags).sort()) {
      tags[k] = String(profile.tags[k]);
    }
    out.tags = tags;
  }
  return out;
}

/**
 * Derive the story-level opening cache key.
 *
 * @param {object} scope
 * @param {string} scope.story_uuid            Stable story UUID (NOT user-bound).
 * @param {string} scope.story_version_uuid   Stable version UUID (NOT user-bound).
 * @param {string} [scope.opening_key]        Logical opening key. Default 'default'.
 * @param {GenerationProfile} scope.profile
 * @returns {string} 64-char hex SHA-256.
 */
export function deriveOpeningCacheKey(scope) {
  if (!scope || typeof scope !== 'object') {
    throw new Error('cacheKey: scope must be an object');
  }
  assertNonEmptyString('scope.story_uuid', scope.story_uuid);
  assertNonEmptyString('scope.story_version_uuid', scope.story_version_uuid);
  assertNoForbiddenKeys(scope, 'scope');
  const profile = normaliseProfile(scope.profile);
  const opening_key =
    typeof scope.opening_key === 'string' && scope.opening_key
      ? scope.opening_key
      : 'default';
  /** @type {{ story_uuid: string, story_version_uuid: string, opening_key: string, profile: GenerationProfile }} */
  const canonical = {
    story_uuid: scope.story_uuid,
    story_version_uuid: scope.story_version_uuid,
    opening_key,
    profile,
  };
  const json = canonicalJsonStringify(canonical);
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

/**
 * Exposed for tests: the forbidden key set is part of the public contract.
 * Adding a key here is a deliberate breaking change.
 * @returns {ReadonlySet<string>}
 */
export function _forbiddenCacheKeyDimensions() {
  return FORBIDDEN_KEYS;
}