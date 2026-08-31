# 故事之外 (Story Outside)

知乎黑客松 MVP · Phase 2 · demo 模式（已抽出 Provider 接缝）

> 如果当时，由你来选——进入故事，看看另一条世界线。

这是一个**分支互动叙事**的小项目。Phase 2 在 Phase 1 的骨架上抽出 `src/providers/` 接缝，让所有数据走 StoryProvider 接口（默认 mock）。本仓库**不连接知乎官方 API**，所有数据来自 `src/providers/mockProvider.mjs` 里的示例 catalog。

## 仓库布局

```
.
├── package.json              # 极简包描述 + 脚本
├── src/
│   ├── server.mjs            # Node 原生 HTTP 服务（无框架）
│   └── providers/            # Provider 抽象 + Mock（官方 adapter 预留接缝）
│       ├── dto.mjs           #   与 transport 无关的数据形状 + 错误类型
│       ├── mockProvider.mjs  #   内存版 Mock，提供 2 个示例故事
│       └── index.mjs         #   Provider 选择器（默认 mock）
├── public/
│   ├── index.html            # 首屏（多屏切换）
│   ├── styles/main.css
│   ├── scripts/app.js
│   └── mascot/
│       ├── liu-kaishan-idle.gif     # 知乎官方 IP 刘看山 · 待机
│       └── liu-kaishan-waving.gif   # 知乎官方 IP 刘看山 · 招一招手
├── vendor/zhihu-hackathon/   # 官方 Skill（只读参考，不当作依赖）
├── docs/
│   └── official-zhihu-skill.md      # 官方 API 调用边界与当前 mock/adapter 约定
├── tests/
│   ├── health.test.mjs       # 端到端 HTTP 冒烟测试
│   ├── providers.test.mjs    # DTO + Mock provider + 选择器 单元测试
│   └── http.test.mjs         # Provider 接缝的 HTTP 集成测试
├── scripts/
│   └── check.mjs             # node --check 风格的脚本语法检查
└── README.md
```

## 技术栈

- Node.js ≥ 20（仅使用 `node:http` / `node:fs` / `node:path`）
- 原生 ESM JavaScript（无打包步骤）
- HTML + CSS + ESM 前端（无框架）
- 没有任何 npm 依赖，零网络安装

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
| `STORY_OUTSIDE_PROVIDER` | `mock` | 数据 provider。`mock` = 内存版示例故事；`real` = 官方知乎 adapter（**未实现**，启动会报错，不静默回退到 mock）。 |

## Provider 接缝（mock ↔ 官方 adapter）

所有 `/api/stories*` 路由都从 `src/providers/index.mjs` 拿数据，从**不**直接读 mock 数组、调知乎 API、或拼接 OAuth Token。

```
HTTP route (src/server.mjs)
    └─ StoryProvider interface (src/providers/index.mjs)
         ├─ MockProvider (src/providers/mockProvider.mjs)   ← 当前唯一实现
         └─ RealProvider (src/providers/realProvider.mjs)  ← TODO，不在本任务实现
```

- **DTO**：Provider 返回的形状见 `src/providers/dto.mjs`（`StorySummary`、`StoryDetail`、`AdvanceResult`、`Role`、`Beat`）。DTO 是与 transport 无关的纯数据对象；Provider 必须返回这些形状，路由才能继续复用 JSON 拼装逻辑。
- **错误类型**：`StoryNotFoundError → 404`、`ValidationError → 400`、其他 `ProviderError → 502`。新增 provider 必须抛这些类（或同名子类），路由才不用变。
- **选择 provider**：启动时读 `STORY_OUTSIDE_PROVIDER`，默认 `mock`。`real` 会**明确报错**而不是静默回退，避免生产上错配置后假装还能谈上知乎。
- **未来接官方知乎**：把 `realProvider.mjs` 实现成 `StoryProvider`，里面负责凭据加载、token 兑换、用户接口调用（一切按 `docs/official-zhihu-skill.md`）；但该任务**不在本仓库本阶段**，也不会被 MockProvider 或 server.mjs 调用。

严禁在代码或提交里出现真实 `app_id` / `app_key` / Access Secret / Token。Real provider 是接缝，不是实现。

## API（demo）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查，返回 demo 标志 |
| GET | `/api/stories` | 故事目录 |
| GET | `/api/stories/:id` | 单个故事详情（含 beats） |
| POST | `/api/stories/advance` | 推进一句，返回下一句 |
| POST | `/api/chat` | 群聊占位：原样回显用户输入 |

每个响应都带 `demo: { mode: "demo", official_zhihu_api: false, reason: ... }`，前端用这个标记渲染横幅与元数据。**绝不**伪造已接通官方 API 的样子。

## 资源声明

- `public/mascot/liu-kaishan-*.gif` 取自知乎官方提供的 `user-attachment-liu-kaishan.zip`（刘看山动态表情包），仅用作本 demo 首屏装饰，版权归原作者。
- `vendor/zhihu-hackathon/` 是官方 Skill ZIP 解压后的源码副本，仅用于本地阅读与规划。**不要**直接 `npm install` 它，不要把它当作部署依赖，不要在这里面跑脚本。

## 后续规划

- 把 demo 故事换成可配置 JSON / 文件 catalog（仍是 Mock provider 的内部实现变更，不改 DTO / 路由）
- 增加 LLM-backed 群聊逐句播放（仍走前端 mock + 后端可替换 adapter）
- 接入知乎 OAuth + 用户数据接口：实现 `src/providers/realProvider.mjs`，严格按 `docs/official-zhihu-skill.md` 的接缝，在生产域名上验收
- 引入 CI / Vercel / Cloudflare Pages 等部署目标

## 不做的事

- 不连接真实知乎账号
- 不在仓库内保存任何 `app_id` / `app_key` / Access Secret / Token
- 不在 server 运行时依赖 `vendor/zhihu-hackathon/scripts/*.mjs`（它们是编排脚本，不属于运行依赖）
- 不 push，不创建远端仓库