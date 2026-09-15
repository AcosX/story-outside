export const MAX_NARRATIVES_WITHOUT_INPUT = 5;

// Count canonical events, not model calls or SQL completions. This survives
// reload/compaction and cannot be reset by an automatic continue request.
export function playerInteraction(history = []) {
  let narratives = 0;
  const committed = history.filter(event => event.committed !== false && !['pending', 'staged'].includes(event.status));
  const awaitingFirstChoice = committed.some(event => event.event_type === 'story_opening')
    && !committed.some(event => event.event_type === 'player_input');
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const event = history[index];
    if (event.committed === false || ['pending', 'staged'].includes(event.status)) continue;
    if (event.event_type === 'player_input') break;
    if (event.event_type === 'narrative_beat') narratives += 1;
  }
  return { narratives_since_input: narratives,
    awaiting_first_choice: awaitingFirstChoice,
    choice_recommended: awaitingFirstChoice || narratives >= 2,
    max_narratives_without_input: MAX_NARRATIVES_WITHOUT_INPUT,
    choice_required: awaitingFirstChoice || narratives >= 2 };
}

export const PLAYER_INTERACTION_PROMPT = `玩家决定故事分岔，导演负责让已选行动自然展开。通常每3至5条连贯叙事形成一个有意义的选择节点；不要为了凑条数替玩家行动，也不对每个细小动作反复提问。awaiting_first_choice=true表示开场结束但尚无玩家决定，本次必须在当前现场交还第一次选择。choice_required=true时本次必须附带ask_player_choice；条目数量以工具schema为准，剩余窗口不足时可用更少条目，不必填满。玩家已明确要求的行动及其直接结果应先完成，再提供下一步选择；continue不授予新的行动。只有核心冲突确已解决且arc_status=resolved，才以finish_story替代选择。`;
