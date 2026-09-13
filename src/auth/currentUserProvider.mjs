// Local mock mode retains its explicit demo identity. OAuth requests bind only
// a server-verified owner; headers, request bodies and caller UUIDs are ignored.
export const OAUTH_PENDING_USER = Object.freeze({
  user_uuid: '00000000-0000-4000-8000-00000000cafe',
  display_name: '待接入用户 (OAuth pending)',
  auth_source: 'oauth_pending',
});
const owners = new WeakMap();
export function bindCurrentUser(req, owner) { owners.set(req, owner); }
export function currentUserProvider(req) {
  return req && owners.has(req) ? owners.get(req) : OAUTH_PENDING_USER;
}
