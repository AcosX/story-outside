// src/providers/mockProvider.mjs — Deterministic in-memory StoryProvider.
// This is the default provider. It MUST NOT call any external API and MUST
// NOT read any environment variables that look like credentials.
//
// The catalog mirrors the inline STORIES that previously lived in
// src/server.mjs, so HTTP responses are byte-identical (modulo the
// structural shape coming from dto.mjs) — this preserves Phase 1 demo
// compatibility.

import {
  normaliseStoryDetail,
  normaliseStorySummary,
  StoryNotFoundError,
  ValidationError,
} from './dto.mjs';

const CATALOG = [
  {
    id: 'cafe-rain',
    title: '雨夜咖啡馆',
    hook: '凌晨的咖啡馆只剩你和她。',
    roles: [
      { id: 'stranger', label: '陌生人', mood: '疏离' },
      { id: 'old-friend', label: '旧友', mood: '怀念' },
    ],
    beats: [
      '雨声裹着玻璃窗，咖啡机嗡地停了。',
      '她把杯沿推向你的方向。',
      { type: 'dialogue', speaker: 'old-friend', text: '「旧友」你在等人吗？' },
      { type: 'action', text: '她替你把冷掉的咖啡换成了热的。' },
      { type: 'ask_player_choice', text: '你要怎么回答她？' },
      '这一句不会出现在开场里。',
    ],
  },
  {
    id: 'night-shift',
    title: '凌晨两点的便利店',
    hook: '夜班店员在货架尽头发现你。',
    roles: [
      { id: 'clerk', label: '店员', mood: '警觉' },
      { id: 'wanderer', label: '夜行人', mood: '迷惘' },
    ],
    beats: [
      '日光灯闪了一下，卷帘门外没人。',
      '你挑了一罐不属于今天的饮料。',
      '店员没有说话，只是把零钱推过来。',
    ],
  },
];

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * Mock provider factory. Returns a frozen StoryProvider object.
 * Stateless beyond the bundled CATALOG; safe to share across requests.
 * @returns {import('./index.mjs').StoryProvider}
 */
export function createMockStoryProvider() {
  const normalisedDetail = CATALOG.map(normaliseStoryDetail);
  const byId = new Map(normalisedDetail.map((s) => [s.id, s]));

  return Object.freeze({
    name: 'mock',
    async listStories() {
      return normalisedDetail.map(normaliseStorySummary);
    },
    async getStory(id) {
      assertStoryId(id);
      const story = byId.get(id);
      if (!story) throw new StoryNotFoundError(id);
      // Return a defensive copy so callers cannot mutate the catalog.
      return normaliseStoryDetail(story);
    },
    async advanceStory(input) {
      if (!input || typeof input !== 'object') {
        throw new ValidationError('advance input must be an object');
      }
      assertStoryId(input.storyId);
      const story = byId.get(input.storyId);
      if (!story) throw new StoryNotFoundError(input.storyId);
      const idx = Number.isInteger(input.index) ? input.index : 0;
      if (idx < 0) {
        throw new ValidationError('advance index must be >= 0', { details: { index: idx } });
      }
      const roleId = typeof input.roleId === 'string' ? input.roleId : null;
      const nextIndex = Math.min(idx + 1, story.beats.length);
      const finished = nextIndex >= story.beats.length;
      /** @type {import('./dto.mjs').AdvanceResult} */
      const result = {
        storyId: story.id,
        roleId,
        index: nextIndex,
        finished,
        beat: finished ? null : story.beats[nextIndex].text,
      };
      return result;
    },
  });
}

/**
 * Reject story ids that look like paths or contain characters we don't want
 * to propagate into logs / URLs. The provider layer owns this validation
 * regardless of transport.
 * @param {unknown} id
 */
function assertStoryId(id) {
  if (typeof id !== 'string' || !id) {
    throw new ValidationError('story id must be a non-empty string');
  }
  if (!ID_PATTERN.test(id)) {
    throw new ValidationError('story id has invalid shape', { details: { id } });
  }
}