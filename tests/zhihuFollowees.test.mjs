// tests/zhihuFollowees.test.mjs — 知乎官方「用户关注」接口适配层 + 账号目录 +
// 关注流编排的回归。
//
// 「故事里的相遇」转正后，关注关系来自官方接口而不是本站维护的图谱。这里覆盖
// 四类路径（成功 / 未配置 / 未登录 / 上游失败）以及安全边界：
//
//   * 双凭证分工：Authorization 是开放平台 Access Secret，X-OAuth-Token 是
//     当前登录用户的 OAuth token，X-Request-Timestamp 是秒级时间戳。
//   * 缺少用户 token 时**绝不**降级为 Access Secret 所属账号的关注列表
//     —— 否则会把运营方的关注关系当成玩家自己的。
//   * host 锁定 developer.zhihu.com；重定向到别处必须拒绝。
//   * 业务错误可能带 HTTP 200，必须按 Code 判定（20001=鉴权失败）。
//   * 错误信息不得泄漏凭证内容。
//   * 关注流只展示「我关注的人 ∩ 本站登录过 ∩ 本人公开了世界线」。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  fetchFollowees,
  hasFolloweeCredentials,
  readAccessSecret,
  ZhihuFolloweeError,
  _internals,
} from '../src/providers/ecosystem/zhihuFolloweeSource.mjs';
import { createZhihuAccountDirectory } from '../src/ecosystem/following/directory.mjs';
import { computeFriendTimelines, createFollowingService } from '../src/ecosystem/following/service.mjs';
import { createInMemoryFollowingRepository } from '../src/ecosystem/following/repository.mjs';
import { urlTokenFromProfileUrl, ownerFromProfile } from '../src/auth/zhihuOAuth.mjs';
import { repositoryState } from '../src/stories/sessionService.mjs';

const SECRET = 'test-access-secret-value';
const TOKEN = 'test-user-oauth-token';
const ENV = { ZHIHU_ACCESS_SECRET: SECRET };

function jsonResponse(body, init = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status || 200,
    headers: init.headers || { 'content-type': 'application/json' },
  });
}

function followeePayload(items, paging) {
  return { Code: 0, Message: 'success', Data: { Items: items, Paging: paging } };
}

const SAMPLE = [
  {
    Fullname: '夜读人',
    UrlToken: 'night-reader',
    Url: 'https://www.zhihu.com/people/night-reader',
    AvatarUrl: 'https://pic1.zhimg.com/50/v2-abc.jpg',
    Headline: '凌晨读短篇的人。',
    Gender: 0,
    FollowerCount: 12,
  },
  {
    Fullname: '咖啡馆漫游',
    UrlToken: 'cafe-wanderer',
    Url: 'https://www.zhihu.com/people/cafe-wanderer',
    AvatarUrl: 'https://pic2.zhimg.com/50/v2-def.jpg',
    Headline: '凌晨常驻咖啡馆。',
    Gender: 2,
    FollowerCount: 34,
  },
];

// 适配层输出（归一化后）的形状：关注流编排消费的是这个，而不是上游原始字段。
const NORMALISED = [
  {
    url_token: 'night-reader',
    fullname: '夜读人',
    url: 'https://www.zhihu.com/people/night-reader',
    avatar_url: 'https://pic1.zhimg.com/50/v2-abc.jpg',
    headline: '凌晨读短篇的人。',
  },
  {
    url_token: 'cafe-wanderer',
    fullname: '咖啡馆漫游',
    url: 'https://www.zhihu.com/people/cafe-wanderer',
    avatar_url: 'https://pic2.zhimg.com/50/v2-def.jpg',
    headline: '凌晨常驻咖啡馆。',
  },
];

// ---------------------------------------------------------------------------
// 请求契约
// ---------------------------------------------------------------------------
{
  const calls = [];
  const result = await fetchFollowees({ oauthToken: TOKEN, limit: 20 }, {
    env: ENV,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(followeePayload(SAMPLE, { IsEnd: true, NextOffset: '2', Totals: 2 }));
    },
  });
  assert.equal(calls.length, 1, '一页就结束时不应继续翻页');
  const requested = new URL(calls[0].url);
  assert.equal(requested.origin, 'https://developer.zhihu.com');
  assert.equal(requested.pathname, '/api/v1/user/followees');
  assert.equal(requested.searchParams.get('Limit'), '20');
  assert.equal(requested.searchParams.get('Offset'), '0');

  const headers = calls[0].options.headers;
  assert.equal(headers.authorization, `Bearer ${SECRET}`, 'Authorization 必须是 Access Secret');
  assert.equal(headers['x-oauth-token'], TOKEN, 'X-OAuth-Token 必须是用户 token');
  assert.match(String(headers['x-request-timestamp']), /^\d{10,}$/, '必须带秒级时间戳');
  assert.equal(calls[0].options.redirect, 'manual', '重定向必须手动校验');

  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items.map((i) => i.url_token), ['night-reader', 'cafe-wanderer']);
  assert.equal(result.items[0].fullname, '夜读人');
  assert.equal(result.items[0].url, 'https://www.zhihu.com/people/night-reader');
  assert.equal(result.total, 2);
  // 只保留展示所需字段，不把粉丝数、性别等冗余画像数据带进本站。
  assert.deepEqual(
    Object.keys(result.items[0]).sort(),
    ['avatar_url', 'fullname', 'headline', 'url', 'url_token'],
  );
  console.log('知乎关注接口：双凭证请求契约与字段投影: PASS');
}

// ---------------------------------------------------------------------------
// 分页：IsEnd=false 时按 NextOffset 继续；NextOffset 不可解析时停止
// ---------------------------------------------------------------------------
{
  const offsets = [];
  const result = await fetchFollowees({ oauthToken: TOKEN, limit: 2 }, {
    env: ENV,
    maxPages: 3,
    fetchImpl: async (url) => {
      const offset = new URL(url).searchParams.get('Offset');
      offsets.push(offset);
      if (offset === '0') {
        return jsonResponse(followeePayload(SAMPLE, { IsEnd: false, NextOffset: '2', Totals: 3 }));
      }
      return jsonResponse(followeePayload([
        { Fullname: '夜班店员', UrlToken: 'clerk-by-night', Url: 'https://www.zhihu.com/people/clerk-by-night', AvatarUrl: '', Headline: '' },
      ], { IsEnd: true, Totals: 3 }));
    },
  });
  assert.deepEqual(offsets, ['0', '2']);
  assert.equal(result.items.length, 3);

  // NextOffset 非法（文档已标注它是 String，必须严格解析）→ 停在当前页，
  // 不能静默回到 Offset=0 无限循环。
  let pages = 0;
  const looped = await fetchFollowees({ oauthToken: TOKEN }, {
    env: ENV,
    maxPages: 5,
    fetchImpl: async () => {
      pages += 1;
      return jsonResponse(followeePayload(SAMPLE, { IsEnd: false, NextOffset: 'not-a-number', Totals: 9 }));
    },
  });
  assert.equal(pages, 1, '非法 NextOffset 必须停止翻页');
  assert.equal(looped.items.length, 2);
  console.log('知乎关注接口：分页推进与非法 NextOffset 处理: PASS');
}

// ---------------------------------------------------------------------------
// 未配置 / 未登录：绝不降级为 Access Secret 所属账号
// ---------------------------------------------------------------------------
{
  assert.equal(readAccessSecret({}), null);
  assert.equal(hasFolloweeCredentials({}), false);
  assert.equal(hasFolloweeCredentials(ENV), true);

  await assert.rejects(
    fetchFollowees({ oauthToken: TOKEN }, { env: {}, fetchImpl: async () => { throw new Error('must not call'); } }),
    (error) => error instanceof ZhihuFolloweeError && error.code === 'unconfigured',
  );

  for (const badToken of [undefined, null, '', '   has space', 'line\nbreak']) {
    await assert.rejects(
      fetchFollowees({ oauthToken: badToken }, { env: ENV, fetchImpl: async () => { throw new Error('must not call'); } }),
      (error) => error instanceof ZhihuFolloweeError && error.code === 'missing_oauth_token',
      `token=${JSON.stringify(badToken)}`,
    );
  }
  console.log('知乎关注接口：缺凭证/缺用户 token 一律拒绝，不读运营方账号: PASS');
}

// ---------------------------------------------------------------------------
// 上游失败：typed error、按 Code 判定、不泄漏凭证
// ---------------------------------------------------------------------------
{
  const cases = [
    { name: 'HTTP 401', impl: async () => jsonResponse({}, { status: 401 }), code: 'upstream_unauthorized' },
    { name: 'HTTP 429', impl: async () => jsonResponse({}, { status: 429 }), code: 'upstream_rate_limited' },
    { name: 'HTTP 500', impl: async () => jsonResponse({}, { status: 500 }), code: 'upstream_http_error' },
    { name: '非 JSON', impl: async () => jsonResponse('not json at all'), code: 'upstream_invalid_json' },
    { name: '业务 Code 20001（HTTP 200）', impl: async () => jsonResponse({ Code: 20001, Message: 'auth failed' }), code: 'upstream_unauthorized' },
    { name: '业务 Code 30002 配额', impl: async () => jsonResponse({ Code: 30002, Message: 'quota' }), code: 'upstream_rate_limited' },
    { name: '业务 Code 90001', impl: async () => jsonResponse({ Code: 90001, Message: 'internal' }), code: 'upstream_business_error' },
    { name: '网络异常', impl: async () => { throw new TypeError(`fetch failed for ${SECRET}`); }, code: 'upstream_network_error' },
  ];
  for (const item of cases) {
    await assert.rejects(
      fetchFollowees({ oauthToken: TOKEN }, { env: ENV, fetchImpl: item.impl }),
      (error) => {
        assert.ok(error instanceof ZhihuFolloweeError, item.name);
        assert.equal(error.code, item.code, item.name);
        // 关键安全断言：错误信息里不得出现 Access Secret 或用户 token。
        assert.ok(!error.message.includes(SECRET), `${item.name} 泄漏了 Access Secret`);
        assert.ok(!error.message.includes(TOKEN), `${item.name} 泄漏了用户 token`);
        return true;
      },
      item.name,
    );
  }

  // 重定向到非白名单主机必须拒绝。
  await assert.rejects(
    fetchFollowees({ oauthToken: TOKEN }, {
      env: ENV,
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/api/v1/user/followees' } }),
    }),
    (error) => error.code === 'upstream_redirect_blocked',
  );
  assert.equal(_internals.isAllowedUrl('https://developer.zhihu.com/api/v1/user/followees'), true);
  assert.equal(_internals.isAllowedUrl('http://developer.zhihu.com/api/v1/user/followees'), false);
  assert.equal(_internals.isAllowedUrl('https://developer.zhihu.com.evil.example/x'), false);
  assert.equal(_internals.isAllowedUrl('https://developer.zhihu.com:8443/x'), false);
  console.log('知乎关注接口：上游失败分类、host 锁定与凭证脱敏: PASS');
}

// ---------------------------------------------------------------------------
// 账号目录：url_token ↔ 本站业务 UUID
// ---------------------------------------------------------------------------
{
  assert.equal(urlTokenFromProfileUrl('https://www.zhihu.com/people/night-reader'), 'night-reader');
  assert.equal(urlTokenFromProfileUrl('https://zhihu.com/people/abc-123/'), 'abc-123');
  assert.equal(urlTokenFromProfileUrl('https://evil.example/people/night-reader'), null);
  assert.equal(urlTokenFromProfileUrl('https://www.zhihu.com/org/company'), null);
  assert.equal(urlTokenFromProfileUrl(undefined), null);

  // /user 带 url 时，owner 上会出现 url_token；它是公开资料，不含隐私字段。
  const owner = ownerFromProfile({ uid: '1234567890123456789', fullname: '夜读人', url: 'https://www.zhihu.com/people/night-reader', email: 'private@example.test' }, '413');
  assert.equal(owner.url_token, 'night-reader');
  assert.ok(!JSON.stringify(owner).includes('private@example.test'));
  const withoutUrl = ownerFromProfile({ uid: '123456', fullname: '无主页' }, '413');
  assert.equal(withoutUrl.url_token, undefined, '没有 url 就不臆造 url_token');

  const directory = createZhihuAccountDirectory();
  assert.equal(directory.remember(owner), true);
  assert.equal(directory.resolve('night-reader'), owner.user_uuid);
  assert.equal(directory.resolve('never-seen'), null, '没登记过必须返回 null，不猜测');
  assert.equal(directory.remember({ url_token: 'x', user_uuid: 'not-a-uuid' }), false);
  assert.equal(directory.remember({ url_token: 'bad token!', user_uuid: randomUUID() }), false);
  // 幂等：重复登录不产生第二条。
  directory.remember(owner);
  assert.equal(directory.size(), 1);
  console.log('账号目录：url_token 解析、登记与严格反查: PASS');
}

// ---------------------------------------------------------------------------
// 关注流编排：我关注的人 ∩ 本站登录过 ∩ 本人公开了世界线
// ---------------------------------------------------------------------------
{
  const me = randomUUID();
  const friend = randomUUID();
  const strangerOwner = randomUUID();
  const friendSession = randomUUID();
  const strangerSession = randomUUID();

  const repository = createInMemoryFollowingRepository();
  repository.upsertSharedSession({ session_uuid: friendSession, owner_user_uuid: friend, title: '雨夜咖啡馆', story_uuid: randomUUID() });
  repository.upsertSharedSession({ session_uuid: strangerSession, owner_user_uuid: strangerOwner, title: '不该看到的故事' });

  const directory = createZhihuAccountDirectory();
  directory.remember({ url_token: 'night-reader', user_uuid: friend });
  // cafe-wanderer 在知乎被关注，但没在本站登录过 → 不该出现。

  const storyRepository = {
    findStoryByUuid: () => ({ title: '兜底书名' }),
  };
  // findOwnShare 走 findCanonicalOwnerBySession（真实 sessionService），归属
  // 存在 symbol 键的会话状态里；用真实导出的 repositoryState 播种，不伪造形状。
  const ownershipRepository = {};
  const ownershipSessions = repositoryState(ownershipRepository).sessions;
  ownershipSessions.set(friendSession, { user_uuid: friend });

  const service = createFollowingService({
    repository,
    accountDirectory: directory,
    fetchFollowees: async ({ oauthToken }) => {
      assert.equal(oauthToken, TOKEN, '必须把当前登录者的 token 传给适配层');
      return { items: NORMALISED, total: 2, truncated: false };
    },
  });

  const feed = await service.friendTimelinesSafe({ followerUuid: me, oauthToken: TOKEN, storyRepository });
  assert.equal(feed.status, 'ok');
  assert.equal(feed.followee_count, 2, '知乎侧关注 2 人');
  assert.equal(feed.matched_count, 1, '其中只有 1 人在本站登录过');
  assert.equal(feed.items.length, 1, '只展示匹配上且已公开的世界线');
  assert.equal(feed.items[0].session_uuid, friendSession);
  assert.equal(feed.items[0].story_title, '雨夜咖啡馆');
  assert.equal(feed.items[0].author.fullname, '夜读人');
  assert.equal(feed.items[0].author.url, 'https://www.zhihu.com/people/night-reader');
  // 公开投影不得带对方的本站内部账号标识。
  assert.equal(feed.items[0].owner_user_uuid, undefined);
  assert.ok(!JSON.stringify(feed.items[0]).includes(friend));
  // 未被关注的人的世界线绝不出现。
  assert.ok(!JSON.stringify(feed.items).includes(strangerSession));

  // 屏蔽：对方屏蔽我 → 不展示。
  repository.upsertBlock(friend, me);
  const blocked = await service.friendTimelinesSafe({ followerUuid: me, oauthToken: TOKEN, storyRepository, limit: 19 });
  assert.equal(blocked.items.length, 0, '被对方屏蔽后不再展示');
  repository.removeBlock(friend, me);

  // 自己的世界线不进自己的关注流。
  const selfDirectory = createZhihuAccountDirectory();
  selfDirectory.remember({ url_token: 'night-reader', user_uuid: me });
  const selfService = createFollowingService({
    repository,
    accountDirectory: selfDirectory,
    fetchFollowees: async () => ({ items: NORMALISED, total: 2, truncated: false }),
  });
  repository.upsertSharedSession({ session_uuid: randomUUID(), owner_user_uuid: me, title: '我自己的故事' });
  const selfFeed = await selfService.friendTimelinesSafe({ followerUuid: me, oauthToken: TOKEN, storyRepository });
  assert.equal(selfFeed.items.length, 0, '自己的世界线不进自己的关注流');

  // 降级路径：未登录 / 未配置 / 上游失败一律返回空列表 + 明确 status。
  const noToken = await service.friendTimelinesSafe({ followerUuid: me, oauthToken: null, storyRepository });
  assert.equal(noToken.status, 'login_required');
  assert.equal(noToken.items.length, 0);

  const unconfigured = createFollowingService({ repository, accountDirectory: directory, fetchFollowees: null });
  const unconfiguredFeed = await unconfigured.friendTimelinesSafe({ followerUuid: me, oauthToken: TOKEN });
  assert.equal(unconfiguredFeed.status, 'unconfigured');

  const failing = createFollowingService({
    repository,
    accountDirectory: directory,
    fetchFollowees: async () => { throw new ZhihuFolloweeError('upstream_timeout', 'timed out'); },
  });
  const failed = await failing.friendTimelinesSafe({ followerUuid: me, oauthToken: TOKEN });
  assert.equal(failed.status, 'unavailable', '上游失败必须降级而不是抛错');
  assert.equal(failed.items.length, 0);

  // 纯函数层：显式传入 owner 集合即可钉死输出。
  const pure = computeFriendTimelines({ repository, followerUuid: me, ownerUuids: [friend] });
  assert.equal(pure.follower_uuid, me);
  assert.ok(pure.items.length >= 1);

  // findOwnShare：本人查询「当前会话是否已被自己公开」，供 share-status
  // 路由恢复按钮初始态。非本人或未公开一律 null，不确认存在性。
  const mySession = randomUUID();
  ownershipSessions.set(mySession, { user_uuid: me });
  assert.equal(service.findOwnShare({ storyRepository: ownershipRepository, sessionUuid: friendSession, ownerUuid: me }), null, '别人的会话查不到自己的分享');
  assert.equal(service.findOwnShare({ storyRepository: ownershipRepository, sessionUuid: mySession, ownerUuid: me }), null, '未公开的会话返回 null');
  repository.upsertSharedSession({ session_uuid: mySession, owner_user_uuid: me, title: '我的公开' });
  const ownShare = service.findOwnShare({ storyRepository: ownershipRepository, sessionUuid: mySession, ownerUuid: me });
  assert.ok(ownShare && ownShare.session_uuid === mySession, '本人已公开的会话能查到');
  assert.equal(
    service.findOwnShare({ storyRepository: ownershipRepository, sessionUuid: mySession, ownerUuid: friend }),
    null,
    '其他账号查同一会话必须返回 null',
  );
  console.log('关注流编排：真实关注 ∩ 本站账号 ∩ 已公开，含屏蔽与全部降级路径: PASS');
}

// ---------------------------------------------------------------------------
// 服务不再提供本站自建关注关系
// ---------------------------------------------------------------------------
{
  const service = createFollowingService({ repository: createInMemoryFollowingRepository() });
  assert.equal(typeof service.follow, 'undefined', 'follow 已随 demo 一起下线');
  assert.equal(typeof service.unfollow, 'undefined', 'unfollow 已随 demo 一起下线');
  console.log('服务面：本站自建关注关系入口已移除: PASS');
}

console.log('\n知乎关注接口 + 账号目录 + 关注流: PASS');
