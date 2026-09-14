// src/agent/contextBuilder.mjs — assemble the request context the agent
// runtime hands to the provider, including the long-context compact
// decision (Story 10).
//
// DEPENDENCY NOTE — projection vs SQL boundary:
// This module is pure: it reads the synchronous session projection returned
// by sessionService and produces a context payload object. It never mutates
// session_events, asks the provider, or opens DB connections. In MariaDB
// mode the projection has already been hydrated by the server adapter, so
// the output is identical after a restart. The compact *write* path lives in
// sessionService.mjs (see recordCompact / rebuildCompactFromHistory) and is
// intentionally separate from this read+assemble path.
//
// MariaDB contract: session_events rows are append-only and never deleted
// by compact. The compact summary lives on game_sessions.context_compact
// (MEDIUMTEXT / JSON); the compact cursor lives on
// game_sessions.compacted_through_seq. Pending / uncommitted speculative
// events (tracked in pending_batches / pending_batch_items, owned by 07/08)
// MUST NOT be folded into compact; this module treats the canonical
// session_events stream as the only valid input.

import { canonicalJsonStringify } from '../stories/canonicalHash.mjs';
import { fallbackEstimateTokens } from './tokenEstimator.mjs';

const COMPACT_PROMPT_VERSION = 1;
const CONTEXT_SCHEMA_VERSION = 1;

const KEPT_RECENT_DEFAULT = 8;          // keep this many of the most recent committed events verbatim
const KEPT_RECENT_MIN = 2;
const KEPT_RECENT_MAX = 64;

const EVENT_TYPES_THAT_NEVER_COMPACT = new Set([
  'ask_player_choice',  // never fold an unresolved choice into compact; the
                        // runtime must still see it as a tool_call result
                        // waiting for the player's response.
  'player_input',       // recent player inputs must stay verbatim so the
                        // provider can mirror the voice / topic
]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(canonicalJsonStringify(value));
}

function asEventList(history) {
  if (!Array.isArray(history)) return [];
  return history.filter((event) => event && typeof event === 'object' && Number.isInteger(event.event_seq));
}

function pickCompactedEvents(history, { through_seq }) {
  if (!Number.isInteger(through_seq) || through_seq < 0) return [];
  return history.filter((event) => event.event_seq <= through_seq);
}

function pickRecentEvents(history, { count }) {
  if (!Number.isInteger(count) || count <= 0) return [];
  return history.slice(Math.max(0, history.length - count));
}

function isEventProtected(event) {
  if (!event || typeof event !== 'object') return true;
  const type = event.event_type || (event.payload && event.payload.type);
  return EVENT_TYPES_THAT_NEVER_COMPACT.has(type);
}

/**
 * Choose the window of committed canonical history that should be folded
 * into the compact summary. The selection rule is:
 *
 *   1. Start at event_seq = 1.
 *   2. Take the prefix starting after compacted_through_seq — everything
 *      that has NOT yet been compact is eligible.
 *   3. Never fold any event whose event_type is in
 *      EVENT_TYPES_THAT_NEVER_COMPACT. Folding STOPS at the first such
 *      event: the protected event itself and everything after it stays out
 *      of the summary (it remains visible in canonical history — folding
 *      past an unresolved choice or a recent player input would both
 *      misorder the summary and make the protected event silently
 *      disappear from the compact view).
 *      A semantic summarizer may opt into folding older player inputs via
 *      fold_player_inputs; it must retain their choices and event_seq.
 *   4. Always keep at least KEPT_RECENT_MIN recent committed events
 *      verbatim, so the provider can still see the latest voice.
 *   5. Returned array preserves canonical order.
 *
 * Pending / uncommitted items (anything in pending_batches / pending_batch_items
 * with status != committed) are NEVER passed in here in the first place
 * (history is the canonical session_events stream). The function
 * defensively filters any such input anyway.
 *
 * @param {Array<object>} canonicalHistory canonical session_events
 * @param {{ compacted_through_seq?: number | null, kept_recent?: number, fold_player_inputs?: boolean }} [options]
 * @returns {{ selected: Array<object>, next_through_seq: number, kept_recent: Array<object>, skipped_protected: number }}
 */
export function selectCompactWindow(canonicalHistory, options = {}) {
  const all = asEventList(canonicalHistory);
  const alreadyCompactedThrough = Number.isInteger(options.compacted_through_seq) ? options.compacted_through_seq : -1;
  let keptRecent = Number.isInteger(options.kept_recent) ? options.kept_recent : KEPT_RECENT_DEFAULT;
  if (keptRecent < KEPT_RECENT_MIN) keptRecent = KEPT_RECENT_MIN;
  if (keptRecent > KEPT_RECENT_MAX) keptRecent = KEPT_RECENT_MAX;

  // Defensive: filter out anything that is not "committed" canonical.
  const committed = all.filter((event) => {
    if (!event || typeof event !== 'object') return false;
    if (event.committed === false) return false;
    if (event.status === 'pending' || event.status === 'staged') return false;
    return true;
  });

  // Recent tail is always kept verbatim, regardless of type.
  const recentTail = pickRecentEvents(committed, { count: keptRecent });

  // Compact pool = committed history up to (recentTail[0].event_seq - 1)
  // (or the entire stream if there are not enough events yet).
  const tailStartSeq = recentTail.length > 0 ? recentTail[0].event_seq : Number.MAX_SAFE_INTEGER;
  const compactPool = committed.filter((event) => event.event_seq < tailStartSeq);

  // Skip events that have already been compact (their summaries already
  // live on session.context_compact and folding them again would double-count).
  const eligiblePool = compactPool.filter((event) => event.event_seq > alreadyCompactedThrough);

  // Walk through eligible pool in order; STOP at the first protected event.
  // The protected event and everything after it stays un-folded (kept
  // verbatim in canonical history instead of vanishing into the summary).
  const selected = [];
  let skippedProtected = 0;
  let lastSelectedSeq = alreadyCompactedThrough;
  for (const event of eligiblePool) {
    if (isEventProtected(event) && !(options.fold_player_inputs === true && event.event_type === 'player_input')) {
      // Folding stops here: we do NOT compact this event, and we do NOT
      // fold anything after it either — the summary must never overtake an
      // unresolved choice / recent player input. The span between the fold
      // point and the recent tail stays raw (visible) in canonical history.
      skippedProtected = 1;
      break;
    }
    selected.push(event);
    lastSelectedSeq = event.event_seq;
  }

  return {
    selected,
    next_through_seq: lastSelectedSeq,
    kept_recent: recentTail,
    skipped_protected: skippedProtected,
  };
}

/**
 * Project an event down to the fields the compact summary actually needs.
 * We strip transient fields that were never part of the canonical payload
 * to keep summaries stable and re-buildable from session_events.
 */
function projectForCompact(event) {
  if (!event || typeof event !== 'object') return null;
  return {
    event_seq: event.event_seq,
    event_id: event.event_id,
    event_type: event.event_type,
    origin: event.origin,
    source: event.source,
    source_sequence: event.source_sequence,
    occurred_at: event.occurred_at,
    payload: event.payload,
  };
}

/**
 * Build a compact summary text from a window of canonical events.
 *
 * The summary MUST be deterministic and self-contained so the future
 * rebuildCompactFromHistory() function can produce the same text from the
 * same input. We structure the summary in three sections:
 *
 *   - "facts"           : concrete world-state changes (characters,
 *                         locations, secrets revealed, items).
 *   - "relationships"   : how characters relate to each other / the player.
 *   - "open_threads"    : unresolved choices, pending goals, promises.
 *
 * Anything that does not fit these buckets is intentionally dropped from
 * the summary; the recent verbatim tail still carries it.
 *
 * @param {Array<object>} selectedEvents canonical events eligible for compact
 * @returns {{ schema_version: number, prompt_version: number, sections: { facts: string[], relationships: string[], open_threads: string[] }, event_count: number, through_seq: number }}
 */
export function buildCompactSummary(selectedEvents) {
  const events = (Array.isArray(selectedEvents) ? selectedEvents : [])
    .map(projectForCompact)
    .filter(Boolean);

  const facts = [];
  const relationships = [];
  const openThreads = [];

  for (const event of events) {
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
    switch (event.event_type) {
      case 'story_opening': {
        const text = typeof payload.text === 'string' && payload.text.length > 0
          ? payload.text
          : (typeof payload.description === 'string' ? payload.description : '');
        const speaker = typeof payload.speaker === 'string' ? payload.speaker : null;
        if (text) {
          facts.push(speaker ? `[opening:${speaker}] ${text}` : `[opening] ${text}`);
        }
        break;
      }
      case 'narrative_beat': {
        const text = typeof payload.text === 'string' ? payload.text : '';
        const speaker = typeof payload.speaker === 'string' ? payload.speaker : null;
        if (text) {
          facts.push(speaker ? `[beat:${speaker}] ${text}` : `[beat] ${text}`);
        }
        break;
      }
      case 'chat_message': {
        const text = typeof payload.text === 'string' ? payload.text : '';
        const speaker = typeof payload.speaker === 'string' ? payload.speaker : 'unknown';
        if (text) {
          relationships.push(`[chat:${speaker}] ${text}`);
        }
        break;
      }
      case 'player_input': {
        const text = typeof payload.text === 'string' ? payload.text : '';
        if (text) {
          openThreads.push(`[player_input] ${text}`);
        }
        break;
      }
      case 'player_choice': {
        const choiceId = typeof payload.choice_id === 'string' ? payload.choice_id : '';
        const label = typeof payload.label === 'string' ? payload.label : '';
        if (choiceId || label) {
          facts.push(`[choice] player picked ${choiceId || '(unknown)'}${label ? ` "${label}"` : ''}`);
        }
        break;
      }
      case 'ending_reached': {
        const ending = typeof payload.ending === 'string' ? payload.ending : '';
        if (ending) facts.push(`[ending] ${ending}`);
        break;
      }
      case 'session_started':
      case 'role_selected':
      case 'session_ended':
      case 'system_event':
      default: {
        // ignored on purpose: schema-only events that do not carry world state
        break;
      }
    }
  }

  return {
    schema_version: CONTEXT_SCHEMA_VERSION,
    prompt_version: COMPACT_PROMPT_VERSION,
    sections: {
      facts: Array.from(new Set(facts)),
      relationships: Array.from(new Set(relationships)),
      open_threads: Array.from(new Set(openThreads)),
    },
    event_count: events.length,
    through_seq: events.length > 0 ? events[events.length - 1].event_seq : 0,
  };
}

/**
 * Render a compact summary object as a deterministic string suitable for
 * both transmission to the provider and storage on game_sessions.context_compact.
 */
export function renderCompactSummary(summary) {
  if (!summary || typeof summary !== 'object') return '';
  const parts = [];
  parts.push(`# compact summary v${summary.schema_version || CONTEXT_SCHEMA_VERSION} (prompt ${summary.prompt_version || COMPACT_PROMPT_VERSION})`);
  parts.push(`# events folded: ${summary.event_count || 0} (through seq ${summary.through_seq || 0})`);
  const sections = summary.sections || {};
  if (Array.isArray(sections.facts) && sections.facts.length > 0) {
    parts.push('## facts');
    for (const line of sections.facts) parts.push(`- ${line}`);
  }
  if (Array.isArray(sections.relationships) && sections.relationships.length > 0) {
    parts.push('## relationships');
    for (const line of sections.relationships) parts.push(`- ${line}`);
  }
  if (Array.isArray(sections.open_threads) && sections.open_threads.length > 0) {
    parts.push('## open threads');
    for (const line of sections.open_threads) parts.push(`- ${line}`);
  }
  return parts.join('\n');
}

/**
 * @typedef {Object} AssembledContext
 * @property {string} schema_version
 * @property {string} prompt_version
 * @property {string|null} compact_text
 * @property {number|null} compact_through_seq
 * @property {Array<object>} recent_events
 * @property {Array<object>} canonical_history   full canonical history (kept for tests / recovery)
 * @property {object} input                      current turn input
 * @property {{ system_prompt: object|null, tool_definitions: Array<object>, pinned: object }} envelope
 * @property {{ window: number, threshold: number, estimated: number }} tokens
 * @property {{ folded_event_count: number, skipped_protected: number, decision: 'no_compact'|'compact' }} decision
 */

/**
 * Assemble the request context the provider sees.
 *
 * Inputs:
 *   - canonicalHistory: full session_events (append-only, never truncated)
 *   - existingCompact: { summary_text, summary_payload, through_seq } from
 *     session.context_compact (may be null if compact never fired).
 *   - kept_recent: minimum tail length. Every event after the summary cursor
 *     stays verbatim, including gaps left by protected events.
 *   - input: the current player/agent input JSON.
 *   - envelope: { system_prompt, tool_definitions, pinned }.
 *   - estimator: a TokenEstimator (see tokenEstimator.mjs).
 *
 * Behaviour:
 *   - If estimated tokens <= estimator.compactThreshold(), the assembled
 *     context is "no_compact" and includes the full original + compact (if
 *     any) + current input. Recent events include the entire uncovered suffix.
 *   - Otherwise we run selectCompactWindow + buildCompactSummary +
 *     renderCompactSummary and mark the decision "compact".
 *
 * The function is pure: it does not mutate canonicalHistory or any input.
 * Callers must persist the resulting summary separately via
 * sessionService.recordCompact() once they have decided to commit it.
 *
 * @param {{
 *   canonicalHistory: Array<object>,
 *   existingCompact?: { summary_text?: string|null, summary_payload?: object|null, through_seq?: number|null } | null,
 *   input: object,
 *   envelope: { system_prompt: object|null, tool_definitions: Array<object>, pinned: object },
 *   estimator: import('./tokenEstimator.mjs').TokenEstimator,
 *   kept_recent?: number,
 *   force_compact?: boolean,
 * }} args
 * @returns {AssembledContext}
 */
export function assembleContext(args) {
  if (!args || typeof args !== 'object') throw new Error('assembleContext: args required');
  const estimator = args.estimator;
  if (!estimator || typeof estimator.estimate !== 'function') throw new Error('assembleContext: estimator required');
  const history = Array.isArray(args.canonicalHistory) ? args.canonicalHistory : [];
  const existing = args.existingCompact && typeof args.existingCompact === 'object' ? args.existingCompact : null;
  const keptRecent = Number.isInteger(args.kept_recent) ? args.kept_recent : KEPT_RECENT_DEFAULT;
  const input = args.input && typeof args.input === 'object' ? args.input : {};
  const envelope = args.envelope && typeof args.envelope === 'object'
    ? args.envelope
    : { system_prompt: null, tool_definitions: [], pinned: {} };
  const forceCompact = args.force_compact === true;

  // Estimate every uncovered event, never just the most recent N events.
  const draftNoCompact = {
    ...buildSessionContext(history, {
      context_compact_text: existing?.summary_text,
      compacted_through_seq: existing?.through_seq,
    }),
    input,
    envelope,
  };
  const draftTokens = estimator.estimate(draftNoCompact);
  const overThreshold = forceCompact || draftTokens > estimator.compactThreshold();

  if (!overThreshold) {
    return Object.freeze({
      schema_version: String(CONTEXT_SCHEMA_VERSION),
      prompt_version: String(COMPACT_PROMPT_VERSION),
      compact_text: draftNoCompact.compact_text,
      compact_through_seq: draftNoCompact.compact_through_seq,
      recent_events: clone(draftNoCompact.recent_events),
      canonical_history: clone(history),
      input: clone(input),
      envelope: clone(envelope),
      tokens: Object.freeze({ window: estimator.contextWindow(), threshold: estimator.compactThreshold(), estimated: draftTokens }),
      decision: 'no_compact',
      folded_event_count: 0,
      skipped_protected: 0,
    });
  }

  // Compact path: pick a window and produce a new summary.
  const window = selectCompactWindow(history, {
    compacted_through_seq: existing && Number.isInteger(existing.through_seq) ? existing.through_seq : null,
    kept_recent: keptRecent,
  });
  const summaryPayload = buildCompactSummary(window.selected);
  const windowText = renderCompactSummary(summaryPayload);
  // Merge contract: the PREVIOUS summary is never discarded. The old
  // summary text comes first, the newly folded window facts are appended
  // after it — incremental compact EXTENDS the summary instead of
  // replacing it. When nothing new was foldable (e.g. the window stopped
  // at a protected event) the previous summary is carried over verbatim
  // and the previous payload (when present) stays authoritative.
  const previousText = existing && typeof existing.summary_text === 'string'
    ? existing.summary_text.trim()
    : '';
  const nothingNewFolded = window.selected.length === 0;
  const mergedPayload = nothingNewFolded
    && existing && existing.summary_payload && typeof existing.summary_payload === 'object'
    ? existing.summary_payload
    : summaryPayload;
  const summaryText = previousText.length > 0
    ? (nothingNewFolded ? previousText : `${previousText}\n${windowText}`)
    : windowText;
  const assembled = {
    compact_text: summaryText,
    compact_through_seq: window.next_through_seq,
    recent_events: history.filter(event => event.event_seq > window.next_through_seq),
    input,
    envelope,
  };
  const estimated = estimator.estimate(assembled);

  return Object.freeze({
    schema_version: String(CONTEXT_SCHEMA_VERSION),
    prompt_version: String(COMPACT_PROMPT_VERSION),
    compact_text: summaryText,
    compact_through_seq: window.next_through_seq,
    recent_events: clone(assembled.recent_events),
    canonical_history: clone(history),
    input: clone(input),
    envelope: clone(envelope),
    summary_payload: Object.freeze(mergedPayload),
    tokens: Object.freeze({ window: estimator.contextWindow(), threshold: estimator.compactThreshold(), estimated }),
    decision: 'compact',
    folded_event_count: window.selected.length,
    skipped_protected: window.skipped_protected,
  });
}

export const __testing = {
  KEPT_RECENT_DEFAULT,
  KEPT_RECENT_MIN,
  KEPT_RECENT_MAX,
  EVENT_TYPES_THAT_NEVER_COMPACT,
  isEventProtected,
  projectForCompact,
  fallbackEstimateTokens,
};

/** Pure runtime projection: a compact cursor may hide only a summarized prefix.
 * LLM summarization preserves older player inputs (including event_seq); recent
 * inputs stay verbatim in the tail. Pending tools are never canonical input.
 */
export function buildSessionContext(canonicalHistory, compact) {
  const history = asEventList(canonicalHistory).filter(event =>
    event.committed !== false && !['pending', 'staged'].includes(event.status));
  const summary = compact?.context_compact_text;
  const through = compact?.compacted_through_seq;
  const valid = typeof summary === 'string' && summary.trim().length > 0
    && Number.isInteger(through) && history.some(event => event.event_seq === through);
  return {
    compact_text: valid ? summary : null,
    compact_through_seq: valid ? through : null,
    recent_events: clone(valid ? history.filter(event => event.event_seq > through) : history),
  };
}
