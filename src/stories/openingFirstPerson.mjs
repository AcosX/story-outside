// src/stories/openingFirstPerson.mjs — deterministic first-person opening
// track, plus the read-time renderer that picks a track per player role.
//
// WHY THIS EXISTS
// ---------------
// The public opening cache is a WORK-LEVEL artifact: `cacheKey.mjs` forbids
// role_id / user_ref / session_uuid from ever reaching the cache key, so one
// generated opening is shared by every player of a (story, version, profile).
//
// That collides with two product requirements:
//
//   1. When the source novel is written in first person AND the player picks
//      that same role ("我"), the opening should read like the ORIGINAL TEXT.
//   2. When the player picks any other role, the opening must not smuggle in
//      the protagonist's private interiority, and must name the protagonist
//      instead of calling them "主角".
//
// Instead of splitting the cache per role (which would break the key
// contract) we store BOTH tracks on the SAME cache event:
//
//   * `text`               — neutral third-person narration (AI-written).
//   * `text_first_person`  — a verbatim slice of the source text (NOT AI-written).
//
// Both tracks always have the SAME event count, so `sequence` stays a shared
// coordinate and canonical history never forks. The renderer below is a pure
// projection applied at READ time only.
//
// The first-person track is produced by deterministic slicing rather than by
// the model, because the requirement is "identical or near-identical to the
// original". Asking an LLM to "not paraphrase" is a hope; slicing is a
// guarantee, and it is reproducible across processes and Node versions.

/** Sentence terminators that end a Chinese narrative sentence. Closing
 *  quotes/brackets are allowed to trail the terminator so a quoted line is
 *  not split away from its punctuation. */
const SENTENCE_END = /([。！？…；\.!?;]+[」』”’）)\]】》]*)/;

/** Minimum / maximum characters per rendered opening entry. These mirror the
 *  40–100 char guidance the analysis prompt gives for the third-person track,
 *  so the two tracks pace similarly during playback. */
const MIN_ENTRY_CHARS = 40;
const MAX_ENTRY_CHARS = 100;

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
 * Distribute `count` sentences into exactly `groups` contiguous buckets.
 *
 * Every bucket receives at least one sentence, and bucket sizes differ by at
 * most one, so the first-person track paces like the third-person track it
 * must stay aligned with. Returns null when there are not enough sentences to
 * fill every bucket — the caller then omits the first-person track entirely
 * rather than emitting an empty entry.
 *
 * @param {number} count
 * @param {number} groups
 * @returns {Array<[number, number]> | null} [startInclusive, endExclusive] pairs.
 */
function partition(count, groups) {
  if (!Number.isInteger(count) || !Number.isInteger(groups) || groups < 1) return null;
  if (count < groups) return null;
  const base = Math.floor(count / groups);
  const remainder = count % groups;
  /** @type {Array<[number, number]>} */
  const ranges = [];
  let cursor = 0;
  for (let i = 0; i < groups; i += 1) {
    // The first `remainder` buckets absorb the extra sentence so the split is
    // deterministic and front-loaded rather than dependent on rounding.
    const size = base + (i < remainder ? 1 : 0);
    ranges.push([cursor, cursor + size]);
    cursor += size;
  }
  return ranges;
}

/**
 * Build the verbatim first-person opening track.
 *
 * The result has EXACTLY `eventCount` entries whose concatenation is a
 * contiguous prefix of the source text, so the player reading as the original
 * narrator sees the author's own words.
 *
 * `sentenceCount` is the model-supplied boundary: how many leading source
 * sentences belong to the opening (i.e. everything before the first
 * meaningful choice). It is clamped to the available sentences, so a bad or
 * oversized estimate degrades into "use what exists" instead of throwing.
 *
 * @param {object} input
 * @param {Array<string | { text?: string, type?: string }>} input.beats
 * @param {number} input.sentenceCount
 * @param {number} input.eventCount   Entry count of the third-person track.
 * @returns {string[] | null} One string per event, or null when unavailable.
 */
export function firstPersonOpeningTexts({ beats, sentenceCount, eventCount }) {
  if (!Number.isInteger(eventCount) || eventCount < 1) return null;
  const sentences = sourceSentences(beats);
  if (sentences.length === 0) return null;
  const limit = Number.isInteger(sentenceCount) && sentenceCount > 0
    ? Math.min(sentenceCount, sentences.length)
    : sentences.length;
  const selected = sentences.slice(0, limit);
  const ranges = partition(selected.length, eventCount);
  if (!ranges) return null;
  const texts = ranges.map(([start, end]) => selected.slice(start, end).join(''));
  // Guard against a pathological source (e.g. one 4000-char unpunctuated
  // block) producing entries far outside the playback envelope. Callers treat
  // null as "no first-person track" and fall back to the neutral text.
  if (texts.some((text) => !text.trim())) return null;
  return texts;
}

/**
 * Pure read-time projection: choose which track a given player should see.
 *
 * Returns the first-person text only when the story really is first-person
 * AND the player picked that exact role. Every other case — third-person
 * source, a different role, a legacy single-track cache row, or a missing
 * field — falls back to the neutral `text`, so old pinned caches and old
 * sessions keep rendering unchanged.
 *
 * @param {{ text?: string, text_first_person?: string } | null | undefined} payload
 * @param {{ role_id?: string | null, first_person_role_id?: string | null }} [perspective]
 * @returns {string} The text to display.
 */
export function renderOpeningText(payload, perspective = {}) {
  const neutral = payload && typeof payload.text === 'string' ? payload.text : '';
  const firstPerson = payload && typeof payload.text_first_person === 'string'
    ? payload.text_first_person
    : '';
  if (!firstPerson) return neutral;
  const roleId = perspective.role_id;
  const firstPersonRoleId = perspective.first_person_role_id;
  if (typeof roleId !== 'string' || typeof firstPersonRoleId !== 'string') return neutral;
  if (!roleId || roleId !== firstPersonRoleId) return neutral;
  return firstPerson;
}

/**
 * Convenience wrapper: project a whole opening event list for one role.
 * The returned events keep every other field (type/sequence/speaker/progress)
 * untouched, and retain `text_first_person` so the client can echo the event
 * back to `commitOpeningEvent` without breaking the strict pinned-cache
 * payload comparison.
 *
 * @template {{ text?: string, text_first_person?: string }} T
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

export const _internals = { partition, MIN_ENTRY_CHARS, MAX_ENTRY_CHARS };
