# 知乎故事备用出口与 MariaDB 缓存

真实故事 provider 使用主出口请求官方无鉴权故事 GET。可选配置：

- `STORY_OUTSIDE_STORY_SSH_HOST=opc@vm2`：网络失败、403、5xx 或无效成功响应时，通过已有 SSH 身份运行备用机 `/usr/local/libexec/story-outside-zhihu-get.py`。
- `STORY_OUTSIDE_STORY_CACHE=mariadb`：使用既有数据库连接配置，在独立表 `story_upstream_cache` 保存完整上游列表和正文。没有文件缓存。

缓存存储来源 URL、格式版本、真实请求时间及完整 JSON；写入和读回均通过真实 provider DTO 校验。列表保留封面、分类等字段；正文保留原始内容。只有真实成功响应能更新获取时间，读取过期缓存不会刷新时间。每次写入等待独立事务 COMMIT，不依赖或重写业务会话快照；写入失败记录日志，但不丢弃当次上游成功结果。没有可用 last-good 时仍报错。

主出口故障冷却 60 秒，同 URL 合并并发，最多四个不同作品在途。单响应 1 MiB；数据库保留最多 256 条，完整列表不被正文条目淘汰。旧请求不能覆盖较新获取时间的数据。原 provider 的列表 60 秒、正文 5 分钟内存 TTL 不变。数据库内容作为故障兜底可过期使用。

只接受 `https://api.zhihu.com/km-indep-home/hackathon/v2/story/list` 和同路径作品 GET；不转发凭证、不跟随备用重定向、不监听端口、不接受任意 URL。404/429 不触发备用请求；429 可使用数据库缓存。主请求最多 4 秒、SSH 最多 9 秒；数据库单查询最多 2 秒，缓存操作连同排队最多 4 秒；到期销毁该操作的专用连接。独立连接池最多两个连接。原 provider 最多一次重试仍保留。

## 391464a 的处置

保留 `hook` 的 Unicode 500 字符限制，避免 `stories.hook VARCHAR(500)` 写入失败；原始 introduction/content 不截断。

不沿用该提交的 `persistentRepository` 回填逻辑：业务表仅包含已导入作品，不能代表完整上游列表；回填摘要只保留 id/title/hook/roles，丢失封面、分类等；重启时间又被当作获取时间。独立缓存表取代这一逻辑，业务导入表保持原用途。原提交不应整体合入；其 hook 修复已纳入本 PR。

## 部署与回滚

1. 在备用机安装仓库 helper 为上述路径，root 所有、0755；从应用用户验证严格 known_hosts 的 BatchMode SSH。
2. 先执行幂等迁移 `0010_story_upstream_cache.sql`，再启用 MariaDB 缓存配置。使用既有数据库身份，不更换凭证或端口。
3. 获取或迁移已验证的完整列表与正文到新表，并验证新 Node 进程在双出口失败时可恢复全部数据。
4. 部署代码并重启；验证公网 health、列表和详情。无需修改业务表、业务持久化队列或 Galera 设置。

PR 审核期间，可使用 `/opt/story-outside-egress/<commit>/src/providers/registerStoryTransport.mjs` 的版本化 Node preload 包。其依赖使用应用现有 mysql2；systemd drop-in 在原 ExecStart 上增加 `--import`，配置上述两个变量。main 自动部署不会删除该包；新 provider 使用保存的原始 fetch，避免重复包装。线上若仍有 391464a 的启动参数，应移除 `persistentRepository: storyRepo` 注入，避免旧回填逻辑提前返回不完整目录。

PR 合并后可移除 preload、恢复原 ExecStart，同时保留两个功能环境变量。停用此功能时撤下 preload 和环境变量并重启；保留数据库表，无须删除业务数据或回滚数据库。主出口仍不可用时，停用会影响可用性，应先验证上游状态。

日志使用 `stories.transport.alternate_success`、`alternate_failed`、`mariadb_stale_served`、`cache_write_failed`、`cache_read_failed`（后四项同样带前缀）。日志不包含正文、凭证或 SSH 原始错误。
