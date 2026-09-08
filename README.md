# 故事之外 (Story Outside)

知乎黑客松 · 蓝白故事书架与实时 AI 互动叙事

> 如果当时，由你来选——进入故事，看看另一条世界线。

这是一个**分支互动叙事**的小项目。Phase 2 抽出 `src/providers/` 接缝，Phase 4 抽出 `src/stories/` 应用层（canonical hash、版本化、作品级开场缓存、会话快照）。默认走 `src/providers/mockProvider.mjs` 的内存 catalog；设置 `STORY_OUTSIDE_PROVIDER=real` 后会改走 `src/providers/realProvider.mjs`，按官方契约对接 `api.zhihu.com/km-indep-home/hackathon/v2/story/*`——这些接口在 `zhihu_hackathon_2026_p2` 比赛期间不需要任何鉴权，也不发送 `Authorization` / `X-OAuth-Token`。配置 MariaDB 后，业务 projection 启动时 hydrate，并在每个 JSON 响应前以事务 flush；未配置数据库时仍可使用内存 fallback。

## 真实 AI 与新版界面

```bash
# secrets/secret 中提供服务端 AI 配置后启动真实故事与模型
STORY_OUTSIDE_PROVIDER=real npm start
# 默认离线示例
npm start
# 全量测试固定使用 mock AI，不产生模型调用
npm test
```

故事页提供封面、分类筛选、搜索与作品详情；进入故事后按角色逐句播放，可自动播放、随时输入打断，并在关键节点做选择。我的页面提供当前浏览器的世界线入口。AI 会从原作提取角色与短开场，开场在作品间共享缓存，剧情生成仅使用已提交历史。密钥只由服务端加载；配置与缓存说明见 [AI 接入文档](docs/ai-integration.md)。

配置 `STORY_OUTSIDE_DATABASE_URL` 并完成迁移后，故事版本、开场缓存、会话、canonical history、pending batch、compact 审计、社区 profile、关注/屏蔽/分享关系和生态搜索缓存都会跨进程恢复。浏览器保存入口只是导航辅助，不替代服务端持久化。

## 仓库布局

```
.
├── package.json              # 极简包描述 + 脚本
├── src/
│   ├── server.mjs            # Node 原生 HTTP 服务（无框架）
│   ├── providers/            # Provider 抽象 + Mock + Real
│   │   ├── dto.mjs           #   与 transport 无关的数据形状 + 错误类型
│   │   ├── mockProvider.mjs  #   内存版 Mock，提供 2 个示例故事
│   │   ├── realProvider.mjs  #   对接 zhihu_hackathon_2026_p2 故事 API；无凭据；不重试
│   │   └── index.mjs         #   Provider 选择器（默认 mock）
│   ├── stories/              # Phase 4 应用层与同步 projection
│       ├── canonicalHash.mjs #   canonical JSON + SHA-256，用于 story_versions.checksum
│       ├── cacheKey.mjs      #   开场缓存 key 推导（仅公开 generation 维度；user/role/session/任意 tags 禁入）
│       ├── openingGenerator.mjs  # 逐句事件生成器；在 ask_player_choice 前截断
│       ├── repository.mjs    #   同步内存 projection；MariaDB 模式由 adapter hydrate/flush
│       ├── storyService.mjs  #   应用层 facade（import / ensure / rebuild / snapshot）
│       ├── fixture.mjs       #   以 mock catalog 为种子提供 UUID
│       └── index.mjs         #   对外公共表面
│   └── db/                    # MariaDB 配置与业务 projection adapter
│       ├── mariadb.mjs       #   连接池、配置与 schema 校验
│       └── mariaPersistence.mjs # hydrate + 事务 flush
├── db/
│   ├── migrations/            # 编号增量迁移（含 0006 业务持久化和 0007 请求 ID 作用域）
│   └── schema.sql             # 全量 schema 入口
├── public/
│   ├── index.html            # 首屏（多屏切换）
│   ├── styles/main.css
│   ├── scripts/app.js
│   └── mascot/
│       ├── liu-kaishan-idle.gif     # 知乎官方 IP 刘看山 · 待机
│       └── liu-kaishan-waving.gif   # 知乎官方 IP 刘看山 · 招一招手
├── vendor/zhihu-hackathon/   # 官方 Skill（只读参考，不当作依赖）
├── docs/
│   ├── official-zhihu-skill.md      # 官方 API 调用边界与当前 mock/adapter 约定
│   └── data-model.md          # MariaDB 数据模型 + 应用层映射说明
├── tests/
│   ├── health.test.mjs       # 端到端 HTTP 冒烟测试
│   ├── providers.test.mjs    # DTO + Mock provider + 选择器 单元测试
│   ├── http.test.mjs         # Provider 接缝的 HTTP 集成测试
│   ├── schema-contract.test.mjs  # db/migrations + schema 文本契约
│   ├── canonicalHash.test.mjs    # canonical hash / 内容标准化
│   ├── cacheKey.test.mjs         # 开场 key 推导 + 禁用维度
│   ├── openingGenerator.test.mjs # 生成器语义与截断
│   ├── storyService.test.mjs     # 应用层服务契约
│   └── adminRoutes.test.mjs      # /api/admin/* / /api/dev/* HTTP 路由
├── scripts/
│   └── check.mjs             # node --check 风格的脚本语法检查
└── README.md
```

## 技术栈

- Node.js ≥ 20（仅使用 `node:http` / `node:fs` / `node:path`）
- 原生 ESM JavaScript（无打包步骤）
- HTML + CSS + ESM 前端（无框架）
- MariaDB 模式使用 `mysql2`；测试和 mock provider 不依赖外部网络

故意选最小的栈：方便快速验证，方便后续按团队喜好切到 Express/Hono/Fastify/Vite/Next 等任意上层。

## 开发与运行

```bash
# 启动本地服务
npm start         # 监听 http://127.0.0.1:4173

# 跑端到端冒烟测试（不需要先启动 server）
npm test

# 全部脚本的语法静态检查
npm run check
```

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `4173` | HTTP 端口 |
| `HOST` | `127.0.0.1` | 监听地址（OAuth 不能用 `localhost` 回调） |
| `STORY_OUTSIDE_PROVIDER` | `mock` | 数据 provider。`mock` = 内存版示例故事；`real` = 对接 `api.zhihu.com/km-indep-home/hackathon/v2/story/*`（`zhihu_hackathon_2026_p2` 期间不需要鉴权；不发送 `Authorization` / `X-OAuth-Token`；超时/429/5xx 走 typed ProviderError，不循环重试）。同时支持别名 `ZHIHU_PROVIDER`（向后兼容早期环境变量）；同时设置时 `STORY_OUTSIDE_PROVIDER` 优先。 |
| `STORY_OUTSIDE_ZHIHU_TIMEOUT_MS` | `5000` | `real` provider 的 fetch 超时（毫秒）。 |
| `STORY_OUTSIDE_DATABASE_URL` | 未设置 | MariaDB 连接串，例如 `mariadb://user:password@127.0.0.1:3306/story_outside`。设置后启动必须连接成功且已应用 `0007_session_event_request_scope`。 |
| `STORY_OUTSIDE_DATABASE_POOL_SIZE` | `10` | MariaDB 连接池上限。 |
| `STORY_OUTSIDE_DATABASE_CONNECT_TIMEOUT_MS` | `5000` | MariaDB 建连超时（毫秒）。 |
| `STORY_OUTSIDE_DATABASE_SSL` | `false` | 设为 `true` 时启用 TLS。 |

也兼容已有 VM3 部署使用的 `STORY_OUTSIDE_DB_HOST` / `STORY_OUTSIDE_DB_PORT` / `STORY_OUTSIDE_DB_NAME` / `STORY_OUTSIDE_DB_USER` / `STORY_OUTSIDE_DB_PASSWORD` 分项配置；同时设置时优先使用 `STORY_OUTSIDE_DATABASE_URL`。

## MariaDB 连接

先在目标库执行仓库内的编号迁移，再启动服务：

```bash
export STORY_OUTSIDE_DATABASE_URL='mariadb://story_user:password@127.0.0.1:3306/story_outside'
npm run db:migrate
npm start
```

`GET /api/health` 的 `database.status` 会返回 `ready`。不设置连接串时为 `disabled`，服务保持内存 fallback；配置数据库时，`src/db/mariaPersistence.mjs` 会在启动前恢复业务 projection，并在业务 JSON 响应发送前完成 MariaDB 事务写入。数据库连接失败或 schema 未完成迁移时，服务不会接受流量。

## Provider 接缝（mock ↔ 官方 adapter）

所有 `/api/stories*` 路由都从 `src/providers/index.mjs` 拿数据，从**不**直接读 mock 数组、调知乎 API、或拼接 OAuth Token。

```
HTTP route (src/server.mjs)
    └─ StoryProvider interface (src/providers/index.mjs)
         ├─ MockProvider (src/providers/mockProvider.mjs)            ← 默认；内存示例 catalog
         └─ RealZhihuStoryProvider (src/providers/realProvider.mjs)  ← 对接 zhihu_hackathon_2026_p2 故事 API
```

- **DTO**：Provider 返回的形状见 `src/providers/dto.mjs`（`StorySummary`、`StoryDetail`、`AdvanceResult`、`Role`、`Beat`）。DTO 是与 transport 无关的纯数据对象；Provider 必须返回这些形状，路由才能继续复用 JSON 拼装逻辑。
- **错误类型**：`StoryNotFoundError → 404`、`ValidationError → 400`、其他 `ProviderError → 502`。`realProvider` 还会抛出 `upstream_timeout / upstream_rate_limited / upstream_5xx / upstream_invalid_json / upstream_empty_body / upstream_shape_mismatch / unsupported_upstream_host`，路由层统一映射为 `502`。
- **选择 provider**：启动时读 `STORY_OUTSIDE_PROVIDER`（优先）或 `ZHIHU_PROVIDER`（向后兼容的别名），默认 `mock`。
- **真实故事 API 边界**：`realProvider` 发送的请求只到 `https://api.zhihu.com`；列表响应里 `work_id/title/artwork/tab_artwork/description/labels` 与详情响应里 `work_id/chapter_name/author_avatar/author_name/labels/introduction/content` 按官方契约映射；上游原文保留在 `source.raw`，作者 / 来源归属不透传到应用侧。`work_id` 拒绝 `/ ? # CR LF`，走 `encodeURIComponent`。
- **严禁在代码或提交里出现真实 `app_id` / `app_key` / Access Secret / Token**。Real provider 当前按官方契约不需要凭据，未来若需要也只接收已加载的 credential，**绝不**读 `.env` / `process.env` 中任何看起来像凭据的键。

## API（demo）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查，返回 demo 标志 |
| GET | `/api/stories` | 故事目录 |
| GET | `/api/stories/:id` | 单个故事详情（含 beats） |
| POST | `/api/stories/advance` | 推进一句，返回下一句 |
| POST | `/api/chat` | 群聊占位：原样回显用户输入 |

### Phase 4 admin / dev 路由（demo-only，无鉴权）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/stories` | 列出 fixture 的 `story_uuid` 与每个 story 的 `story_version_uuid` / `version_no` / `checksum` |
| POST | `/api/admin/stories/:slug/import` | 用 mock provider 拉一次详情并写入版本仓库（相同 DTO 命中复用） |
| POST | `/api/admin/opening-cache/rebuild` | 为某个 `story_version_uuid` 生成作品级开场缓存；可换 `profile.rules_version` 走新 generation |
| POST | `/api/dev/sessions` | 为会话生成快照（`session_uuid` / `user_ref` / `role_id` / `story_version_uuid`），固定引用 |
| POST | `/api/dev/sessions/:uuid/first-choice` | 模拟会话首次 `ask_player_choice`，只返回该 session 的 consumed marker；不 invalidate 共享开场缓存 |

所有 admin / dev 响应都带 `dev: { demo: true, admin_only: false, dev_only: true, authenticated: false, reason: ... }` 横幅。**这些路由没有鉴权**，在配置数据库时也会写入 MariaDB，**严禁**暴露在公网——上线前需要前置反向代理 + 鉴权层。

## 资源声明

- `public/mascot/liu-kaishan-*.gif` 取自知乎官方提供的 `user-attachment-liu-kaishan.zip`（刘看山动态表情包），仅用作本 demo 首屏装饰，版权归原作者。
- `vendor/zhihu-hackathon/` 是官方 Skill ZIP 解压后的源码副本，仅用于本地阅读与规划。**不要**直接 `npm install` 它，不要把它当作部署依赖，不要在这里面跑脚本。

## 后续规划

- 把 demo 故事换成可配置 JSON / 文件 catalog（仍是 Mock provider 的内部实现变更，不改 DTO / 路由）
- 增加 LLM-backed 群聊逐句播放（仍走前端 mock + 后端可替换 adapter）
- 接入知乎 OAuth + 用户数据接口：与当前故事 API 不同，用户数据接口需 Access Secret + OAuth Token；另起任务，按 `docs/official-zhihu-skill.md` §3.1–3.5 安全边界
- 引入 CI / Vercel / Cloudflare Pages 等部署目标
- 为 MariaDB projection adapter 增加更细粒度的 SQL 写入/恢复观测与后台清理策略

## 不做的事

- 不连接真实知乎账号
- 不在仓库内保存任何 `app_id` / `app_key` / Access Secret / Token
- 不在 server 运行时依赖 `vendor/zhihu-hackathon/scripts/*.mjs`（它们是编排脚本，不属于运行依赖）
- 未配置 MariaDB 时才使用内存 fallback；配置 MariaDB 后，`src/stories/repository.mjs` 作为同步 projection，由 `src/db/mariaPersistence.mjs` 负责 hydrate 与事务 flush
- 不在 `story_opening_caches` 上携带任何 `user_id` / `role_id` / `session_id`；该断言由 `src/stories/cacheKey.mjs` 在编译期强制（详见 `docs/data-model.md` §9）
- 不在 `realProvider` 里循环重试上游 / 伪造原文 / 回显上游错误 body；所有失败必须出 typed `ProviderError`
