# Agent Runtime

- 运行时保留 pinned session context，保证同一会话的请求与修订在稳定上下文中推进。
- provider.complete 是关键 seam，用于把规范化结果和提供者回调解耦。
- speculative 与 canonical 分离：前者只用于探索/草稿，后者才进入持久化路径。
- 提供 `ask_player_choice` 与 `finish_story` 两个工具，分别处理交互选择与故事收束。
- `request` / `revision` 采用幂等语义，重复提交不应产生重复副作用。
- `recoverRuntime` 负责恢复可继续的运行态；`resumeTurn` 只恢复可续接的回合，不替代首次创建。
- `src/db/mariaPersistence.mjs` 负责把 session projection、canonical history、pending batch 和 compact runtime state hydrate/flush 到 MariaDB；runtime 本身仍只依赖同步 repository contract。
- Story 08 P1.2：运行时归一化的 stage 调用在 canonical session 已有未消费 active pending 时，相同 payload 返回同一 pending snapshot（幂等），不同 payload 必须 fail closed。运行时 / sessionService 都不会静默覆盖待消费的批；调用方必须先 commit / interrupt / discard 才能开新批。
- Story 08 P1.3：normalizeProviderResult 仅接受以下合法输入形状：(a) `items: [1..5 个 narrative item]`，可选附加 `tool_call: <one>`；(b) 遗留 `messages: [1..5 个 assistant 文本]`，可选 `tool_calls: [<恰一个>]`——messages 为有序 narrative items，唯一 tool 作为可选 FINAL item 无歧义归一化。`items + messages` / `tool_calls` 数组多于一个 / `tool_calls` 仅一条无 narrative / 6+ items / 空批次 / items 内混入 tool 型条目 / 非法 tool payload 一律 `invalid_tool_call` fail closed。tool_call 永远不进入 canonical history。
- Story 08 P1.1：`cursor` 是 canonical cursor——等于 `revision` 与最后一条 `event_seq`（已提交 canonical 事件总数），每次 commit（opening / narrative / player_input）都 +1；opening 播放顺序由内部 `opening_cursor` 单独维护（对外只读暴露）。下一轮 runtime 的 `buildRequest` 通过 `listSessionEvents` 看到上一轮所有已提交的 canonical event；`source_sequence` 是 (session, source) 单调计数器，跨 batch 不复位。
- Story 08 P1.5：HTTP 层每次请求新建 runtime，但 request_id 幂等状态归属 **session**（`sessionService.turnRequests`）：相同 `request_id + input + expected_revision` 跨请求返回完全相同的 result（turn_id / items / tool / pending_id）且不再调用 provider；同 request_id 不同 input/revision 拒绝（`duplicate_request`）；active pending 下不同 request_id 不能覆盖（stage fail closed）。`commitNarrativeEvent` 的 client_request_id 幂等在 pending 清空后仍可重放（final-commit 幂等）。
- Story 08 P1.6：未配置数据库时 runtime / sessionService 使用内存 repository，只提供本进程 recover；配置 MariaDB 后，server 在启动时 hydrate projection，`recoverSession` 可跨进程恢复 canonical history、revision、cursor、pending 与 compact state，且仍不调用 provider、不重放、不追加。
- Story 08 P1.4/P2.6：`interruptWithPlayerInput` 接受 `opening` / `awaiting_first_choice` / `realtime`；realtime 会话可再次打断（丢弃 pending tail、追加 player_input、保持 `realtime`），同 client_request_id 幂等。

## 实时逐句续写

真实 AI 每批通常生成 3 条短叙事，必要时 4～5 条；交互窗口不足时按 schema 返回剩余 1～2 条，并在末尾交还选择。每条通常 20～60 字、最多 80 字，整批正文最多 240 字（按 Unicode 码点计数），不设最低字数。条目共同推进一个行动及其直接结果，保留因果衔接和选择前提，避免重复铺陈。超长候选走现有有界重试，重新生成完整批次，不机械截断句子或丢弃尾部选择、结局。

当前模型调用仍等待完整批次响应；前端收到批次即显示第一条，其余条目按阅读节奏逐条显示、提交。服务端按 revision 接受叙事后应答，数据库异步保存；本批消费完且没有选择或结局时再请求下一批。暂停停止自动推进，插话等待已开始的内存提交并作废旧生成，不能越过选择或结局继续生成。旧会话较长的正文仍可回放，长度限制仅作用于新 AI 生成结果。

## 异步保存与保存状态

播放器为 `opening-events`、`narrative-events` 发送 `Prefer: persist-async`，为带 request_id 的 `generate` 发送 `Prefer: respond-async, persist-async`。服务端仍同步校验 revision、pending 和幂等标识，并把被接受的叙事放入内存 canonical history；响应附带 `persistence`，不再把 HTTP 200 当作数据库已保存。下一轮读取这个已接受的历史，所以不需要猜测 revision 或在不同请求之间争抢顺序。未发送此偏好的客户端继续等待数据库确认；初始会话创建、玩家输入等业务写入保留原来的持久化应答。

`asyncSessionPersistence.mjs` 合并待保存更新，用单个后台任务调用现有串行 `flush`。每轮保存水位只覆盖该轮启动前接受的更新，写入期间的新内容另排一轮；失败不会推进水位。正常关闭服务会等待请求与异步保存完成，再关闭数据库。

`GET /api/sessions/:uuid/save-status` 返回当前保存水位；`POST` 同一路径重试失败的保存。接口受现有账户所有权与 Origin 校验保护。播放器的 `recover` 同样发送 `Prefer: persist-async`，不等待数据库，返回内存恢复投影及保存状态；旧客户端的恢复请求仍等待数据库。状态带进程 epoch，页面不能用重启后的新水位冒充旧进程的保存确认。

页面只有在水位覆盖当前更新后才显示“已自动保存”，否则显示“正在保存…”；保存失败暂停自动推进并提供“重试保存”。重试完成不自动解除暂停。异步应答与数据库落盘之间，异常进程退出可能丢失尚未保存的进度；页面发现进程或保存状态失效时提供重新载入，按服务端已保存历史恢复。

“故事正在继续…”按播放状态显示，覆盖生成、消息返回、提交接受与下一轮请求的间隔，并保持在消息底部。暂停、插话、选择节点或结局会隐藏它；保存中的状态独立显示，不冒充正在生成或已保存。

## 当前行动与剧情连续性

播放器保留用户选择的完整文本，用 `input.kind: player_action` 区分新行动，自动阅读用 `input.kind: continue`。不再把选项覆盖为演示命令。真实AI兼容旧播放器的hello/short：若历史最后一条为玩家输入，使用其中的实际选择，否则解释为继续阅读；显式player_action中的同名文本按用户原话处理。

模型输入单独标示turn_instruction与最近的世界线事件；continue的player_input为null，避免把阅读动作当成新剧情指令。当前世界线事实以已接受历史/摘要为准，原作后续和角色秘密并非玩家已经历的事实。先落实已选行动及直接结果，不再要求重复选择，必要场景过渡必须出现在正文里。

真实AI的narrate工具内嵌选择/结局参数schema，选择question只能为“接下来，你想怎么做？”。将情节藏入question的结果不再被静默改写，而是拒绝并在现有有界重试中要求重新生成完整正文。所有场景信息因此应进入唯一的items，随显示/提交进入下一轮上下文。旧会话和通用工具层仍能回放已有自由问题文本；不会改写已保存的错误剧情。

选项ID只是界面标识，真实模型漏写时按顺序补齐稳定ID并避让已有ID，不改选项正文；其他非法结构仍拒绝。格式校验与连续性提示不能证明所有选项的语义前提，仍需真实多轮样本复核。

## 选择节奏

通常每3～5条实时叙事交还选择：第3条起提示模型寻找合适分岔，第5条强制narrate返回tool_call，并在服务端拒绝继续只有正文的输出，走现有有界纠正重试。真正已结束的故事仍可以finish_story，不以结局绕过交互。重大未授权行动应更早交还玩家，不为了凑满条数替玩家决定。

计数从完整canonical历史中计算，自最后一次player_input之后计narrative_beat；缓存开场、未提交pending、HTTP重试不计数。自动continue、刷新、compact都不能重置计数，真实玩家输入才开启下一轮。旧会话已超过上限时下一次新生成立即要求选择；第5条额外强调停在最新历史所在场景，不能先跳到原作后续再出题。单条即时显示及异步保存不变。
