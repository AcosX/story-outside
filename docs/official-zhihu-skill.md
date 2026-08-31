# 官方知乎 Skill 调用边界与当前 Mock/Adapter 约定

> 这份文档描述本仓库（`story-outside`）对接知乎官方能力的边界，以及当前 MVP 在没有真实联调能力时使用的 mock/adapter 约定。
>
> 编写时的官方 Skill 快照见 `vendor/zhihu-hackathon/`，对应包 SHA-256 见 `vendor/zhihu-hackathon/references/official-skill-snapshot.md`（`be08e10b…2f9f3`）。官方 Skill 不参与构建，不在 `package.json` 依赖里；下次更新时**先**重新校验哈希，**再**核对本文。

## 1. 当前阶段定位

- MVP 第一阶段**完全 demo 模式**：服务端 `src/server.mjs` 在内存里维护 2 个示例故事，所有 API 响应都带 `demo.official_zhihu_api: false` 字段。
- 任何客户端都必须根据这个字段判断"是否真在和知乎对话"，否则一律视为 mock。
- 我们**没有**调用官方 `zhihu-cli`、**没有**交换任何 OAuth Token、**没有**保存 App ID / App Key / Access Secret。

## 2. mock ↔ 官方 adapter 的接缝

未来真的接入官方能力时，按下列接缝替换。Phase 2 已把接缝落地，便于后续并行开发：

| 现在的 mock | 未来真实 adapter | 替换位置 |
| --- | --- | --- |
| `GET /api/stories` 返回 `STORIES` 数组 | 由后端 catalog 服务读取真实故事库（暂未确认是否走知乎创作内容接口） | `src/providers/mockProvider.mjs` 的 `listStories()` |
| `GET /api/stories/:id` 返回单条 + beats | 同样由 catalog 服务提供；不直接调知乎 | `src/providers/mockProvider.mjs` 的 `getStory()` |
| `POST /api/stories/advance` 仅递增 index | 接入 LLM 生成下一句；如要"展示用户关注/收藏"，从这里转调用户数据接口 | `src/providers/mockProvider.mjs` 的 `advanceStory()` |
| `POST /api/chat` 原样回显 | 真正的群聊逐句播放；同样要避免无脑调用户数据接口 | 同上 handler（仍留在 `src/server.mjs`，不是 provider 接缝的一部分） |
| `GET /api/health` 返回 demo 标志 | 在 OAuth 联调成功且 doctor 通过后切到 `mode: "live"` | `DEMO_FLAG` 常量 |

Provider 接缝的关键文件：

- `src/providers/dto.mjs` —— 与 transport 无关的 DTO（`StorySummary`、`StoryDetail`、`AdvanceResult` 等）和错误类型（`StoryNotFoundError`、`ValidationError`）。
- `src/providers/mockProvider.mjs` —— 内存版 Mock；返回上面 DTO。
- `src/providers/index.mjs` —— Provider 选择器；读 `STORY_OUTSIDE_PROVIDER`（默认 `mock`）。
- `src/providers/realProvider.mjs` —— **尚未实现**；接入官方 API 时按接缝实现，从这里发起 token / 用户接口调用。

选择器规则：

- `STORY_OUTSIDE_PROVIDER=mock`（默认） → MockProvider。
- `STORY_OUTSIDE_PROVIDER=real` → **明确报错**而不是静默回退 mock，避免生产上错配置后假装还能谈上知乎。
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

本仓库**任何位置都不保存这三个值**；Phase 1 完全没有 `.env` / `hackathon.config.json` 的 `oauth` 段。

### 3.2 `/access_token` 表单（OAuth 兑换）

```
app_id=<App ID>
app_key=<OAuth App Key>
grant_type=authorization_code            ← 固定枚举，不从回调读取
redirect_uri=<公网 HTTPS callback>
code=<回调里的 authorization_code>      ← 即便后端兼容字段名 code，也不叫 authorization_code
```

### 3.3 用户数据接口的鉴权头

```
Authorization: Bearer <Access Secret>
X-OAuth-Token: <OAuth access_token>
```

`app_key` **不是** `X-OAuth-Token`。

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

## 4. Demo 模式如何被客户端识别

每个 JSON 响应都附 `demo` 段：

```json
{
  "demo": {
    "mode": "demo",
    "official_zhihu_api": false,
    "reason": "Phase 1 builds an interactive narrative demo without touching the real Zhihu Open Platform. See docs/official-zhihu-skill.md for the planned integration boundary."
  }
}
```

前端在 `public/scripts/app.js` 的 `applyDemoBanner()` 里：

- 把 `data-mode-tag` 的横幅标记成 `demo · 未连接知乎官方 API`；
- 把 `[data-demo-meta]` 元数据写入首屏；
- 任何后续 adapter 接入后必须把这个标记置为 `live` 并清掉 demo 横幅。

## 5. 现在不做、以后要做

- ❌ 现在：不引入官方 `zhihu-cli`、不写 OAuth handler、不写 Token 会话。
- ✅ 以后：先在生产域名上把 OAuth 跑通 → 验收 5 项用户接口（创作 / 关注 / 收藏夹列表 / 收藏夹内容 / 近期收藏）→ 才把 `demo` 标记切到 `live`。
- ✅ 以后：医生脚本（`vendor/zhihu-hackathon/scripts/doctor.mjs`）只在开发机运行；CI 不跑。

## 6. 校验快照

每次官方 Skill 更新后：

1. 重新下载 `https://developer-cdn.zhihu.com/zhihu-cli/releases/stable/skill/zhihu-cli-skill.zip`；
2. 解压到 `vendor/zhihu-hackathon/`；
3. 更新 `vendor/zhihu-hackathon/references/official-skill-snapshot.md` 里的 SHA-256；
4. 把本次变更要点追加到本文末尾"变更日志"。