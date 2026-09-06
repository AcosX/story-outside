// tests/_communityMockDetails.mjs — shared mock-story detail shapes used by
// the community-profile test. Mirrors the catalog in
// src/stories/fixture.mjs (which is the canonical seed source) so the
// community-profile test can pass detail objects to ensureCommunityProfile
// without depending on the mockProvider factory.

import { FIXTURE_UUIDS } from '../src/stories/fixture.mjs';

/**
 * @type {Record<string, { id: string, title: string, hook: string, roles: Array<object>, beats: Array<string|object> }>}
 */
export const MOCK_DETAILS_FOR_COMMUNITY = Object.freeze({
  'cafe-rain': Object.freeze({
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
  }),
  'night-shift': Object.freeze({
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
  }),
});

void FIXTURE_UUIDS;
