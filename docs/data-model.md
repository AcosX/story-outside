# 故事之外 · MariaDB 数据模型与迁移

> 适用范围：故事之外 05。本文件描述 `story-outside` 在 MariaDB 上的数据模型、迁移策略、验证命令和演进边界，以及 05 应用层到未来 DAO 的映射。
>
> 当前实现文件：
>
> - `db/migrations/0001_initial_story_outside.sql` — 增量迁移（历史基线）
> - `db/migrations/0002_opening_cache_generation_profile.sql` — 开场缓存 generation profile 与 session-local first choice
> - `db/migrations/0003_session_playback.sql` — session playback 快照、canonical event provenance 与 story/version/cache 复合关系
> - `db/migrations/0004_pending_batch_lifecycle.sql` — pending batch 生命周期字段与 `pending_batch_items` 表
> - `db/schema.sql` — 全新环境一键建库入口（0001 + 0002 + 0003 + 0004 的最终 DDL）
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
| `game_sessions` | 一次游玩会话：user/story/version/role、model/prompt/profile 快照、opening cursor/state/revision、首次选择、结局 |
| `session_events` | canonical append-only 事件历史；`event_seq` 会话内唯一，并保留 `source` / `source_sequence` provenance |
| `pending_batches` | 推测生成队列；保留 speculative request/response 与提正记录；0004 补充 `expected_revision` / `request_fingerprint` / `committed_count` / `item_count` / `source` / `superseded_by` |
| `pending_batch_items` | 推测生成队列的逐项有序 beat；item_seq 0-based 唯一；status=pending/committed/discarded |
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

- `story_opening_caches` 是作品级缓存，表中没有任何 `user_id` / `role_id` / `session_id` 列。
- 唯一键为 `(story_id, story_version_id, opening_key, generation_hash)`；同一作品/版本可以有多个公开 generation profile 并存。
- `generation_profile` JSON 只允许公开生成维度：`identifier` / `rules_version` / `locale` / `variant`。**不允许**任意 tags、未知字段或任何用户/角色/会话维度进入缓存键。
- 缓存从创建到某一会话首次 `ask_player_choice` 前可被任意用户/角色复用。
- 插入 `ask_player_choice` 事件时，`trg_session_events_first_choice` 只负责在 `game_sessions.first_choice_at` 第一次写入该时间。**不再** invalidate 共享 `story_opening_caches`；是否停止某个会话继续导入开场由应用层按 session-local marker 决定。

### 3.3 canonical 事件历史

- `session_events` 是唯一 canonical history；`event_seq` 在会话内从 1 开始递增且唯一。
- `prev_event_seq` 自引用前一条事件，形成会话内链；`hash` 固定事件内容。
- `client_request_id` 唯一，用于幂等去重。
- `event_type` 覆盖 `player_input` / `narrative_beat` / `ask_player_choice` / `player_choice` / `story_opening` / `session_started` / `role_selected` / `chat_message` / `ending_reached` / `session_ended` / `system_event`，`origin` 保留 `user` / `system` / `llm` 并允许 `imported`。ClickUp 08 的 runtime narrative beat 使用 `event_type='narrative_beat'`、`origin='llm'`、`source='runtime'`（与 0003 SQL 枚举对齐；不要使用旧的 `event_type='narrative'` 或 `origin='runtime'`，它们不会通过 `session_events` 的 ENUM 约束）。
- `source` 是事件生产来源标签（例如 `opening_cache`、`user`、`llm`、`runtime`），`source_sequence` 是该来源自己的序号（开场缓存事件可保持 0-based 序号）；`(session_id, source, source_sequence)` 唯一，便于 DAO 幂等写入与回放定位。
- 对用户可见的内容只有在写入 `session_events` 后才算 canonical；speculative response、缓存 payload 或内存中的预览不能直接当作历史展示。展示层应按 canonical `event_seq` 回放，并用 `session_revision` 做乐观并发检查。
- 两个 trigger 禁止对 `session_events` 执行 `UPDATE` / `DELETE`：
  - `trg_session_events_no_update`
  - `trg_session_events_no_delete`
- 事件类型枚举覆盖：`session_started`、`role_selected`、`story_opening`、`ask_player_choice`、`player_choice`、`player_input`、`narrative_beat`、`chat_message`、`ending_reached`、`session_ended`、`system_event`。

### 3.4 推测队列

- `pending_batches` 保存 speculative 请求/响应，不直接写入 canonical 历史。
- 状态机：`queued → reserved → succeeded | failed | expired | superseded`。
- `request_uuid` 唯一做幂等；`base_event_id` 指向生成所基于的 canonical 事件。
- 提正成功后由应用把 `promoted_event_id` 指向对应 `session_events.event_id`，完成 speculative → canonical 的对应关系。
- `priority`、`available_at`、`expires_at`、`attempts` 支持简单队列调度与重试。
- ClickUp 08 在 `pending_batches` 上额外约束：`expected_revision`（乐观并发，默认 0，与 `db/schema.sql` 一致）、`request_fingerprint`（64 字符，唯一，请求 id 复用不同负载时由应用层做 fail-closed；数据库通过唯一键作为最后防线）、`committed_count <= item_count`（`chk_pending_batches_counts`）、`source` 非空（`chk_pending_batches_source`）。0004 与 schema.sql 同步补齐这两个 CHECK。
- `pending_batch_items` 是 08 新增的逐项表：每个 staged item 一行，`(batch_id, item_seq)` 唯一，`item_type` 区分 narrative_beat 与 tool_call；`status` 在 pending/committed/discarded 三态机内流转，`chk_pending_batch_items_committed` / `chk_pending_batch_items_discarded` 保证 committed 必须有 `promoted_event_id` 与 `occurred_at`，discarded 必须两者为 NULL；`chk_pending_batch_items_pending` 进一步保证 pending 状态也不得携带 `promoted_event_id` / `occurred_at`（只有 committed 行可以有）。
- `chk_pending_batch_items_tool_commit`：tool_call 行永远不能是 `committed` —— tool 从不进入 canonical `session_events`，因此不存在可指向的 promoted event。
- 同 session 完整性由数据库强制，而非仅文档声明：`pending_batch_items.session_id` 冗余自 `pending_batches.session_id`，`(session_id, batch_id) → pending_batches(session_id, id)` 复合外键保证 item 归属其 batch 的 session；`(session_id, promoted_event_id) → session_events(session_id, event_id)` 复合外键保证 committed item 的 promoted event 属于同一 session（跨 session promotion 被 MariaDB 拒绝）。`pending_batches.promoted_event_id` 同样受 `(session_id, promoted_event_id)` 复合外键约束。

### 3.5 会话 playback 游标与状态

- `game_sessions.model`、`prompt`、`generation_profile` 是创建会话时的生成快照；未来 DAO 必须与会话一同写入，不能从后来变化的全局配置回读。
- `cursor`（canonical cursor，ClickUp 08 P1.1）等于已提交 canonical 事件总数，恒等于 `session_revision` 与最后一条 `session_events.event_seq`；每次 commit（opening / narrative / player_input）都 +1，单调不回退。
- `opening_cursor` 是独立的 opening 播放位置（内部语义），只随 `story_opening` commit 递增；`commitOpeningEvent` 用它与 `event.sequence` 比对来强制开场顺序，开场放完（`opening_cursor >= event_count`）后 `opening_state` 进入 `awaiting_first_choice`。对外只读暴露，供客户端继续驱动开场播放。
- `opening_state` 只允许 `opening`、`awaiting_first_choice`、`realtime`。`stageNarrativeBatch` 接受三种状态；`interruptWithPlayerInput` 接受 `opening` / `awaiting_first_choice` / `realtime`，realtime 会话可再次打断（丢弃 pending tail、追加 player_input、状态保持 `realtime`）。
- `session_revision` 是会话边界的单调修订号，供 `expected_revision` 乐观锁使用；事件提交成功后应由 DAO 在同一事务中推进它，并以 canonical history 为准恢复。
- `source_sequence` 是 (session, source) 维度的单调连续计数器（0-based，可从 canonical history 恢复），跨 batch 不复位，因此 `(session_id, source, source_sequence)` 唯一键在连续多批 runtime 事件与多次 player interrupt 下成立；opening 事件使用 pinned cache 的 0-based sequence（source=`opening_cache`）。
- session 同时以复合外键绑定 `story_id + story_version_id`，opening cache 还必须属于同一 story/version；不能只凭三个独立 id 组合出跨作品会话。

### 3.6 checkpoint 投影

- `session_checkpoints` 以 `session_id` 为主键，保存由事件流派生出的摘要、token 数、context digest、当前 state JSON。
- `last_event_id` / `last_event_seq` / `event_count` 标识投影覆盖到哪条 canonical 事件。
- `is_dirty` 与 `projection_status` 组合表达 `synced / stale / rebuilding / failed`，并允许从 canonical 历史重建。

### 3.7 结局

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

- 迁移文件按编号递增：`0001_initial_story_outside.sql`、`0002_opening_cache_generation_profile.sql`、`0003_session_playback.sql`、`0004_pending_batch_lifecycle.sql`，以此类推。
- `0001` 可重复执行：`CREATE TABLE IF NOT EXISTS`、`DROP TRIGGER IF EXISTS`、`INSERT IGNORE` 都不产生重复错误。
- `0002` 可重复执行：使用 `ADD COLUMN IF NOT EXISTS`、`ADD UNIQUE INDEX IF NOT EXISTS`、`DROP INDEX IF EXISTS`、`ADD CONSTRAINT IF NOT EXISTS` 与 drop-before-create trigger；旧 0001 的 `uq_story_opening_caches_scope` 被移除，旧行以 legacy generation 回填。
- `0003` 可重复执行：先为复合外键暴露父表复合索引，再回填旧 session/event 行的 playback/provenance 默认值；事件枚举扩展后，命名 CHECK/外键按名称 drop/recreate（MariaDB 不支持 `ADD FOREIGN KEY IF NOT EXISTS`），最后完成非空与幂等约束；旧事件的 `source='legacy'`、`source_sequence=event_seq` 只在空值时回填。
- `0004` 可重复执行：扩展 `pending_batches` 生命周期字段（`expected_revision` 默认 0 / `request_fingerprint` / `committed_count` / `item_count` / `source` / `superseded_by`），先 backfill NULL 值，再 MODIFY 为 NOT NULL；补 `chk_pending_batches_source` / `chk_pending_batches_counts` 两个 CHECK 与 schema.sql 对齐；新增 `pending_batch_items` 表表达逐项有序 payload 与三态机（含 `session_id` 冗余列、`chk_pending_batch_items_pending`、`chk_pending_batch_items_tool_commit` 与同 session 复合外键）；新增/重建命名 CHECK 与索引。MariaDB 不支持 `ADD FOREIGN KEY IF NOT EXISTS`，所以外键仍按 drop-by-name + create 模式。
- 已应用迁移在部署环境中**不要编辑**；结构变更必须新增迁移文件。`0001` 是历史基线，其中的旧 trigger 级联行为由 `0002` 替换，不回头修改。
- `schema.sql` 是当前 canonical 全量入口，包含建库与 0001+0002+0003+0004 合并后的最终 DDL；`tests/schema-contract.test.mjs` 会校验它与迁移集合保持一致。
- schema 不创建应用账号、不写入任何密钥。应用账号权限由部署环境负责，推荐：普通读写账号不授予 `session_events` 的 `UPDATE` / `DELETE`，与 trigger 形成双重防线。

## 6. 真实 MariaDB 验证

前置条件：本机有 `mariadb` / `mariadb-admin`，并只连接本地 scratch 数据库或专用测试实例；**不要对生产数据库执行 DDL**。

```bash
# 确认客户端与服务端可用
mariadb --version
mariadb-admin --no-defaults ping

# 方式 A：先建临时数据库，再依次应用迁移（0001、0002、0003、0004 各跑两遍验证幂等）
DB="story_outside_schema_check_$(date +%s)"
mariadb --no-defaults -e "CREATE DATABASE \`$DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mariadb --no-defaults "$DB" < db/migrations/0001_initial_story_outside.sql
mariadb --no-defaults "$DB" < db/migrations/0001_initial_story_outside.sql
mariadb --no-defaults "$DB" < db/migrations/0002_opening_cache_generation_profile.sql
mariadb --no-defaults "$DB" < db/migrations/0002_opening_cache_generation_profile.sql
mariadb --no-defaults "$DB" < db/migrations/0003_session_playback.sql
mariadb --no-defaults "$DB" < db/migrations/0003_session_playback.sql
mariadb --no-defaults "$DB" < db/migrations/0004_pending_batch_lifecycle.sql
mariadb --no-defaults "$DB" < db/migrations/0004_pending_batch_lifecycle.sql
mariadb --no-defaults "$DB" -e "SHOW TABLES; SELECT migration_name FROM schema_migrations; SHOW CREATE TABLE pending_batches\G; SHOW CREATE TABLE pending_batch_items\G"
mariadb --no-defaults -e "DROP DATABASE \`$DB\`;"

# 方式 B：全新环境直接使用 canonical 入口
mariadb --no-defaults < db/schema.sql

# 应用后检查关键对象
mariadb --no-defaults story_outside -e "SHOW TABLES;"
mariadb --no-defaults story_outside -e "SHOW TRIGGERS LIKE 'session_events';"
mariadb --no-defaults story_outside -e "SHOW CREATE TABLE session_events\G"
mariadb --no-defaults story_outside -e "SHOW CREATE TABLE pending_batches\G; SHOW CREATE TABLE pending_batch_items\G;"
```

### 6.1 负面约束探针（ClickUp 08 P1.4 / P1.7）

仓库提供一键脚本 `scripts/mariadb-probes.sh`，在 scratch 库上验证：0001→0004 每步重复 3 次幂等 + 额外重复 0004 + 全新 `schema.sql` 独立可建 + 下列负面约束确实拒绝非法行（用两 session 探针证明跨 session promotion 被拒）。脚本结束自动 DROP 临时库：

```bash
bash scripts/mariadb-probes.sh /path/to/story-outside
```

脚本覆盖的负面探针（`EXPECT_FAIL` = 必须报错；`EXPECT_OK` = 必须成功）：

1. `pending_batches.source=''` → `chk_pending_batches_source` 拒绝；
2. `pending_batches.committed_count > item_count` → `chk_pending_batches_counts` 拒绝；
3. `pending_batches.expected_revision` 为 `NOT NULL DEFAULT 0`（与 schema.sql 一致，information_schema 校验）；
4. `pending_batch_items` status=`pending` 且带 `promoted_event_id`/`occurred_at` → `chk_pending_batch_items_pending` 拒绝；
5. 跨 session promotion：item 属于 session A、`promoted_event_id` 指向 session B 的 canonical 事件 → `fk_pending_batch_items_promoted_event_session` 复合外键拒绝；
6. 同 session promotion（item 与 promoted event 同属 session A）→ 成功；
7. `pending_batch_items` item_type=`tool_call` 且 status=`committed` → `chk_pending_batch_items_tool_commit` 拒绝；
8. item 的 `session_id` 与其 batch 的 `session_id` 不一致 → `fk_pending_batch_items_session_batch` 复合外键拒绝。

> 注意：脚本用 `(SELECT id FROM game_sessions WHERE session_uuid=...)` 子查询解析 session 主键，不假设自增 id 连续——本机 MariaDB 的 `auto_increment_increment=3`（Galera 风格配置）下自增步长不是 1，直接写死 id=1/2 会导致探针误报。

## 7. 契约测试

```bash
node tests/schema-contract.test.mjs
```

该测试不连接数据库、不读取任何凭据，只做文本/结构断言：

- `db/migrations/0001_initial_story_outside.sql`、`db/migrations/0002_opening_cache_generation_profile.sql`、`db/migrations/0003_session_playback.sql`、`db/migrations/0004_pending_batch_lifecycle.sql` 与 `db/schema.sql` 存在，且 schema 代表 0001+0002+0003+0004 的最终形态；
- 必备表与必备列齐全；
- 版本、事件序列、幂等键、opening cache generation 复合唯一键等约束存在；
- 外键覆盖 story/version/session/event 关系，并以复合外键保证 session/version/cache 不串线；
- `game_sessions` 的 model/prompt/generation_profile、opening_cursor/opening_state/session_revision 齐全；
- `session_events` 的 append-only trigger、source/source_sequence 唯一性与非空校验存在；`trg_session_events_first_choice` 只写 `game_sessions.first_choice_at`，不再级联修改 `story_opening_caches`；
- 未混入 PostgreSQL 专属语法；
- 未出现 `password`、`app_key`、`access_secret`、`access_token` 等密钥字段。

## 8. 演进规则

- 新增状态枚举或字段时，优先走新的编号增量迁移（例如本次的 `0003_*.sql`）并更新 `db/schema.sql`，不能只改一边。
- canonical 事件新增类型时，同步更新 `session_events.event_type` 枚举与本文档；当前 05 的用户中断事件使用 `player_input`，不要复用旧事件类型表达新含义。
- 任何引入用户体系/多租户/鉴权的变更，必须继续遵守“不落库密钥、不存明文凭据”。

## 9. 应用层映射（故事之外 05 + 08）

05 在 Node 应用内增加 session playback 与 canonical history 逻辑（`src/stories/`），**不写入真实 MariaDB**。当前阶段仍提供凭据无关的内存版数据访问与 fixture；本节定义未来 MariaDB DAO 的列映射与事务边界。08 在同一 sessionService 上增加 pending batch lifecycle，仍不写入真实 MariaDB。

### 9.1 模块边界

- `src/stories/canonicalHash.mjs` — 稳定 SHA-256 + canonical JSON（按 key 递归排序）。同一故事内容（不计字段顺序）→ 同一 `checksum`；任一字段变化 → 新的 `checksum`。
- `src/stories/cacheKey.mjs` — 开场缓存键推导。键只由 `story_uuid` / `story_version_uuid` / `opening_key` / `profile.identifier` / `profile.rules_version` / `profile.locale` / allow-listed `profile.variant` 组成。**任何** `user_id` / `role_id` / `session_id` / `ip` / `device` / `timestamp` / `nonce`、任意 tags 或未知字段出现在 scope/profile 上都会明确报错。
- `src/stories/openingGenerator.mjs` — 纯函数：`story_version` 内容 → 逐句事件序列。结构化 `type: 'ask_player_choice'` beat（或文本标记）之前截断；输出中**不允许**出现 choice tool call / `ask_player_choice` 事件。结构化 dialogue/action 与说话人保留在公开开场中。
- `src/stories/repository.mjs` — 内存仓库，实现与 MariaDB 表对齐的方法集合：`upsertStory` / `findVersionByChecksum` / `importVersion` / `upsertOpeningCache` / `recordCacheInvalidation` / `recordSessionFirstChoice` 等。
- `src/stories/storyService.mjs` — 应用层 facade：`importStory` / `ensureOpeningCache` / `rebuildOpeningCache` / `startSessionSnapshot` / `markFirstChoiceConsumed`。
- `src/stories/sessionService.mjs` — **ClickUp 05 + 08 的唯一 canonical session store**。同一会话只存在一份 history、revision、cursor、state、idempotency map、active pending。Opening 事件走 `commitOpeningEvent`（受缓存事件约束）；narrative 事件走 `stageNarrativeBatch` + `commitNarrativeEvent` 序列（每 commit 仅追加 1 条已展示 narrative_beat）；可选 final tool call 随 batch 一起 staged，但绝不写入 canonical history；`interruptWithPlayerInput` 在同一原子状态机内丢弃 pending tail、追加 player_input 并切换 state='realtime'；`recoverSession` 只读返回 history + revision + cursor + pending，不调用 provider、不重放、不追加。
- `src/stories/pendingLifecycle.mjs` — ClickUp 08 的 strict facade。所有函数透传到 sessionService，不拥有独立的 history / revision / pending。可以被替换为更薄的别名层。`stageNarrativeBatch` 同时接受 `items:`（08 契约）与 `events:`（legacy 06/07 命名）以保留向后兼容。
- `src/agent/runtime.mjs` — Provider adapter。Provider 返回的 messages（1..4）或 items（1..4）被归一化为有序 narrative items + 可选 final tool_call，然后 staged 到 sessionService。provider 不再保存自己的 `state.pending`；所有 speculative 状态都在 session.pending。
- `src/server.mjs` — ClickUp 08 新增 `/api/dev/sessions/:uuid/generate` / `.../narrative-events` / `.../recover` 三个路由，原 `.../interrupt` 仍走统一的 `interruptWithPlayerInput`。
- `src/stories/fixture.mjs` — 用 mock provider 的内容预填仓库，保证 admin/dev 路由能拿到稳定的 `story_uuid` / `story_version_uuid`。

### 9.2 SQL 表 ↔ 仓库 / 服务映射

| MariaDB 表 | 仓库 / 服务 | 重要列 ↔ 内存表示 |
| --- | --- | --- |
| `stories` | `repository.upsertStory` | `slug` / `story_uuid` / `title` / `hook` / `locale` / `status`；目录行，不携带正文。 |
| `story_versions` | `repository.importVersion` / `repository.findVersion` / `repository.listVersionsByStory` | `version_uuid` / `story_id` / `version_no` / `content_payload` / `roles_payload` / `checksum` / `status`。同一 `checksum` 已存在时直接复用；不同则 `version_no` 递增，旧行保留。 |
| `story_opening_caches` | `repository.upsertOpeningCache` / `repository.findOpeningCacheByScope` / `repository.recordCacheInvalidation` | `cache_uuid` / `story_id` / `story_version_id` / `opening_key` / `generation_profile` / `generation_hash` / `status` (valid/invalidated/failed) / `content_payload` / `content_hash` / `use_count`。生成失败产生 `status='failed'` 行，不覆盖既有 `valid` 行。 |
| `game_sessions` | `createSession` / `recoverSession` / `repository.recordSessionFirstChoice` | `session_uuid` / `story_id` / `story_version_id` / `user_ref` / `role_id` / `model` / `prompt` / `generation_profile` / `opening_cache_id` / `opening_cursor` / `opening_state` / `session_revision` / `first_choice_at` / `ending_id`。创建会话时固定 story/version/cache 复合关系；未来 DAO 在同一事务中写入快照并推进 revision。 |
| `session_events` | `commitOpeningEvent` / `commitNarrativeEvent` / `interruptWithPlayerInput` 的未来 DAO 接缝 | canonical 事件流只允许 INSERT；`event_seq` 是 session chain，`source` / `source_sequence` 是 producer provenance（(session, source) 单调计数器，跨 batch 不复位），`client_request_id` 做幂等。`markFirstChoiceConsumed` 只返回 session-local marker，不直接把预览写成 canonical 事件。 |
| `pending_batches` | `stageNarrativeBatch` 的未来 DAO 接缝 | speculative request / response 包；生命周期 `expected_revision` / `request_fingerprint`（唯一）/ `committed_count <= item_count`（`chk_pending_batches_counts`）/ `source` 非空；提正时设 `promoted_event_id` 与 `status='succeeded'`。 |
| `pending_batch_items` | `stageNarrativeBatch` + `commitNarrativeEvent` 的未来 DAO 接缝 | 每个 staged narrative beat 一行，`(batch_id, item_seq)` 唯一，`item_type='narrative_beat'` / `tool_call`；`session_id` 冗余自 batch；committed 必须填 `promoted_event_id` + `occurred_at`（`chk_pending_batch_items_committed`），discarded 必须两者为 NULL（`chk_pending_batch_items_discarded`），pending 同样不得携带（`chk_pending_batch_items_pending`）；tool_call 行不可 committed（`chk_pending_batch_items_tool_commit`）；`(session_id, promoted_event_id)` 复合外键强制 promoted event 与 batch 同 session。 |

> 注：内存仓库仅复现 schema 表面上的应用语义；不会假装数据已写入 MariaDB。任何 `repository.*` 调用都不发起 SQL。当未来引入 `src/stories/daoMaria.mjs` 时，可以逐方法替换仓库实现，服务层和路由代码不需要变动。

### 9.3 开场缓存作用域与不可变性

- `opening_key` 默认为 `'default'`；保留多套 `opening_key` 是为以后的 spoof / 彩蛋 / 实验者索引位预留。
- 唯一键：`(story_id, story_version_id, opening_key, generation_hash)`，其中 `generation_hash` 由公开 generation profile 推导。旧版本缓存与新一代 profile 可并存。
- 一旦 `status='valid'`，其 `content_payload` / `content_hash` **不可变**。后续调用如果仍在同一 generation 下重复生成，将直接返回原缓存；需要变更必须通过 `rebuildOpeningCache(...)`（显式传 `rules_version` / `identifier` / `locale` / allow-listed `variant`）或 `ensureOpeningCache({ force: true, replace_strategy: 'new_generation' | 'in_place' })`。
- `recordCacheInvalidation` 是 admin 层显式审计动作：将行状态改为 `invalidated`，并从基于 scope 的查找索引中移除；行本身保留。
- `markFirstChoiceConsumed` 是会话首次发生 `ask_player_choice` 事件的等价动作；它只返回 **session-local consumed marker**（`session_uuid` / `opening_cache_uuid` / `first_choice_at` / reason）。它**不**调用 `recordCacheInvalidation`，因此其他 Session 仍可复用共享开场缓存。当前内存仓库没有持久化 `game_sessions` 表，marker 保存在 `sessionFirstChoices` 映射；未来 DAO 应落库到 `game_sessions.first_choice_at`。

### 9.4 替换 DAO 的注意事项

- 应用层需要的 SQL 列在仓库里的命名与 SQL 列名一致，便于未来 SQL 写入无歧义映射；`createSession` 的 model/prompt/profile 与 playback 初值应映射到同名列。
- DAO 创建 session 时必须同时校验 story/version/cache 的复合归属；恢复时以 `session_events` 的最大 canonical `event_seq`、source provenance 和 `session_revision` 为准，不以 speculative payload 或客户端 cursor 覆盖数据库值。
- `session_events` 的 append-only 限制仍由 trigger 保证，应用层**不能也不应** `UPDATE` / `DELETE`。`markFirstChoiceConsumed` 只记录 session-local first-choice marker，不绕过 `session_events` 直接修改事件，也不修改共享 opening cache。
- 后续 DAO 落地后，仓库方法可逐个替换为参数化查询；建议为每个方法单独提供单元测试 + 集成测试，保留现有应用层语义不变。
