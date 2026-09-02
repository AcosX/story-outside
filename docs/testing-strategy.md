# 测试策略（Task 12）

> 适用: ClickUp 12 — 自动测试、回归 Fixture 与故障场景。本文件描述 `story-outside` 在 main 上的测试分层、固定测试故事契约、以及 CI 跑法。

## 1. 测试套件清单

| 套件 | 覆盖层次 | 用例数 | 跑法 |
| --- | --- | --- | --- |
| `tests/dbTransactions.test.mjs` | DB / 事务 | 5 | `node tests/dbTransactions.test.mjs` |
| `tests/providerAdapter.test.mjs` | DTO / Provider Adapter | 10 | `node tests/providerAdapter.test.mjs` |
| `tests/failureScenarios.test.mjs` | 故障场景（15 项） | 15 | `node tests/failureScenarios.test.mjs` |
| `tests/integrationFullChain.test.mjs` | Integration 全链路 | 3 | `node tests/integrationFullChain.test.mjs` |
| `tests/agentRegression.test.mjs` | Agent 回归 | 7 | `node tests/agentRegression.test.mjs` |

合计 40 用例，全部通过。原有套件（health/providers/http/schema-contract/canonicalHash/cacheKey/openingGenerator/storyService/sessionService/sessionHttp/agentTools/agentRuntime/adminRoutes）保持原样。

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
3. **打断删除 pending** — `interruptWithPlayerInput` 后状态切到 `realtime`，任何后续 `commitOpeningEvent` 抛 `not in opening`。
4. **sequence 唯一** — 整个会话历史 `event_seq` 是 1..N 连续无重复。
5. **Session recover** — `recoverSession` 在跨次读取下字节级一致。

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
| 13 | compact 触发时服务重启 | failureScenarios #13（R1 收编后覆盖） |
| 14 | compact 触发时模型失败 | failureScenarios #14（R1 收编后覆盖） |
| 15 | finish_story 尚未 commit 前玩家打断 | failureScenarios #15 |

## 4. R1 收编后的覆盖路径（#13 / #14）

`feat/story-outside-10` 在 `src/agent/` 下新增 `tokenEstimator.mjs` + `contextBuilder.mjs`，并在 `src/stories/sessionService.mjs` 上加 4 个函数:

* `recordCompact` — 持久化 compact 快照
* `recordCompactFailure` — 持久化 compact 失败
* `getSessionCompact` — 读取 compact 快照
* `rebuildCompactFromHistory` — 从 canonical history 重生成

合编到 main 后，`failureScenarios.test.mjs` 的 #13 / #14 应改为:

* **#13 (compact + 服务重启)**: 触发一次 compact → 模拟服务重启 (`_resetForTests()` + 新建 repository) → `rebuildCompactFromHistory` 必须重新生成与重启前等价的快照。
* **#14 (compact + 模型失败)**: provider 抛 `provider_failure` → `recordCompactFailure(session_uuid, reason)` 必须在 `pending_batches` 或 session-local marker 上写入失败原因；后续 retry 调用 `rebuildCompactFromHistory` 不被该次失败污染。

合编时不要修改本套件编号 — 直接把 #13 / #14 现在的"negative assertion (未合并)" 改成"positive assertion (已合并)"。

## 5. CI 跑法（不依赖真实 API）

```bash
cd /srv/lmdo/story-outside-work-12

# 1. 全套现有测试
npm test
# → health, providers, http, schema-contract, canonicalHash, cacheKey,
#   openingGenerator, storyService, sessionService, sessionHttp,
#   agentTools, agentRuntime, adminRoutes

# 2. 新增 5 套件（顺序无关）
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

> Task 12 范围不在 `package.json` 的 `npm test` 链里追加新套件 — R1 合编时统一收编。本文档描述的 CI 命令即"用户日常跑法"，合编后会被 `npm test` 自动覆盖。

## 6. 真实边界声明

> 套件明确不假装生产。所有断言仅在以下两个边界内可证:
>
> * **进程内 in-memory repository**: 仍是当前 main 上的实现；MariaDB DAO 是未来的事，触发器 / 唯一键 / canonical append-only 由 `docs/data-model.md` + `tests/schema-contract.test.mjs` 守门。
> * **固定故事 cafe-rain**: 任何 slug 漂移 / 字段漂移会立刻把本套件变红。

不要把以下当作可生产契约:

* `repository` 的内存状态在进程退出时丢失 — 真实生产是 MariaDB。
* `createMockAgentProvider` 的 canned responses — 真实生产是任意 LLM provider。
* `STORY_OUTSIDE_PROVIDER=mock` 是默认 — `real` 仍未实现。

## 7. 添加新测试的规则

* 不要 mutate `tests/fixtures/seed-stories/cafe-rain.mjs` — 用新 slug / 新 fixture 文件。
* 不要让 suite 依赖网络 / 真实 LLM / MariaDB。
* 不要在 suite 里 echo `process.env.STORY_OUTSIDE_PROVIDER` 之外的任何 env key。
* 不要修改 `package.json` 的 `scripts` 段（合编时统一处理）。
* 4–8 个 commit 粒度，每个 commit 末尾加 `Co-authored-by: OpenClaw <claw@acosx.top>`。