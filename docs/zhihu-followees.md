# 故事里的相遇（知乎关注关系）

「我的」页面的「故事里的相遇」区块，在 2026-09-13 从 demo 转为使用知乎官方接口的正式功能。

## 为什么要转正

转正前这块是联调夹具，不是产品：

- 前端是右下角一张 `position: fixed` 的深色悬浮卡片，带关闭按钮，再用一堆 `!important` 硬塞进「我的」页面；
- 「加关注」按钮调 `window.prompt('输入朋友的用户编号：')`，要求用户手输一串内部 UUID；
- 关注关系存在本站内存里（`src/ecosystem/following/fixtures.mjs` 的四个虚构账号），与知乎无关；
- 动态流只渲染裸 `session_uuid` 和时间戳。

## 现在的语义

```text
我在知乎关注的人  →  按 url_token 反查本站账号  →  他主动公开的世界线
```

三段分别由以下部分负责：

| 环节 | 实现 | 边界 |
| --- | --- | --- |
| 我在知乎关注谁 | `src/providers/ecosystem/zhihuFolloweeSource.mjs` | 调官方 `/api/v1/user/followees`，代表当前登录用户 |
| 他是不是本站用户 | `src/ecosystem/following/directory.mjs` | 登录时登记本人 `url_token → 业务 UUID`，反查不到就是空 |
| 他公开了哪段故事 | `src/ecosystem/following/service.mjs` | 仍以本站显式 `POST /share` 记录为唯一依据 |

关注关系不再由本站维护，因此没有「加关注」按钮，`POST /v1/ecosystem/follow` 与 `DELETE /v1/ecosystem/follow/:uuid` 已下线。要增减关注请到知乎。

## 官方接口契约

```text
GET https://developer.zhihu.com/api/v1/user/followees?Offset=&Limit=
Authorization:       Bearer <开放平台 Access Secret>   —— 鉴权「本应用」
X-OAuth-Token:       <该用户的 OAuth access token>     —— 指明「当前代表谁」
X-Request-Timestamp: <秒级 Unix 时间戳>
Content-Type:        application/json
```

资料来源：官方 zhihu Skill 的 `references/user-api.md` 与 `references/oauth.md`（2026-09-13 复核）。同日以真实 Access Secret 实测该端点返回 `Code: 0` 与真实关注列表。

实现约束：

- **两类凭证职责分离，且不可互相顶替。** 缺少用户 OAuth token 时直接报 `missing_oauth_token`，**绝不**降级为 Access Secret 所属账号的关注列表——否则会把运营方的关注关系当成玩家自己的。
- host 锁定 `developer.zhihu.com`，仅 HTTPS 默认端口；重定向手动处理并逐跳重新校验。
- 响应体有大小上限；超时、非 2xx、非 JSON、业务 `Code ≠ 0` 一律抛 typed `ZhihuFolloweeError`，不循环重试。
- 业务错误可能带 HTTP 200，必须按 `Code` 判定（`20001` 鉴权失败，`30001/30002` 频率与配额）。
- 错误信息不含任何凭证内容（测试显式断言 Access Secret 与用户 token 都不出现在 message 里）。
- 分页：`Paging.IsEnd=false` 时按 `NextOffset` 继续；该字段文档标为 String，严格解析，解析失败就停止，不静默回到 `Offset=0` 死循环。默认最多 4 页（≤200 人）。
- 只保留展示所需的公开字段（昵称 / 主页标识 / 主页链接 / 头像 / 一句话介绍），不落粉丝数、性别等冗余画像数据。

## 身份链路

官方关注列表只给 `UrlToken`，不给 `uid`；而本站账号主键是 `app_id + uid` 派生的业务 UUID。两端原本对不上，因此：

1. OAuth 登录成功后，从 `/user` 响应的 `url`（形如 `https://www.zhihu.com/people/<url_token>`）解析出 `url_token`；
2. 通过 `createZhihuOAuth` 的 `onLogin` 钩子登记进账号目录；
3. 读关注流时用关注列表里的 `UrlToken` 反查本站账号。

边界：

- 目录只存公开主页标识与业务 UUID，不存昵称、头像、手机号、邮箱或 token。
- 只有本人登录才能写入自己那一条，没有任何接口能代别人登记。
- 反查不到就是不到，返回空态，绝不猜测或回退到示例数据。
- 用户 access token 只留在服务端会话内，用于官方接口的 `X-OAuth-Token`；不进响应体、日志或 Cookie。`/api/auth/status` 只投影 `user_uuid / display_name / auth_source`。
- 与会话同为单进程内存状态，重启需重新登录。**多进程部署前必须改为共享存储**，否则关注流会因目录不共享而匹配不到人。

## 关注流的可见性规则

- 关注 ≠ 公开。关注某人不会改变其世界线可见性；只有对方自己 `POST /share` 才进入别人的关注流。
- 自己的世界线不进自己的关注流。
- 双向屏蔽都生效：对方屏蔽我、或我屏蔽对方，均不展示。
- 公开投影不含对方的本站内部账号标识。
- 响应缓存 5 分钟，缓存键包含 follower 与**登录态**（token 本身是凭据，不入键）。公开或撤回后整体失效，撤回立即从所有人关注流消失。降级结果（`unavailable` 等）不写缓存：上游持续故障时每次进入「我的」都会重试，代价是最长一次上游超时的等待；如需负面缓存再议。

## 降级（这是必须正确的部分）

`GET /v1/ecosystem/friend-timelines` 已登录时任何失败都返回 200 + 明确 `status`，绝不抛 5xx，也绝不影响故事创建与推进链路。**未登录是例外：路由层直接 401**（`requireAuthUserUuid`），不会走到 service 层的 `login_required` 分支——该分支只在「已登录但会话内无用户 token」时出现。前端对 401 和 `status` 两个分支都有处理：

| `status` | 含义 | 前端文案 |
| --- | --- | --- |
| `ok` | 正常 | 列表，或「还没有人公开过」 |
| `login_required` | 已登录但会话内无用户 token（未登录在路由层即 401） | 登录知乎后查看 |
| `unconfigured` | 未配置 Access Secret | 该能力未在本次部署启用 |
| `missing_oauth_token` | 会话无用户 token | 同上 |
| `unavailable` | 上游超时 / 限流 / 异常 | 暂时读不到，稍后再看 |

响应还带 `followee_count` 与 `matched_count`，因此空态能区分「没读到关注列表」和「关注的人里没人在这儿公开过」，不会把失败显示成「没有人」。

## UI

模块从 `public/scripts/socialPanel.js` 改名为 `public/scripts/communitySection.js`，直接渲染进 `#community-section`，复用 `.recent-section` 的 eyebrow / h2 / 卡片 / 空态语言，与「阅读历史」一致；不再有悬浮宿主与内联样式。

按钮按「无需则取消」处理：关闭、加关注、刷新关注流全部删除（进入「我的」自动加载）。**只保留「公开这段故事 / 撤回」**——那是本人对自己内容的处置，无法由知乎代劳。分享时服务端补上故事标题，列表显示头像、昵称（链到知乎主页）、《书名》与时间。按钮初始态由 `GET /v1/ecosystem/sessions/:uuid/share-status` 恢复（服务端按 canonical owner 判定，非本人会话恒为 `shared:false`，不确认存在性）；否则刷新页面后已公开的会话会错误地显示「公开」。

前端身份边界未松动：不携带任何调用者身份，分享 / 撤回不带 body（服务端要求 `Content-Length: 0`）。转正后前端连 `target_user_uuid` 都不再需要，`public/scripts/` 代码行的调用者身份名命中数要求为 0（比改版前更严格）。

## 验证

```bash
env -u NODE_ENV node scripts/check.mjs      # 140 个文件语法检查
env -u NODE_ENV node scripts/test.mjs       # 全量回归
env -u NODE_ENV node tests/zhihuFollowees.test.mjs
```

`tests/zhihuFollowees.test.mjs` 覆盖：双凭证请求头、字段投影、分页推进与非法 `NextOffset`、未配置 / 缺用户 token、八类上游失败分类、host 锁定与重定向拦截、凭证脱敏、`url_token` 解析与严格反查、关注流交集与屏蔽、全部降级路径、以及「本站自建关注入口确已移除」。

真实账号下的端到端验收仍需本人在知乎授权页确认；模拟上游的测试不能替代该验收。

> 注：若 shell 环境存在 `NODE_ENV=production`，服务启动会因 OAuth 配置检查而直接失败。本地运行测试请用 `env -u NODE_ENV`。
