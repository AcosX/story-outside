// src/stories/fixture.mjs — convenience fixture that preloads the in-memory
// repository with stable story/story_version rows derived from the existing
// mock provider catalog. Useful for development, demos, and tests.
//
// IMPORTANT: This module does NOT call any external API and does NOT read
// any environment variable that looks like a credential. All story content
// comes from src/providers/mockProvider.mjs.
//
// The story_uuid / story_version_uuid values are stable across process
// restarts so that admin/dev tooling can rely on them when rebuilding caches
// against a known catalog. (Real UUIDs would normally be server-generated.)

import { canonicalStoryHash } from './canonicalHash.mjs';
import { createInMemoryStoryRepository } from './repository.mjs';
import { bindPinnedCacheResolver } from './sessionService.mjs';

/**
 * Stable UUIDs for the bundled mock catalog. Real deployments generate
 * these server-side; we hard-code them here so test assertions and admin
 * commands have stable keys.
 */
export const FIXTURE_UUIDS = Object.freeze({
  'cafe-rain': {
    story_uuid: '11111111-1111-4111-8111-111111111111',
    story_version_uuid: '21111111-1111-4111-8111-111111111111',
  },
  'night-shift': {
    story_uuid: '11111111-1111-4111-8111-222222222222',
    story_version_uuid: '21111111-1111-4111-8111-222222222222',
  },
});

const MOCK_DETAILS = {
  'cafe-rain': {
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
  'night-shift': {
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
};

/**
 * Build a repository already populated with stories + story_versions that
 * mirror the mock provider catalog. Old fixture versions can be added by
 * callers via importStory() with a different upstream DTO.
 *
 * @returns {{
 *   repository: ReturnType<typeof createInMemoryStoryRepository>,
 *   fixtures: Array<{ story_uuid: string, story_version_uuid: string, slug: string }>,
 * }}
 */
export function createSeededRepository() {
  const repository = createInMemoryStoryRepository();
  // Wire the opening-cache eviction hook to the canonical session map so
  // the eviction loop never drops a cache that is still pinned by an
  // active session (PR #7 ChatGPT 2026-09-05 follow-up, Blocker 1).
  bindPinnedCacheResolver(repository);
  /** @type {Array<{ story_uuid: string, story_version_uuid: string, slug: string }>} */
  const fixtures = [];
  for (const [slug, ids] of Object.entries(FIXTURE_UUIDS)) {
    const detail = MOCK_DETAILS[slug];
    repository.upsertStory({
      story_uuid: ids.story_uuid,
      slug,
      title: detail.title,
      hook: detail.hook,
      locale: 'zh-CN',
    });
    const checksum = canonicalStoryHash(detail);
    repository._seedVersion({
      version_uuid: ids.story_version_uuid,
      story_uuid: ids.story_uuid,
      version_no: 1,
      title: detail.title,
      hook: detail.hook,
      content_payload: detail,
      roles_payload: detail.roles,
      checksum,
      source_ref: 'mock-fixture',
      status: 'published',
      published_at: '1970-01-01T00:00:00.000Z',
      created_at: '1970-01-01T00:00:00.000Z',
      updated_at: '1970-01-01T00:00:00.000Z',
    });
    fixtures.push({
      story_uuid: ids.story_uuid,
      story_version_uuid: ids.story_version_uuid,
      slug,
    });
  }
  return { repository, fixtures };
}