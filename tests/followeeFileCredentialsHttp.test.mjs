import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Exercise the real server wiring in an isolated application root. Never read
// or overwrite the developer's secrets/secret, and never contact real Zhihu.
const root = fileURLToPath(new URL('..', import.meta.url));
const isolated = await mkdtemp(join(tmpdir(), 'story-followee-file-'));
const savedEnv = { ...process.env };
const realFetch = globalThis.fetch;
let server;
let upstreamCalls = 0;
let expectedSecret = 'fixture-file-access-secret';
try {
  await cp(join(root, 'src'), join(isolated, 'src'), { recursive: true });
  await cp(join(root, 'package.json'), join(isolated, 'package.json'));
  await symlink(resolve(root, 'node_modules'), join(isolated, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await mkdir(join(isolated, 'secrets'));
  await writeFile(join(isolated, 'secrets', 'secret'), 'Access Secret: fixture-file-access-secret\n');
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('STORY_OUTSIDE_') || key.startsWith('ZHIHU_') || key === 'NODE_ENV') delete process.env[key];
  }
  Object.assign(process.env, {
    STORY_OUTSIDE_AUTH_MODE: 'oauth', STORY_OUTSIDE_OAUTH_SECRET_FILE: join(isolated, 'absent-oauth'),
    ZHIHU_OAUTH_APP_ID: '413', ZHIHU_OAUTH_APP_KEY: 'fixture-app-key',
    ZHIHU_OAUTH_REDIRECT_URI: 'https://story.example/auth/callback',
    STORY_OUTSIDE_PROVIDER: 'mock', STORY_OUTSIDE_AI_PROVIDER: 'mock',
  });
  globalThis.fetch = async (url, options) => {
    if (url === 'https://openapi.zhihu.com/access_token') return Response.json({access_token:'fixture-user-token',token_type:'Bearer',expires_in:3600});
    if (url === 'https://openapi.zhihu.com/user') return Response.json({uid:'123',fullname:'测试用户',url:'https://www.zhihu.com/people/fixture-reader'});
    if (String(url).startsWith('https://developer.zhihu.com/api/v1/user/followees')) {
      upstreamCalls++;
      assert.equal(options.headers.authorization, `Bearer ${expectedSecret}`);
      assert.equal(options.headers['x-oauth-token'], 'fixture-user-token');
      return Response.json({Code:0,Data:{Items:[],Paging:{IsEnd:true}}});
    }
    throw new Error('Unexpected external request');
  };
  ({ server } = await import(pathToFileURL(join(isolated, 'src', 'server.mjs')).href));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, cookie='') => realFetch(base + path, {headers:{cookie},redirect:'manual'});
  const start = await get('/auth/login');
  const flowCookie = start.headers.getSetCookie()[0].split(';')[0];
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const callback = await get('/auth/callback?authorization_code=fixture-code&state=' + encodeURIComponent(state), flowCookie);
  const cookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-story_outside_session=')).split(';')[0];
  const feed = async () => {
    const response = await get('/v1/ecosystem/friend-timelines', cookie);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes('fixture-file-access-secret') && !text.includes('fixture-user-token'));
    return JSON.parse(text);
  };
  assert.equal((await feed()).status, 'ok', 'file-only credentials must reach the adapter through the server');
  assert.equal(upstreamCalls, 1);
  process.env.ZHIHU_ACCESS_SECRET = expectedSecret = 'fixture-env-access-secret';
  assert.equal((await feed()).status, 'ok', 'environment secret overrides file');
  assert.equal(upstreamCalls, 2);
  delete process.env.ZHIHU_ACCESS_SECRET;
  await rm(join(isolated, 'secrets', 'secret'));
  assert.equal((await feed()).status, 'unconfigured', 'missing credentials retain explicit degradation');
  assert.equal(upstreamCalls, 2, 'missing credentials must not contact upstream');
  assert.equal((await get('/v1/ecosystem/friend-timelines')).status, 401);
  console.log('Followee HTTP: isolated file-only credentials, env precedence, missing configuration and login boundary PASS');
} finally {
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  globalThis.fetch = realFetch;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await rm(isolated, { recursive: true, force: true });
}
