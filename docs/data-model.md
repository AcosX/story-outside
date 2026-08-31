# 故事之外 · MariaDB 数据模型与迁移

> 适用范围：ClickUp 03。本文件描述 `story-outside` 在 MariaDB 上的初始数据模型、迁移策略、验证命令和演进边界。
>
> 当前实现文件：
>
> - `db/migrations/0001_initial_story_outside.sql` — 增量迁移
> - `db/schema.sql` — 全新环境一键建库入口
> - `tests/schema-contract.test.mjs` — 不依赖真实数据库凭据的 schema/SQL 契约测试

## 1. 设计原则

- 目标数据库为 **MariaDB 10.6+ / 11.x**，不使用 PostgreSQL 专属语法。
- 全部表使用 `InnoDB`，字符集统一 `utf8mb4` / `utf8mb4_unicode_ci`。
- 所有 `DATETIME(6)` 一律表示 **UTC 时间**；应用层负责写入 UTC。
- 故事正文、角色元数据、事件载荷等结构化内容使用 `JSON` 列，并用 `JSON_VALID()` 校验。
- 版本固定优先：故事正文不直接改，编辑产生新的 `story_versions`。
- 会话历史采用 canonical append-only 事件流，`session_checkpoints` 只是可重建投影。
- 仓库和 schema 中不保存任何 `app_id`、`app_key`、Access Secret、Token 或用户明文凭据；会话只保留不透明 `user_ref`。

## 2. 表总览

| 表 | 角色 |
| --- | --- |
| `stories` | 作品目录；稳定公开标识 `slug` / `story_uuid` |
| `story_versions` | 原作不可变快照：`version_no`、`content_payload`、`roles_payload`、内容 `checksum` |
| `endings` | 结局定义，绑定 `story_version_id`，供会话记录到达结果 |
| `story_opening_caches` | 作品级开场缓存；只绑定 story/version，不绑定 user/role |
| `game_sessions` | 一次游玩会话：user/story/version/role、状态、首次选择、结局 |
| `session_events` | canonical append-only 事件历史；`event_seq` 会话内唯一 |
| `pending_batches` | 推测生成队列；保留 speculative request/response 与提正记录 |
| `session_checkpoints` | context/checkpoint 投影；可由 `session_events` 重建 |
| `schema_migrations` | 迁移台账；`INSERT IGNORE` 记录已应用迁移 |

## 3. 核心语义

### 3.1 版本固定

- `stories` 只保存目录级元数据；叙事正文、beats、分支和角色元数据放在 `story_versions`。
- `story_versions.version_no` 在 `(story_id, version_no)` 上唯一。
- `checksum` 为 64 位十六进制 SHA-256，全局唯一，用于确认同一快照内容固定。
- `game_sessions` 同时绑定 `story_id` 与 `story_version_id`，会话永远知道自己从哪个版本开始。
- 版本行原则上不可变；应用层应只创建新版本，不 UPDATE 已发布版本的正文与哈希。

### 3.2 开场缓存生命周期

- `story_opening_caches` 是作品级缓存，表中没有任何 `user_id` / `role_id` 列。
- 唯一键为 `(story_id, story_version_id, opening_key)`；默认 `opening_key = 'default'`。
- 缓存从创建到第一次 `ask_player_choice` 前可被任意用户/角色复用。
- 插入 `ask_player_choice` 事件时，`trg_session_events_first_choice` 会：
  - 在 `game_sessions.first_choice_at` 第一次写入该时间；
  - 把该会话引用的 `story_opening_caches` 标记为 `invalidated`，并记录 `invalidated_at` / reason。

### 3.3 canonical 事件历史

- `session_events` 是唯一 canonical history；`event_seq` 在会话内从 1 开始递增且唯一。
- `prev_event_seq` 自引用前一条事件，形成会话内链；`hash` 固定事件内容。
- `client_request_id` 唯一，用于幂等去重。
- 两个 trigger 禁止对 `session_events` 执行 `UPDATE` / `DELETE`：
  - `trg_session_events_no_update`
  - `trg_session_events_no_delete`
- 事件类型枚举覆盖：`session_started`、`role_selected`、`story_opening`、`ask_player_choice`、`player_choice`、`narrative_beat`、`chat_message`、`ending_reached`、`session_ended`、`system_event`。

### 3.4 推测队列

- `pending_batches` 保存 speculative 请求/响应，不直接写入 canonical 历史。
- 状态机：`queued → reserved → succeeded | failed | expired | superseded`。
- `request_uuid` 唯一做幂等；`base_event_id` 指向生成所基于的 canonical 事件。
- 提正成功后由应用把 `promoted_event_id` 指向对应 `session_events.event_id`，完成 speculative → canonical 的对应关系。
- `priority`、`available_at`、`expires_at`、`attempts` 支持简单队列调度与重试。

### 3.5 checkpoint 投影

- `session_checkpoints` 以 `session_id` 为主键，保存由事件流派生出的摘要、token 数、context digest、当前 state JSON。
- `last_event_id` / `last_event_seq` / `event_count` 标识投影覆盖到哪条 canonical 事件。
- `is_dirty` 与 `projection_status` 组合表达 `synced / stale / rebuilding / failed`，并允许从 canonical 历史重建。

### 3.6 结局

- `endings` 绑定 `story_id` 与 `story_version_id`，`ending_key` 在版本内唯一。
- 提供 `kind`（canonical/secret/failure/abandoned）、展示字段、`conditions_payload` 和排序。
- `game_sessions.ending_id` 记录会话最终到达的结局；`ended_at` 与 `status` 约束保证结束状态有时间。

## 4. 时间语义

- `created_at` / `updated_at`：数据库自动维护（`CURRENT_TIMESTAMP(6)` / `ON UPDATE CURRENT_TIMESTAMP(6)`），UTC。
- `occurred_at`：业务事件发生时间，必须由应用以 UTC 写入。
- `published_at` / `first_choice_at` / `ended_at` / `invalidated_at`：业务时间点，UTC。
- `available_at` / `reserved_at` / `expires_at` / `completed_at`：队列调度时间，UTC。
- 时区由连接 `SET time_zone = '+00:00'` 显式固定；迁移连接和应用连接（含连接池初始化）都必须设置该值，否则 `CURRENT_TIMESTAMP(6)` 默认值会按服务器会话时区落库。

## 5. 迁移策略

- 迁移文件按编号递增：`0001_initial_story_outside.sql`，后续为 `0002_*.sql`，以此类推。
- `0001` 可重复执行：`CREATE TABLE IF NOT EXISTS`、`DROP TRIGGER IF EXISTS`、`INSERT IGNORE` 都不产生重复错误。
- 已应用迁移在部署环境中**不要编辑**；结构变更必须新增迁移文件。
- `schema.sql` 是当前 canonical 全量入口，包含建库与完整 DDL；`tests/schema-contract.test.mjs` 会校验它与迁移文件主体保持一致。
- schema 不创建应用账号、不写入任何密钥。应用账号权限由部署环境负责，推荐：普通读写账号不授予 `session_events` 的 `UPDATE` / `DELETE`，与 trigger 形成双重防线。

## 6. 真实 MariaDB 验证

前置条件：本机有 `mariadb` / `mariadb-admin`，并只连接本地 scratch 数据库或专用测试实例；**不要对生产数据库执行 DDL**。

```bash
# 确认客户端与服务端可用
mariadb --version
mariadb-admin --no-defaults ping

# 方式 A：先建临时数据库，再应用迁移
DB="story_outside_schema_check_$(date +%s)"
mariadb --no-defaults -e "CREATE DATABASE \`$DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mariadb --no-defaults "$DB" < db/migrations/0001_initial_story_outside.sql
mariadb --no-defaults "$DB" -e "SHOW TABLES; SELECT migration_name FROM schema_migrations;"
mariadb --no-defaults -e "DROP DATABASE \`$DB\`;"

# 方式 B：全新环境直接使用 canonical 入口
mariadb --no-defaults < db/schema.sql

# 应用后检查关键对象
mariadb --no-defaults story_outside -e "SHOW TABLES;"
mariadb --no-defaults story_outside -e "SHOW TRIGGERS LIKE 'session_events';"
mariadb --no-defaults story_outside -e "SHOW CREATE TABLE session_events\G"
```

## 7. 契约测试

```bash
node tests/schema-contract.test.mjs
```

该测试不连接数据库、不读取任何凭据，只做文本/结构断言：

- `db/migrations/0001_initial_story_outside.sql` 与 `db/schema.sql` 存在且 DDL 主体一致；
- 必备表与必备列齐全；
- 版本、事件序列、幂等键等唯一约束存在；
- 外键覆盖 story/version/session/event 关系；
- `session_events` 的 append-only trigger 存在；
- 未混入 PostgreSQL 专属语法；
- 未出现 `password`、`app_key`、`access_secret`、`access_token` 等密钥字段。

## 8. 演进规则

- 新增状态枚举或字段时，优先走 `0002_*.sql` 增量迁移并更新 `db/schema.sql`，不能只改一边。
- canonical 事件新增类型时，同步更新 `session_events.event_type` 枚举与本文档；不要复用旧事件类型表达新含义。
- 任何引入用户体系/多租户/鉴权的变更，必须继续遵守“不落库密钥、不存明文凭据”。
