# 结局页 · ClickUp 11

> 范围：结局页、原著对比与世界线回放。  
> 状态：基于 `feat/story-outside-09@919d52d` 新增分支 `feat/story-outside-11`。  
> 本文件只描述 ClickUp 11 的契约、字段定义、对比算法与回放口径；所有边界条件与 09 / 08 / 07 契约保持一致。

## 1. 设计原则

* **结局页是 `finished` 状态的天然终点**：从播放器 `state.finished` 进入独立的 `#screen-ending` 区块；`player.js` 状态机核心逻辑（autoplay / pause / skip / interrupt / commit / recover / opening-phase guard / pendingNodes / 二次 interrupt / progress）**不**做任何改动；11 只新增一个 `await import('/scripts/endingPage.js')` 的 hook。
* **所有数据从只读投影推导**：结局页的 `ending / original-timeline / replay` 三段信息均通过三个独立的只读 `GET` 端点返回；不修改任何 canonical 事件、不调用 provider、不重放 speculative 内容。
* **视觉与语义严格区分"原作事实"与"AI 平行时间线"**：原作时间线使用 `timeline-source` 类 + 引用块样式 + 标签 `来自原作《title》 v<n>`；AI 平行时间线使用 `timeline-ai` 类 + 故事线条目 + 标签 `AI 生成平行时间线`。UI 永不把 AI 内容伪装为原作内容。
* **回放严格等于 committed session history**：按 `event_seq` 升序、排除 `tool_call` / `pending_tool_call` / `pending` / `discarded` 类型的行（08 契约：tool_call 永不进 canonical；pending_batch 中 `status='staged'` 的事件永不进回放）。
* **数据契约先行，排行榜延后**：定义稳定的 `ending_key` / `category` 字段，MVP 不实现排行榜 / 社区统计 UI；为未来的"结局榜"预留口径。

## 2. 端点契约（新增，不改）

### 2.1 `GET /api/dev/sessions/:uuid/ending`

返回 `200`：

```json
{
  "ending_title": "雨夜咖啡馆 · 陌生人线",
  "ending_summary": "她把最后一口咖啡留给你，关了灯。",
  "key_choices": ["a", "b", "c"],
  "character_outcomes": [
    { "character": "陌生人", "fate": "继续等下一场雨" },
    { "character": "旧友", "fate": "在街角点了一根烟" }
  ],
  "first_deviation": {
    "event_seq": 7,
    "type": "narrative_beat",
    "text": "她没有把冷掉的咖啡换成热的。",
    "speaker": "old-friend",
    "occurred_at": "2026-09-02T...",
    "after_opening_sequence": 4
  },
  "total_analysis": "本次共播放 4 句开场、6 段剧情、2 次玩家输入。第一次重大偏离发生在第 7 句。",
  "ending_key": "rain_cafe__stranger__warmth",
  "category": "cafe-rain#v1/opening-default"
}
```

`finish_story` 尚未提交时返回 `404 ending_not_committed`。其他错误码沿用 09 的 `session_not_found` / `validation_failed` 分类。

### 2.2 `GET /api/dev/sessions/:uuid/original-timeline`

返回 `200`：

```json
{
  "story_id": "11111111-...",
  "story_version_id": "21111111-...",
  "story_version_checksum": "...",
  "story_title": "雨夜咖啡馆",
  "story_version_no": 1,
  "key_facts": [
    { "kind": "story_title", "label": "作品", "text": "雨夜咖啡馆", "source": "story_version" },
    { "kind": "story_hook",  "label": "简介", "text": "凌晨的咖啡馆只剩你和她。", "source": "story_version" },
    { "kind": "story_roles", "label": "角色", "text": "陌生人、旧友", "source": "story_version" },
    { "kind": "opening_beat", "label": "原作开场", "sequence": 0, "type": "narration", "speaker": null, "text": "雨声裹着玻璃窗，咖啡机嗡地停了。", "source": "opening_cache" },
    { "kind": "opening_beat", "label": "原作开场", "sequence": 1, "type": "dialogue", "speaker": "stranger", "text": "...", "source": "opening_cache" },
    { "kind": "choice_boundary", "label": "首次选择", "text": "原作在第 4 句进入首次选择；总拍数 6。", "source": "opening_cache" }
  ],
  "source_attribution": "来自原作《雨夜咖啡馆》 v1"
}
```

`source_attribution` 字段必填且必须以 `来自原作` 开头；UI 用它在右侧（AI 平行时间线）旁标注"原作信息来自此处"。

### 2.3 `GET /api/dev/sessions/:uuid/replay`

返回 `200`：

```json
{
  "events": [
    { "sequence": 1, "type": "narration", "text": "雨声裹着玻璃窗，咖啡机嗡地停了。", "occurred_at": "...", "source": "opening_cache" },
    { "sequence": 2, "type": "dialogue", "text": "「陌生人」你在等人吗？", "speaker": "stranger", "occurred_at": "...", "source": "opening_cache" },
    { "sequence": 3, "type": "narration", "text": "demo line 1", "occurred_at": "...", "source": "runtime" },
    { "sequence": 4, "type": "player_input", "text": "我想说点什么", "occurred_at": "...", "source": "player" }
  ]
}
```

`events` 严格等于 canonical `session_events`，按 `event_seq` 升序，**不**包含 `tool_call` / `pending_tool_call` / `pending` / `discarded` 行。

## 3. 字段语义

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `ending_title` | `finish_story.arguments.ending` | 结局标题；若缺省取 `summary`。 |
| `ending_summary` | `finish_story.arguments.summary` | 结局摘要；不超过 1KB。 |
| `key_choices` | `finish_story.arguments.key_choices[]` | 1..20 条；类型 `string`。 |
| `character_outcomes` | `finish_story.arguments.character_outcomes[]` | 1..20 条；每条 `{ character, fate, change? }`。 |
| `first_deviation` | 推导自 canonical history + opening_cache | `event_seq` 是第一个 canonical `narrative_beat` 且 `event_seq > opening_events.length` 的事件；如果是纯玩家选择 → 全贴近原作 → `null`。 |
| `total_analysis` | 推导自 session.history | 包含开场 / 剧情 / 玩家输入三段计数 + 第一次偏离提示；纯派生，不来自 runtime。 |
| `ending_key` | `finish_story.arguments.ending_key` | 稳定短串；未来社区统计维度。 |
| `category` | 推导自 story.slug + version_no + cache.opening_key | MVP 不展示排行榜；仅为未来预留。 |

## 4. 对比算法说明

原著时间线的 `key_facts` 严格来自 `story_version.content_payload` 与 `opening_cache.content_payload.events`：

1. **作品级元数据**：从 `content_payload.title` / `hook` / `roles[]` 取，构建 `story_title` / `story_hook` / `story_roles` 三条事实。
2. **开场事实节**：从 `opening_cache.content_payload.events` 取前 3 条，构建 `opening_beat` 事实（kind=`opening_beat`，带 `sequence` 与 `speaker`）。
3. **选择边界**：从 `opening_cache.content_payload.event_count` 与 `content_payload.beats.length` 取，构建 `choice_boundary` 事实。

AI 平行时间线完全来自 `GET /replay` 返回的 `events`，**不**做整篇逐字 diff：只对每个事件标注 `kind`（`narration` / `dialogue` / `action` / `player_input`）与 `sequence`，并在 `first_deviation.event_seq` 对应的那条事件上加 `timeline-deviation` 类（红色高亮 + danger 边框）。

视觉上：

* 左栏 `.comparison-source` —— `border-left: 3px solid var(--accent)` + 子项 `.timeline-source`。
* 右栏 `.comparison-ai` —— `border-left: 3px solid var(--warn)` + 子项 `.timeline-ai`，首次偏离 `.timeline-deviation` 用 `border-color: var(--danger)`。
* 标题区有 `timeline-source-tag`（"来自原作"）与 `timeline-ai-tag`（"AI 生成平行时间线"）两个 chip 标签，永远可见。

## 5. 回放控制

`#replay-list` 内每个 `<li.replay-event>` 默认 `opacity: 0.35`。"下一句"按钮调用 `endingPage` 内部的 `stepReplay(+1)`，把 `[0, currentIndex)` 区间的事件加 `.replay-event-shown` 类（`opacity: 1`）。"上一句" / "回到开头" 按钮分别递减或归零索引。进度文本格式：`current / total`，位于 `.replay-progress`。

按钮事件绑定在每次 `mount()` 时通过 `attachReplayHandlers()` 重新挂载；`teardown()` 会清空 `#screen-ending` 并切回 `#screen-player`。

## 6. 浏览器层集成（player.js）

`public/scripts/player.js` 的 `surfaceToolCall` 在收到 `finish_story` 时：

```javascript
if (toolCall.name === 'finish_story') {
  setStatus('finished');
  renderEnding(toolCall);
  setText('#player-help', '');
  state.finished = true;
  // 11 hook: lazy-load endingPage and mount it.
  const mod = await import('/scripts/endingPage.js');
  await mod.mount({ sessionUuid: state.sessionUuid, sessionMeta: { storyTitle, roleLabel } });
}
```

`renderEnding` 仍保留内嵌的最小结局卡片（向后兼容 / 离线场景）；`endingPage.mount` 会切换到 `#screen-ending` 并渲染完整版本。`mount` 失败时只 toast 提示，不重置状态——内嵌卡片继续可用。

## 7. 数据契约稳定 / 排行榜延后

为未来社区统计预留：

* `ending_key`：玩家结局的稳定短串；同结局 → 同 key。来源 `finish_story.arguments.ending_key`，缺省时为 `null`。
* `category`：作品+版本+生成口径组合（`{slug}#v{version_no}/{opening_key}`），稳定反映"我在哪个版本哪条规则下走完了这个结局"。

MVP 不实现：

* 排行榜 / 分类统计 UI
* 跨会话聚合查询
* 任何用户身份维度的聚合

这些是后续任务（不在 11 范围）。

## 8. 真实边界与 DEPENDENCY NOTE

* 仓库仍是**进程内 in-memory repository**（08 / 09 / 10 / 11 一致）；跨进程 recover 不可恢复；MariaDB 仍未接线（schema 是未来的 DAO contract）。
* `/ending` 的 `category` 与 `first_deviation` 是纯派生字段，不持久化——重启即丢失。
* `first_deviation` 当前的算法只识别"开场之后第一个 `narrative_beat`"，未做句子级语义对比。
* `original-timeline` 的 `key_facts` 数量取决于开场缓存的前 3 条事件；如果开场缓存为空（例如空作品），只展示作品级元数据 + 选择边界（值仍包含"原作在第 0 句进入首次选择"）。
* `replay` 严格按 `session_events.event_seq` 升序；任何未通过 `commitNarrativeEvent` / `commitOpeningEvent` / `interruptWithPlayerInput` 路径写入的行都不会出现在回放里。