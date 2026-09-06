// tests/clickup16-3-p1-auth.test.mjs — ClickUp 16.3 P1 rebuild on
// `44343b2`.
//
// What this test verifies (ChatGPT 2026-09-07 re-review of PR #21):
//
//   P1.1 — auth is NOT a request header.
//     * No request to /v1/ecosystem/* can succeed without a
//       `story_outside_session` cookie carrying a valid user_uuid.
//     * Missing cookie → 401.
//     * Malformed cookie (non-UUID) → 401.
//     * The cookie value IS the user_uuid — there is no DB lookup,
//       no header fallback, no body-derived identity.
//
//   P1.2 — share binds to the canonical session owner.
//     * `shareSession` MUST reject any caller whose cookie-derived
//       identity does NOT match the canonical owner persisted by
//       `sessionService.createSession`.
//     * The handler MUST refuse any body that carries
//       `user_ref` / `user_uuid` / `identity` (or `user_id`,
//       `subject`, `actor`, `owner`).
//     * Knowing a session_uuid but not owning the session cookie
//       for that session is enough to fail with 401 (cookie-less)
//       or 400 not_session_owner (cookie for a DIFFERENT user).
//     * A clean body + a valid cookie for the canonical owner is
//       a 200 and creates a share row whose owner_user_uuid comes
//       from internal state, not from the request.
//
// We deliberately drive every check through fetch() against the real
// HTTP server; the player is a browser-shaped client and the seam is
// the wire contract, not the service layer.

import http from 'node:http';

import { server } from '../src/server.mjs';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`);
  }
}

const PICK = await new Promise((resolve, reject) => {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
  probe.on('error', reject);
});

await new Promise((resolve) => server.listen(PICK, '127.0.0.1', resolve));

const baseUrl = `http://127.0.0.1:${PICK}`;
const workId = 'cafe-rain';
const roleId = 'stranger';

/**
 * Each player has a fresh cookie jar. The server mints a fresh
 * user_uuid on the first request and reuses it on subsequent requests
 * via the `story_outside_session` cookie. The session the player
 * bootstraps carries that user_uuid as the canonical owner.
 */
async function bootstrapPlayer() {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ work_id: workId, role_id: roleId }),
  });
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie || !setCookie.startsWith('story_outside_session=')) {
    throw new Error('bootstrap did not set story_outside_session');
  }
  const cookieValue = setCookie.split(';')[0].split('=')[1];
  const data = await res.json();
  return {
    cookieHeader: `story_outside_session=${cookieValue}`,
    cookieValue,
    sessionUuid: data.session_uuid,
    response: data,
    status: res.status,
  };
}

async function shareRequest({ cookieHeader, sessionUuid, body }) {
  return fetch(`${baseUrl}/v1/ecosystem/sessions/${sessionUuid}/share`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader || '',
    },
    body: body === undefined ? '' : JSON.stringify(body),
  });
}

async function unshareRequest({ cookieHeader, sessionUuid, body }) {
  return fetch(`${baseUrl}/v1/ecosystem/sessions/${sessionUuid}/unshare`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader || '',
    },
    body: body === undefined ? '' : JSON.stringify(body),
  });
}

async function followRequest({ cookieHeader, body }) {
  return fetch(`${baseUrl}/v1/ecosystem/follow`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader || '',
    },
    body: body === undefined ? '' : JSON.stringify(body),
  });
}

async function friendTimelinesRequest({ cookieHeader }) {
  return fetch(`${baseUrl}/v1/ecosystem/friend-timelines?limit=10`, {
    headers: { cookie: cookieHeader || '' },
  });
}

console.log('ClickUp 16.3 P1 — cookie-based auth');

// ---------------------------------------------------------------------------
// P1.1 — auth seam is the cookie, not a header.
// ---------------------------------------------------------------------------
{
  const res = await friendTimelinesRequest({ cookieHeader: '' });
  check('P1.1: missing cookie → 401', res.status === 401, `got ${res.status}`);
  const data = await res.json().catch(() => null);
  check('P1.1: 401 body carries unauthenticated code', data && data.error === 'unauthenticated', JSON.stringify(data));
  check('P1.1: 401 message mentions story_outside_session', data && typeof data.message === 'string' && data.message.includes('story_outside_session'), JSON.stringify(data));
}

{
  const res = await friendTimelinesRequest({ cookieHeader: 'story_outside_session=not-a-uuid' });
  check('P1.1: malformed cookie → 401', res.status === 401, `got ${res.status}`);
}

{
  const res = await friendTimelinesRequest({ cookieHeader: '' });
  // Header alone is not enough.
  void res;
  const headerOnly = await fetch(`${baseUrl}/v1/ecosystem/friend-timelines?limit=10`, {
    headers: { 'x-mock-user-uuid': '11111111-1111-4111-8111-aaaaaaaaaaaa' },
  });
  check('P1.1: x-mock-user-uuid header alone is NOT enough', headerOnly.status === 401, `got ${headerOnly.status}`);
}

// ---------------------------------------------------------------------------
// Bootstrap two players. Each one has a distinct cookie and a distinct
// session. owner = first player, attacker = second player.
// ---------------------------------------------------------------------------
const owner = await bootstrapPlayer();
check('P1.1: bootstrap returns 200', owner.status === 200, `got ${owner.status}`);
check('P1.1: cookie value is a UUID', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(owner.cookieValue), owner.cookieValue);
check('P1.1: bootstrap response carries session_uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(owner.sessionUuid), owner.sessionUuid);

const attacker = await bootstrapPlayer();
check('P1.1: second bootstrap mints a distinct user_uuid cookie', attacker.cookieValue !== owner.cookieValue, `${owner.cookieValue} vs ${attacker.cookieValue}`);
check('P1.1: second bootstrap mints a distinct session_uuid', attacker.sessionUuid !== owner.sessionUuid, `${owner.sessionUuid} vs ${attacker.sessionUuid}`);

// ---------------------------------------------------------------------------
// P1.2 — share handler MUST reject identity-shaped body fields.
// ---------------------------------------------------------------------------
{
  const body = { user_ref: 'attacker-supplied' };
  const res = await shareRequest({ cookieHeader: owner.cookieHeader, sessionUuid: owner.sessionUuid, body });
  check('P1.2: body.user_ref → 400', res.status === 400, `got ${res.status}`);
}
{
  const body = { user_uuid: 'attacker-supplied' };
  const res = await shareRequest({ cookieHeader: owner.cookieHeader, sessionUuid: owner.sessionUuid, body });
  check('P1.2: body.user_uuid → 400', res.status === 400, `got ${res.status}`);
}
{
  const body = { identity: { user_uuid: 'attacker-supplied' } };
  const res = await shareRequest({ cookieHeader: owner.cookieHeader, sessionUuid: owner.sessionUuid, body });
  check('P1.2: body.identity → 400', res.status === 400, `got ${res.status}`);
}
{
  const body = { user_id: 'attacker-supplied' };
  const res = await shareRequest({ cookieHeader: owner.cookieHeader, sessionUuid: owner.sessionUuid, body });
  check('P1.2: body.user_id → 400', res.status === 400, `got ${res.status}`);
}
{
  const body = { subject: 'attacker-supplied' };
  const res = await shareRequest({ cookieHeader: owner.cookieHeader, sessionUuid: owner.sessionUuid, body });
  check('P1.2: body.subject → 400', res.status === 400, `got ${res.status}`);
}
{
  const body = { actor: 'attacker-supplied' };
  const res = await shareRequest({ cookieHeader: owner.cookieHeader, sessionUuid: owner.sessionUuid, body });
  check('P1.2: body.actor → 400', res.status === 400, `got ${res.status}`);
}
{
  const body = { owner: 'attacker-supplied' };
  const res = await shareRequest({ cookieHeader: owner.cookieHeader, sessionUuid: owner.sessionUuid, body });
  check('P1.2: body.owner → 400', res.status === 400, `got ${res.status}`);
}
{
  const body = { user: 'attacker-supplied' };
  const res = await shareRequest({ cookieHeader: owner.cookieHeader, sessionUuid: owner.sessionUuid, body });
  check('P1.2: body.user → 400', res.status === 400, `got ${res.status}`);
}

// ---------------------------------------------------------------------------
// P1.2 — clean body + owner cookie → 200, share row binds to canonical owner.
// ---------------------------------------------------------------------------
{
  const body = { title: '我的晚安故事', story_uuid: '11111111-1111-4111-8111-111111111111', story_version_uuid: '21111111-1111-4111-8111-111111111111' };
  const res = await shareRequest({ cookieHeader: owner.cookieHeader, sessionUuid: owner.sessionUuid, body });
  check('P1.2: clean body + owner cookie → 200', res.status === 200, `got ${res.status}`);
  const data = await res.json();
  check('P1.2: share row session_uuid matches', data && data.share && data.share.session_uuid === owner.sessionUuid, JSON.stringify(data));
  check('P1.2: share row owner_user_uuid matches canonical owner (NOT request body)', data && data.share && data.share.owner_user_uuid === owner.cookieValue, JSON.stringify(data));
  check('P1.2: share row carries the title we sent', data && data.share && data.share.title === body.title, JSON.stringify(data));
}

{
  const res = await shareRequest({ cookieHeader: owner.cookieHeader, sessionUuid: owner.sessionUuid, body: {} });
  check('P1.2: empty body + owner cookie → 200', res.status === 200, `got ${res.status}`);
}

// ---------------------------------------------------------------------------
// P1.2 — knowing the session_uuid but using the wrong cookie cannot share.
// ---------------------------------------------------------------------------
{
  const res = await shareRequest({ cookieHeader: attacker.cookieHeader, sessionUuid: owner.sessionUuid, body: {} });
  check('P1.2: attacker cookie ≠ owner cookie → share rejected', res.status === 400, `got ${res.status}`);
  const data = await res.json();
  check('P1.2: attacker share response carries not_session_owner', data && data.error === 'not_session_owner', JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// P1.1 — share / unshare require a valid cookie.
// ---------------------------------------------------------------------------
{
  const res = await shareRequest({ cookieHeader: '', sessionUuid: owner.sessionUuid, body: {} });
  check('P1.1: share with no cookie → 401', res.status === 401, `got ${res.status}`);
}
{
  const res = await shareRequest({ cookieHeader: 'story_outside_session=not-a-uuid', sessionUuid: owner.sessionUuid, body: {} });
  check('P1.1: share with malformed cookie → 401', res.status === 401, `got ${res.status}`);
}

// ---------------------------------------------------------------------------
// P1.1 — follow requires a valid cookie too.
// ---------------------------------------------------------------------------
{
  const res = await followRequest({ cookieHeader: '', body: { target_user_uuid: '11111111-1111-4111-8111-bbbbbbbbbbbb' } });
  check('P1.1: follow with no cookie → 401', res.status === 401, `got ${res.status}`);
}
{
  const res = await followRequest({ cookieHeader: owner.cookieHeader, body: { target_user_uuid: '11111111-1111-4111-8111-bbbbbbbbbbbb' } });
  check('P1.1: follow with owner cookie → 200', res.status === 200, `got ${res.status}`);
  const data = await res.json();
  check('P1.1: follow row follower_uuid matches the cookie identity', data && data.follow && data.follow.follower_uuid === owner.cookieValue, JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// P1.2 — unshare is owner-only.
// ---------------------------------------------------------------------------
{
  const res = await unshareRequest({ cookieHeader: '', sessionUuid: owner.sessionUuid });
  check('P1.1: unshare with no cookie → 401', res.status === 401, `got ${res.status}`);
}
{
  const res = await unshareRequest({ cookieHeader: attacker.cookieHeader, sessionUuid: owner.sessionUuid });
  check('P1.2: unshare with attacker cookie → 400 not_session_owner', res.status === 400, `got ${res.status}`);
}
{
  const res = await unshareRequest({ cookieHeader: owner.cookieHeader, sessionUuid: owner.sessionUuid });
  check('P1.2: unshare with owner cookie → 200', res.status === 200, `got ${res.status}`);
  const data = await res.json();
  check('P1.2: unshare response reports unshared=true', data && data.unshared === true, JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// P1.2 — session not owned by anyone cannot be shared. Pre-existing
// legacy sessions have no canonical owner (createSession was called
// without user_uuid in older code paths). Sharing such a session must
// fail-closed.
// ---------------------------------------------------------------------------
// We can synthesise this by creating a session via /api/dev/sessions
// (the legacy demo route) which does not pass user_uuid, then trying
// to share it through /v1/ecosystem.
{
  const legacy = await fetch(`${baseUrl}/api/dev/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_uuid: '11111111-1111-4111-8000-00000000dead',
      story_uuid: '11111111-1111-4111-8111-111111111111',
      story_version_uuid: '21111111-1111-4111-8111-111111111111',
      user_ref: 'legacy-player',
      role_id: 'stranger',
    }),
  });
  // We do NOT care if /api/dev/sessions succeeds — what matters is
  // that the resulting session has no canonical owner, so any share
  // attempt must fail-closed.
  void legacy;
  const res = await shareRequest({
    cookieHeader: owner.cookieHeader,
    sessionUuid: '11111111-1111-4111-8000-00000000dead',
    body: {},
  });
  // Either the session does not exist → 401 session_not_found, OR
  // the session exists without an owner → 400 not_session_owner.
  // Both are correct fail-closed outcomes. We accept anything that
  // is NOT a 200 share.
  const data = await res.json();
  check(
    'P1.2: legacy (no canonical owner) session cannot be shared',
    (res.status === 401 && data.error === 'session_not_found') || (res.status === 400 && data.error === 'not_session_owner'),
    `status=${res.status} body=${JSON.stringify(data)}`,
  );
}

console.log(`\nClickUp 16.3 P1 — cookie-based auth: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
if (failures > 0) process.exit(1);
process.exit(0);