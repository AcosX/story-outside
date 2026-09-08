// src/stories/openingGenerator.mjs — produces a story-level public opening
// cache from a pinned story_version. This is the work that happens once per
// (story, story_version, generation_profile) and is shared across all
// subsequent sessions that read that version.
//
// ClickUp 04 contract:
//   * The opening spans "from the story start to right before the first
//     ask_player_choice marker would be presented".
//   * Output is a per-sentence event sequence the client can play one at a
//     time. Each event has type/sequence/text; dialogue carries a speaker;
//     narration does not.
//   * Structured beat metadata is preserved: `type` ('narration' |
//     'dialogue' | 'action') and `speaker` survive into the event stream.
//   * A structured `type: 'ask_player_choice'` beat (or a text choice marker)
//     truncates the opening. The choice beat itself NEVER enters the cache.
//   * The generator is pure: same input → same output. It does NOT read or
//     write any user/role/session state and never forks by player role.
//
// The generator is intentionally minimal so it can be unit-tested without
// any provider call. The output is also stable across Node versions.

import { canonicalSha256 } from './canonicalHash.mjs';

/**
 * @typedef {Object} OpeningEvent
 * @property {string} type             'narration' | 'dialogue' | 'action' | 'beat'.
 * @property {number} sequence         0-based, contiguous, no gaps.
 * @property {string} text             Plain text shown to the reader.
 * @property {string} [speaker]        Set on 'dialogue'; canonical role id.
 */

/**
 * @typedef {Object} OpeningCachePayload
 * @property {string} story_uuid
 * @property {string} story_version_uuid
 * @property {string} opening_key
 * @property {string} profile_identifier
 * @property {string} rules_version
 * @property {string} locale
 * @property {string} variant
 * @property {string} boundary         'truncated_before_first_choice' | 'no_choice_in_story' | 'empty_story'.
 * @property {number} event_count
 * @property {OpeningEvent[]} events
 * @property {{ content_hash: string, generation_hash: string }} hash
 */

/** Markers that signal "the player is being asked a question". Any beat
 *  whose text contains one of these tokens (case-insensitive, trimmed) is
 *  treated as the end of the public opening cache.
 *
 *  We treat the markers as a small, explicit allowlist so a stray Chinese
 *  phrase in normal narration never accidentally closes the cache.
 */
const CHOICE_MARKERS = Object.freeze([
  'ask_player_choice',
  '[choice]',
  '[ask]',
  '【选择】',
  '【ask】',
  '请选择',
  '你的选择',
]);

/**
 * Decide whether a beat text contains an ask_player_choice marker.
 * @param {string} text
 * @returns {boolean}
 */
function isChoiceMarker(text) {
  if (typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  for (const marker of CHOICE_MARKERS) {
    if (lower.includes(marker.toLowerCase())) return true;
  }
  return false;
}

/**
 * Resolve the speaker for a beat. Structured `speaker` wins; otherwise the
 * legacy `「label」` text prefix is used so existing string-only catalog rows
 * keep working.
 *
 * @param {string|undefined} structuredSpeaker
 * @param {string} text
 * @param {ReadonlyArray<{ id: string, label: string }>} roles
 * @param {number} index
 */
function resolveSpeaker(structuredSpeaker, text, roles, index) {
  if (structuredSpeaker) {
    const match = roles.find((r) => r.id === structuredSpeaker || r.label === structuredSpeaker);
    if (!match) {
      throw new Error(`generateOpeningCache: speaker '${structuredSpeaker}' is not a known role`);
    }
    return match.id;
  }
  return detectSpeaker(text, roles, index);
}

/**
 * Pick the speaker for a beat. The mock catalog assigns each beat to a role
 * in a deterministic pattern: round-robin over roles, but skip roles when
 * the current beat is a narration beat (no leading '「').
 *
 * If the beat text starts with "「xxx：..." the speaker is xxx.
 * Otherwise it is narration.
 *
 * @param {string} text
 * @param {ReadonlyArray<{ id: string, label: string }>} roles
 * @param {number} index
 */
function detectSpeaker(text, roles, index) {
  if (typeof text !== 'string') return null;
  const m = /^「([^」：:]{1,40})」/.exec(text);
  if (!m) return null;
  const label = m[1].trim();
  const match = roles.find((r) => r.label === label || r.id === label);
  if (match) return match.id;
  // Unknown label — still attribute to a stable role based on index to keep
  // the cache deterministic.
  if (roles.length > 0) return roles[index % roles.length].id;
  return null;
}

/**
 * Generate the opening cache payload for a story_version + generation profile.
 *
 * @param {object} input
 * @param {string} input.story_uuid
 * @param {string} input.story_version_uuid
 * @param {string} [input.opening_key]                  Default 'default'.
 * @param {{ identifier: string, rules_version: string, locale?: string }} input.profile
 * @param {{ id: string, title: string, hook: string, roles: Array<{id:string,label:string,mood?:string}>, beats: Array<string | { text: string, index?: number, type?: string, speaker?: string }> }} input.story
 * @returns {OpeningCachePayload}
 */
export function generateOpeningCache(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('generateOpeningCache: input required');
  }
  const story = input.story;
  if (!story || typeof story !== 'object') {
    throw new Error('generateOpeningCache: story required');
  }
  // AI-prepared public openings end before the first choice. Full source
  // beats stay intact on the pinned story version for generation/replay.
  const beats = Array.isArray(story.ai_opening_events) ? story.ai_opening_events : (Array.isArray(story.beats) ? story.beats : []);
  const roles = Array.isArray(story.roles) ? story.roles : [];
  /** @type {OpeningEvent[]} */
  const events = [];
  let boundary = /** @type {OpeningCachePayload['boundary']} */ ('no_choice_in_story');
  for (let i = 0; i < beats.length; i += 1) {
    const beat = beats[i];
    const text = typeof beat === 'string' ? beat : beat && beat.text;
    if (typeof text !== 'string' || text.length === 0) {
      // Skip empty beats but do not collapse sequence numbers; gap-free
      // numbering keeps the cache easier to stream.
      continue;
    }
    const structured = beat && typeof beat === 'object' ? beat : null;
    const type = structured && typeof structured.type === 'string' ? structured.type : undefined;
    if (type === 'ask_player_choice' || isChoiceMarker(text)) {
      boundary = 'truncated_before_first_choice';
      break;
    }
    const structuredSpeaker =
      structured && typeof structured.speaker === 'string' && structured.speaker
        ? structured.speaker
        : undefined;
    if (type === 'action') {
      events.push({ type: 'action', sequence: events.length, text });
      continue;
    }
    const speaker =
      type === 'dialogue' || type === undefined
        ? resolveSpeaker(structuredSpeaker, text, roles, events.length)
        : null;
    /** @type {OpeningEvent} */
    const ev = speaker
      ? { type: 'dialogue', sequence: events.length, text, speaker }
      : { type: 'narration', sequence: events.length, text };
    events.push(ev);
  }
  if (events.length === 0) {
    boundary = 'empty_story';
  }

  const payload = {
    story_uuid: input.story_uuid,
    story_version_uuid: input.story_version_uuid,
    opening_key: input.opening_key || 'default',
    profile_identifier: input.profile.identifier,
    rules_version: input.profile.rules_version,
    locale: input.profile.locale || 'zh-CN',
    variant: input.profile.variant || 'default',
    boundary,
    event_count: events.length,
    events,
  };
  const payloadHashes = _hashes(payload);
  return {
    ...payload,
    hash: payloadHashes,
  };
}

/**
 * Hash the cache payload into two distinct fingerprints.
 * @param {OpeningCachePayload} payload
 */
function _hashes(payload) {
  const content_payload = {
    story_uuid: payload.story_uuid,
    story_version_uuid: payload.story_version_uuid,
    opening_key: payload.opening_key,
    boundary: payload.boundary,
    event_count: payload.event_count,
    events: payload.events,
  };
  const generation_payload = {
    profile_identifier: payload.profile_identifier,
    rules_version: payload.rules_version,
    locale: payload.locale,
    variant: payload.variant,
  };
  return {
    content_hash: canonicalSha256(content_payload),
    generation_hash: canonicalSha256(generation_payload),
  };
}