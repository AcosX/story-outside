// Pacing is independent of the advisory original-story progress meter.
export function storyPacing(history = [], input = {}) {
  const choices = history.filter(event => event.event_type === 'player_input');
  const latest = typeof input.text === 'string' ? input.text : choices.at(-1)?.payload?.text || '';
  const requested = /^(?:请|麻烦)?(?:尽快|马上|现在|直接)?(?:结束(?:游戏|故事|本局)?|收束(?:故事|剧情)?|完结)[。！!\s]*$/.test(latest.trim());
  const count = choices.length;
  return { player_choices: count,
    phase: requested || count >= 24 ? 'conclude_now' : count >= 16 ? 'resolution' : count >= 10 ? 'climax' : 'development',
    must_finish: requested || count >= 24,
  };
}
export const PACING_PROMPT = `本局是一段有终点的完整故事，而非无限连载。每轮先判定arc_status，再叙事：当前历史已完成本局核心目标时判为resolved，必须finish_story；玩家说“继续”仅表示继续阅读尾声，不表示要求开启新冲突。结局对照资料不足可填null，不得因此拒绝结束。根据原作导语/正文确定本局核心目标与终点（例如完成本次副本），主要冲突解决、通关、离开危险或人物命运已明确时，立即叙述简短尾声并调用finish_story；不要再开新地图、新副本或新悬念拖延结局。玩家休息、等待、睡到某天时压缩无事件的时间，不反复询问日常琐事。story_pacing.phase为climax时推动已有主要冲突，为resolution时收束已有线索、不给无关分支，为conclude_now时本次必须finish_story并尊重玩家已做的选择。允许提前达成结局；这些阶段不代表原作进度。`;
