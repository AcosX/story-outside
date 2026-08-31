# 故事之外 (Story Outside)

知乎黑客松 MVP · Phase 1 · demo 模式

> 如果当时，由你来选——进入故事，看看另一条世界线。

这是一个**分支互动叙事**的小项目。第一阶段只搭骨架，让首屏就能跑起来一条最小流程：选故事 → 选角色 → 逐句推进 → 进入占位群聊。本仓库**不连接知乎官方 API**，所有数据来自 `src/server.mjs` 里的 demo 列表。

## 仓库布局

```
.
├── package.json              # 极简包描述 + 脚本
├── src/
│   └── server.mjs            # Node 原生 HTTP 服务（无框架）
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
│   └── health.test.mjs       # 端到端 HTTP 冒烟测试
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

- 把 demo 故事换成可配置 JSON / 文件 catalog
- 增加 LLM-backed 群聊逐句播放（仍走前端 mock + 后端可替换 adapter）
- 等部署平台公网 HTTPS 回调就位后，按 `docs/official-zhihu-skill.md` 里的边界接入知乎 OAuth + 用户数据接口
- 引入 CI / Vercel / Cloudflare Pages 等部署目标

## 不做的事

- 不连接真实知乎账号
- 不在仓库内保存任何 `app_id` / `app_key` / Access Secret / Token
- 不 push，不创建远端仓库