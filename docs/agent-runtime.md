# Agent Runtime

- 运行时保留 pinned session context，保证同一会话的请求与修订在稳定上下文中推进。
- provider.complete 是关键 seam，用于把规范化结果和提供者回调解耦。
- speculative 与 canonical 分离：前者只用于探索/草稿，后者才进入持久化路径。
- 提供 `ask_player_choice` 与 `finish_story` 两个工具，分别处理交互选择与故事收束。
- `request` / `revision` 采用幂等语义，重复提交不应产生重复副作用。
- `recoverRuntime` 负责恢复可继续的运行态；`resumeTurn` 只恢复可续接的回合，不替代首次创建。
- 不在此文档声称已有 MariaDB DAO；持久层实现应以实际代码为准。
- ClickUp 08 P1.2：运行时归一化的 stage 调用在 canonical session 已有未消费 active pending 时，相同 payload 返回同一 pending snapshot（幂等），不同 payload 必须 fail closed。运行时 / sessionService 都不会静默覆盖待消费的批；调用方必须先 commit / interrupt / discard 才能开新批。
- ClickUp 08 P1.3：normalizeProviderResult 仅接受以下合法输入形状：(a) `items: [1..4 个 narrative item]`，可选附加 `tool_call: <one>`；(b) 遗留 `messages: [1..4 个 assistant 文本]`，可选 `tool_calls: [<恰一个>]`——messages 为有序 narrative items，唯一 tool 作为可选 FINAL item 无歧义归一化。`items + messages` / `tool_calls` 数组多于一个 / `tool_calls` 仅一条无 narrative / 5+ items / 空批次 / items 内混入 tool 型条目 / 非法 tool payload 一律 `invalid_tool_call` fail closed。tool_call 永远不进入 canonical history。
- ClickUp 08 P1.1：`cursor` 是 canonical cursor——等于 `revision` 与最后一条 `event_seq`（已提交 canonical 事件总数），每次 commit（opening / narrative / player_input）都 +1；opening 播放顺序由内部 `opening_cursor` 单独维护（对外只读暴露）。下一轮 runtime 的 `buildRequest` 通过 `listSessionEvents` 看到上一轮所有已提交的 canonical event；`source_sequence` 是 (session, source) 单调计数器，跨 batch 不复位。
- ClickUp 08 P1.5：HTTP 层每次请求新建 runtime，但 request_id 幂等状态归属 **session**（`sessionService.turnRequests`）：相同 `request_id + input + expected_revision` 跨请求返回完全相同的 result（turn_id / items / tool / pending_id）且不再调用 provider；同 request_id 不同 input/revision 拒绝（`duplicate_request`）；active pending 下不同 request_id 不能覆盖（stage fail closed）。`commitNarrativeEvent` 的 client_request_id 幂等在 pending 清空后仍可重放（final-commit 幂等）。
- ClickUp 08 P1.6：runtime / sessionService 在内存 repository 下不提供跨进程恢复；要声称“已恢复”必须未来 MariaDB DAO 接通后再说；当前只验证本进程内可幂等 recover，不重复追加、不调用 provider。
- ClickUp 08 P1.4/P2.6：`interruptWithPlayerInput` 接受 `opening` / `awaiting_first_choice` / `realtime`；realtime 会话可再次打断（丢弃 pending tail、追加 player_input、保持 `realtime`），同 client_request_id 幂等。
