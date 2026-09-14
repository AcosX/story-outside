# Agent Runtime

- 运行时保留 pinned session context，保证同一会话的请求与修订在稳定上下文中推进。
- provider.complete 是关键 seam，用于把规范化结果和提供者回调解耦。
- speculative 与 canonical 分离：前者只用于探索/草稿，后者才进入持久化路径。
- 提供 `ask_player_choice` 与 `finish_story` 两个工具，分别处理交互选择与故事收束。
- `request` / `revision` 采用幂等语义，重复提交不应产生重复副作用。
- `recoverRuntime` 负责恢复可继续的运行态；`resumeTurn` 只恢复可续接的回合，不替代首次创建。
- `src/db/mariaPersistence.mjs` 负责把 session projection、canonical history、pending batch 和 compact runtime state hydrate/flush 到 MariaDB；runtime 本身仍只依赖同步 repository contract。
- Story 08 P1.2：运行时归一化的 stage 调用在 canonical session 已有未消费 active pending 时，相同 payload 返回同一 pending snapshot（幂等），不同 payload 必须 fail closed。运行时 / sessionService 都不会静默覆盖待消费的批；调用方必须先 commit / interrupt / discard 才能开新批。
- Story 08 P1.3：normalizeProviderResult 仅接受以下合法输入形状：(a) `items: [1..4 个 narrative item]`，可选附加 `tool_call: <one>`；(b) 遗留 `messages: [1..4 个 assistant 文本]`，可选 `tool_calls: [<恰一个>]`——messages 为有序 narrative items，唯一 tool 作为可选 FINAL item 无歧义归一化。`items + messages` / `tool_calls` 数组多于一个 / `tool_calls` 仅一条无 narrative / 5+ items / 空批次 / items 内混入 tool 型条目 / 非法 tool payload 一律 `invalid_tool_call` fail closed。tool_call 永远不进入 canonical history。
- Story 08 P1.1：`cursor` 是 canonical cursor——等于 `revision` 与最后一条 `event_seq`（已提交 canonical 事件总数），每次 commit（opening / narrative / player_input）都 +1；opening 播放顺序由内部 `opening_cursor` 单独维护（对外只读暴露）。下一轮 runtime 的 `buildRequest` 通过 `listSessionEvents` 看到上一轮所有已提交的 canonical event；`source_sequence` 是 (session, source) 单调计数器，跨 batch 不复位。
- Story 08 P1.5：HTTP 层每次请求新建 runtime，但 request_id 幂等状态归属 **session**（`sessionService.turnRequests`）：相同 `request_id + input + expected_revision` 跨请求返回完全相同的 result（turn_id / items / tool / pending_id）且不再调用 provider；同 request_id 不同 input/revision 拒绝（`duplicate_request`）；active pending 下不同 request_id 不能覆盖（stage fail closed）。`commitNarrativeEvent` 的 client_request_id 幂等在 pending 清空后仍可重放（final-commit 幂等）。
- Story 08 P1.6：未配置数据库时 runtime / sessionService 使用内存 repository，只提供本进程 recover；配置 MariaDB 后，server 在启动时 hydrate projection，`recoverSession` 可跨进程恢复 canonical history、revision、cursor、pending 与 compact state，且仍不调用 provider、不重放、不追加。
- Story 08 P1.4/P2.6：`interruptWithPlayerInput` 接受 `opening` / `awaiting_first_choice` / `realtime`；realtime 会话可再次打断（丢弃 pending tail、追加 player_input、保持 `realtime`），同 client_request_id 幂等。

## 实时逐句续写

真实 AI 每次 `narrate.items` 恰好一条简短叙事（建议 20～80 字），schema 与返回校验同时限制数量；违规结果走现有有界重试，禁止截断多条结果以免丢失选择或结局的前置情节。只有有意义的分岔才附带选择，核心冲突解决时继续要求结局。

前端收到即显示，自动播放中立即提交这一条；服务端按 revision 接受这一句后立即应答，数据库写入与下一句生成并行，不再等待 SQL 完成或额外等待 1100ms。暂停停止自动推进，插话仍等待已开始的内存提交并作废旧生成。选择/结局先展示，不能越过它们生成。兼容旧会话 1～4 条 pending 与回放，公共开场缓存仍按原有阅读节奏播放。

每句独立调用会增加请求次数及重复输入成本；消除了等待同批后续叙事和多余播放定时器的延迟，但首句仍依赖模型响应与网络耗时。

## 异步保存与保存状态

播放器为 `opening-events`、`narrative-events` 发送 `Prefer: persist-async`，为带 request_id 的 `generate` 发送 `Prefer: respond-async, persist-async`。服务端仍同步校验 revision、pending 和幂等标识，并把被接受的叙事放入内存 canonical history；响应附带 `persistence`，不再把 HTTP 200 当作数据库已保存。下一轮读取这个已接受的历史，所以不需要猜测 revision 或在不同请求之间争抢顺序。未发送此偏好的客户端继续等待数据库确认；初始会话创建、玩家输入等业务写入保留原来的持久化应答。

`asyncSessionPersistence.mjs` 合并待保存更新，用单个后台任务调用现有串行 `flush`。每轮保存水位只覆盖该轮启动前接受的更新，写入期间的新内容另排一轮；失败不会推进水位。正常关闭服务会等待请求与异步保存完成，再关闭数据库。

`GET /api/sessions/:uuid/save-status` 返回当前保存水位；`POST` 同一路径重试失败的保存。接口受现有账户所有权与 Origin 校验保护。播放器的 `recover` 同样发送 `Prefer: persist-async`，不等待数据库，返回内存恢复投影及保存状态；旧客户端的恢复请求仍等待数据库。状态带进程 epoch，页面不能用重启后的新水位冒充旧进程的保存确认。

页面只有在水位覆盖当前更新后才显示“已自动保存”，否则显示“正在保存…”；保存失败暂停自动推进并提供“重试保存”。重试完成不自动解除暂停。异步应答与数据库落盘之间，异常进程退出可能丢失尚未保存的进度；页面发现进程或保存状态失效时提供重新载入，按服务端已保存历史恢复。

“故事正在继续…”按播放状态显示，覆盖生成、消息返回、提交接受与下一轮请求的间隔，并保持在消息底部。暂停、插话、选择节点或结局会隐藏它；保存中的状态独立显示，不冒充正在生成或已保存。
