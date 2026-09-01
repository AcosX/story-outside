# Agent Runtime

- 运行时保留 pinned session context，保证同一会话的请求与修订在稳定上下文中推进。
- provider.complete 是关键 seam，用于把规范化结果和提供者回调解耦。
- speculative 与 canonical 分离：前者只用于探索/草稿，后者才进入持久化路径。
- 提供 `ask_player_choice` 与 `finish_story` 两个工具，分别处理交互选择与故事收束。
- `request` / `revision` 采用幂等语义，重复提交不应产生重复副作用。
- `recoverRuntime` 负责恢复可继续的运行态；`resumeTurn` 只恢复可续接的回合，不替代首次创建。
- 不在此文档声称已有 MariaDB DAO；持久层实现应以实际代码为准。
- ClickUp 08 P1.2：运行时归一化的 stage 调用在 canonical session 已有未消费 active pending 时，相同 payload 返回同一 pending snapshot（幂等），不同 payload 必须 fail closed。运行时 / sessionService 都不会静默覆盖待消费的批；调用方必须先 commit / interrupt / discard 才能开新批。
- ClickUp 08 P1.3：normalizeProviderResult 仅接受以下合法输入形状：(a) `items: [1..4 个 narrative item]`，可选附加 `tool_call: <one>`；(b) 遗留 `messages: [1..4 个 assistant 文本]`，无 tool_calls。`items + messages` / `messages + tool_calls` / `items + tool_calls` 数组 / `tool_calls` 仅一条无 narrative / 5+ items / 空批次 一律 `invalid_tool_call` fail closed。tool_call 永远不进入 canonical history。
- ClickUp 08 P1.1：下一轮 runtime 的 `buildRequest` 必须通过 `listSessionEvents` 看到上一轮所有已提交的 canonical event；cursor 仅在开场 commit 时递增、narrative commit / interrupt 不递增，cursor 不回退。
- ClickUp 08 P1.6：runtime / sessionService 在内存 repository 下不提供跨进程恢复；要声称“已恢复”必须未来 MariaDB DAO 接通后再说；当前只验证本进程内可幂等 recover，不重复追加、不调用 provider。
