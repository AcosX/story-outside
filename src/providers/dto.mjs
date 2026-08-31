// src/providers/dto.mjs — Provider-agnostic data shapes.
// These DTOs are the contract between any provider (mock today, official
// Zhihu adapter tomorrow) and the HTTP routes in src/server.mjs.
//
// Rules:
//   * No HTTP / framework / fetch imports.
//   * No mention of OAuth, tokens, app_id, app_key, or Access Secret.
//   * Providers return these plain objects; routes spread them into JSON.
//   * Adding a field is a non-breaking additive change. Renaming or removing
//     a field is a breaking change — bump the provider version.

/**
 * @typedef {Object} Role
 * @property {string} id            Stable role identifier (URL-safe).
 * @property {string} label         Human-readable label.
 * @property {string} mood          Free-form mood tag (疏离 / 怀念 / ...).
 */

/**
 * @typedef {Object} Beat
 * @property {string} text          The beat line shown to the reader.
 * @property {number} index         Zero-based beat index within the story.
 * @property {('narration'|'dialogue'|'action'|'ask_player_choice')} [type]
 *                                  Optional structured beat kind. Providers
 *                                  SHOULD use 'ask_player_choice' for the
 *                                  first choice boundary instead of relying
 *                                  on text markers.
 * @property {string} [speaker]     Canonical role id for dialogue beats.
 */

/**
 * @typedef {Object} StorySummary
 * @property {string} id
 * @property {string} title
 * @property {string} hook
 * @property {Role[]} roles
 */

/**
 * @typedef {Object} StoryDetail
 * @property {string} id
 * @property {string} title
 * @property {string} hook
 * @property {Role[]} roles
 * @property {Beat[]} beats
 */

/**
 * @typedef {Object} AdvanceResult
 * @property {string} storyId
 * @property {string|null} roleId
 * @property {number} index            Next beat index (>= input index + 1, capped).
 * @property {boolean} finished        True when no more beats remain.
 * @property {string|null} beat        Next beat text, or null when finished.
 */

/**
 * Provider operation result envelope.
 * Providers SHOULD return `{ ok: true, value }` or throw a ProviderError.
 * @template T
 * @typedef {{ ok: true, value: T } | { ok: false, error: ProviderError }} ProviderResult
 */

/**
 * Lightweight, provider-defined error. Routes map these to HTTP status codes
 * (StoryNotFoundError → 404, ValidationError → 400, others → 502).
 */
export class ProviderError extends Error {
  /**
   * @param {string} code      Stable, machine-readable code (snake_case).
   * @param {string} message   Human-readable message (safe to expose).
   * @param {object} [details] Optional structured detail.
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.details = details;
  }
}

export class StoryNotFoundError extends ProviderError {
  constructor(storyId) {
    super('story_not_found', `Story not found: ${storyId}`, { storyId });
    this.name = 'StoryNotFoundError';
  }
}

export class ValidationError extends ProviderError {
  constructor(message, details) {
    super('invalid_input', message, details);
    this.name = 'ValidationError';
  }
}

/**
 * Normalise a story summary returned by any provider.
 * Defensive copy: strips unknown fields, validates shape.
 * @param {unknown} raw
 * @returns {StorySummary}
 */
export function normaliseStorySummary(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError('story summary must be an object');
  }
  const s = /** @type {any} */ (raw);
  if (typeof s.id !== 'string' || !s.id) {
    throw new ValidationError('story summary missing id');
  }
  if (typeof s.title !== 'string') {
    throw new ValidationError(`story ${s.id} missing title`);
  }
  if (typeof s.hook !== 'string') {
    throw new ValidationError(`story ${s.id} missing hook`);
  }
  if (!Array.isArray(s.roles)) {
    throw new ValidationError(`story ${s.id} missing roles[]`);
  }
  return {
    id: s.id,
    title: s.title,
    hook: s.hook,
    roles: s.roles.map((r, i) => normaliseRole(s.id, r, i)),
  };
}

/**
 * @param {string} storyId
 * @param {unknown} raw
 * @param {number} index
 * @returns {Role}
 */
function normaliseRole(storyId, raw, index) {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError(`role[${index}] of story ${storyId} must be an object`);
  }
  const r = /** @type {any} */ (raw);
  if (typeof r.id !== 'string' || !r.id) {
    throw new ValidationError(`role[${index}] of story ${storyId} missing id`);
  }
  if (typeof r.label !== 'string') {
    throw new ValidationError(`role ${r.id} of story ${storyId} missing label`);
  }
  return {
    id: r.id,
    label: r.label,
    mood: typeof r.mood === 'string' ? r.mood : '',
  };
}

/**
 * @param {unknown} raw
 * @returns {StoryDetail}
 */
export function normaliseStoryDetail(raw) {
  const summary = normaliseStorySummary(raw);
  const beatsRaw = /** @type {any} */ (raw).beats;
  if (!Array.isArray(beatsRaw)) {
    throw new ValidationError(`story ${summary.id} missing beats[]`);
  }
  const beats = beatsRaw.map((b, i) => {
    if (typeof b === 'string') return { text: b, index: i };
    if (!b || typeof b !== 'object') {
      throw new ValidationError(`beat[${i}] of story ${summary.id} must be string or object`);
    }
    if (typeof b.text !== 'string') {
      throw new ValidationError(`beat[${i}] of story ${summary.id} missing text`);
    }
    const beat = { text: b.text, index: typeof b.index === 'number' ? b.index : i };
    if (typeof b.type === 'string' && BEAT_TYPES.has(b.type)) {
      beat.type = b.type;
    }
    if (typeof b.speaker === 'string' && b.speaker) {
      beat.speaker = b.speaker;
    }
    return beat;
  });
  return { ...summary, beats };
}

/**
 * Structured beat kinds the pipeline understands. Unknown types are dropped
 * by normalisation so a future provider field cannot silently change story
 * hashing semantics.
 */
const BEAT_TYPES = new Set(['narration', 'dialogue', 'action', 'ask_player_choice']);