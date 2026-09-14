# 我关注的人

关注动态取自当前登录用户的知乎官方关注列表，与本站已登录账号的公开主页标识对应，显示这些账号正在玩的故事。动态只投影公开昵称、头像、故事标题、状态与时间，不包含剧情正文或玩家输入。

动态中的小说标题链接到本站对应小说的详情页（`/?story=<slug>`），支持新标签页与刷新。链接标识取自服务端小说目录，不使用其他玩家的游戏会话；缺少可用标识时仅显示标题文字。

## 可见性

“让关注我的人看到我在玩什么”为账号级开关，默认开启。关闭后所有故事动态立即隐藏；重新开启后恢复。隐身偏好和知乎主页映射保存在 MariaDB 的 `ecosystem_account_preferences`，重新登录、刷新和部署重启均不重置。双向屏蔽仍然优先。

历史 share/unshare 接口保留兼容，但不再决定活动动态可见性。前端不需要指定当前故事，设置请求只发送 `{ visible: boolean }`，调用者由服务端登录态解析。公开动态不提供其他用户会话的读取权限。

## 接口与凭证

- `GET /v1/ecosystem/visibility`：读取本人设置。
- `PUT /v1/ecosystem/visibility`：更新本人设置；需要登录、同源请求，拒绝额外字段。
- `GET /v1/ecosystem/friend-timelines`：知乎关注关系与本站可见活动的交集。
- 官方上游：`GET https://developer.zhihu.com/api/v1/user/followees`，`Authorization: Bearer <Access Secret>` 与 `X-OAuth-Token: <当前用户授权令牌>` 职责分离，不互相替代。
- 服务端复用现有 `loadZhihuAccessSecret`，环境变量优先，否则读取忽略文件 `secrets/secret`，无需新增或更换线上凭证。
- 知乎令牌仍仅留在登录会话内，重启后需要重新登录。持久化的主页映射不包含令牌。

## 登录账号与公开主页的对应

OAuth `GET https://openapi.zhihu.com/user` 的 `url` 实际为 `/users/<数字 UID>`，不能将其当作 `/people/<url_token>`，也不能将数字 UID 直接用于关注列表匹配。

当 OAuth 资料没有可用的公开主页地址时，使用该资料的 `hash_id` 查询 `GET https://www.zhihu.com/api/v4/members/<hash_id>?include=url_token`，核对响应 `id` 与 `hash_id` 完全一致后，才登记响应中的 `url_token`。此公开用户接口已于 2026-09-14 在 VM3 实测；请求不携带 OAuth token、Access Secret 或 Cookie，禁止重定向，并限制为 5 秒和 64 KiB。已有 `/people/` 资料继续直接使用。

公开资料查询失败仍允许登录，但不猜测账号映射，并记录 `following.identity.unavailable`，便于区分没有活动与身份解析失败。旧版本未登记的玩家需要在修复后重新登录一次才能补齐映射；账号 UUID、已有游戏和可见性偏好保持不变。后续部署重启可从数据库恢复已登记的映射。

## 发布

启动新版前执行迁移 `0009_following_account_preferences.sql`。这是新增表与迁移记录，旧版本不依赖此表，可回滚应用代码。数据库启动检查要求 migration 0009 已应用。

## 验证

单元与 HTTP 测试覆盖默认可见、关闭隐藏、其他账号不受影响、双向屏蔽、重登不重置、账号标识变更、无效写入与未登录访问；数据库测试验证真实 MariaDB 多次实例恢复。真实双账号的关注交集验收需要双方在知乎登录本站。
