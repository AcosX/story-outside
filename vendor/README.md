# vendor/ 目录说明

`vendor/` 里是第三方/官方资料副本，**只读参考**，不是构建依赖。

## zhihu-hackathon/

知乎黑客松官方编排 Skill 的解压副本（来自
官方发布的 `zhihu-hackathon-skill` ZIP 包）。

- 用途：阅读官方 API 边界、OAuth 流程、部署约束。
- **不要**在仓库内 `npm install` 它；**不要**让 Node 把它当作模块加载。
- **不要**直接执行里面的 `scripts/*.mjs`（`init_project.mjs`、`doctor.mjs`、`set_app_key.mjs` 等），
  它们是开发机本地编排脚本，依赖 macOS Keychain、OpenAI Codex 等环境。

详细边界与未来接入规划见 `../docs/official-zhihu-skill.md`。

## 为什么不解压进 `node_modules/`

- 让仓库可独立运行、零网络安装。
- 避免把 OAuth 编排脚本误当成运行依赖。
- 方便未来整体替换或升级官方 Skill。