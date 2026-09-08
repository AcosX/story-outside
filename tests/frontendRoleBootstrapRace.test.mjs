import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/scripts/player.js', import.meta.url), 'utf8');
const bootstrapSource = source.slice(
  source.indexOf('async function bootstrapSession('),
  source.indexOf('/**\n * ClickUp 16.4 P1.v1-7 fix', source.indexOf('async function bootstrapSession(')),
);

const requests = [];
const remembered = [];
const fields = new Map();
const $ = (selector) => {
  if (!fields.has(selector)) fields.set(selector, { disabled: false });
  return fields.get(selector);
};
const state = {
  role: { id: 'a', label: 'A' },
  navigationToken: 1,
};
const api = (_path, options) => new Promise((resolve, reject) => {
  requests.push({ body: JSON.parse(options.body), resolve, reject });
});
const bind = new Function('state', 'api', '$', 'remembered', `
const clearAutoplayTimer = () => {};
const setStatus = () => {};
const setText = () => {};
const publishBootstrapIdentity = () => {};
const persistSessionContext = () => {};
const dispatchLocalSessionChanged = () => {};
const rememberReading = () => remembered.push({ role: state.role.id, sessionUuid: state.sessionUuid });
const showScreen = () => {};
const syncHeaderRoles = () => {};
const recoverAndStart = async () => {};
${bootstrapSource}
return { bootstrapSession };
`)(state, api, $, remembered);

const story = { id: 'story-1', title: 'Story' };
const roleB = { id: 'b', label: 'B' };
const roleC = { id: 'c', label: 'C' };
const pendingB = bind.bootstrapSession({ story, role: roleB });
const pendingC = bind.bootstrapSession({ story, role: roleC });

assert.equal(requests.length, 2, 'a later role selection starts its own bootstrap');
assert.deepEqual(requests.map((request) => request.body.role_id), ['b', 'c']);
assert.equal(state.role.id, 'a', 'client role stays canonical until a matching session succeeds');

requests[0].resolve({ session_uuid: 'session-b', cache_uuid: 'cache-b', pinned: { role_id: 'b' } });
await pendingB;
assert.equal(state.role.id, 'a', 'late response for an older selection cannot change the role');
assert.equal(state.sessionUuid, undefined, 'late response cannot install its session');
assert.equal(state.bootstrapInFlight, true, 'older completion cannot clear the latest loading state');

requests[1].resolve({ session_uuid: 'session-c', cache_uuid: 'cache-c', pinned: { role_id: 'c' } });
await pendingC;
assert.equal(state.role.id, 'c');
assert.equal(state.sessionUuid, 'session-c');
assert.equal(state.bootstrapInFlight, false);
assert.deepEqual(remembered, [{ role: 'c', sessionUuid: 'session-c' }]);

console.log('frontend role bootstrap race: PASS');
