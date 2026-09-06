// src/sessionToken.mjs — ClickUp 16.3 P1 v2 HMAC-signed session cookie.
//
// P1.v2 design (ChatGPT 2026-09-07 02:23 review of PR #22):
//
//   PR #22 stored `req.cookies.story_outside_session` as a bare UUID.
//   Any client could set the cookie to ANY UUID (e.g. guessing one
//   of the 4 mock fixture identities) and authenticate as that user.
//   This module replaces that with a server-signed token:
//
//     token = base64url(payload) + "." + base64url(HMAC-SHA256(secret, payload))
//
//     payload = base64url(JSON({ session_uuid, user_uuid, iat, exp }))
//
//   * Signing / verifying use `crypto.createHmac('sha256', secret)`
//     against `process.env.STORY_OUTSIDE_SESSION_SECRET`.
//   * The secret is loaded ONCE at boot from the environment; the
//     server refuses to start if it is missing or shorter than 16
//     bytes. There is no in-source fallback.
//   * The verification result has three outcomes — `valid` (returns
//     payload), `invalid_signature` (HMAC mismatch → 401
//     `invalid_session_token`), and `expired` (HMAC ok but `exp`
//     has passed → 401 `session_expired`). `iat` is informational;
//     future clock-skew tolerance could be layered on top.
//
// Wire contract:
//
//   * The token is opaque to clients — httpOnly + SameSite=Lax +
//     Secure (in production). The browser never sees the raw bytes
//     so JS code cannot forge or replay them.
//   * The token is bound to ONE `user_uuid` per `session_uuid`. The
//     route layer never reads the request body for identity; the
//     owner is always derived from the verified payload.
//
// Security notes (intentional, not bugs):
//
//   * No "kid" rotation hook — rotating the secret invalidates every
//     outstanding cookie in one operation. The route layer maps that
//     to a 401 and the browser gets a fresh token on the next
//     `/api/sessions` POST. Acceptable for the demo catalog.
//   * No replay protection inside a 30-day window. The cookie is
//     httpOnly so XSS cannot extract it; the same-origin Lax policy
//     blocks cross-origin CSRF; the binding to a `user_uuid` means
//     a stolen cookie authenticates only as that user. A real
//     deployment with sensitive data would add nonce / jti.

import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

const COOKIE_NAME = 'story_outside_session';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
const TOKEN_TTL_SECONDS = COOKIE_MAX_AGE_SECONDS;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let cachedSecretBytes = null;
let cachedSecretSource = null;

function loadSecret() {
  if (cachedSecretBytes !== null) {
    return { bytes: cachedSecretBytes, source: cachedSecretSource };
  }
  const raw = process.env.STORY_OUTSIDE_SESSION_SECRET;
  if (typeof raw !== 'string' || raw.length < 16) {
    throw new Error(
      'sessionToken: STORY_OUTSIDE_SESSION_SECRET must be set to a string >= 16 chars ' +
      '(got ' + (raw === undefined ? 'undefined' : 'string of length ' + raw.length) + ')',
    );
  }
  cachedSecretBytes = Buffer.from(raw, 'utf8');
  cachedSecretSource = 'env:STORY_OUTSIDE_SESSION_SECRET';
  return { bytes: cachedSecretBytes, source: cachedSecretSource };
}

/**
 * Reset the cached secret. Test-only: lets a test toggle the env var
 * and re-load without restarting the process.
 */
export function _resetSessionSecretCache() {
  cachedSecretBytes = null;
  cachedSecretSource = null;
}

function base64UrlEncode(buffer) {
  /** @type {Buffer | string} */
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), 'utf8');
  return buf.toString('base64url');
}

function base64UrlDecodeToBuffer(str) {
  if (typeof str !== 'string' || !str) return null;
  try {
    return Buffer.from(str, 'base64url');
  } catch {
    return null;
  }
}

/**
 * Sign a session token.
 *
 * @param {{ session_uuid: string, user_uuid: string }} input
 * @returns {string} the opaque token (base64url(payload) + "." + base64url(sig))
 */
export function signSessionToken({ session_uuid, user_uuid }) {
  if (!UUID_PATTERN.test(session_uuid)) {
    throw new Error('sessionToken.signSessionToken: session_uuid must be a UUID');
  }
  if (!UUID_PATTERN.test(user_uuid)) {
    throw new Error('sessionToken.signSessionToken: user_uuid must be a UUID');
  }
  const { bytes: secret } = loadSecret();
  const nowSeconds = Math.floor(Date.now() / 1000);
  /** @type {{ session_uuid: string, user_uuid: string, iat: number, exp: number }} */
  const payload = {
    session_uuid,
    user_uuid,
    iat: nowSeconds,
    exp: nowSeconds + TOKEN_TTL_SECONDS,
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(payloadB64).digest();
  const sigB64 = base64UrlEncode(sig);
  return `${payloadB64}.${sigB64}`;
}

/**
 * Verify a session token. Returns `{ ok: true, payload }` on success,
 * `{ ok: false, reason: 'invalid_session_token' | 'session_expired' }` on
 * failure. The reason string is the wire-level `error` field for the
 * HTTP layer.
 *
 * @param {string} token
 * @returns {{ ok: true, payload: { session_uuid: string, user_uuid: string, iat: number, exp: number } } | { ok: false, reason: 'invalid_session_token' | 'session_expired' }}
 */
export function verifySessionToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'invalid_session_token' };
  }
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) {
    return { ok: false, reason: 'invalid_session_token' };
  }
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  const expectedSig = base64UrlDecodeToBuffer(sigB64);
  const payloadBuf = base64UrlDecodeToBuffer(payloadB64);
  if (!expectedSig || !payloadBuf) {
    return { ok: false, reason: 'invalid_session_token' };
  }
  const { bytes: secret } = loadSecret();
  const computed = createHmac('sha256', secret).update(payloadB64).digest();
  // timingSafeEqual requires equal-length buffers; pad / compare to
  // keep the verification branch constant-time.
  const sigLen = expectedSig.length;
  const computedLen = computed.length;
  if (sigLen !== computedLen) {
    return { ok: false, reason: 'invalid_session_token' };
  }
  if (!timingSafeEqual(expectedSig, computed)) {
    return { ok: false, reason: 'invalid_session_token' };
  }
  /** @type {unknown} */
  let payload;
  try {
    payload = JSON.parse(payloadBuf.toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid_session_token' };
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, reason: 'invalid_session_token' };
  }
  /** @type {{ session_uuid?: unknown, user_uuid?: unknown, iat?: unknown, exp?: unknown }} */
  const p = /** @type {any} */ (payload);
  if (typeof p.session_uuid !== 'string' || !UUID_PATTERN.test(p.session_uuid)) {
    return { ok: false, reason: 'invalid_session_token' };
  }
  if (typeof p.user_uuid !== 'string' || !UUID_PATTERN.test(p.user_uuid)) {
    return { ok: false, reason: 'invalid_session_token' };
  }
  if (typeof p.exp !== 'number' || !Number.isFinite(p.exp)) {
    return { ok: false, reason: 'invalid_session_token' };
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (p.exp <= nowSeconds) {
    return { ok: false, reason: 'session_expired' };
  }
  return {
    ok: true,
    payload: {
      session_uuid: p.session_uuid,
      user_uuid: p.user_uuid,
      iat: typeof p.iat === 'number' ? p.iat : nowSeconds,
      exp: p.exp,
    },
  };
}

/**
 * Build the `Set-Cookie` header value for the session cookie.
 * httpOnly + SameSite=Lax + Path=/ + Max-Age=30d. `Secure` is
 * intentionally controllable via the `secure` argument so the local
 * test suite (plain HTTP on 127.0.0.1) can verify the contract
 * without TLS; production callers pass `secure: true`.
 *
 * @param {string} token
 * @param {{ secure?: boolean }} [opts]
 * @returns {string}
 */
export function buildSessionCookie(token, opts = {}) {
  const secure = opts.secure ? '; Secure' : '';
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}${secure}`;
}

/**
 * Build the `Set-Cookie` header value that clears the cookie (used
 * on /api/sessions DELETE / logout paths).
 */
export function buildClearSessionCookie(opts = {}) {
  const secure = opts.secure ? '; Secure' : '';
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

/**
 * Parse a `Cookie` header into a `{ name: value }` map. Node has no
 * built-in `req.cookies` API in the core `http` module so the route
 * layer hands us the raw header.
 *
 * @param {string | undefined | null} headerValue
 * @returns {Record<string, string>}
 */
export function parseCookieHeader(headerValue) {
  /** @type {Record<string, string>} */
  const out = {};
  if (typeof headerValue !== 'string' || !headerValue) return out;
  for (const part of headerValue.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function getSessionCookieName() {
  return COOKIE_NAME;
}

/**
 * Mint a fresh `user_uuid`. Used by /api/sessions when no cookie is
 * present so the cookie can be tied to a brand-new identity without
 * trusting the client.
 */
export function mintUserUuid() {
  return randomUUID();
}