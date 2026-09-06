// src/auth/currentUserProvider.mjs
//
// ClickUp 16.3 P1 v1-2 — OAuth-pending assumption rebuild.
//
// The product has not yet wired a real OAuth flow. Per the主人的
// 2026-09-07 04:21 巡检 ruling (rebuilding v1 on PR #22 head
// `10abc0a`, NOT cherry-picking v2 HMAC), the auth seam is a single
// fixed function: `currentUserProvider(req)`. Every request resolves
// to the SAME canonical owner. There is no cookie, no header, no body
// field, and no per-browser random user_uuid.
//
// This is an OAuth-pending placeholder. When the real OAuth flow
// lands, this file is the only one that needs to change — the route
// layer already routes through `currentUserProvider(req)` and never
// touches the cookie / header / body for identity.
//
// Contract (locked by tests/clickup16-3-p1-auth.test.mjs):
//
//   * `currentUserProvider(req)` always returns OAUTH_PENDING_USER.
//   * The returned object has shape
//       { user_uuid, display_name, auth_source }
//     where `auth_source === 'oauth_pending'`.
//   * The `req` argument is accepted so a future real implementation
//     can read OAuth headers / cookies without changing every callsite;
//     in this build we deliberately ignore it.
//   * There is NO other path to a `user_uuid` in the codebase: no
//     `X-Mock-User-uuid`, no HMAC, no cookie minting, no random UUID
//     in the browser.

/**
 * Canonical owner placeholder used until OAuth is wired. The
 * `user_uuid` is a stable UUIDv4-shaped sentinel so the bootstrap /
 * share / follow routes can still talk about owners without
 * pretending to authenticate a real player.
 *
 * @type {{ user_uuid: string, display_name: string, auth_source: string }}
 */
export const OAUTH_PENDING_USER = Object.freeze({
  user_uuid: '00000000-0000-4000-8000-00000000cafe',
  display_name: '待接入用户 (OAuth pending)',
  auth_source: 'oauth_pending',
});

/**
 * Resolve the caller's identity. In the OAuth-pending build this
 * always returns OAUTH_PENDING_USER. The `req` parameter is reserved
 * for the future real implementation — a real OAuth provider would
 * read the bearer token / signed cookie from it.
 *
 * The function is intentionally synchronous and pure. There is no
 * await, no randomUUID, no Date.now, no I/O — every request resolves
 * to the same identity, and the test suite can pin it deterministically.
 *
 * @param {import('node:http').IncomingMessage | null | undefined} _req
 * @returns {{ user_uuid: string, display_name: string, auth_source: string }}
 */
export function currentUserProvider(_req) {
  // Returning the frozen object directly is safe — callers must
  // treat the value as read-only. The route layer only reads the
  // three fields above.
  return OAUTH_PENDING_USER;
}
