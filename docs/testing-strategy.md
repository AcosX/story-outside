# 测试策略（Task 12）

> 适用: ClickUp 12 — 自动测试、回归 Fixture 与故障场景。本文件描述 `story-outside` 在 main 上的测试分层、固定测试故事契约、以及 CI 跑法。
>
> **08/09/10 合编后的契约适配（已完成）**: 本清单中的 5 个套件最初针对 08 合并前的旧契约编写，现已全部适配到 08（pending 批次硬化 + 统一 cursor）/ 09（单屏播放器别名）/ 10（compact）合并后的统一契约，并已接入 `package.json` 的 `npm test` 链（追加在 `storyOutside09` 之后）。适配要点：
>
> * **provider 批次形状**: tool call 必须骑在 1..4 个 narrative item 批次的末尾（`{ items, tool_call }` 或 legacy `{ messages, tool_calls }`）；**tool-only 批次被拒绝**（`invalid_tool_call`）。provider 返回 `{}` → `provider_failure`；空 `messages` 数组 → `invalid_tool_call`。
> * **turn 结果面**: runtime 返回单个 tool envelope（`result.tool_call` / `tool_envelope` / `tool_result.payload`），不再有 `result.tool_calls[]` 数组；恢复快照的 pending 字段是 `recoverRuntime().staged`。
> * **cursor 语义**: `cursor === revision === history.length`，所有 commit（含 player_input）双增；开场播放位置独立在 `opening_cursor`（仅 opening commit 推进）。
> * **source_sequence**: per-(session, source) 0-based 连续计数器——runtime 批次跨批连续，第一条 player_input 从 0 开始。
> * **pending 生命周期**: 存在未消费 pending 时 `stageNarrativeBatch` fail-closed；多次 agent turn 之间测试需先 commit 或 `discardPendingTail`。配置 MariaDB 的 HTTP flush 还会把 active narrative/tool item 保持为 `pending`，提交后分别写成 `committed` / `discarded`。

## 1. 测试套件清单

| 套件 | 覆盖层次 | 用例数 | 跑法 |
| --- | --- | --- | --- |
| `tests/dbTransactions.test.mjs` | DB / 事务 | 5 | `node tests/dbTransactions.test.mjs` |
| `tests/providerAdapter.test.mjs` | DTO / Provider Adapter | 10 | `node tests/providerAdapter.test.mjs` |
| `tests/failureScenarios.test.mjs` | 故障场景（15 项） | 15 | `node tests/failureScenarios.test.mjs` |
| `tests/integrationFullChain.test.mjs` | Integration 全链路 | 3 | `node tests/integrationFullChain.test.mjs` |
| `tests/agentRegression.test.mjs` | Agent 回归 | 7 | `node tests/agentRegression.test.mjs` |

合计 40 用例，全部通过（已按统一契约适配并接入 `npm test`）。原有套件（health/providers/http/schema-contract/canonicalHash/cacheKey/openingGenerator/storyService/sessionService/sessionHttp/agentTools/agentRuntime/adminRoutes/observability/observabilityHttp/pendingLifecycle/storyOutside08/storyOutside09）与 PR #10 的三个 compact 套件（tokenEstimator/contextBuilder/agentCompact）一并挂在同一条 `npm test` 链上。

## 2. 唯一固定测试故事

`tests/fixtures/seed-stories/cafe-rain.mjs` 锁定一个唯一的、可断言的 fixture:

* slug = `cafe-rain`（与 `src/providers/mockProvider.mjs` CATALOG 同源）
* `story_uuid` / `story_version_uuid` = `FIXTURE_UUIDS['cafe-rain']`
* `beats.length = 6`，第 4 个是 `ask_player_choice`（开场缓存会在此处截断）
* 角色: `stranger` + `old-friend`
* `ask_player_choice_envelope` 与 `finish_story_envelope` 锁定 tool_call_id 与 `ending_key`

所有套件只 import 这一个 fixture — 修改字段时全部测试同步失耦。

## 3. 测试层次

### 3.1 Unit

* DTO 转换 — `providerAdapter.test.mjs` 第 1a/1b/1c
* 工具参数校验 — `providerAdapter.test.mjs` 第 2a/2b/2c
* 事件解析 — `providerAdapter.test.mjs` 第 1b

### 3.2 DB / 事务

`dbTransactions.test.mjs` 覆盖五条不可让渡的契约，对应 `docs/data-model.md` §3.3:

1. **逐句 commit** — 每次 `commitOpeningEvent` 严格递增 `event_seq`，`prev_event_seq` 形成单链。
2. **重复点击幂等** — 同 `client_request_id` 重放返回原值；同 id 不同 payload 抛 `different request`。
3. **打断删除 pending** — `interruptWithPlayerInput` 后状态切到 `realtime`，任何后续 `commitOpeningEvent` 抛 `not in opening`。统一 cursor 语义下：canonical `cursor` 随 player_input 双增（`cursor === revision === history.length`），开场播放位置冻结在 `opening_cursor`。
4. **sequence 唯一** — 整个会话历史 `event_seq` 是 1..N 连续无重复；`source_sequence` 是 per-(session, source) 0-based 连续计数器（opening 事件沿用 pinned cache sequence，第一条 player_input 从 0 开始）。
5. **Session recover** — `recoverSession` 在跨次读取下字节级一致，并重建 cursor / revision / opening_cursor / history。

### 3.3 Integration

`integrationFullChain.test.mjs` 端到端跑:

```
importStory
  → ensureOpeningCache (status=valid, boundary=truncated_before_first_choice)
  → startSessionSnapshot (pin story_version + cache_uuid)
  → createSession (state=opening, cursor=0)
  → 3×commitOpeningEvent (cursor=3, state=opening)
  → drain remaining cache (state=awaiting_first_choice)
  → markFirstChoiceConsumed (session-local marker; shared cache still valid)
  → agent.runTurn#1 (ask_player_choice envelope, canonical history unchanged)
  → interruptWithPlayerInput (player_input event)
  → agent.runTurn#2 (finish_story envelope, terminal=true)
  → recoverSession (pin invariants preserved)
```

### 3.4 Agent 回归

`agentRegression.test.mjs` 7 个用例锁定 agent runtime + tool envelope 的结构契约:

* `R1` — fixture + canned tool call 的 envelope 字节稳定
* `R2` — finish_story envelope 端点保留所有 character_outcomes 字段
* `R3` — stale revision 必须 `revision_mismatch` 失败
* `R4` — agent 多次 turn 不触碰 canonical history
* `R5` — 同 `request_id` 同 payload 幂等；不同 payload 抛 `duplicate_request`
* `R6` — pin 不匹配 (story_version / generation_profile) 抛 `pin_mismatch`
* `R7` — session A 中断不影响共享 cache，session B 仍可 pin 同一 `cache_uuid`

### 3.5 故障场景（15 项）

| # | 场景 | 套件用例 |
| --- | --- | --- |
| 1 | Agent 超时 | failureScenarios #1 |
| 2 | Agent 返回 500 | failureScenarios #2 |
| 3 | Agent 返回无效结构化输出 | failureScenarios #3 |
| 4 | Tool schema 不合法 | failureScenarios #4 |
| 5 | Mock API 429 | failureScenarios #5 |
| 6 | Mock API 500 | failureScenarios #6 |
| 7 | Mock API 超时 | failureScenarios #7 |
| 8 | Mock API 空正文 | failureScenarios #8 |
| 9 | 用户连续快速点击推进 | failureScenarios #9 + dbTransactions #2 |
| 10 | 自动播放期间输入框 focus | failureScenarios #10 |
| 11 | pending 尚未播完时发送玩家输入 | failureScenarios #11 |
| 12 | commit 后客户端断线再重试 | failureScenarios #12 + dbTransactions #2 |
| 13 | compact 触发时服务重启 | failureScenarios #13（10 已合编：正断言 canonical history 单独重建等价快照） |
| 14 | compact 触发时模型失败 | failureScenarios #14（10 已合编：正断言 recordCompactFailure 标记 + retry 不被污染） |
| 15 | finish_story 尚未 commit 前玩家打断 | failureScenarios #15 |

## 4. 10 合编后的现状（#13 / #14 已是正断言）

`feat/story-outside-10` 的 compact 交付物已合入 main：`src/agent/tokenEstimator.mjs` + `src/agent/contextBuilder.mjs`，以及 `src/stories/sessionService.mjs` 上的 4 个函数：

* `recordCompact` — 持久化 compact 快照
* `recordCompactFailure` — 持久化 compact 失败
* `getSessionCompact` — 读取 compact 快照
* `rebuildCompactFromHistory` — 从 canonical history 重生成

`failureScenarios.test.mjs` 的 #13 / #14 已从"negative assertion（未合并）"改成"positive assertion（已合并）"：

* **#13 (compact + 服务重启)**: 断言 4 个 compact 函数存在于 sessionService、`src/stories/index.mjs` 的 re-export 面完整（sessionService 10 个导出 + pendingLifecycle 门面 6 个导出）；recordCompact 不触碰 canonical history；用新 repository 模拟"重启后进程"，`rebuildCompactFromHistory` 仅凭 canonical history 重建出与重启前等价的快照（同 through_seq / event_count / payload / token_estimate）。内存 repository 的单元边界见 §6；配置 MariaDB 的真实 HTTP 重启验证见 §6.1。
* **#14 (compact + 模型失败)**: `recordCompactFailure` 写入 session-local 失败标记（`last_compact_status='failed'`），不推进 `compacted_through_seq`、不清空既有快照、不失效共享 opening cache；更高 `through_seq` 的 retry 照常成功并清除失败状态。

## 5. CI 跑法（不依赖真实 API）

```bash
cd /path/to/story-outside   # 仓库根目录（以 package.json 所在处为准，不要硬编码机器路径）

# 1. 全套测试（一条链跑完，含 Task 12 的 5 个套件与 PR #10 的 3 个 compact 套件）
npm test
# → health, providers, http, schema-contract, canonicalHash, cacheKey,
#   openingGenerator, storyService, sessionService, sessionHttp,
#   agentTools, agentRuntime, adminRoutes, observability, observabilityHttp,
#   pendingLifecycle, storyOutside08, storyOutside09,
#   tokenEstimator, contextBuilder, agentCompact,
#   providerAdapter, dbTransactions, failureScenarios,
#   integrationFullChain, agentRegression

# 2. 单独跑任意套件（顺序无关）
node tests/dbTransactions.test.mjs
node tests/providerAdapter.test.mjs
node tests/failureScenarios.test.mjs
node tests/integrationFullChain.test.mjs
node tests/agentRegression.test.mjs

# 3. 语法检查（覆盖 tests/ + docs/ + src/）
npm run check

# 4. whitespace 检查
git diff --check
```

> Task 12 的 5 个套件与 PR #10 的 3 个 compact 套件现已全部接入 `package.json` 的 `npm test` 链（追加在 `storyOutside09` 之后）——"合编时统一收编"已完成，`npm test` 即用户日常跑法。

## 6. 真实边界声明

> 套件明确不假装生产。所有断言仅在以下两个边界内可证:
>
> * **进程内 in-memory repository**: `npm test` 的大多数 service/unit 套件使用无数据库的同步 projection，专门验证应用层语义；这不是跨进程持久化证明。
> * **MariaDB runtime adapter**: 配置 `STORY_OUTSIDE_DATABASE_URL` 后，`src/db/mariaPersistence.mjs` 在启动时 hydrate，并在 JSON 响应前事务 flush。真实数据库启动、迁移、跨进程 recovery 和 pending item 状态需要按 §6.1 验证。
> * **固定故事 cafe-rain**: 任何 slug 漂移 / 字段漂移会立刻把本套件变红。

不要把以下当作可生产契约:

* 未配置数据库时，`repository` 的内存 projection 在进程退出时丢失；配置 MariaDB 的运行模式从 SQL hydrate，跨进程 recovery 由真实 adapter 验证。
* `createMockAgentProvider` 的 canned responses — 真实生产是任意 LLM provider。
* `STORY_OUTSIDE_PROVIDER=mock` 是默认；`ZHIHU_PROVIDER` 是向后兼容的别名（`STORY_OUTSIDE_PROVIDER` 优先）。`real` 已实现。

### 6.1 MariaDB 真实集成清单

自动回归使用单独创建的空测试库，测试不会删除库，运行后由调用者清理测试库和测试用户：

```bash
STORY_OUTSIDE_TEST_DATABASE_URL='mariadb://test_user:password@127.0.0.1:3307/disposable_test_db' npm run test:db
```

该测试覆盖旧 schema 升级、迁移重跑、跨会话相同请求 ID、相同 pending 内容的批次隔离、重载和事件冲突回滚。未显式配置测试连接时跳过；非空库会拒绝执行。普通 `npm test` 包含无数据库的事务队列恢复、事件幂等和批次身份回归。

使用本地 scratch MariaDB 或专用测试库，不对生产库执行迁移：

```bash
export STORY_OUTSIDE_DATABASE_URL='mariadb://user:password@127.0.0.1:3306/story_outside'
npm run db:migrate
STORY_OUTSIDE_PROVIDER=mock PORT=4175 npm start
```

确认 `GET /api/health` 返回 `database.status=ready`，然后从 HTTP 创建 session、生成带 `finish_story` 的 batch，分别检查：active batch 的 narrative/tool item 都是 `pending`；提交最后一个 narrative 后 batch 是 `succeeded`、narrative 是 `committed`、tool 是 `discarded`。停止并重新启动服务后，`/api/sessions/:uuid/recover` 的 history/revision/pending 与数据库一致；`pinned` 元数据由 durable session projection 重建。

## 7. 添加新测试的规则

* 不要 mutate `tests/fixtures/seed-stories/cafe-rain.mjs` — 用新 slug / 新 fixture 文件。
* 不要让 suite 依赖网络 / 真实 LLM / MariaDB。
* 不要在 suite 里 echo `process.env.STORY_OUTSIDE_PROVIDER` 或 `process.env.ZHIHU_PROVIDER` 之外的任何 env key。
* 新增套件时同步追加到 `package.json` 的 `test` 链尾（"合编时统一收编"已完成，链内现有 26 个套件）。
* 4–8 个 commit 粒度，每个 commit 末尾加 `Co-authored-by: OpenClaw <claw@acosx.top>`。
