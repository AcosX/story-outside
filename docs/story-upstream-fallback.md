# 知乎故事备用出口与 MariaDB 缓存

真实故事 provider 使用主出口请求官方无鉴权故事 GET。为提高上游异常时的可用性，可选启用 SSH 备用出口与 MariaDB last-good 缓存：

- `STORY_OUTSIDE_STORY_SSH_HOST=<ssh-user>@<fallback-host>`：主出口发生网络失败、403、5xx 或无效成功响应时，通过预先配置的 SSH 身份调用备用主机上的只读 helper。helper 的安装位置由部署环境约定；当前实现调用 `/usr/local/libexec/story-outside-zhihu-get.py`。
- `STORY_OUTSIDE_STORY_CACHE=mariadb`：复用既有数据库连接配置，在独立表 `story_upstream_cache` 保存完整上游列表和正文，不使用文件缓存。

缓存保存来源 URL、格式版本、真实请求时间及完整 JSON；写入和读回均通过真实 provider DTO 校验。列表保留封面、分类等字段；正文保留原始内容。只有真实成功响应能更新获取时间，读取过期缓存不会刷新时间。每次写入等待独立事务 COMMIT，不依赖或重写业务会话快照；写入失败只记录脱敏日志，不丢弃当次上游成功结果。没有可用 last-good 时仍返回上游错误。

主出口故障冷却 60 秒，同 URL 合并并发，最多四个不同作品在途。单响应上限 1 MiB；数据库最多保留 256 条，完整列表不被正文条目淘汰。旧请求不能覆盖较新获取时间的数据。provider 原有的列表 60 秒、正文 5 分钟内存 TTL 保持不变；数据库内容作为故障兜底可以过期使用。

只接受 `https://api.zhihu.com/km-indep-home/hackathon/v2/story/list` 和同路径作品 GET；不转发凭证、不跟随备用重定向、不监听端口、不接受任意 URL。404/429 不触发备用请求；429 可以使用数据库缓存。主请求最多 4 秒、SSH 最多 9 秒；数据库单查询最多 2 秒，缓存操作连同排队最多 4 秒；超时销毁对应专用连接。独立连接池最多两个连接。provider 原有的单次重试策略保持不变。

## 数据一致性

`stories.hook` 保持 Unicode 500 字符限制，避免写入 `VARCHAR(500)` 失败；原始 introduction/content 不截断。

备用缓存不使用业务作品表作为上游目录回填来源。业务表只包含已导入作品，不能代表完整上游列表；独立缓存表负责保存完整列表、封面、分类、正文和实际获取时间，业务导入表保持原用途。

## 部署与回滚

1. 在备用主机安装 `ops/story-relay/story-outside-zhihu-get.py` 只读 helper，并为应用进程配置严格的 `known_hosts` 与 `BatchMode` SSH 身份；不要把私钥或 SSH 配置提交到仓库。
2. 执行幂等迁移 `0010_story_upstream_cache.sql`，再按需启用 `STORY_OUTSIDE_STORY_CACHE=mariadb`。
3. 如启用备用出口，设置 `STORY_OUTSIDE_STORY_SSH_HOST` 为部署环境实际使用的 SSH 目标；主机名、用户名与密钥由部署系统管理，不写入版本库。
4. 部署后验证 health、故事列表与详情，并在主出口不可用时确认 last-good 缓存和备用出口均按预期工作。

停用该功能时移除相应环境变量并重启应用即可；数据库缓存表可以保留，无需删除业务数据。若主出口当时仍不可用，应先确认停用备用出口不会影响服务可用性。

日志使用 `stories.transport.alternate_success`、`alternate_failed`、`mariadb_stale_served`、`cache_write_failed`、`cache_read_failed` 等事件名；日志不包含正文、凭证、SSH 原始错误或部署主机信息。
