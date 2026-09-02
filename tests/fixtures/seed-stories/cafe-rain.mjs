// tests/fixtures/seed-stories/cafe-rain.mjs — fixed deterministic test story.
//
// This is the SINGLE canonical fixture used by every Task 12 suite. It
// mirrors the bundled mock catalog (cafe-rain) so that 08/09/10's tests
// stay coupled to one stable slug. All event payloads, sequence numbers,
// and role ids are derived from this document; if you change one field,
// every regression suite below will assert against the new shape.
//
// Hard contract — do NOT mutate this file from one suite to another:
//   * slug          = 'cafe-rain'  (must match mockProvider.mjs CATALOG)
//   * story_uuid    = FIXTURE_UUIDS['cafe-rain'].story_uuid
//   * version_uuid  = FIXTURE_UUIDS['cafe-rain'].story_version_uuid
//   * beats         = 6 events, with exactly one ask_player_choice at index 4
//                     (the boundary marker for the opening cache)
//   * roles         = 2 roles: stranger + old-friend (canonical ids)
//
// Structural guarantees the regression fixtures rely on:
//   * boundary-1 (ask_player_choice) sits at beat index 4
//   * dialogue beat at index 2 is the FIRST opening-cache event with a
//     structured speaker (old-friend)
//   * finish_story envelope uses `ending_key: 'cafe-rain/rain-stays'` and
//     exactly one character_outcomes entry keyed on role_id `old-friend`
//
// Anything that wants a "more interesting" fixture must add a NEW slug,
// not mutate this one.

import { FIXTURE_UUIDS } from '../../../src/stories/fixture.mjs';

export const CAFE_RAIN_FIXTURE = Object.freeze({
  slug: 'cafe-rain',
  story_uuid: FIXTURE_UUIDS['cafe-rain'].story_uuid,
  story_version_uuid: FIXTURE_UUIDS['cafe-rain'].story_version_uuid,
  story_version_checksum: null, // populated by the helper below (matches seeded fixture)
  title: '雨夜咖啡馆',
  hook: '凌晨的咖啡馆只剩你和她。',
  roles: Object.freeze([
    Object.freeze({ id: 'stranger', label: '陌生人', mood: '疏离' }),
    Object.freeze({ id: 'old-friend', label: '旧友', mood: '怀念' }),
  ]),
  beats: Object.freeze([
    Object.freeze({ index: 0, text: '雨声裹着玻璃窗，咖啡机嗡地停了。' }),
    Object.freeze({ index: 1, text: '她把杯沿推向你的方向。' }),
    Object.freeze({ index: 2, text: '「旧友」你在等人吗？', type: 'dialogue', speaker: 'old-friend' }),
    Object.freeze({ index: 3, text: '她替你把冷掉的咖啡换成了热的。', type: 'action' }),
    Object.freeze({ index: 4, text: '你要怎么回答她？', type: 'ask_player_choice' }),
    Object.freeze({ index: 5, text: '这一句不会出现在开场里。' }),
  ]),
  // First ask_player_choice boundary index — required by the integration
  // and agent-regression suites.
  first_choice_beat_index: 4,
  // Stable ending envelope used by finish_story regression tests.
  finish_story_envelope: Object.freeze({
    tool_call_id: 'tool-finish-cafe-rain',
    name: 'finish_story',
    arguments: Object.freeze({
      summary: '你在雨夜咖啡馆留下了自己的答案。',
      ending: '雨停了，她把名片留在桌上。',
      original_difference: '原结局里，她没有开口。',
      ending_key: 'cafe-rain/rain-stays',
      key_choices: Object.freeze([
        '回答她「在等」',
        '没有回答她',
      ]),
      character_outcomes: Object.freeze([
        Object.freeze({ character: 'old-friend', fate: '留下名片', change: '沉默多年后终于开口' }),
      ]),
    }),
  }),
  // Stable ask_player_choice envelope used by agent-regression tests.
  ask_player_choice_envelope: Object.freeze({
    tool_call_id: 'tool-ask-cafe-rain-1',
    name: 'ask_player_choice',
    arguments: Object.freeze({
      question: '你要怎么回答她？',
      options: Object.freeze([
        Object.freeze({ id: 'wait', label: '在等人', description: '她或许就是那个人' }),
        Object.freeze({ id: 'leave', label: '起身离开', description: '沉默更安全' }),
      ]),
      allow_free_text: true,
      choice_id: 'cafe-rain-boundary-1',
    }),
  }),
});

/**
 * Convenience accessor that resolves the canonical checksum by reading it
 * from the seeded repository. Tests that build their own repository via
 * createSeededRepository can call this to keep checksum assertions honest.
 *
 * @param {import('../../../src/stories/repository.mjs').StoryRepository} repository
 * @returns {string}
 */
export function resolveChecksum(repository) {
  const version = repository.findVersion(CAFE_RAIN_FIXTURE.story_version_uuid);
  if (!version) throw new Error('cafe-rain fixture: seeded version missing');
  return version.checksum;
}

/**
 * Canonical opening-cache events the seeded `cafe-rain` cache will expose
 * after ensureOpeningCache. We freeze the projection so test suites can
 * hard-assert against `event_count`, boundary label, and the absence of
 * `ask_player_choice`.
 */
export const CAFE_RAIN_OPENING_EVENT_COUNT = 4;
export const CAFE_RAIN_OPENING_BOUNDARY = 'truncated_before_first_choice';