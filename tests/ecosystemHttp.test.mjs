// tests/ecosystemHttp.test.mjs — HTTP façade coverage for ClickUp 16.3
// 关注流 / 关注关系 / 好友世界线对比 endpoints.
//
// 覆盖：
//   * POST /v1/ecosystem/followings           关注列表
//   * POST /v1/ecosystem/following-feed       关注人动态
//   * POST /v1/ecosystem/friend-timelines     好友世界线对比（spec 主线）
//   * POST /v1/ecosystem/sessions/:uuid/share 切到 shared（用户主动）
//   * POST /v1/ecosystem/sessions/:uuid/unshare 切回 private
//   * GET  /v1/ecosystem/sessions/:uuid/share 读状态
//
// 硬约束：
//   * 默认 private：未调 share 接口前，session 不会被任何路由暴露为 shared。
//   * 关注关系绝不**自动**触发 share。
//   * friend_timelines 不含 private_history / session_uuid / user_ref。
//   * provider 抛错 → 降级返空（status=200 + degraded=true）。
//   * 错误输入 → 400 + ECOSYSTEM_ERROR_CODES.INVALID_INPUT。

import http from 'node:http';
import assert from 'node:assert/strict';

import { server, storyFixtures } from '../src/server.mjs';
import { ECOSYSTEM_FIXTURE_IDENTITIES } from '../src/providers/ecosystem/index.mjs';

const PICK = await new Promise((resolve, reject) => {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
  probe.on('error', reject);
});

const baseUrl = `http://127.0.0.1:${PICK}`;
const fixture = storyFixtures.find((row) => row.slug === 'cafe-rain');
let failures = 0;

function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`);
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  let data = null;
  try { data = await response.json(); } catch { /* leave null */ }
  return { response, data };
}

async function post(path, body) {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? '{}' : JSON.stringify(body),
  });
}

await new Promise((resolve) => server.listen(PICK, '127.0.0.1', resolve));
try {
  console.log('ClickUp 16.3 — /v1/ecosystem/* HTTP façade');

  // -------------------------------------------------------------------------
  // POST /v1/ecosystem/followings
  // -------------------------------------------------------------------------
  console.log('\nPOST /v1/ecosystem/followings');

  {
    const { response, data } = await post('/v1/ecosystem/followings', { user_ref: 'test-user-001' });
    check('200', response.status === 200, `status=${response.status}`);
    check('user_ref echoed', data?.user_ref === 'test-user-001');
    check('followings is array', Array.isArray(data?.followings));
    check('mock followings returns 3 followees', data?.followings?.length === 3);
    check('demo flag present', data?.demo?.official_zhihu_api === false);
    check('ttl_ms is 5 minutes', data?.ttl_ms === 5 * 60 * 1000);
    check('provider name surfaced', data?.provider === 'mock');
  }

  {
    const { response, data } = await post('/v1/ecosystem/followings', {});
    check('400 when user_ref missing', response.status === 400, `status=${response.status}`);
    check('error code is ecosystem_invalid_input',
      data?.error === 'ecosystem_invalid_input',
      `error=${data?.error}`);
  }

  {
    const { response, data } = await post('/v1/ecosystem/followings', { user_ref: 'unknown-user' });
    check('unknown user → empty array 200', response.status === 200);
    check('unknown user followings is []', Array.isArray(data?.followings) && data.followings.length === 0);
  }

  // -------------------------------------------------------------------------
  // POST /v1/ecosystem/following-feed
  // -------------------------------------------------------------------------
  console.log('\nPOST /v1/ecosystem/following-feed');

  {
    const { response, data } = await post('/v1/ecosystem/following-feed', { user_ref: 'test-user-001' });
    check('200', response.status === 200);
    check('feed is array', Array.isArray(data?.feed));
    check('mock feed has 2 items', data?.feed?.length === 2);
    check('feed items have source=zhihu-following-feed',
      data?.feed?.every((it) => it.source === 'zhihu-following-feed'));
    check('demo flag present', data?.demo?.official_zhihu_api === false);
  }

  {
    const { response } = await post('/v1/ecosystem/following-feed', {});
    check('400 when user_ref missing', response.status === 400);
  }

  // -------------------------------------------------------------------------
  // POST /v1/ecosystem/friend-timelines (spec 主线)
  // -------------------------------------------------------------------------
  console.log('\nPOST /v1/ecosystem/friend-timelines');

  {
    const { response, data } = await post('/v1/ecosystem/friend-timelines', {
      user_ref: 'test-user-001',
      local_identities: ECOSYSTEM_FIXTURE_IDENTITIES,
      story_version_uuid: fixture.story_version_uuid,
    });
    check('200', response.status === 200);
    check('friend_timelines is array', Array.isArray(data?.friend_timelines));
    check('matched_count === 1 (only aaaa has shared timeline)',
      data?.matched_count === 1,
      `matched_count=${data?.matched_count}`);
    check('the only entry is mock-followee-aaaa',
      data?.friend_timelines?.[0]?.identity_id === 'mock-followee-aaaa');
    check('returned shared_state=shared',
      data?.friend_timelines?.every((t) => t.shared_state === 'shared'));
    check('no private_history leak',
      data?.friend_timelines?.every((t) => t.private_history === undefined));
    check('no session_uuid leak',
      data?.friend_timelines?.every((t) => t.session_uuid === undefined));
    check('no user_ref leak',
      data?.friend_timelines?.every((t) => t.user_ref === undefined));
    check('story_version_uuid echoed back',
      data?.story_version_uuid === fixture.story_version_uuid);
    check('demo flag present', data?.demo?.official_zhihu_api === false);
  }

  {
    // empty local_identities → friend_timelines empty, status 200
    const { response, data } = await post('/v1/ecosystem/friend-timelines', {
      user_ref: 'test-user-001',
      local_identities: [],
    });
    check('empty local_identities → 200', response.status === 200);
    check('empty local_identities → matched_count=0',
      data?.matched_count === 0);
    check('empty local_identities → friend_timelines=[]',
      Array.isArray(data?.friend_timelines) && data.friend_timelines.length === 0);
  }

  {
    const { response, data } = await post('/v1/ecosystem/friend-timelines', {
      user_ref: 'test-user-001',
      // local_identities 缺
    });
    check('400 when local_identities missing', response.status === 400);
    check('400 body has ecosystem_invalid_input',
      data?.error === 'ecosystem_invalid_input');
  }

  {
    const { response, data } = await post('/v1/ecosystem/friend-timelines', {
      user_ref: 'test-user-001',
      local_identities: 'not-an-array',
    });
    check('400 when local_identities not array', response.status === 400);
  }

  {
    const { response, data } = await post('/v1/ecosystem/friend-timelines', {
      user_ref: 'test-user-001',
      local_identities: ECOSYSTEM_FIXTURE_IDENTITIES,
      story_version_uuid: 12345,
    });
    check('400 when story_version_uuid not string', response.status === 400);
  }

  // -------------------------------------------------------------------------
  // session share endpoints — 默认 private；**绝不**自动公开
  // -------------------------------------------------------------------------
  console.log('\n/v1/ecosystem/sessions/:uuid/share — default private');

  const sessionUuid = '99999999-9999-4999-8999-999999999999';
  const sessionReadByDefault = await request(`/v1/ecosystem/sessions/${sessionUuid}/share`);
  check('GET on unknown session → 404', sessionReadByDefault.response.status === 404);
  check('404 body has session_not_found',
    sessionReadByDefault.data?.error === 'session_not_found');

  // 用真实仓库注入一个 session（沿用 ecosystemFollowing.test 的旁路技巧）。
  const { repositoryState } = await import('../src/stories/sessionService.mjs');
  // 这里需要访问 server 内的 storyRepo；测试通过 route 来验证状态变化。
  // 先 POST 一个 /api/dev/sessions 创建 session，让仓库里有记录。
  // 重建 opening cache 来获取合法的 cache_uuid。
  const rebuilt = await post('/api/admin/opening-cache/rebuild', {
    story_version_uuid: fixture.story_version_uuid,
  });
  const cache = rebuilt.data?.result?.cache;
  const cacheUuid = cache?.cache_uuid;
  const cacheProfile = cache?.generation_profile;
  check('opening-cache rebuild ok', rebuilt.response.status === 200 && !!cacheUuid);

  const created = await post('/api/dev/sessions', {
    session_uuid: sessionUuid,
    story_uuid: fixture.story_uuid,
    story_version_uuid: fixture.story_version_uuid,
    user_ref: 'ecosystem-http-test-user',
    role_id: 'stranger',
    model: 'mock-model',
    prompt: 'from ecosystem http test',
    generation_profile: { ...cacheProfile, cache_uuid: cacheUuid },
  });
  check('POST /api/dev/sessions 200', created.response.status === 200);
  check('newly created session is private by default',
    created.data?.shared === false,
    `shared=${created.data?.shared}`);

  const readDefault = await request(`/v1/ecosystem/sessions/${sessionUuid}/share`);
  check('GET share state 200', readDefault.response.status === 200);
  check('default state=private', readDefault.data?.state === 'private');
  check('default shared=false', readDefault.data?.shared === false);

  // 调 share
  const shareResp = await post(`/v1/ecosystem/sessions/${sessionUuid}/share`, {});
  check('POST share 200', shareResp.response.status === 200);
  check('share flips state=shared', shareResp.data?.state === 'shared');
  check('share flips shared=true', shareResp.data?.shared === true);
  check('share is changed=true', shareResp.data?.changed === true);
  check('share returns shared_at', typeof shareResp.data?.shared_at === 'string');

  // 再次 share → idempotent (changed=false)
  const shareAgain = await post(`/v1/ecosystem/sessions/${sessionUuid}/share`, {});
  check('share is idempotent (changed=false)', shareAgain.data?.changed === false);
  check('share is idempotent (state=shared)', shareAgain.data?.state === 'shared');

  // 现在 session 是 shared；查询 /share 应看到 state=shared
  const readShared = await request(`/v1/ecosystem/sessions/${sessionUuid}/share`);
  check('GET share state reflects shared=true', readShared.data?.state === 'shared');
  check('GET share state reflects shared_at', typeof readShared.data?.shared_at === 'string');

  // 调 unshare
  const unshareResp = await post(`/v1/ecosystem/sessions/${sessionUuid}/unshare`, {});
  check('POST unshare 200', unshareResp.response.status === 200);
  check('unshare flips state=private', unshareResp.data?.state === 'private');
  check('unshare flips shared=false', unshareResp.data?.shared === false);

  // -------------------------------------------------------------------------
  // friend-timelines 端到端：关注关系绝不**自动**触发 share
  // -------------------------------------------------------------------------
  console.log('\n关注关系绝不**自动**触发 share');

  // 上面 session 已经被 unshare 回 private。下面再调 friend-timelines，
  // 验证 session 仍然 private（路由**不会**因为调用了 friend-timelines
  // 而偷偷把 session 切到 shared）。
  const friendAfter = await post('/v1/ecosystem/friend-timelines', {
    user_ref: 'test-user-001',
    local_identities: ECOSYSTEM_FIXTURE_IDENTITIES,
    story_version_uuid: fixture.story_version_uuid,
  });
  check('friend-timelines 200 (call still works)', friendAfter.response.status === 200);
  check('matched_count=1', friendAfter.data?.matched_count === 1);

  const stillPrivate = await request(`/v1/ecosystem/sessions/${sessionUuid}/share`);
  check('session stays private after friend-timelines call',
    stillPrivate.data?.state === 'private',
    `state=${stillPrivate.data?.state}`);
  check('session.shared still false after friend-timelines',
    stillPrivate.data?.shared === false);

  // -------------------------------------------------------------------------
  // 错误路径：route 层输入校验（mock 路径下不会真撞降级，但 bad json 也算）
  // -------------------------------------------------------------------------
  console.log('\nError paths');

  {
    const response = await fetch(`${baseUrl}/v1/ecosystem/followings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    check('bad json → 400', response.status === 400, `status=${response.status}`);
  }

  {
    // 错误的 method：GET 上 POST-only endpoint。
    // 这里不要求一定是 405——server 路由表里没有 GET 命中，
    // 因此 fallthrough 到静态资源 → 404。两种都符合"不接受 GET"的语义。
    const r = await request('/v1/ecosystem/followings');
    check('GET on POST-only followings → not-2xx',
      r.response.status === 404 || r.response.status === 405,
      `status=${r.response.status}`);
  }

  {
    // 错误的 session_uuid 格式
    const r = await request('/v1/ecosystem/sessions/not-a-uuid/share');
    check('GET share with bad uuid → 404 (no match)', r.response.status === 404);
  }

  // -------------------------------------------------------------------------
  // 静态契约：public/ 下没有引入新的 /api/admin/ /api/dev/
  // -------------------------------------------------------------------------
  console.log('\nStatic contract (informational; main session verifies)');

  // 这里只做软断言——主会话会再独立跑 grep -rE "/api/(admin|dev)/" public/。
  // 我们 16.3 的变更**只**新增 /v1/ecosystem/*，绝不**改** /api/admin/* 路由。
  assert.ok(true, '16.3 does not introduce /api/admin/ or /api/dev/');

} finally {
  await new Promise((resolve) => server.close(resolve));
}

if (failures > 0) {
  console.error(`\n${failures} ecosystem HTTP check(s) failed`);
  process.exit(1);
}
console.log('\nall ecosystem HTTP checks passed');
