// tests/ecosystem16-3-p1-auth.test.mjs — Story 16.3 P1 v1-2
// rebuild (2026-09-07 review).
//
// What this test verifies (OAuth-pending contract):
//
//   P1.1 — auth seam is a single fixed function.
//     * `currentUserProvider(req)` returns OAUTH_PENDING_USER on every
//       request — no cookie, no header, no body field, no random
//       per-browser user_uuid.
//     * `POST /api/sessions` returns 200 with an `owner` object whose
//       `user_uuid` equals `OAUTH_PENDING_USER.user_uuid` and whose
//       `auth_source` equals `'oauth_pending'`.
//     * `POST /api/sessions` with a body that contains
//       `user_uuid` (or any identity-shaped key) returns
//       400 `forbidden_field` — the request body must NEVER be a
//       path to spoof the canonical owner.
//     * `GET /api/auth/status` returns the same canonical owner and
//       is the wire contract the browser UI consumes.
//
//   P1.2 — share binds to the canonical session owner.
//     * `POST /v1/ecosystem/sessions/:uuid/share` with NO body and no
//       cookie returns 200 with a share row whose
//       `owner_user_uuid` equals `OAUTH_PENDING_USER.user_uuid`.
//     * The same endpoint with ANY body (including `{}`-shaped) returns
//       400 `forbidden_field` — the OAuth-pending player has nothing
//       legitimate to send.
//     * The response `owner.user_uuid` matches
//       `OAUTH_PENDING_USER.user_uuid` and `owner.auth_source` is
//       `'oauth_pending'`.
//     * There is NO Set-Cookie header anywhere: identity does not
//       flow through the cookie jar.
//
// We deliberately drive every check through fetch() against the real
// HTTP server; the player is a browser-shaped client and the seam is
// the wire contract, not the service layer.

import http from 'node:http';

import { server } from '../src/server.mjs';
import {
  OAUTH_PENDING_USER,
  currentUserProvider,
} from '../src/auth/currentUserProvider.mjs';

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
 * Bootstrap a session the way the browser would. The server does NOT
 * mint a cookie in v1-2 — it returns the canonical owner in the
 * response body.
 */
async function bootstrapSession({ body } = {}) {
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(`${baseUrl}/api/sessions`, init);
}

async function authStatusRequest({ cookieHeader = '' } = {}) {
  return fetch(`${baseUrl}/api/auth/status`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  });
}

async function shareRequest({ cookieHeader = '', sessionUuid, body }) {
  const init = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
  };
  if (cookieHeader) init.headers.cookie = cookieHeader;
  init.body = body === undefined ? '' : JSON.stringify(body);
  return fetch(`${baseUrl}/v1/ecosystem/sessions/${sessionUuid}/share`, init);
}

console.log('Story 16.3 P1 v1-2 — currentUserProvider auth');

// ---------------------------------------------------------------------------
// P1.1 — currentUserProvider seam is fixed, pure, and OAuth-pending.
// ---------------------------------------------------------------------------
{
  const a = currentUserProvider(null);
  const b = currentUserProvider({});
  check('P1.1: currentUserProvider is pure (same return on null req)', a === b || JSON.stringify(a) === JSON.stringify(b), JSON.stringify({ a, b }));
  check('P1.1: currentUserProvider returns OAUTH_PENDING_USER.user_uuid', a.user_uuid === OAUTH_PENDING_USER.user_uuid, JSON.stringify(a));
  check('P1.1: currentUserProvider returns OAUTH_PENDING_USER.display_name', a.display_name === OAUTH_PENDING_USER.display_name, JSON.stringify(a));
  check('P1.1: currentUserProvider returns auth_source === oauth_pending', a.auth_source === 'oauth_pending', JSON.stringify(a));
}

// ---------------------------------------------------------------------------
// P1.1 — GET /api/auth/status surfaces the canonical owner.
// ---------------------------------------------------------------------------
{
  const res = await authStatusRequest({});
  check('P1.1: /api/auth/status → 200', res.status === 200, `got ${res.status}`);
  check('P1.1: /api/auth/status does NOT emit Set-Cookie', !res.headers.get('set-cookie'), res.headers.get('set-cookie') || '');
  const data = await res.json();
  check('P1.1: /api/auth/status owner.user_uuid matches OAUTH_PENDING_USER', data && data.owner && data.owner.user_uuid === OAUTH_PENDING_USER.user_uuid, JSON.stringify(data));
  check('P1.1: /api/auth/status owner.display_name matches OAUTH_PENDING_USER', data && data.owner && data.owner.display_name === OAUTH_PENDING_USER.display_name, JSON.stringify(data));
  check('P1.1: /api/auth/status owner.auth_source === oauth_pending', data && data.owner && data.owner.auth_source === 'oauth_pending', JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// P1.1 — POST /api/sessions (no body) → 200 + canonical owner.
// ---------------------------------------------------------------------------
const session1 = await bootstrapSession();
{
  check('P1.1: POST /api/sessions no body → 200', session1.status === 200, `got ${session1.status}`);
  check('P1.1: POST /api/sessions no body does NOT emit Set-Cookie', !session1.headers.get('set-cookie'), session1.headers.get('set-cookie') || '');
  const data = await session1.json();
  check('P1.1: POST /api/sessions returns session_uuid', data && typeof data.session_uuid === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.session_uuid), JSON.stringify(data));
  check('P1.1: POST /api/sessions owner.user_uuid === OAUTH_PENDING_USER.user_uuid', data && data.owner && data.owner.user_uuid === OAUTH_PENDING_USER.user_uuid, JSON.stringify(data));
  check('P1.1: POST /api/sessions owner.auth_source === oauth_pending', data && data.owner && data.owner.auth_source === 'oauth_pending', JSON.stringify(data));
  check('P1.1: POST /api/sessions owner.display_name === "待接入用户 (OAuth pending)"', data && data.owner && data.owner.display_name === '待接入用户 (OAuth pending)', JSON.stringify(data));
  session1._data = data;
}

// ---------------------------------------------------------------------------
// P1.1 — POST /api/sessions body.user_uuid → 400 forbidden_field.
// ---------------------------------------------------------------------------
{
  const res = await bootstrapSession({ body: { work_id: workId, role_id: roleId, user_uuid: '00000000-0000-4000-8000-00000000dead' } });
  check('P1.1: body.user_uuid → 400', res.status === 400, `got ${res.status}`);
  const data = await res.json();
  check('P1.1: body.user_uuid error === forbidden_field', data && data.error === 'forbidden_field', JSON.stringify(data));
  check('P1.1: body.user_uuid field === user_uuid', data && data.field === 'user_uuid', JSON.stringify(data));
}
{
  const res = await bootstrapSession({ body: { work_id: workId, role_id: roleId, user_ref: 'attacker' } });
  check('P1.1: body.user_ref → 400 forbidden_field', res.status === 400 && (await res.clone().json()).error === 'forbidden_field', `got ${res.status}`);
}
{
  const res = await bootstrapSession({ body: { work_id: workId, role_id: roleId, identity: { user_uuid: 'attacker' } } });
  check('P1.1: body.identity → 400 forbidden_field', res.status === 400 && (await res.clone().json()).error === 'forbidden_field', `got ${res.status}`);
}
{
  const res = await bootstrapSession({ body: { work_id: workId, role_id: roleId, owner: 'attacker' } });
  check('P1.1: body.owner → 400 forbidden_field', res.status === 400 && (await res.clone().json()).error === 'forbidden_field', `got ${res.status}`);
}

// ---------------------------------------------------------------------------
// P1.1 — POST /api/sessions (work_id + role_id body) → 200 + canonical owner.
//   Confirms the route accepts work_id/role_id as legitimate bootstrap
//   inputs and STILL pins the canonical owner to OAUTH_PENDING_USER.
// ---------------------------------------------------------------------------
const session2 = await bootstrapSession({ body: { work_id: workId, role_id: roleId } });
{
  check('P1.1: POST /api/sessions with work_id+role_id → 200', session2.status === 200, `got ${session2.status}`);
  const data = await session2.json();
  check('P1.1: work_id+role_id bootstrap owner.user_uuid === OAUTH_PENDING_USER', data && data.owner && data.owner.user_uuid === OAUTH_PENDING_USER.user_uuid, JSON.stringify(data));
  check('P1.1: work_id+role_id bootstrap owner.auth_source === oauth_pending', data && data.owner && data.owner.auth_source === 'oauth_pending', JSON.stringify(data));
  session2._data = data;
}

// ---------------------------------------------------------------------------
// P1.2 — share binds to the canonical session owner (no cookie, no body).
// ---------------------------------------------------------------------------
{
  const res = await shareRequest({ sessionUuid: session1._data.session_uuid });
  check('P1.2: /share no body + no cookie → 200', res.status === 200, `got ${res.status}`);
  check('P1.2: /share no body + no cookie does NOT emit Set-Cookie', !res.headers.get('set-cookie'), res.headers.get('set-cookie') || '');
  const data = await res.json();
  check('P1.2: share.owner_user_uuid === OAUTH_PENDING_USER.user_uuid', data && data.share && data.share.owner_user_uuid === OAUTH_PENDING_USER.user_uuid, JSON.stringify(data));
  check('P1.2: response owner.user_uuid === OAUTH_PENDING_USER.user_uuid', data && data.owner && data.owner.user_uuid === OAUTH_PENDING_USER.user_uuid, JSON.stringify(data));
  check('P1.2: response owner.auth_source === oauth_pending', data && data.owner && data.owner.auth_source === 'oauth_pending', JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// P1.2 — share with ANY body → 400 forbidden_field.
// ---------------------------------------------------------------------------
{
  const res = await shareRequest({ sessionUuid: session1._data.session_uuid, body: { title: '我的晚安故事' } });
  check('P1.2: /share with body → 400', res.status === 400, `got ${res.status}`);
  const data = await res.json();
  check('P1.2: /share with body error === forbidden_field', data && data.error === 'forbidden_field', JSON.stringify(data));
}
{
  const res = await shareRequest({ sessionUuid: session1._data.session_uuid, body: {} });
  check('P1.2: /share with empty-object body → 400 forbidden_field', res.status === 400, `got ${res.status}`);
  const data = await res.json();
  check('P1.2: /share with empty-object body error === forbidden_field', data && data.error === 'forbidden_field', JSON.stringify(data));
}
{
  const res = await shareRequest({ sessionUuid: session1._data.session_uuid, body: { user_uuid: 'attacker-supplied' } });
  check('P1.2: /share with body.user_uuid → 400 forbidden_field', res.status === 400, `got ${res.status}`);
  const data = await res.json();
  check('P1.2: /share with body.user_uuid error === forbidden_field', data && data.error === 'forbidden_field', JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// P1.1 — bootstrap does NOT mint a cookie. Repeated bootstraps share the
//   same canonical owner and never advertise a session-scoped identity.
// ---------------------------------------------------------------------------
{
  const res1 = await bootstrapSession();
  const res2 = await bootstrapSession();
  const d1 = await res1.json();
  const d2 = await res2.json();
  check('P1.1: repeated bootstrap → same OAUTH_PENDING_USER.user_uuid', d1.owner.user_uuid === d2.owner.user_uuid && d1.owner.user_uuid === OAUTH_PENDING_USER.user_uuid, JSON.stringify({ d1: d1.owner, d2: d2.owner }));
  check('P1.1: repeated bootstrap → distinct session_uuids', d1.session_uuid !== d2.session_uuid, JSON.stringify({ d1: d1.session_uuid, d2: d2.session_uuid }));
}

console.log(`\nStory 16.3 P1 v1-2 — currentUserProvider auth: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
if (failures > 0) process.exit(1);
process.exit(0);
