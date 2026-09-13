import { progressMetadata } from './plotProgress.mjs';
// src/stories/canonicalHash.mjs — deterministic canonicalisation + hashing.
//
// ClickUp 04 contract:
//   * Two story DTOs with the same authored content (after normalisation)
//     MUST yield the same canonical hash, regardless of object key order.
//   * Two story DTOs with any content difference MUST yield different
//     canonical hashes.
//   * The hash drives story_versions.checksum; same hash → reusable version,
//     different hash → a new version_no is created (old rows are kept).
//
// Rules:
//   * No I/O, no env, no fetch, no logging of payloads.
//   * Stable across Node versions: only primitive JSON values, sorted keys,
//     UTF-8 string encoding, no NaN / Infinity allowed.
//   * The canonicalisation is deliberately strict: extra fields on the input
//     that the application does not know about are stripped before hashing
//     so that a provider returning a stray telemetry field cannot invalidate
//     an otherwise-identical version.
//
// The output hash is hex(SHA-256) of the UTF-8 bytes of the canonical JSON
// string. Length is always 64 characters.

import { createHash } from 'node:crypto';

/**
 * Fields included in the story content hash. Anything outside this set is
 * stripped before hashing so two DTOs that differ only on presentation
 * (e.g. a stray `excerpt` field) still collide.
 *
 * Roles are normalised as {id,label,mood}; the hash is taken over the
 * normalised roles array.
 *
 * Beats are normalised as {index,text,type,speaker}. Structured `type` and
 * `speaker` are first-class authored fields, so changing them changes the
 * version checksum.
 *
 * @typedef {Object} CanonicalStoryContent
 * @property {string} id
 * @property {string} title
 * @property {string} hook
 * @property {Array<{id:string,label:string,mood:string}>} roles
 * @property {string|null} [first_person_role_id]
 * @property {Array<{index:number,text:string,type?:string,speaker?:string}>} beats
 */

// JSON itself permits \n, \r and \t in string values. They are normal story
// formatting and must not change versioning. The remaining C0 controls are
// rejected before canonicalisation so binary / protocol garbage cannot leak
// into hashes or event text.
const FORBIDDEN_JSON = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {unknown}
 */
function assertValidJson(value, path) {
  if (value === null) return null;
  if (typeof value === 'string') {
    if (FORBIDDEN_JSON.test(value)) {
      throw new Error(`non-printable character in ${path}`);
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`non-finite number at ${path}`);
    }
    return value;
  }
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.map((entry, idx) => assertValidJson(entry, `${path}[${idx}]`));
  }
  if (typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(/** @type {object} */ (value)).sort()) {
      out[key] = assertValidJson(
        /** @type {Record<string, unknown>} */ (value)[key],
        `${path}.${key}`,
      );
    }
    return out;
  }
  throw new Error(`unsupported JSON value at ${path}: ${typeof value}`);
}

/**
 * Produce a deterministic JSON string for a value. Keys are sorted
 * recursively so {b:1,a:2} serialises identically to {a:2,b:1}.
 * The output contains no whitespace.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJsonStringify(value) {
  const normalised = assertValidJson(value, '$');
  return JSON.stringify(normalised);
}

/**
 * @param {unknown} value
 * @returns {string} 64-char hex SHA-256 of the canonical JSON encoding.
 */
export function canonicalSha256(value) {
  const json = canonicalJsonStringify(value);
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

/**
 * Reduce a StoryDetail DTO to its authored canonical form. Drops unknown
 * fields and forces the order of fields to a known list so equivalent DTOs
 * from different providers collide on the same hash.
 *
 * @param {unknown} detail
 * @returns {CanonicalStoryContent}
 */
export function canonicalStoryContent(detail) {
  if (!detail || typeof detail !== 'object') {
    throw new TypeError('canonicalStoryContent: detail must be an object');
  }
  const d = /** @type {any} */ (detail);
  if (typeof d.id !== 'string' || !d.id) {
    throw new TypeError('canonicalStoryContent: missing id');
  }
  if (typeof d.title !== 'string') {
    throw new TypeError('canonicalStoryContent: missing title');
  }
  if (typeof d.hook !== 'string') {
    throw new TypeError('canonicalStoryContent: missing hook');
  }
  if (!Array.isArray(d.roles)) {
    throw new TypeError('canonicalStoryContent: missing roles');
  }
  if (!Array.isArray(d.beats)) {
    throw new TypeError('canonicalStoryContent: missing beats');
  }
  const roles = d.roles.map((r, i) => {
    if (!r || typeof r !== 'object') {
      throw new TypeError(`roles[${i}] not an object`);
    }
    return {
      id: String(r.id ?? ''),
      label: String(r.label ?? ''),
      mood: typeof r.mood === 'string' ? r.mood : '',
    };
  });
  const hasFirstPersonRoleId = Object.prototype.hasOwnProperty.call(d, 'first_person_role_id');
  let firstPersonRoleId = null;
  if (hasFirstPersonRoleId) {
    if (d.first_person_role_id !== null && typeof d.first_person_role_id !== 'string') {
      throw new TypeError('canonicalStoryContent: first_person_role_id must be a role id or null');
    }
    firstPersonRoleId = d.first_person_role_id;
    if (typeof firstPersonRoleId === 'string' && !roles.some((role) => role.id === firstPersonRoleId)) {
      throw new TypeError('canonicalStoryContent: first_person_role_id must reference roles[]');
    }
  }
  const beats = d.beats.map((b, i) => {
    if (typeof b === 'string') return { index: i, text: b };
    if (!b || typeof b !== 'object') {
      throw new TypeError(`beats[${i}] not an object`);
    }
    const beat = {
      index: typeof b.index === 'number' ? b.index : i,
      text: String(b.text ?? ''),
      ...progressMetadata(b),
    };
    if (typeof b.type === 'string' && b.type) beat.type = b.type;
    if (typeof b.speaker === 'string' && b.speaker) beat.speaker = b.speaker;
    // Second narration track for first-person sources (see
    // stories/openingFirstPerson.mjs). It is content, so it participates in
    // the content hash; absent on third-person stories and legacy rows.
    if (typeof b.text_first_person === 'string' && b.text_first_person) {
      beat.text_first_person = b.text_first_person;
    }
    return beat;
  });
  return {
    id: d.id,
    title: d.title,
    hook: d.hook,
    roles,
    ...(hasFirstPersonRoleId ? { first_person_role_id: firstPersonRoleId } : {}),
    beats,
    ...(Array.isArray(d.ai_opening_events) ? {
      ai_opening_events: canonicalStoryContent({ id: d.id, title: d.title, hook: d.hook, roles: d.roles, beats: d.ai_opening_events }).beats,
      ai_preparation_version: String(d.ai_preparation_version || ''),
    } : {}),
  };
}

/**
 * Convenience: hash a StoryDetail DTO directly.
 * @param {unknown} detail
 * @returns {string}
 */
export function canonicalStoryHash(detail) {
  return canonicalSha256(canonicalStoryContent(detail));
}