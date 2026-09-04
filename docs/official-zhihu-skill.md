# 官方知乎 Skill 调用边界与当前 Mock/Adapter 约定

> 这份文档描述本仓库（`story-outside`）对接知乎官方能力的边界，以及当前 MVP 在没有真实联调能力时使用的 mock/adapter 约定。
>
> 编写时的官方 Skill 快照见 `vendor/zhihu-hackathon/`，对应包 SHA-256 见 `vendor/zhihu-hackathon/references/official-skill-snapshot.md`（`be08e10b…2f9f3`）。官方 Skill 不参与构建，不在 `package.json` 依赖里；下次更新时**先**重新校验哈希，**再**核对本文。

## 1. 当前阶段定位

- 默认模式仍是 mock：服务端 `src/server.mjs` 在内存里维护 2 个示例故事，所有响应都带 `demo.official_zhihu_api: false` 字段。
- `STORY_OUTSIDE_PROVIDER=real` 接入官方 **zhihu_hackathon_2026_p2** 故事内容 API（端点见 §3）。响应里的 `demo` 段随之改为 `{ mode: 'live', provider: 'real', official_zhihu_api: true, contract: 'zhihu_hackathon_2026_p2', auth: 'none' }`。
- 真实 API 仅在 `zhihu_hackathon_2026_p2` 比赛窗口内可用；活动结束后路径、响应或可用状态可能调整（见 `references/hackathon-content-api.md`）。比赛结束后请把 `STORY_OUTSIDE_PROVIDER` 切回 `mock`。
- 我们**没有**调用官方 `zhihu-cli`、**没有**交换任何 OAuth Token、**没有**保存 App ID / App Key / Access Secret。真实故事 API 当前不需要鉴权（详见 §3.3）。

## 2. mock ↔ 官方 adapter 的接缝

| 现在的 mock | 未来真实 adapter | 替换位置 |
| --- | --- | --- |
| `GET /api/stories` 返回 `STORIES` 数组 | 由 `src/providers/realProvider.mjs` 调用 `https://api.zhihu.com/km-indep-home/hackathon/v2/story/list` 并按契约映射 | `src/providers/realProvider.mjs` 的 `listStories()` |
| `GET /api/stories/:id` 返回单条 + beats | 同样由 `realProvider` 调 `…/story/{work_id}` 详情端点，按契约映射；`content` 作为单一 narration beat 保留原文，不切割为虚构的 dialogue/ask_player_choice | `src/providers/realProvider.mjs` 的 `getStory()` |
| `POST /api/stories/advance` 仅递增 index | 真实 API 没有结构化 beats；advance 总是立即 finished（已展示完 `content`） | `src/providers/realProvider.mjs` 的 `advanceStory()` |
| `POST /api/chat` 原样回显 | 真正的群聊逐句播放；与本次真实 API 接缝无关 | 同上 handler（仍留在 `src/server.mjs`，不是 provider 接缝的一部分） |
| `GET /api/health` 返回 demo 标志 | `STORY_OUTSIDE_PROVIDER=real` 时切换为 live 模式并新增 `provider: 'real'` 字段 | `src/server.mjs` 的 `currentDemoFlag()` |

Provider 接缝的关键文件：

- `src/providers/dto.mjs` —— 与 transport 无关的 DTO（`StorySummary`、`StoryDetail`、`AdvanceResult` 等）和错误类型（`StoryNotFoundError`、`ValidationError`）。
- `src/providers/mockProvider.mjs` —— 内存版 Mock；返回上面 DTO。
- `src/providers/index.mjs` —— Provider 选择器；读 `STORY_OUTSIDE_PROVIDER`（默认 `mock`）。
- `src/providers/realProvider.mjs` —— 已实现；按官方契约对接故事 API；不发送 `Authorization`/`X-OAuth-Token`；不消费任何环境变量型 credential；超时 / 429 / 5xx / 非 JSON / 缺字段均抛出 typed `ProviderError`，不循环重试；上游响应原文保留在 `source.raw` 以便溯源。

选择器规则：

- `STORY_OUTSIDE_PROVIDER=mock`（默认） → MockProvider。
- `STORY_OUTSIDE_PROVIDER=real` → RealZhihuProvider；启动只需 Node ≥ 18 的内置 `fetch`，无需任何 secret。
- `STORY_OUTSIDE_PROVIDER=<其他>` → 启动报 `Unknown STORY_OUTSIDE_PROVIDER`。

后端**不**直接依赖 `vendor/zhihu-hackathon/scripts/*.mjs`。它们是编排型脚本，不属于运行依赖。后续若要"按官方指引执行 OAuth 流程"，应当是开发机本地跑这些脚本去申请/写入钥匙串，**而不是**服务器在每次启动时去跑。`src/providers/realProvider.mjs` 一律不许 `import` 任何 `vendor/zhihu-hackathon/**` 路径。

## 3. 官方 API 调用边界（按官方 Skill 与 references 整理）

### 3.1 三类凭证必须分开

| 凭证 | 用途 | 安全存储 |
| --- | --- | --- |
| `app_id`（App ID） | 标识第三方应用 | 项目公开配置 `hackathon.config.json` 的 `oauth.appId` |
| `app_key`（OAuth App Key） | 后端交换 OAuth Token | macOS 钥匙串 / 部署平台 Secret 注入为 `ZHIHU_OAUTH_APP_KEY` |
| Access Secret | 鉴权开放平台调用方 | 官方 `zhihu-cli` 凭证存储 / 部署平台 Secret 注入为 `ZHIHU_ACCESS_SECRET` |

**禁止把 App ID 写进 `ZHIHU_OAUTH_APP_KEY`，也禁止把 OAuth App Key 写进 `ZHIHU_ACCESS_SECRET`。**

本仓库**任何位置都不保存这三个值**。当前真实故事 API（`zhihu_hackathon_2026_p2`）按 `references/hackathon-content-api.md` 不需要鉴权，因此 real provider 不读取上面任何凭证。未来若官方要求鉴权，必须先在本文档补一节"接入凭证前必要的安全检查"，再在 `realProvider` 里接收已加载的凭证值，**绝不**让它读 `.env` / `process.env` 中任何看起来像凭据的键。

### 3.2 故事内容端点（黑客松专用，无鉴权）

```
GET https://api.zhihu.com/km-indep-home/hackathon/v2/story/list
GET https://api.zhihu.com/km-indep-home/hackathon/v2/story/{work_id}
```

请求头：仅 `Accept: application/json`（加上 `User-Agent` 仅为绕过部分 CDN 边缘限制；不含任何凭据）。

列表响应字段：`work_id`、`title`、`artwork`、`tab_artwork`、`description`、`labels`（及其他服务端可新增字段，客户端须兼容缺失字段并保留未识别字段）。

详情响应字段：`work_id`、`chapter_name`、`author_avatar`、`author_name`、`labels`、`introduction`、`content`（同上）。

`work_id` 取自对应列表接口的返回；调用详情前必须校验非空、长度 ≤ 128，且不含 `/`、`?`、`#`、回车、换行或控制字符。provider 内部用 `encodeURIComponent` 走 URL path 编码，禁止拼接未校验输入。

调用失败、超时、`429`/`5xx`、非 JSON 响应、缺字段、空 body 等情形须抛出 typed `ProviderError`，永不循环重试、永不伪造正文、永不回显上游错误 body。

### 3.3 用户数据接口的鉴权头

```
Authorization: Bearer <Access Secret>
X-OAuth-Token: <OAuth access_token>
```

`app_key` **不是** `X-OAuth-Token`。

> **本次黑客松故事接口不需要以上鉴权头**。`realProvider` 显式禁用 `Authorization` 和 `X-OAuth-Token`，并在 `meta.forbiddenRequestHeaders` 中暴露该约束以供集成评审使用。

### 3.4 已知协议缺口（来自官方 `oauth-boundary.md`）

- 真实回调参数是 `authorization_code`；后端兼容 `code`。
- Token 接口表单仍用 `code`，固定 `grant_type=authorization_code`。
- 实测回调可能不返回 `state` —— 不能宣称通过标准 OAuth CSRF 校验。
- 没有 PKCE / scope / refresh token / 撤销 / 解绑 / 拒绝授权协议。
- `/user` 没有正式响应 schema —— 不能伪造字段。

这意味着我们的 OAuth 联调**只能是黑客松基线**，不能宣称"生产安全"。

### 3.5 部署边界

- 本地 `http://127.0.0.1:4173/` 只能预览页面，不能完成知乎登录。
- 真实 OAuth 必须部署到 Cloudflare / Sealos 等平台，使用公网 HTTPS 回调 `https://<public-domain>/auth/callback`，并和知乎开放平台登记值完全一致。
- `PORT` / `HOST` 必须可配：默认 `127.0.0.1:4173`，未来部署时切换到平台要求的地址。
- 黑客松故事 API 不需要公网回调；`STORY_OUTSIDE_PROVIDER=real` 在任何能联网到 `api.zhihu.com` 的环境下都能跑。

## 4. Demo / Live 模式如何被客户端识别

每个 JSON 响应都附 `demo` 段：

- mock 默认：
  ```json
  {
    "demo": {
      "mode": "demo",
      "official_zhihu_api": false,
      "reason": "Phase 2 builds an interactive narrative demo without touching the real Zhihu Open Platform. Data is served by src/providers/mockProvider.mjs (default STORY_OUTSIDE_PROVIDER=mock). See docs/official-zhihu-skill.md for the planned real-provider integration boundary."
    }
  }
  ```
- real provider：
  ```json
  {
    "demo": {
      "mode": "live",
      "provider": "real",
      "official_zhihu_api": true,
      "contract": "zhihu_hackathon_2026_p2",
      "auth": "none",
      "scope": "zhihu_hackathon_2026_p2",
      "reason": "Live mode: data is served by src/providers/realProvider.mjs against api.zhihu.com/km-indep-home/hackathon/v2/story/*. ..."
    }
  }
  ```

`/api/health` 额外携带顶层 `provider: 'mock' | 'real'`，方便客户端不需要解 `demo` 段也能判断。

前端在 `public/scripts/app.js` 的 `applyDemoBanner()` 里：

- 把 `data-mode-tag` 的横幅标记成 `demo · 未连接知乎官方 API` 或 `live · 已连接知乎黑客松 API`；
- 把 `[data-demo-meta]` 元数据写入首屏；
- 任何后续 adapter 接入后必须把这个标记置为 `live` 并清掉 demo 横幅。

## 5. 现在不做、以后要做

- ❌ 现在：不引入官方 `zhihu-cli`、不写 OAuth handler、不写 Token 会话。
- ✅ 现在：`STORY_OUTSIDE_PROVIDER=real` 可直接对接黑客松故事 API；无 Access Secret；超时 / 429 / 5xx / 缺字段统一返回 typed error；不循环重试。
- ✅ 以后：先在生产域名上把 OAuth 跑通 → 验收 5 项用户接口（创作 / 关注 / 收藏夹列表 / 收藏夹内容 / 近期收藏）→ 才把用户数据接入游戏业务。
- ✅ 以后：医生脚本（`vendor/zhihu-hackathon/scripts/doctor.mjs`）只在开发机运行；CI 不跑。

## 6. 校验快照

每次官方 Skill 更新后：

1. 重新下载 `https://developer-cdn.zhihu.com/zhihu-cli/releases/stable/skill/zhihu-cli-skill.zip`；
2. 解压到 `vendor/zhihu-hackathon/`；
3. 更新 `vendor/zhihu-hackathon/references/official-skill-snapshot.md` 里的 SHA-256；
4. 把本次变更要点追加到本文末尾"变更日志"。