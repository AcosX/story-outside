# 贡献指南

感谢你对《故事之外》的关注！本文档说明本地开发、测试与提交约定，帮助你顺利参与。

## 环境要求

- Node.js ≥ 20（仓库仅使用 `node:http` / `node:fs` / `node:path` 等原生模块，无需打包工具）
- 可选：MariaDB（仅在需要验证跨进程持久化时）

## 本地开发

```bash
# 启动本地服务（默认离线示例数据，监听 http://127.0.0.1:4173）
npm start

# 端到端冒烟测试（无需先启动 server）
npm test

# 所有脚本的语法静态检查
npm run check
```

默认使用内存版 Mock provider，不产生任何外部网络调用。设置 `STORY_OUTSIDE_PROVIDER=real` 后会改走真实故事 provider，详见 [README](README.md) 与 [AI 接入文档](docs/ai-integration.md)。

## 分支与提交

- 请基于最新的 `main` 分支开新分支进行开发。
- 建议按 4–8 个 commit 的粒度提交，保持每个 commit 聚焦单一改动，便于评审。
- 提交信息使用简明的中文或英文描述本次改动的意图。

## 提交 Pull Request

- PR 描述清楚**动机、改动范围、验证方式**（跑了哪些测试、结果如何）。
- 如仓库启用了自动部署或存在其他需要人工介入的合并前置条件，请在 PR 中补充一节「合并特殊步骤」，写明该 PR 除点击 merge 外是否还需要额外的合并动作。
- 保持改动最小、可回退；不要顺带重排或重命名无关代码。

## 测试约定

- 新增测试套件时同步追加到 `package.json` 的 `test` 链中。
- 测试不得依赖网络、真实大模型或 MariaDB（数据库集成测试单独通过 `npm run test:db` 触发）。
- 详细的测试分层与固定测试故事契约见 [测试策略文档](docs/testing-strategy.md)。

## 安全与敏感信息

- **切勿**在代码、注释、提交信息或文档中写入任何真实的 `app_id` / `app_key` / Access Secret / Token / 密码。
- 服务端密钥只从被 Git 忽略的 `secrets/` 目录加载；该目录已在 `.gitignore` 中，请勿提交其中任何文件。
- 提交前请自查 diff，确保没有引入部署主机名、内网地址、个人邮箱等私有信息。

## 相关文档

- [README](README.md)：项目概览、运行方式与架构
- [数据模型](docs/data-model.md)
- [Agent 运行时契约](docs/agent-runtime.md)
- [可观测性](docs/observability.md)
- [知乎 OAuth 登录](docs/zhihu-oauth.md)
