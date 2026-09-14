# 故事 API 备用出口与持久化缓存

真实故事 provider 可选启用两个独立配置：

- `STORY_OUTSIDE_STORY_SSH_HOST=opc@vm2`：主出口发生网络故障、403、5xx 或无效成功响应时，通过 SSH 执行备用机上的 `/usr/local/libexec/story-outside-zhihu-get.py`。使用已有 SSH 身份及严格 known_hosts 校验，不传递应用凭证。
- `STORY_OUTSIDE_STORY_CACHE_DIR=/var/lib/story-outside/story-cache`：原子保存通过真实 provider DTO 校验的完整上游 JSON，网络失败时重新读取。目录应在部署工作目录外，目录 0700、文件 0600。

未设置时保持原有传输。仅接受官方 HTTPS 主机下的故事列表及单作品 GET，不允许任意 URL、查询参数或修改请求。备用 helper 不跟随重定向，不监听端口，不接收 Cookie、OAuth 或 Access Secret。404、429、重定向不触发备用请求；429 可读取已有磁盘缓存。

主出口故障后冷却 60 秒，同 URL 合并并发请求，最多四个不同作品同时在途。主出口最多 4 秒，SSH 最多 9 秒（远端 curl 最多 6 秒）。原 provider 最多一次重试仍保留，因此完全无缓存且双出口失败时可能需要约 27 秒。

单响应最多 1 MiB，磁盘最多 256 条，列表不被正文条目淘汰。缓存记录原始来源 URL、写入时间和格式版本；只有通过相同 DTO 校验的数据才可写入或读回。进程内原有 60 秒列表、5 分钟正文 TTL 不变。磁盘数据作为故障兜底可过期使用，不延长上游成功时间；写盘失败记录日志但不丢弃当次成功响应。没有 last-good 时仍报错，不造数据。

日志事件：`stories.transport.alternate_success`、`alternate_failed`、`disk_stale_served`、`cache_write_failed`、`cache_read_failed`（后四项均使用同样前缀）。不输出正文、凭据或 SSH 原始错误。

## 部署

1. 在备用机将本仓库 `ops/vm3/story-outside-zhihu-get.py` 安装为上述绝对路径，root 所有、0755；从应用用户验证 BatchMode SSH 和 helper。
2. 在 VM3 创建缓存目录并配置两个环境变量（可使用独立 systemd drop-in）。用独立 provider 预热列表及作品正文。
3. 部署源码并重启服务；验证 `/api/health`、`/api/stories`、作品详情，以及新 Node 进程在双出口失败时读取磁盘缓存。
4. 自动部署继续跟踪 main，缓存目录不能包含在 Git reset/清理范围中。

回滚：移除该功能的 systemd drop-in，daemon-reload 并重启即可停用（须评估主出口仍 403 时的可用性）。保留磁盘缓存便于恢复，不需要数据库回滚或凭证变更。

## PR 审核期间的独立运行包

`src/providers/registerStoryTransport.mjs` 可通过 Node `--import` 预加载，从 Git 工作目录外的固定版本运行包为现有 provider 提供同一传输。不覆盖线上未提交代码；自动部署 main 后仍生效。只拦截原 provider 使用的故事 URL 字符串，其他 API 和 Request 对象保持原 fetch 行为。新版 provider 检测并使用保存的原始 fetch，避免嵌套备用请求。

独立运行包至少包含 `src/providers/{registerStoryTransport,storyTransport,realProvider,dto}.mjs`、`src/util/boundedMap.mjs` 和 `src/observability/logger.mjs`。运行包使用提交 SHA 命名并校验 SHA-256；systemd drop-in 在原 `node src/server.mjs` 上增加 `--import=/opt/story-outside-egress/<sha>/src/providers/registerStoryTransport.mjs`。PR 合并后可在后续维护时移除 preload，保留两个功能环境变量。
