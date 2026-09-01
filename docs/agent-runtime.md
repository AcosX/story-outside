# Agent Runtime

- 运行时保留 pinned session context，保证同一会话的请求与修订在稳定上下文中推进。
- provider.complete 是关键 seam，用于把规范化结果和提供者回调解耦。
- speculative 与 canonical 分离：前者只用于探索/草稿，后者才进入持久化路径。
- 提供 `ask_player_choice` 与 `finish_story` 两个工具，分别处理交互选择与故事收束。
- `request` / `revision` 采用幂等语义，重复提交不应产生重复副作用。
- `recoverRuntime` 负责恢复可继续的运行态；`resumeTurn` 只恢复可续接的回合，不替代首次创建。
- 不在此文档声称已有 MariaDB DAO；持久层实现应以实际代码为准。

