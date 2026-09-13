// src/stories/openingFirstPerson.mjs — per-role opening track helpers plus
// the read-time renderer that picks a track per player role.
//
// WHY THIS EXISTS
// ---------------
// The public opening cache is a WORK-LEVEL artifact: `cacheKey.mjs` forbids
// role_id / user_ref / session_uuid from ever reaching the cache key, so one
// generated opening is shared by every player of a (story, version, profile).
//
// That collides with the product requirement that the opening read like the
// CHOSEN role's story:
//
//   * the original narrator ("我") must read a first-person opening in the
//     novel's own voice, but GENERATED (not a verbatim slice), and
//   * every other role must read an opening focalised on themselves — never
//     the original narrator's camera.
//
// Instead of splitting the cache per role (which would break the key
// contract) the preparation step stores MULTIPLE narration tracks on the
// SAME cache events, all covering the same beats of the same span:
//
//   * `text`          — neutral third-person narration (AI-written, base).
//   * `text_by_role`  — { [role_id]: text } perspective tracks (AI-written):
//                       first-person voice for the original narrator role,
//                       second person ("你") for every other role.
//   * `text_first_person` — legacy verbatim slice from opening-rules/2 rows;
//                       still honoured for old caches and old sessions.
//
// All tracks share one event count, so `sequence` stays a shared coordinate
// and canonical history never forks. The renderer below is a pure projection
// applied at READ time only.

/** Sentence terminators that end a Chinese narrative sentence. Closing
 *  quotes/brackets are allowed to trail the terminator so a quoted line is
 *  not split away from its punctuation. */
const SENTENCE_END = /([。！？…；\.!?;]+[」』”’）)\]】》]*)/;

/**
 * Split narrative prose into sentences, keeping terminal punctuation attached.
 * Whitespace-only fragments are dropped. Text with no terminator at all yields
 * a single sentence.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const parts = text.split(SENTENCE_END);
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < parts.length; i += 2) {
    const body = parts[i] || '';
    const tail = parts[i + 1] || '';
    const sentence = (body + tail).trim();
    if (sentence) out.push(sentence);
  }
  return out;
}

/**
 * Collect the source sentences of a story, in order. Structured beats and
 * plain-string beats are both accepted; `ask_player_choice` beats terminate
 * the scan because nothing at or beyond the first choice belongs to a public
 * opening (same boundary rule as `generateOpeningCache`).
 *
 * The leading slice of this list is the scene reference handed to the
 * per-role perspective-track generation; it is never shown verbatim.
 *
 * @param {Array<string | { text?: string, type?: string }>} beats
 * @returns {string[]}
 */
export function sourceSentences(beats) {
  if (!Array.isArray(beats)) return [];
  /** @type {string[]} */
  const sentences = [];
  for (const beat of beats) {
    const text = typeof beat === 'string' ? beat : beat && beat.text;
    const type = beat && typeof beat === 'object' ? beat.type : undefined;
    if (type === 'ask_player_choice') break;
    if (typeof text !== 'string' || !text.trim()) continue;
    sentences.push(...splitSentences(text));
  }
  return sentences;
}

/**
 * Pure read-time projection: choose which track a given player should see.
 *
 * Resolution order:
 *   1. `text_by_role[role_id]` — the generated perspective track for the
 *      session's role (opening-rules/3 and later).
 *   2. `text_first_person` — legacy opening-rules/2 verbatim slice, served
 *      only when the player picked the original narrator role.
 *   3. `text` — the neutral third-person base track.
 *
 * Every missing-field case falls through, so old pinned caches and old
 * sessions keep rendering unchanged.
 *
 * @param {{ text?: string, text_first_person?: string, text_by_role?: Record<string, string> } | null | undefined} payload
 * @param {{ role_id?: string | null, first_person_role_id?: string | null }} [perspective]
 * @returns {string} The text to display.
 */
export function renderOpeningText(payload, perspective = {}) {
  const neutral = payload && typeof payload.text === 'string' ? payload.text : '';
  const byRole = payload && payload.text_by_role && typeof payload.text_by_role === 'object' && !Array.isArray(payload.text_by_role)
    ? payload.text_by_role
    : null;
  const roleId = perspective.role_id;
  if (byRole && typeof roleId === 'string' && roleId && typeof byRole[roleId] === 'string' && byRole[roleId]) {
    return byRole[roleId];
  }
  const firstPerson = payload && typeof payload.text_first_person === 'string'
    ? payload.text_first_person
    : '';
  if (firstPerson) {
    const firstPersonRoleId = perspective.first_person_role_id;
    if (typeof roleId === 'string' && typeof firstPersonRoleId === 'string' && roleId && roleId === firstPersonRoleId) {
      return firstPerson;
    }
  }
  return neutral;
}

/**
 * Convenience wrapper: project a whole opening event list for one role.
 * The returned events keep every other field (type/sequence/speaker/progress)
 * untouched, and retain the track fields so the client can echo the event
 * back to `commitOpeningEvent` without breaking the strict pinned-cache
 * payload comparison.
 *
 * @template {{ text?: string, text_first_person?: string, text_by_role?: Record<string, string> }} T
 * @param {T[]} events
 * @param {{ role_id?: string | null, first_person_role_id?: string | null }} perspective
 * @returns {Array<T & { display_text: string }>}
 */
export function renderOpeningEvents(events, perspective) {
  if (!Array.isArray(events)) return [];
  return events.map((event) => ({
    ...event,
    display_text: renderOpeningText(event, perspective),
  }));
}
