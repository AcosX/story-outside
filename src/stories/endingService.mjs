// src/stories/endingService.mjs — ClickUp 11 ending-page service.
//
// Derives three read-only projections from a session + its story version:
//
//   * buildEnding          → ending_title / ending_summary / key_choices /
//                            character_outcomes / first_deviation /
//                            total_analysis / ending_key / category
//                            (rebuilt from session_events + tool envelope)
//   * buildOriginalTimeline → canonical key_facts extracted from the
//                            story_version (the "original work" baseline).
//                            Includes a `source_attribution` label so the
//                            UI can mark these as "来自原作 …" and never
//                            mistake them for AI-generated content.
//   * buildReplay          → committed session_events in sequence order,
//                            excluding pending / discarded tool_call rows
//                            (08 / 09 contract: tool_call never becomes
//                            a canonical event; pending_batch items with
//                            status=staged are excluded).
//
// Strict invariants (fail closed):
//   - repository is required (in-memory per-process)
//   - session_uuid is a UUID
//   - finish_story commit has happened for buildEnding; otherwise throws
//     ending_not_committed so the HTTP layer can return 404.
//
// The service is intentionally pure: it does NOT mutate state, does NOT
// touch the in-memory pending batch, and does NOT replay the provider.
// Every projection can be rebuilt deterministically from
// session_events + story_version + opening_cache.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CACHE_EVENT_TYPES = new Set(['narration', 'dialogue', 'action', 'beat']);
const REPLAY_EXCLUDED_TYPES = new Set([
  'pending_tool_call', // never canonical
  'tool_call',         // never canonical
  'pending',           // pending row from earlier draft; never canonical
  'discarded',         // explicitly dropped; never canonical
]);

function assertUuid(label, value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`endingService: ${label} must be a UUID`);
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sessionFor(repository, session_uuid) {
  const state = repository.sessionState;
  if (!state || !state.sessions) {
    throw new Error('endingService: repository has no sessionState');
  }
  const session = state.sessions.get(session_uuid);
  if (!session) throw new Error(`endingService: unknown session '${session_uuid}'`);
  return session;
}

/**
 * Locate the finish_story tool envelope in the session. The envelope is
 * stored on session.pending.tool_call at the moment the FINAL narrative
 * commit lands; the service also reads it from session.requestIds so a
 * process restart that lost the in-memory pending still surfaces the
 * last committed envelope via the idempotency store.
 *
 * Returns the tool envelope payload (the normalized args passed to
 * finish_story by the runtime) plus the kind, or null when the session
 * has not yet committed a finish_story.
 */
function findFinishStoryToolCall(session) {
  const pendingToolCall = session.pending && session.pending.tool_call;
  if (pendingToolCall && pendingToolCall.name === 'finish_story') {
    return pendingToolCall;
  }
  // Fallback: scan requestIds for the most recent finish_story envelope.
  let mostRecent = null;
  for (const [, entry] of session.requestIds.entries()) {
    const result = entry && entry.result;
    if (!result || typeof result !== 'object') continue;
    if (result.pending_tool_call && result.pending_tool_call.name === 'finish_story') {
      mostRecent = result.pending_tool_call;
    }
  }
  return mostRecent;
}

/**
 * Stable short slug derived from the session's opening-cache opening_key
 * (e.g. "cafe-rain@opening-default") so the category can later be used
 * as a community-statistics dimension without leaking the internal
 * cache generation profile identifier.
 */
function deriveCategory({ story, version, cache }) {
  if (!story || !version) return null;
  const storySlug = typeof story.slug === 'string' ? story.slug : (story.story_uuid || '');
  const versionNo = Number.isInteger(version.version_no) ? version.version_no : 0;
  if (cache && cache.opening_key) {
    return `${storySlug}#v${versionNo}/${cache.opening_key}`;
  }
  return `${storySlug}#v${versionNo}`;
}

/**
 * Walk the canonical history and find the first place the player
 * deviated from the original timeline. "Deviation" here means the first
 * event that is NOT in the opening cache's event stream AND was authored
 * AFTER the last opening cache event had been consumed.
 *
 * The output is intentionally a structured diff hint (no full-text
 * comparison): the UI highlights this in the ending summary and as the
 * red anchor in the comparison view.
 */
function findFirstDeviation({ canonicalHistory, openingEvents }) {
  if (!Array.isArray(canonicalHistory) || canonicalHistory.length === 0) return null;
  const openingLength = Array.isArray(openingEvents) ? openingEvents.length : 0;
  // The first N canonical events correspond to opening cache events
  // (story_opening). The (N+1)th canonical event that is NOT a
  // player_input is the first author-driven deviation.
  for (let i = openingLength; i < canonicalHistory.length; i += 1) {
    const ev = canonicalHistory[i];
    if (!ev || typeof ev !== 'object') continue;
    if (ev.event_type === 'player_input') continue; // player-driven; ignore
    if (ev.event_type === 'narrative_beat') {
      const payload = ev.payload || {};
      return {
        event_seq: ev.event_seq,
        type: ev.event_type,
        text: payload.text || '',
        speaker: payload.speaker || null,
        occurred_at: ev.occurred_at,
        // For UI display: a short label comparing to the next opening
        // beat ("after beat X").
        after_opening_sequence: Math.max(0, openingLength - 1),
      };
    }
  }
  return null;
}

/**
 * Build the ending projection. Requires the finish_story tool envelope
 * to have committed (otherwise throws ending_not_committed).
 *
 * Output shape (stable contract; the HTTP layer returns this verbatim):
 *   {
 *     ending_title, ending_summary, key_choices[], character_outcomes[],
 *     first_deviation, total_analysis, ending_key, category
 *   }
 */
export function buildEnding({ repository, session_uuid }) {
  if (!repository) throw new Error('buildEnding: repository required');
  assertUuid('session_uuid', session_uuid);
  const session = sessionFor(repository, session_uuid);
  const toolCall = findFinishStoryToolCall(session);
  if (!toolCall) {
    const err = new Error('buildEnding: finish_story has not committed');
    err.code = 'ending_not_committed';
    throw err;
  }
  const payload = toolCall.payload || {};
  const story = repository.findStoryByUuid(session.story_uuid);
  const version = repository.findVersion(session.story_version_uuid);
  const cache = repository.findOpeningCacheByUuid(session.cache_uuid);
  const firstDeviation = findFirstDeviation({
    canonicalHistory: session.history,
    openingEvents: (cache && cache.content_payload && Array.isArray(cache.content_payload.events))
      ? cache.content_payload.events
      : [],
  });
  // Total analysis: a short, deterministic paragraph that surfaces
  // session-level totals (canonical events + player inputs + first
  // deviation hint). It is NEVER authored by the runtime; it is a
  // summary derived from session state. The UI surfaces this verbatim.
  const committedEvents = Array.isArray(session.history) ? session.history : [];
  const playerInputCount = committedEvents.filter((e) => e && e.event_type === 'player_input').length;
  const narrativeCount = committedEvents.filter((e) => e && e.event_type === 'narrative_beat').length;
  const openingCount = committedEvents.filter((e) => e && e.event_type === 'story_opening').length;
  const category = deriveCategory({ story, version, cache });
  const totalAnalysis = [
    `本次共播放 ${openingCount} 句开场、${narrativeCount} 段剧情、${playerInputCount} 次玩家输入。`,
    firstDeviation
      ? `第一次重大偏离发生在第 ${firstDeviation.event_seq} 句。`
      : '玩家选择全程贴近原作节奏。',
  ].join('');
  return {
    ending_title: payload.ending || payload.summary || '结局',
    ending_summary: payload.summary || '',
    key_choices: Array.isArray(payload.key_choices) ? payload.key_choices.map((c) => String(c)) : [],
    character_outcomes: Array.isArray(payload.character_outcomes)
      ? payload.character_outcomes.map((item) => ({
          character: String(item.character || ''),
          fate: String(item.fate || ''),
          change: item.change ? String(item.change) : undefined,
        }))
      : [],
    first_deviation: firstDeviation,
    total_analysis: totalAnalysis,
    ending_key: typeof payload.ending_key === 'string' ? payload.ending_key : null,
    category,
  };
}

/**
 * Extract the canonical key_facts from a story_version. These are the
 * ORIGINAL story's structural facts (title, role list, beat sequence,
 * opening cache highlights), used by the UI to draw the "原作时间线"
 * column. NEVER sourced from the AI-parallel timeline.
 *
 * Source attribution is set to "来自原作 《title》 (version_no)" so the
 * UI can label these entries distinctly from the AI-parallel timeline.
 */
export function buildOriginalTimeline({ repository, session_uuid }) {
  if (!repository) throw new Error('buildOriginalTimeline: repository required');
  assertUuid('session_uuid', session_uuid);
  const session = sessionFor(repository, session_uuid);
  const version = repository.findVersion(session.story_version_uuid);
  const story = repository.findStoryByUuid(session.story_uuid);
  if (!version) {
    const err = new Error('buildOriginalTimeline: story_version not found');
    err.code = 'story_version_not_found';
    throw err;
  }
  const cache = repository.findOpeningCacheByUuid(session.cache_uuid);
  const openingEvents = (cache && cache.content_payload && Array.isArray(cache.content_payload.events))
    ? cache.content_payload.events
    : [];
  const detail = version.content_payload || {};
  const beats = Array.isArray(detail.beats) ? detail.beats : [];
  const roles = Array.isArray(detail.roles) ? detail.roles : [];
  const key_facts = [];
  // 1) Story-level metadata facts (title / hook / roles).
  key_facts.push({
    kind: 'story_title',
    label: '作品',
    text: version.title || (story && story.title) || '',
    source: 'story_version',
  });
  if (version.hook || (story && story.hook)) {
    key_facts.push({
      kind: 'story_hook',
      label: '简介',
      text: version.hook || (story && story.hook) || '',
      source: 'story_version',
    });
  }
  if (roles.length > 0) {
    key_facts.push({
      kind: 'story_roles',
      label: '角色',
      text: roles.map((r) => (r && r.label) || (r && r.id) || '').filter(Boolean).join('、'),
      source: 'story_version',
    });
  }
  // 2) Opening-cache key facts (first 3 events only). We pick the
  // opening stream instead of the full beat list because the opening
  // cache IS the canonical "playable from start to first choice"
  // segment, which is the segment the player's parallel timeline is
  // most likely to deviate from.
  const openingSample = openingEvents.slice(0, 3);
  for (const event of openingSample) {
    if (!event || typeof event !== 'object') continue;
    key_facts.push({
      kind: 'opening_beat',
      label: '原作开场',
      sequence: event.sequence,
      type: event.type || 'narration',
      speaker: event.speaker || null,
      text: event.text || '',
      source: 'opening_cache',
    });
  }
  // 3) Choice boundary (where the opening ends).
  const totalOpening = openingEvents.length;
  const totalBeats = beats.length;
  key_facts.push({
    kind: 'choice_boundary',
    label: '首次选择',
    text: `原作在第 ${totalOpening} 句进入首次选择；总拍数 ${totalBeats}。`,
    source: 'opening_cache',
  });
  const sourceAttribution = `来自原作《${version.title || (story && story.slug) || ''}》 v${version.version_no || 1}`;
  return {
    story_id: story ? story.story_uuid : null,
    story_version_id: version.version_uuid,
    story_version_checksum: version.checksum,
    story_title: version.title || null,
    story_version_no: version.version_no || 1,
    key_facts,
    source_attribution: sourceAttribution,
  };
}

/**
 * Build the replay projection. Strictly equals the canonical
 * session_events (already filtered to status='committed' by the append
 * path) with these additional filters:
 *   - exclude tool_call / pending_tool_call / pending / discarded types
 *     (08 contract: tool_call never becomes canonical; pending_batch
 *     staged items are excluded until committed)
 *   - ordered by event_seq ascending
 *   - each event is annotated with `type` (narration/dialogue/action/beat
 *     or 'player_input') derived from event_type + payload.type
 */
export function buildReplay({ repository, session_uuid }) {
  if (!repository) throw new Error('buildReplay: repository required');
  assertUuid('session_uuid', session_uuid);
  const session = sessionFor(repository, session_uuid);
  const history = Array.isArray(session.history) ? session.history.slice() : [];
  // Defensive: filter any pre-canonical rows (should never be present
  // in the in-memory history, but the contract requires explicit
  // rejection of `pending` / `discarded` types so a future DAO-backed
  // repository is held to the same shape).
  const filtered = history.filter((ev) => ev && !REPLAY_EXCLUDED_TYPES.has(ev.event_type));
  // Order by event_seq ascending (defensive: history is append-only so
  // it is already in order, but the contract requires this guarantee).
  filtered.sort((a, b) => (a.event_seq || 0) - (b.event_seq || 0));
  const events = filtered.map((ev) => {
    const payload = (ev && typeof ev.payload === 'object' && ev.payload !== null) ? ev.payload : {};
    let displayType = ev.event_type;
    if (ev.event_type === 'narrative_beat' || ev.event_type === 'story_opening') {
      // Prefer the structured sub-type when available.
      if (CACHE_EVENT_TYPES.has(payload.type)) displayType = payload.type;
      else displayType = 'narration';
    } else if (ev.event_type === 'player_input') {
      displayType = 'player_input';
    }
    const out = {
      sequence: ev.event_seq,
      type: displayType,
      text: typeof payload.text === 'string' ? payload.text : '',
      occurred_at: ev.occurred_at,
      source: ev.source || null,
    };
    if (payload.speaker) out.speaker = String(payload.speaker);
    return out;
  });
  return { events };
}