export const MAX_NARRATIVES_WITHOUT_INPUT = 5;

// Count canonical events, not model calls or SQL completions. This survives
// reload/compaction and cannot be reset by an automatic continue request.
export function playerInteraction(history = []) {
  let narratives = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const event = history[index];
    if (event.committed === false || ['pending', 'staged'].includes(event.status)) continue;
    if (event.event_type === 'player_input') break;
    if (event.event_type === 'narrative_beat') narratives += 1;
  }
  return { narratives_since_input: narratives,
    choice_recommended: narratives >= 2,
    max_narratives_without_input: MAX_NARRATIVES_WITHOUT_INPUT,
    choice_required: narratives >= 2 };
}

export const PLAYER_INTERACTION_PROMPT = `这是由玩家作决定的互动故事。自动continue只允许叙述已选行动的直接结果、环境变化和其他人物的反应，绝不是让导演替玩家选楼层、进房间、答应请求、触碰或拥抱他人。遇到尚未获玩家授权的行动分岔，立即在动作发生之前用ask_player_choice交还控制权。通常每3至5条连贯叙事形成一个有意义的选择节点：choice_recommended=true时优先在本条或接下来的合适分岔停下，不为凑数拖延；遇到重大决定可更早停下。当player_interaction.choice_required=true时，本次必须附带ask_player_choice，不能只返回正文。只写清当前位置和眼前局面，给2至6个能采取的不同动作，不要再次询问已经做出的选择。只有核心冲突确实解决且arc_status=resolved时才以finish_story替代选择，不能为了绕开交互要求草率结束。`;
