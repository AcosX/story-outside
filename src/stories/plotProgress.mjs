// Advisory metadata only: malformed/missing estimates never reject narrative.
export function progressMetadata(item) {
  const value = item?.story_progress;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? { story_progress: value } : {};
}

export function latestStoryProgress(history = []) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const event = history[i];
    if (!['story_opening', 'narrative_beat'].includes(event?.event_type)) continue;
    const value = progressMetadata(event.payload).story_progress;
    if (value !== undefined) return value;
  }
  return null;
}

export const PLOT_PROGRESS_PROMPT = `每条正文都附带 story_progress 数字（0至1），估算读完这一条后，本局当前剧情对应完整原文的全局剧情位置：0为原作起点，1为原作终点。以原文关键事件的先后位置和当前情节的因果阶段为依据，而非生成条数、对话轮数、开场播放比例或已读字数。故事偏离原作时按最接近的剧情阶段估算；允许大幅跃进、回退或重新评估，不要求单调递增。无可靠依据可省略并保留已有估算，不机械增加。该值仅供进度显示，不是剧情约束；不要为达到某百分比强行推进或拖延，不影响选择、分支或直接结局的剧情决策。到达原作终点也不强制结束本局，仍遵守当前任务的输出范围。不要在正文中解释此字段或这些规则。`;
