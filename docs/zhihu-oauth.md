# 知乎 OAuth 登录

## 协议来源

2026-09-13 核对已登录的官方接口文档：
<https://www.zhihu.com/ring/moltbook/api/oauth/oauth_quickstart>，以及其中的「获取 Access Token」「获取用户信息」「知乎 OAuth Skill」。

- 授权：`GET https://openapi.zhihu.com/authorize`，参数 `app_id`、`redirect_uri`、`response_type=code`、随机 `state`。
- 回调：`/auth/callback?authorization_code=...&state=...`，兼容单一 `code` 参数。缺失、不匹配、重复、过期或已使用的 state 一律拒绝，不能降级为无 state 登录。
- 换 Token：`POST https://openapi.zhihu.com/access_token`，表单 `app_id`、`app_key`、`redirect_uri`、`grant_type=authorization_code`、`code`。
- 用户资料：`GET https://openapi.zhihu.com/user`，`Authorization: Bearer <用户 access_token>`。正式响应为根对象的 `uid`、`fullname` 等字段；兼容旧 `code:20000,data:{...}` 包装。业务错误可能使用 HTTP 200，必须检查 JSON。
- `uid` 为 19 位十进制整数，超出 JavaScript 安全整数范围（2^53-1，16 位）。响应体必须在 `JSON.parse` 之前把超长整数字面量转成字符串，否则末几位会被静默改写，既拿不到真实账号，也会让整数校验失败。真实授权验证曾暴露该精度问题。

旧 Hackathon 包里的 `/user` 双凭证示例不适用于该正式 OAuth 接口。故事 Real Provider 和数据平台调用仍保持各自的鉴权契约。

## 配置

服务从被 Git 忽略的 `secrets/secret` 读取以下字段：

```text
OAuth App ID: <由平台分配的应用 ID>
OAuth App Key: <由部署环境安全写入>
OAuth Redirect URI: https://<你的部署域名>/auth/callback
```

环境变量 `ZHIHU_OAUTH_APP_ID`、`ZHIHU_OAUTH_APP_KEY`、`ZHIHU_OAUTH_REDIRECT_URI` 优先于文件；`STORY_OUTSIDE_OAUTH_SECRET_FILE` 可指定其他私有文件。必须保留原有 AI 和 Access Secret 字段，不把密钥填进本文件。文件应为 `0600`，父目录为 `0700`。

存在 OAuth 配置时自动启用登录。生产设置 `NODE_ENV=production` 或显式 `STORY_OUTSIDE_AUTH_MODE=oauth` 可确保配置缺失时启动失败。无配置的本地开发保留 demo 身份；`STORY_OUTSIDE_AUTH_MODE=demo` 不允许在 `NODE_ENV=production` 使用。

回调必须是已登记的公网 HTTPS 地址，路径为 `/auth/callback`。反向代理需要保留 Cookie、Origin 和 Set-Cookie，禁止缓存 `/auth/*`、`/api/auth/status` 和个人会话响应。访问日志应省略 OAuth 回调的查询参数，避免记录授权码。

## 身份和数据边界

- 浏览器只接收随机、不透明的 `__Host-` 会话 Cookie，具有 Secure、HttpOnly、SameSite=Lax、Path=/，不设置 Domain。
- 授权尝试有效期 10 分钟，一次使用；退出或重新发起登录会使旧授权尝试失效。会话最多 8 小时且不超过 Token 有效期。
- Token 只在服务端换取和读取资料时使用，随后丢弃；邮箱、手机号及原始资料不落盘、不返给前端。只保留稳定业务 UUID 和显示昵称。
- 会话存在单一 Node 进程内，重启后必须重新登录。业务故事所有权使用 `app_id + uid` 稳定映射，仍持久化在现有 MariaDB 会话字段；重新登录不丢失所有权。多进程部署前必须改为共享会话存储。
- 会话还保留该用户的 access token 与公开主页标识 `url_token`，仅供服务端代表本人调用知乎用户数据接口（`X-OAuth-Token`）。两者都不返回浏览器：`/api/auth/status` 只投影 `user_uuid`、`display_name`、`auth_source`。`url_token` 用于「故事里的相遇」的账号映射，详见 [故事里的相遇](zhihu-followees.md)。
- 创建、读取、续写、回放、结局以及分享/关注均绑定服务端身份；个人写请求还必须通过同源 Origin 校验。OAuth 模式下禁用旧 `/api/admin/*` 和 `/api/dev/*` 入口。
- 浏览器书架按账号筛选；以前 demo 身份的历史保留但不自动归属给第一个登录账号。
- `POST /auth/logout` 只退出本站，不代表撤销知乎授权。平台当前没有 refresh_token；过期后重新授权。

## 验证

`node tests/zhihuOAuth.test.mjs` 验证协议、安全失败、超时/过期、回调重放、会话轮换、账号隔离及隐私边界。`node tests/zhihuOAuthHttp.test.mjs` 驱动真实 HTTP 路由、模拟知乎上游，覆盖登录及各个人会话路由所有权。`node scripts/test.mjs` 执行全套回归。

上线后的真实验收需要用户亲自在知乎授权页确认；回调必须带回匹配的 state 并成功读取 uid。静态检查和模拟上游测试不能代替该验收。如果平台仍不回传 state，应报告协议不匹配并保持拒绝登录，不能放宽验证。

受控真实授权验证确认：授权回调**确实回传 `state`**（形态为 `/auth/callback?state=...&authorization_code=...`），与旧资料中「实测不返 state」的记载不同，严格单次 state 校验可以正常工作。该验证同时暴露了 19 位 `uid` 的精度缺陷，已在协议来源一节记录。
