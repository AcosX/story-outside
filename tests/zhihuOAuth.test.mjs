import assert from 'node:assert/strict';
import { createZhihuOAuth, loadOAuthConfig, ownerFromProfile } from '../src/auth/zhihuOAuth.mjs';
const config = { appId: '413', appKey: 'test-app-key', redirectUri: 'https://story.example/auth/callback', origin: 'https://story.example' };
const response = () => ({ headers: {}, getHeader(k) { return this.headers[k]; }, setHeader(k,v) { this.headers[k] = v; } });
const req = (cookie = '') => ({ headers: { cookie, origin: config.origin } });
const cookies = res => (res.headers['Set-Cookie'] || []).filter(x => !x.includes('Max-Age=0')).map(x => x.split(';')[0]).join('; ');
let time = 1000000;
let calls = [];
let userId = 123;
let expiresIn = 3600;
let profileCode = undefined;
let extra = {};
const oauth = createZhihuOAuth(config, { now: () => time, fetchImpl: async (url, options) => {
  calls.push({ url, options });
  return new Response(JSON.stringify(url.endsWith('/access_token') ? { code: 20000, data: { access_token: 'test-user-token', expires_in: expiresIn, token_type: 'Bearer' } } : profileCode === undefined ? { uid: userId, fullname: '测试用户', email: 'private@example.test', ...extra } : { code: profileCode, data: { uid: userId, fullname: '测试用户' } }));
}});
function begin(instance = oauth, cookie = '', returnTo = '/') {
  const res = response();
  const url = new URL(instance.start(req(cookie), res, new URL('https://story.example/auth/login?return_to=' + encodeURIComponent(returnTo))));
  assert.equal(url.origin, 'https://openapi.zhihu.com');
  assert.equal(url.searchParams.get('app_id'), '413');
  assert.ok(!url.href.includes(config.appKey));
  assert.match(res.headers['Set-Cookie'][0], /HttpOnly; Secure; SameSite=Lax/);
  return { cookie: cookies(res), state: url.searchParams.get('state') };
}
async function finish(flow, instance = oauth, moreCookie = '') {
  const res = response();
  const url = new URL(config.redirectUri);
  url.searchParams.set('authorization_code', 'test-code'); url.searchParams.set('state', flow.state);
  const redirect = await instance.callback(req([flow.cookie, moreCookie].filter(Boolean).join('; ')), res, url);
  return { cookie: cookies(res), res, redirect };
}
assert.equal(oauth.status(req()).authenticated, false);
for (const state of [null, '', 'wrong', '中文'.repeat(43)]) {
  const flow = begin(); const url = new URL(config.redirectUri + '?authorization_code=test-code');
  if (state !== null) url.searchParams.set('state', state);
  await assert.rejects(oauth.callback(req(flow.cookie), response(), url), { code: 'oauth_state_invalid' });
}
assert.equal(calls.length, 0, 'unbound callbacks never exchange tokens');
const flow = begin(oauth, '', '/?s=mine');
const first = await finish(flow);
assert.equal(first.redirect, '/?s=mine');
assert.equal(oauth.status(req(first.cookie)).authenticated, true);
const owner = oauth.owner(req(first.cookie));
assert.equal(owner.auth_source, 'zhihu_oauth');
assert.match(owner.user_uuid, /^[a-f0-9-]{36}$/);
assert.equal(calls[0].options.redirect, 'error');
assert.equal(new URLSearchParams(calls[0].options.body).get('code'), 'test-code');
assert.equal(calls[1].options.headers.Authorization, 'Bearer test-user-token');
assert.equal(calls[1].options.headers['X-OAuth-Token'], undefined);
assert.ok(!JSON.stringify(oauth.status(req(first.cookie))).includes('test-user-token'));
assert.ok(!JSON.stringify(owner).includes('private@example.test'));
await assert.rejects(finish(flow), { code: 'oauth_state_invalid' });
const second = await finish(begin(oauth, first.cookie), oauth, first.cookie);
assert.equal(oauth.owner(req(first.cookie)), null, 'session rotates on login');
assert.deepEqual(oauth.owner(req(second.cookie)), owner, 'same stable uid keeps the business owner');
userId = 456;
const other = await finish(begin());
assert.notEqual(oauth.owner(req(other.cookie)).user_uuid, owner.user_uuid);
assert.throws(() => oauth.logout({ headers: { cookie: second.cookie, origin: 'https://evil.example' } }, response()), { code: 'csrf_rejected' });
oauth.logout(req(second.cookie), response());
assert.equal(oauth.owner(req(second.cookie)), null);
assert.ok(oauth.owner(req(other.cookie)), 'logging out A keeps B');
time += 3600001;
assert.equal(oauth.owner(req(other.cookie)), null, 'expired sessions cannot act');
const expired = begin(); time += 600001;
await assert.rejects(finish(expired), { code: 'oauth_state_invalid' });
profileCode = 401;
await assert.rejects(finish(begin()), { code: 'oauth_identity_unavailable' });
profileCode = 20000; userId = null;
await assert.rejects(finish(begin()), { code: 'oauth_identity_unavailable' });
userId = 123; expiresIn = 0;
await assert.rejects(finish(begin()), { code: 'oauth_token_invalid' });
expiresIn = 3600;
assert.throws(() => ownerFromProfile({ code: 20000, data: { fullname: 'only a name' } }, '413'), { code: 'oauth_identity_unavailable' });
const noRedirect = await finish(begin(oauth, '', '//evil.example'));
assert.equal(noRedirect.redirect, '/');
const bounded = createZhihuOAuth(config, { maxEntries: 1, now: () => time });
begin(bounded); assert.throws(() => begin(bounded), { code: 'oauth_busy' });
time += 600001; begin(bounded);
const configEnv = { STORY_OUTSIDE_OAUTH_SECRET_FILE: '/nonexistent-oauth-test', ZHIHU_OAUTH_APP_ID: '413', ZHIHU_OAUTH_APP_KEY: 'test-only', ZHIHU_OAUTH_REDIRECT_URI: config.redirectUri };
assert.equal(loadOAuthConfig(configEnv).appId, '413');
assert.throws(() => loadOAuthConfig({ ...configEnv, ZHIHU_OAUTH_REDIRECT_URI: 'http://localhost/auth/callback' }));
assert.throws(() => loadOAuthConfig({ ...configEnv, ZHIHU_OAUTH_APP_KEY: '' }));
assert.throws(() => loadOAuthConfig({ NODE_ENV: 'production', STORY_OUTSIDE_AUTH_MODE: 'demo', STORY_OUTSIDE_OAUTH_SECRET_FILE: '/nonexistent-oauth-test' }));
console.log('OAuth state, replay, token contract, stable identity, rotation, expiry, CSRF, privacy and bounds: PASS');

// Logout and a newer login cancel a token exchange already in flight.
for (const cancel of ['logout', 'restart']) {
  let release;
  const delayed = createZhihuOAuth(config, { fetchImpl: async url => {
    if (url.endsWith('/access_token')) return new Promise(resolve => { release = () => resolve(Response.json({ access_token: 'test-token', expires_in: 3600 })); });
    return Response.json({ uid: 123, fullname: '测试' });
  } });
  const flow = begin(delayed);
  const pending = finish(flow, delayed);
  await assert.rejects(finish(flow, delayed), { code: 'oauth_state_invalid' }, 'parallel replay refused');
  if (cancel === 'logout') delayed.logout(req(flow.cookie), response());
  else begin(delayed, flow.cookie);
  release();
  await assert.rejects(pending, { code: 'oauth_state_invalid' }, 'stale callback cannot resurrect a login');
}
for (const upstream of [() => { throw new Error('test-token'); }, () => new Response('not-json'), () => new Response('x'.repeat(65537)), () => Response.json({ code: 401, data: 'secret' })]) {
  const failed = createZhihuOAuth(config, { fetchImpl: upstream });
  const flow = begin(failed);
  await assert.rejects(finish(flow, failed), error => /^oauth_/.test(error.code) && !error.message.includes('test-token'));
  assert.equal(failed.status(req(flow.cookie)).authenticated, false);
}
console.log('OAuth concurrent callback cancellation and redacted upstream failures: PASS');

// 知乎 /user 的 uid 是 19 位十进制整数，超过 IEEE-754 安全整数范围。
// 上线首日真实登录因此被拒（oauth_identity_unavailable）：JSON.parse 把末位
// 改写后 Number.isSafeInteger 失败。回归锁定完整精度与 user_uuid 稳定性。
{
  const bigUid = '1234567890123456789';
  const owner = ownerFromProfile({ uid: bigUid, fullname: '大号用户' }, '413');
  assert.match(owner.user_uuid, /^[0-9a-f-]{36}$/);
  assert.equal(owner.display_name, '大号用户');
  // 同一 uid 无论以字符串还是安全整数出现，业务 UUID 必须一致，否则老用户丢失故事所有权。
  assert.equal(ownerFromProfile({ uid: '123456' }, '413').user_uuid, ownerFromProfile({ uid: 123456 }, '413').user_uuid);
  // 不同的 19 位 uid 必须区分开，不能因精度丢失被折叠成同一账号。
  assert.notEqual(owner.user_uuid, ownerFromProfile({ uid: '1234567890123456788' }, '413').user_uuid);
  for (const bad of [null, undefined, 0, -1, 1.5, '0', '01', 'abc', '', '12 34', {}, []]) {
    assert.throws(() => ownerFromProfile({ uid: bad }, '413'), { code: 'oauth_identity_unavailable' }, String(bad));
  }
  // 端到端：模拟上游以 19 位裸整数返回 uid，登录必须成功。
  const bigIntOAuth = createZhihuOAuth(config, { fetchImpl: async url => new Response(url.endsWith('/access_token')
    ? '{"access_token":"test-big-token","token_type":"Bearer","expires_in":3600}'
    : `{"avatar_path":"/a.jpg","uid":${bigUid},"fullname":"大号用户","hash_id":"abc"}`) });
  const bigFlow = begin(bigIntOAuth);
  const bigSession = await finish(bigFlow, bigIntOAuth);
  assert.equal(bigIntOAuth.owner(req(bigSession.cookie)).user_uuid, owner.user_uuid, 'raw 19-digit uid survives JSON parsing');
  console.log('OAuth 19-digit uid precision and stable business UUID: PASS');
}
