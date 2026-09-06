// src/ecosystem/following/fixtures.mjs — pre-baked mock identities for the
// follow/relationship surface (ClickUp 16.3 P1 rebuild on `44343b2`).
//
// Hard rules:
//   * Identities here are entirely FAKE. They live in the demo catalog only
//     and have NO correspondence to any real-user UUID, real OAuth subject,
//     or real browser fingerprint.
//   * Mock identities are NEVER read from request headers. The auth seam
//     is the `story_outside_session` cookie (set by `/api/sessions`
//     bootstrap), whose value IS the user_uuid. This module only
//     validates the cookie value is well-formed.
//   * This module does NOT read any env var that looks like a credential.
//   * This module does NOT call any external API.

/**
 * @typedef {Object} MockIdentity
 * @property {string} user_uuid          Stable UUID, used as the auth principal.
 * @property {string} handle             Stable, human-readable handle.
 * @property {string} display_name       Display name shown in the social panel.
 * @property {string} bio                One-line bio.
 * @property {string} avatar_seed        Stable seed for the avatar glyph.
 */

/**
 * Pre-baked mock identities. The handles are deliberately mundane so the
 * test suite can pin them byte-for-byte. The `user_uuid` values are the
 * keys of the relationship repository, NOT the session-internal `user_ref`
 * — those are two different identifiers by design.
 *
 * @type {Readonly<Record<string, MockIdentity>>}
 */
export const MOCK_FOLLOWING_FIXTURE_USERS = Object.freeze({
  '11111111-1111-4111-8111-aaaaaaaaaaaa': Object.freeze({
    user_uuid: '11111111-1111-4111-8111-aaaaaaaaaaaa',
    handle: 'night-reader',
    display_name: '夜读人',
    bio: '凌晨读短篇的人。',
    avatar_seed: 'night-reader',
  }),
  '11111111-1111-4111-8111-bbbbbbbbbbbb': Object.freeze({
    user_uuid: '11111111-1111-4111-8111-bbbbbbbbbbbb',
    handle: 'cafe-wanderer',
    display_name: '咖啡馆漫游',
    bio: '凌晨常驻咖啡馆。',
    avatar_seed: 'cafe-wanderer',
  }),
  '11111111-1111-4111-8111-cccccccccccc': Object.freeze({
    user_uuid: '11111111-1111-4111-8111-cccccccccccc',
    handle: 'clerk-by-night',
    display_name: '夜班店员',
    bio: '在便利店货架尽头等下一位夜行人。',
    avatar_seed: 'clerk-by-night',
  }),
  '11111111-1111-4111-8111-dddddddddddd': Object.freeze({
    user_uuid: '11111111-1111-4111-8111-dddddddddddd',
    handle: 'wanderer',
    display_name: '夜行人',
    bio: '选了一罐不属于今天的饮料。',
    avatar_seed: 'wanderer',
  }),
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Convenience: get an identity by UUID. Returns `null` (does NOT throw) so
 * the auth middleware can answer 401 cleanly for unknown principals.
 *
 * @param {string} user_uuid
 * @returns {MockIdentity | null}
 */
export function getMockFollowingIdentity(user_uuid) {
  if (typeof user_uuid !== 'string' || !user_uuid) return null;
  if (!UUID_PATTERN.test(user_uuid)) return null;
  return MOCK_FOLLOWING_FIXTURE_USERS[user_uuid] || null;
}

/**
 * Convenience: list every mock identity. The order is insertion-order so
 * test assertions can pin a stable index.
 *
 * @returns {MockIdentity[]}
 */
export function listMockFollowingIdentities() {
  return Object.freeze(
    Object.values(MOCK_FOLLOWING_FIXTURE_USERS).map((id) => Object.freeze({ ...id })),
  );
}

/**
 * Validate that a string is a well-formed UUID. Used by the auth seam
 * to reject malformed cookie values without consulting the fixture
 * table.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidUserUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}