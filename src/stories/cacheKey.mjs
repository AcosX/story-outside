// src/stories/cacheKey.mjs — story-level opening cache key derivation.
//
// Hard contract (ClickUp 04):
//   * The opening cache key is the SAME for every (user, role, session)
//     that reads a given (story, story_version) at a given generation profile.
//   * The key MUST be derived only from PUBLIC generation dimensions:
//        - story_uuid (or stable slug)
//        - story_version_uuid
//        - opening_key (default 'default')
//        - generation_profile.identifier
//        - generation_profile.rules_version
//        - generation_profile.locale (default 'zh-CN')
//        - generation_profile.variant (allow-listed public variant, default 'default')
//   * The key MUST NOT include any of:
//        - user_id / user_ref / oauth subject / ip / device
//        - role_id / role_label / role mood
//        - session_id / session_uuid / client_request_id
//        - timestamp / random nonce
//        - free-form tags or arbitrary profile/scope fields
//   * Any unknown or forbidden dimension MUST throw — we want the failure to
//     be loud, not silent, so a future regression cannot accidentally produce
//     a per-user cache that leaks cross-user data.
//
// The output is hex(SHA-256) of the canonical profile bytes. Length is 64.

import { createHash } from 'node:crypto';
import { canonicalJsonStringify } from './canonicalHash.mjs';

/**
 * @typedef {Object} GenerationProfile
 * @property {string} identifier       Free-form profile name, e.g. 'opening-default'.
 * @property {string} rules_version    Semantic rules version, e.g. 'opening-rules/1'.
 * @property {string} [locale]         Optional locale hint (e.g. 'zh-CN'). Defaults to 'zh-CN'.
 * @property {string} [variant]        Optional allow-listed PUBLIC variant. Defaults to
 *                                     'default'. Adding a variant is a deliberate public
 *                                     cache split, never a per-user/per-role split.
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
 * Public variant names. A variant is a deliberate, authored split of a
 * public cache (e.g. bundle edition), not a place to smuggle in identity.
 */
const PUBLIC_PROFILE_VARIANTS = new Set(['default', 'spoiler', 'bonus', 'bundle', 'demo']);

const ALLOWED_SCOPE_KEYS = new Set(['story_uuid', 'story_version_uuid', 'opening_key', 'profile']);
const ALLOWED_PROFILE_KEYS = new Set(['identifier', 'rules_version', 'locale', 'variant']);

/**
 * @param {Record<string, unknown>} obj
 * @param {string} label
 * @param {ReadonlySet<string>} allowed
 */
function assertKnownKeys(obj, label, allowed) {
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error(
        `cacheKey: forbidden dimension '${key}' in ${label}. ` +
          `The opening cache MUST stay story/version-scoped.`,
      );
    }
    if (!allowed.has(key)) {
      throw new Error(
        `cacheKey: unknown field '${key}' in ${label}. ` +
          `Only public, allow-listed generation dimensions may affect the opening cache.`,
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
  assertKnownKeys(profile, 'profile', ALLOWED_PROFILE_KEYS);
  assertNonEmptyString('profile.identifier', profile.identifier);
  assertNonEmptyString('profile.rules_version', profile.rules_version);
  const variant =
    typeof profile.variant === 'string' && profile.variant ? profile.variant : 'default';
  if (!PUBLIC_PROFILE_VARIANTS.has(variant)) {
    throw new Error(
      `cacheKey: profile.variant '${variant}' is not an allow-listed public variant. ` +
        `Allowed: ${[...PUBLIC_PROFILE_VARIANTS].sort().join(', ')}.`,
    );
  }
  return {
    identifier: profile.identifier,
    rules_version: profile.rules_version,
    locale: typeof profile.locale === 'string' && profile.locale ? profile.locale : 'zh-CN',
    variant,
  };
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
  assertKnownKeys(scope, 'scope', ALLOWED_SCOPE_KEYS);
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