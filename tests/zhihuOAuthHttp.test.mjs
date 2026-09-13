import assert from 'node:assert/strict';
process.env.STORY_OUTSIDE_AUTH_MODE = 'oauth';
process.env.STORY_OUTSIDE_OAUTH_SECRET_FILE = '/nonexistent-oauth-test';
process.env.ZHIHU_OAUTH_APP_ID = '413';
process.env.ZHIHU_OAUTH_APP_KEY = 'test-app-key';
process.env.ZHIHU_OAUTH_REDIRECT_URI = 'https://story.example/auth/callback';
process.env.STORY_OUTSIDE_PROVIDER = 'mock';
process.env.STORY_OUTSIDE_AI_PROVIDER = 'mock';
const realFetch = globalThis.fetch;
let userId = 100;
let exchangeCount = 0;
globalThis.fetch = async (url, options) => {
  if (url === 'https://openapi.zhihu.com/access_token') {
    exchangeCount++;
    return Response.json({ access_token: 'fixture-user-token', token_type: 'Bearer', expires_in: 3600 });
  }
  if (url === 'https://openapi.zhihu.com/user') {
    assert.equal(options.headers.Authorization, 'Bearer fixture-user-token');
    return Response.json({ uid: userId, fullname: `用户${userId}` });
  }
  return realFetch(url, options);
};
const { server } = await import('../src/server.mjs');
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const get = (path, cookie = '') => realFetch(base + path, { headers: { cookie }, redirect: 'manual' });
const post = (path, body, cookie = '', origin = 'https://story.example') => realFetch(base + path, { method: 'POST', redirect: 'manual', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function login(id) {
  userId = id;
  const start = await get('/auth/login');
  assert.equal(start.status, 303);
  const flowCookie = start.headers.getSetCookie()[0].split(';')[0];
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const callback = '/auth/callback?authorization_code=fixture-code&state=' + state;
  const finish = await get(callback, flowCookie);
  assert.equal(finish.headers.get('location'), '/');
  const cookie = finish.headers.getSetCookie().find(s => s.startsWith('__Host-story_outside_session=')).split(';')[0];
  assert.equal((await get(callback, flowCookie)).headers.get('location'), '/?oauth_error=oauth_state_invalid');
  return cookie;
}
try {
  assert.equal((await get('/api/health')).status, 200);
  assert.equal((await get('/api/stories')).status, 200);
  const anonymous = await get('/api/auth/status');
  assert.equal(anonymous.headers.get('cache-control'), 'no-store');
  assert.equal((await anonymous.json()).owner, null);
  assert.equal((await post('/api/sessions', {})).status, 401);
  // 「故事里的相遇」转正后，本站不再自建关注关系：手输 UUID 的
  // POST /v1/ecosystem/follow 已下线。它既不能成功，也不该再表现为
  // 401 这种「路由还在、只是没登录」的语义。
  const removedFollow = await post('/v1/ecosystem/follow', { target_user_uuid: '11111111-1111-4111-8111-aaaaaaaaaaaa' });
  assert.ok(removedFollow.status !== 200 && removedFollow.status !== 401, `follow 路由应已下线，实际 ${removedFollow.status}`);
  // 关注流才是需要登录的个人路由。
  assert.equal((await get('/v1/ecosystem/friend-timelines')).status, 401);
  assert.equal((await get('/api/dev/sessions/00000000-0000-4000-8000-00000000cafe')).status, 403);
  const a = await login(100); const b = await login(200);
  assert.equal(exchangeCount, 2);
  assert.equal((await get('/api/auth/status', a)).status, 200);
  assert.equal((await post('/api/sessions', {}, a, 'https://evil.example')).status, 403);
  const create = await post('/api/sessions', {}, a);
  assert.equal(create.status, 200, await create.clone().text());
  const session = await create.json();
  const uuid = session.session_uuid;
  assert.ok(uuid);
  for (const suffix of ['', '/recover', '/ending', '/replay', '/original-timeline']) {
    const route = '/api/sessions/' + uuid + suffix;
    assert.equal((await get(route)).status, 401);
    assert.equal((await get(route, b)).status, 404, route);
  }
  assert.equal((await get('/api/sessions/' + uuid + '/recover', a)).status, 200);
  for (const suffix of ['generate','interrupt','opening-events','narrative-events','first-choice','discard-pending']) assert.equal((await post('/api/sessions/' + uuid + '/' + suffix, {}, b)).status, 404, suffix);
  const shared = await post('/v1/ecosystem/sessions/' + uuid + '/share', undefined, b);
  assert.equal(shared.status, 400); assert.equal((await shared.json()).error, 'not_session_owner');
  assert.equal((await post('/auth/logout', {}, a, 'https://evil.example')).status, 403);
  assert.equal((await post('/auth/logout', {}, a)).status, 200);
  assert.equal((await get('/api/sessions/' + uuid + '/recover', a)).status, 401);
  assert.equal((await (await get('/api/auth/status', b)).json()).authenticated, true);
  const a2 = await login(100);
  assert.equal((await get('/api/sessions/' + uuid + '/recover', a2)).status, 200, 'stable user identity restores ownership');
  const error = await get('/auth/callback?authorization_code=sensitive-value&state=bad');
  assert.equal(error.status, 303);
  assert.ok(!error.headers.get('location').includes('sensitive-value'));
  console.log('OAuth HTTP login, ownership across all session routes, logout, CSRF and callback privacy: PASS');
} finally {
  globalThis.fetch = realFetch;
  await new Promise(resolve => server.close(resolve));
}
