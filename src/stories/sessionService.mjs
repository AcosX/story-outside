// src/stories/sessionService.mjs — canonical session store.
//
// ClickUp 05 / 08 / 09 contract (unified):
//
//   The sessionService IS the canonical store. It owns the per-session
//   history, revision, cursor, state, idempotency map, and the active
//   speculative pending batch. There is exactly one history per session,
//   and every event committed to it is hash-pinned and append-only.
//
//   * Opening events come from the pinned cache via commitOpeningEvent.
//     They MUST be explicitly displayed before they reach canonical
//     history, opening order is enforced against session.opening_cursor,
//     and the revision check MUST pass.
//
//   * Cursor semantics (ClickUp 08 P1.1): `cursor` is the CANONICAL
//     cursor — the count of committed canonical events. It equals
//     session.revision and the last committed event_seq, and advances on
//     EVERY commit (opening, narrative, player_input). The opening
//     playback position lives in a separate INTERNAL `opening_cursor`
//     (only opening commits advance it); it is exposed read-only so
//     clients can keep driving the opening sequence while `cursor`
//     stays consistent with the full canonical chain.
//
//   * Narrative events come from the runtime via stageNarrativeBatch + a
//     sequence of commitNarrativeEvent calls. Each commit appends exactly
//     ONE event to canonical history (the one the player just saw). The
//     speculative tail is parked on session.pending and NEVER reaches
//     canonical history unless the corresponding commitNarrativeEvent is
//     called.
//
//   * source_sequence is a per (session, source) monotonic counter
//     (0-based, contiguous, recoverable from history). It never resets
//     between batches, so the SQL unique key
//     uq_session_events_source_sequence(session_id, source, source_sequence)
//     holds across consecutive runtime batches and repeated player
//     interrupts. Opening events keep their pinned cache sequence (they
//     use the 'opening_cache' source).
//
//   * A tool call may ride on a batch as the OPTIONAL FINAL item. It is
//     validated, surfaced as part of the staged batch, and never written
//     to canonical history as a narrative item (it never advances the
//     pending cursor and never becomes a committed event_seq).
//
//   * interruptWithPlayerInput atomically:
//       - discards the speculative pending tail;
//       - appends the player_input as a NEW canonical event;
//       - switches the session state to 'realtime' (a realtime session
//         may be interrupted again; the state stays 'realtime').
//
//   * recoverSession returns canonical history + revision + cursor +
//     opening_cursor + the active pending snapshot. Read-only: never
//     calls the provider, never replays, never mutates state.
//
//   * Every mutating call accepts a client_request_id and uses the same
//     fingerprint contract as the application layer: a reused id with the
//     same payload replays the prior result; a reused id with a different
//     payload fails closed.
//
//   * Turn-level request idempotency (request_id + input + revision) is
//     owned by the SESSION (session.turnRequests), not by any transient
//     runtime instance, so the HTTP layer's per-request runtime creation
//     still replays a stable result for the same request_id.
//
// Stale revision / wrong pending_id / out-of-order sequence / mixed
// payloads / unknown event types fail closed.
//
//
// DEPENDENCY NOTE — in-memory vs SQL boundary (ClickUp 10 compact):
// `recordCompact` / `rebuildCompactFromHistory` / `getSessionCompact` add
// a compact cursor + summary onto the session object. They NEVER mutate
// the canonical history (`session.history`, the in-memory mirror of
// session_events) and they never write to a speculative / pending queue.
// In the current in-memory repository the compact is stored on the
// session object; the MariaDB schema in db/migrations/0005 mirrors this
// on game_sessions.context_compact_text / context_compact_payload /
// compacted_through_seq plus the compact_compacted_events audit table.
// `session_events` remains append-only (trigger in 0001) and is the only
// source of truth; `rebuildCompactFromHistory` is always able to rebuild
// the compact from canonical events alone.

import { randomUUID } from 'node:crypto';
import { canonicalJsonStringify, canonicalSha256 } from './canonicalHash.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_STATE = 'sessionState';
const CACHE_EVENT_TYPES = new Set(['narration', 'dialogue', 'action', 'beat']);
const NARRATIVE_EVENT_TYPES = new Set(['narration', 'dialogue', 'action', 'beat']);
const NARRATIVE_ORIGIN = 'llm';
const NARRATIVE_SOURCE = 'runtime';

// Hard limits from ClickUp 08: a staged batch may carry 1..4 narrative
// items plus an OPTIONAL final tool call.
const MAX_NARRATIVE_ITEMS = 4;

// Idempotency-store bound. Per session we keep at most this many entries
// in `requestIds` / `turnRequests`; inserting beyond the bound evicts the
// OLDEST entry (Map insertion order). Semantic boundary (fail-closed):
// a request whose id has been evicted is no longer REPLAYED — the call is
// re-processed from scratch and must then pass the normal validation
// gauntlet (opening sequence, pending_id match, revision check). For
// commits / interrupts that gauntlet rejects stale replays, so an evicted
// id can never silently re-append content; callers get an error instead
// of a stale cached result.
const MAX_TRACKED_REQUESTS_PER_SESSION = 1000;

// Canonical session store bound. PR #7 only capped three auxiliary Maps
// (sessionPinnedMetadata, turnRequests-by-session, sessionMetrics); the
// canonical session store itself could still grow without limit. This
// demo-grade bound evicts the LEAST RECENTLY TOUCHED session when the
// store is full. Touch points (commitOpeningEvent, stageNarrativeBatch,
// commitNarrativeEvent, interruptWithPlayerInput, recoverSession,
// recordCompact) call `touchSession(...)` to refresh the LRU position;
// `createSession` also touches after insertion. The eviction drops
// history / pending / requestIds / turnRequests for the evicted session
// AND drops its entries from the cross-session uniqueness index so
// future replays are not silently prevented. Anonymous /api/dev traffic
// can therefore grow the canonical store up to this bound and no
// further; documented as a demo bound in docs/observability.md.
const MAX_CANONICAL_SESSIONS = 2000;

// Mirror of uq_session_events_client_request (db/schema.sql): the column
// is GLOBALLY unique across sessions, not per session. This registry maps
// client_request_id -> session_uuid for every id that produced a canonical
// event. Unlike the per-session replay maps it is a uniqueness index, not
// a cache — in the real DB its lifetime matches the table. In this
// in-memory demo the map is still bounded so anonymous API traffic cannot
// grow it without limit; evicting the oldest id shrinks the uniqueness
// window (callers then re-validate against the normal request gauntlet).
const MAX_TRACKED_CLIENT_REQUEST_IDS = 50000;
function repositoryState(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new Error('sessionService: repository required');
  }
  if (!repository[SESSION_STATE]) {
    Object.defineProperty(repository, SESSION_STATE, {
      value: { sessions: new Map(), clientRequestIndex: new Map() },
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
  return repository[SESSION_STATE];
}

// Public (read-only) access for cross-module helpers. Callers MUST NOT
// mutate the returned object.
export { repositoryState };

function assertUuid(label, value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`sessionService: ${label} must be a UUID`);
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function sessionFor(repository, session_uuid) {
  const session = repositoryState(repository).sessions.get(session_uuid);
  if (!session) throw new Error(`sessionService: unknown session '${session_uuid}'`);
  return session;
}

/**
 * Resolve a session AND refresh its LRU position. Use this on every
 * mutating and read-only access that means "the session is still
 * active" (route handlers, recovers, commits, interrupts, compact
 * touch). Throws the same `unknown session` error as sessionFor when
 * the session was evicted. Pairing every entry point with a touch
 * keeps eviction targeting the genuinely quiet sessions rather than a
 * session that just happens to have been inserted a long time ago.
 */
function sessionForActive(repository, session_uuid) {
  const session = sessionFor(repository, session_uuid);
  touchSessionRecord(session);
  return session;
}

function requiredString(label, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`sessionService: ${label} required`);
  }
}

function validateRevision(session, expected_revision) {
  if (expected_revision === undefined || expected_revision === null) return;
  if (!Number.isInteger(expected_revision)) {
    throw new Error('sessionService: expected_revision must be an integer');
  }
  if (expected_revision !== session.revision) {
    throw new Error(
      `sessionService: revision mismatch, expected ${expected_revision} but current is ${session.revision}`,
    );
  }
}

function requestId(value) {
  if (value === undefined || value === null) return null;
  requiredString('client_request_id', value);
  return value;
}

function requestFingerprint(kind, input) {
  return canonicalJsonStringify(kind === 'opening'
    ? { kind, event: input.event }
    : kind === 'stage'
      ? { kind, payload: input.payload }
      : kind === 'commit'
        ? { kind, pending_id: input.pending_id, sequence: input.sequence }
        : kind === 'interrupt'
          ? { kind, text: input.text }
          : { kind, ...input });
}

function idempotentResult(session, id, kind, input) {
  if (!id || !session.requestIds.has(id)) return null;
  const prior = session.requestIds.get(id);
  if (prior.kind !== kind || prior.fingerprint !== requestFingerprint(kind, input)) {
    throw new Error('sessionService: client_request_id was already used for a different request');
  }
  return clone(prior.result);
}

/**
 * Record a request result on the session's replay map with an LRU-style
 * insertion-order cap (see MAX_TRACKED_REQUESTS_PER_SESSION). Overwriting
 * an existing id keeps its original insertion position (Map semantics),
 * so eviction always removes the least recently INSERTED entry.
 */
function rememberRequest(session, id, entry) {
  if (!id) return;
  const map = session.requestIds;
  map.set(id, entry);
  while (map.size > MAX_TRACKED_REQUESTS_PER_SESSION) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

/**
 * Enforce the cross-session uniqueness of client_request_id on canonical
 * events (mirror of uq_session_events_client_request). Called from append()
 * — the only writer of canonical events — so a duplicate id used by a
 * DIFFERENT session fails closed exactly like the SQL unique key would.
 * Same-session replays never reach this path (they return earlier through
 * the idempotency lookup and do not append a second event).
 */
function registerCanonicalRequestId(state, session, clientRequestId) {
  if (!clientRequestId) return;
  if (!state.clientRequestIndex) state.clientRequestIndex = new Map();
  const owner = state.clientRequestIndex.get(clientRequestId);
  if (owner && owner !== session.session_uuid) {
    throw new Error(
      `sessionService: client_request_id '${clientRequestId}' was already committed by another session (${owner}) — uq_session_events_client_request is globally unique`,
    );
  }
  if (!state.clientRequestIndex.has(clientRequestId) && state.clientRequestIndex.size >= MAX_TRACKED_CLIENT_REQUEST_IDS) {
    const oldestKey = state.clientRequestIndex.keys().next().value;
    if (oldestKey !== undefined) state.clientRequestIndex.delete(oldestKey);
  }
  state.clientRequestIndex.set(clientRequestId, session.session_uuid);
}

function getPinnedVersion(repository, story_uuid, story_version_uuid) {
  const version = repository.findVersion(story_version_uuid);
  if (!version) throw new Error('sessionService: unknown story_version');
  if (version.story_uuid !== story_uuid) {
    throw new Error('sessionService: story_uuid does not match story_version');
  }
  return version;
}

function validateProfile(profile, story_uuid, story_version_uuid, cache) {
  if (!profile || typeof profile !== 'object') {
    throw new Error('createSession: generation_profile required');
  }
  for (const [key, value] of Object.entries({ identifier: profile.identifier, rules_version: profile.rules_version })) {
    requiredString(`generation_profile.${key}`, value);
  }
  if (profile.story_uuid !== undefined && profile.story_uuid !== story_uuid) {
    throw new Error('sessionService: generation_profile story_uuid mismatch');
  }
  if (profile.story_version_uuid !== undefined && profile.story_version_uuid !== story_version_uuid) {
    throw new Error('sessionService: generation_profile story_version_uuid mismatch');
  }
  if (profile.cache_uuid !== undefined && profile.cache_uuid !== cache.cache_uuid) {
    throw new Error('sessionService: generation_profile cache_uuid mismatch');
  }
  if (profile.generation_hash !== undefined && profile.generation_hash !== cache.generation_hash) {
    throw new Error('sessionService: generation_profile hash mismatch');
  }
  const cacheProfile = cache.generation_profile || {};
  for (const key of ['identifier', 'rules_version', 'locale', 'variant']) {
    const expected = cacheProfile[key] === undefined && key === 'locale' ? 'zh-CN'
      : cacheProfile[key] === undefined && key === 'variant' ? 'default'
        : cacheProfile[key];
    const actual = profile[key] === undefined && key === 'locale' ? 'zh-CN'
      : profile[key] === undefined && key === 'variant' ? 'default'
        : profile[key];
    if (actual !== expected) throw new Error(`sessionService: generation_profile.${key} does not match pinned cache`);
  }
}

function validatePinnedCache(cache, story_uuid, story_version_uuid) {
  if (!cache || cache.status !== 'valid') throw new Error('sessionService: pinned cache must be valid');
  if (cache.story_uuid !== story_uuid || cache.story_version_uuid !== story_version_uuid) {
    throw new Error('sessionService: cache does not match pinned story/version');
  }
  const payload = cache.content_payload;
  const events = payload && payload.events;
  if (!payload || !Array.isArray(events) || !Number.isInteger(payload.event_count) || payload.event_count !== events.length) {
    throw new Error('sessionService: pinned cache event payload is invalid');
  }
  return events;
}

function normalizeCacheEvent(event, pinned, cache_uuid, session_uuid) {
  if (!event || typeof event !== 'object') throw new Error('commitOpeningEvent: event required');
  if (event.displayed !== true && event.explicitly_displayed !== true) {
    throw new Error('commitOpeningEvent: event must be explicitly displayed');
  }
  if (!Number.isInteger(event.sequence)) {
    throw new Error('commitOpeningEvent: event.sequence must be an integer');
  }
  if (event.type === 'ask_player_choice' || event.event_type === 'ask_player_choice') {
    throw new Error('commitOpeningEvent: ask_player_choice events are not allowed in canonical history');
  }
  const eventType = event.type || event.event_type;
  if (!CACHE_EVENT_TYPES.has(eventType)) {
    throw new Error('commitOpeningEvent: event.type is not a cache event type');
  }
  const payload = event.payload && typeof event.payload === 'object'
    ? event.payload
    : { type: eventType, ...(event.text === undefined ? {} : { text: event.text }), ...(event.speaker === undefined ? {} : { speaker: event.speaker }) };
  if (!pinned || pinned.sequence !== event.sequence || pinned.type !== eventType) {
    throw new Error('commitOpeningEvent: event does not belong to pinned cache');
  }
  const expectedPayload = { ...pinned };
  delete expectedPayload.sequence;
  if (canonicalJsonStringify(payload) !== canonicalJsonStringify(expectedPayload)) {
    throw new Error('commitOpeningEvent: event payload does not match pinned cache');
  }
  return {
    event_id: randomUUID(),
    event_type: 'story_opening',
    origin: 'imported',
    source: 'opening_cache',
    source_sequence: event.sequence,
    payload: clone(expectedPayload),
    occurred_at: typeof event.occurred_at === 'string' ? event.occurred_at : nowIso(),
  };
}

function append(state, session, canonical, clientRequestId = null) {
  registerCanonicalRequestId(state, session, clientRequestId);
  const eventSeq = session.history.length + 1;
  const committed = {
    ...canonical,
    event_seq: eventSeq,
    prev_event_seq: eventSeq === 1 ? null : eventSeq - 1,
    client_request_id: clientRequestId,
    created_at: nowIso(),
  };
  committed.hash = canonicalSha256({
    event_id: committed.event_id,
    event_seq: committed.event_seq,
    prev_event_seq: committed.prev_event_seq,
    event_type: committed.event_type,
    origin: committed.origin,
    source: committed.source,
    source_sequence: committed.source_sequence,
    payload: committed.payload,
    occurred_at: committed.occurred_at,
    client_request_id: committed.client_request_id,
  });
  session.history.push(committed);
  // Every committed canonical event advances the canonical cursor by 1:
  // cursor === revision === max(event_seq) === history.length. This is the
  // ClickUp 08 P1.1 invariant — the opening playback position is tracked
  // separately in session.opening_cursor.
  session.cursor += 1;
  session.revision += 1;
  return committed;
}

/**
 * Next source_sequence for a (session, source) pair. Per-source counters
 * are 0-based, contiguous, and monotonic — they never reset between
 * batches. The counter is seeded from canonical history on first use so
 * a session object rebuilt from persisted history (future DAO) derives
 * the same next value without extra state.
 */
function nextSourceSequence(session, source) {
  if (!session.sourceSeq.has(source)) {
    let count = 0;
    for (const event of session.history) {
      if (event.source === source) count += 1;
    }
    session.sourceSeq.set(source, count);
  }
  const next = session.sourceSeq.get(source);
  session.sourceSeq.set(source, next + 1);
  return next;
}

function publicSession(session, includeHistory = false) {
  const result = {
    session_uuid: session.session_uuid,
    story_uuid: session.story_uuid,
    story_version_uuid: session.story_version_uuid,
    story_version_checksum: session.story_version_checksum,
    cache_uuid: session.cache_uuid,
    opening_cache_status: session.opening_cache_status,
    generation_profile: clone(session.generation_profile),
    user_ref: session.user_ref,
    role_id: session.role_id,
    model: session.model,
    prompt: session.prompt,
    state: session.state,
    cursor: session.cursor,
    opening_cursor: session.opening_cursor,
    revision: session.revision,
  };
  if (includeHistory) result.history = clone(session.history);
  return result;
}

function publicPending(pending) {
  if (!pending) return null;
  return {
    pending_id: pending.pending_id,
    events: clone(pending.events),
    tool_call: pending.tool_call ? clone(pending.tool_call) : null,
    committed_count: pending.committed_count,
    source: pending.source,
    produced_at: pending.produced_at,
    revision_at_stage: pending.revision_at_stage,
    request_id: pending.request_id || null,
  };
}

function ensurePendingShape(pending) {
  if (!pending || typeof pending !== 'object') return null;
  return {
    pending_id: pending.pending_id,
    events: Array.isArray(pending.events) ? pending.events.slice() : [],
    tool_call: pending.tool_call || null,
    committed_count: Number.isInteger(pending.committed_count) ? pending.committed_count : 0,
    source: pending.source || NARRATIVE_SOURCE,
    produced_at: pending.produced_at || nowIso(),
    revision_at_stage: Number.isInteger(pending.revision_at_stage) ? pending.revision_at_stage : 0,
    request_id: pending.request_id || null,
  };
}

function publicCompact(session) {
  return {
    context_compact_text: typeof session.context_compact_text === 'string' ? session.context_compact_text : null,
    context_compact_payload: session.context_compact_payload ? clone(session.context_compact_payload) : null,
    compacted_through_seq: Number.isInteger(session.compacted_through_seq) ? session.compacted_through_seq : null,
    compacted_event_count: Number.isInteger(session.compacted_event_count) ? session.compacted_event_count : null,
    token_estimate: Number.isInteger(session.token_estimate) ? session.token_estimate : null,
    context_window: Number.isInteger(session.context_window) ? session.context_window : null,
    context_safety_ratio: typeof session.context_safety_ratio === 'number' ? session.context_safety_ratio : null,
    reserved_completion_tokens: Number.isInteger(session.reserved_completion_tokens) ? session.reserved_completion_tokens : null,
    context_schema_version: Number.isInteger(session.context_schema_version) ? session.context_schema_version : null,
    prompt_version: Number.isInteger(session.prompt_version) ? session.prompt_version : null,
    last_compact_at: typeof session.last_compact_at === 'string' ? session.last_compact_at : null,
    last_compact_attempt_at: typeof session.last_compact_attempt_at === 'string' ? session.last_compact_attempt_at : null,
    last_compact_status: session.last_compact_status || 'idle',
    last_compact_error: typeof session.last_compact_error === 'string' ? session.last_compact_error : null,
  };
}

export function createSession({ repository, session_uuid, story_uuid, story_version_uuid, user_ref, role_id, model, prompt, generation_profile }) {
  if (!repository) throw new Error('createSession: repository required');
  assertUuid('session_uuid', session_uuid);
  assertUuid('story_uuid', story_uuid);
  assertUuid('story_version_uuid', story_version_uuid);
  requiredString('user_ref', user_ref);
  requiredString('role_id', role_id);
  requiredString('model', model);
  if (typeof prompt !== 'string') throw new Error('createSession: prompt required');
  const version = getPinnedVersion(repository, story_uuid, story_version_uuid);
  const roles = Array.isArray(version.roles_payload) ? version.roles_payload : [];
  if (!roles.some((role) => role && role.id === role_id)) {
    throw new Error(`sessionService: role_id '${role_id}' is not present in pinned version`);
  }
  if (!generation_profile || typeof generation_profile !== 'object') {
    throw new Error('createSession: generation_profile required');
  }
  const cache = repository.findOpeningCacheByUuid(generation_profile.cache_uuid);
  validatePinnedCache(cache, story_uuid, story_version_uuid);
  validateProfile(generation_profile, story_uuid, story_version_uuid, cache);
  const state = repositoryState(repository);
  if (state.sessions.has(session_uuid)) throw new Error('createSession: session already exists');
  const session = {
    session_uuid,
    story_uuid,
    story_version_uuid,
    story_version_checksum: version.checksum,
    cache_uuid: cache.cache_uuid,
    opening_cache_status: cache.status,
    generation_profile: clone(generation_profile),
    user_ref,
    role_id,
    model,
    prompt,
    state: cache.content_payload && cache.content_payload.event_count === 0 ? 'awaiting_first_choice' : 'opening',
    cursor: 0,
    opening_cursor: 0,
    revision: 0,
    history: [],
    pending: null,
    requestIds: new Map(),
    turnRequests: new Map(),
    sourceSeq: new Map(),
    // ClickUp 11 ending page: direct reference to the terminal finish_story
    // envelope set by the FINAL narrative commit (see commitNarrativeEvent).
    // Null until the story finishes; never cleared afterwards.
    finish_envelope: null,
    // ClickUp 10 compact state. See DEPENDENCY NOTE at top of file.
    context_compact_text: null,
    context_compact_payload: null,
    compacted_through_seq: null,
    compacted_event_count: null,
    token_estimate: null,
    context_window: null,
    context_safety_ratio: null,
    reserved_completion_tokens: null,
    context_schema_version: null,
    prompt_version: null,
    last_compact_at: null,
    last_compact_attempt_at: null,
    last_compact_status: 'idle',
    last_compact_error: null,
    compact_history: [], // append-only list of compact_attempt records (audit)
  };
  // Evict the least-recently-touched session if the canonical store is
  // full. Eviction drops ALL per-session state including history and
  // pending batch, AND the session's entries in the cross-session
  // uniqueness index (see registerCanonicalRequestId / the eviction
  // helper below). createSession is the only insertion point for the
  // canonical store, so bounding here keeps the entire demo memory
  // budget predictable (this is the H1 follow-up to PR #7).
  if (state.sessions.size >= MAX_CANONICAL_SESSIONS) {
    evictOldestSession(state);
  }
  state.sessions.set(session_uuid, session);
  session.lastTouchedAt = nowIso();
  return publicSession(session);
}

/**
 * Drop the least-recently-touched session from the canonical store.
 * Eviction is a hard cut: history / pending / per-session request maps
 * are gone, and every entry the session contributed to the cross-session
 * clientRequestIndex is removed so a future replay of a freed id will
 * pass the uniqueness check (rather than being permanently blocked).
 */
function evictOldestSession(state) {
  let oldestUuid = null;
  let oldestAt = null;
  for (const [uuid, session] of state.sessions.entries()) {
    const touched = typeof session.lastTouchedAt === 'string' ? session.lastTouchedAt : null;
    // Sessions inserted without lastTouchedAt (legacy code path or
    // rehydrated state) sort first by insertion order, so they are the
    // natural eviction target.
    if (oldestUuid === null || (touched === null) || (oldestAt !== null && touched < oldestAt)) {
      oldestUuid = uuid;
      oldestAt = touched;
    }
  }
  if (oldestUuid === null) return;
  evictSession(state, oldestUuid);
}

function evictSession(state, session_uuid) {
  state.sessions.delete(session_uuid);
  if (state.clientRequestIndex && state.clientRequestIndex.size > 0) {
    for (const [id, owner] of state.clientRequestIndex.entries()) {
      if (owner === session_uuid) state.clientRequestIndex.delete(id);
    }
  }
}

/**
 * Refresh the session's LRU position so eviction targets the least
 * recently ACTIVE session, not just the oldest inserted one. A long-lived
 * busy session must not be evicted by a burst of new sessions.
 */
function touchSessionRecord(session) {
  session.lastTouchedAt = nowIso();
}

export function commitOpeningEvent({ repository, session_uuid, cache_uuid, event, client_request_id, expected_revision }) {
  if (!repository) throw new Error('commitOpeningEvent: repository required');
  assertUuid('session_uuid', session_uuid);
  assertUuid('cache_uuid', cache_uuid);
  const session = sessionForActive(repository, session_uuid);
  if (session.cache_uuid !== cache_uuid) throw new Error('commitOpeningEvent: cache_uuid does not match session cache');
  const id = requestId(client_request_id);
  const prior = idempotentResult(session, id, 'opening', { event });
  if (prior) return prior;
  validateRevision(session, expected_revision);
  if (session.state !== 'opening') throw new Error('commitOpeningEvent: session is not in opening state');
  if (!Number.isInteger(event && event.sequence)) throw new Error('commitOpeningEvent: event.sequence must be an integer');
  // Opening order is enforced against the OPENING cursor (the number of
  // opening events already displayed), not the canonical cursor.
  if (event.sequence !== session.opening_cursor) throw new Error(`commitOpeningEvent: event.sequence must equal opening cursor ${session.opening_cursor}`);
  const cache = repository.findOpeningCacheByUuid(session.cache_uuid);
  if (!cache || cache.status !== 'valid') throw new Error('commitOpeningEvent: pinned cache is no longer valid');
  const pinned = validatePinnedCache(cache, session.story_uuid, session.story_version_uuid)
    .find((candidate) => candidate && candidate.sequence === event.sequence);
  const canonical = normalizeCacheEvent(event, pinned, cache_uuid, session.session_uuid);
  const committed = append(repositoryState(repository), session, canonical, id);
  session.opening_cursor += 1;
  if (session.opening_cursor >= cache.content_payload.event_count) session.state = 'awaiting_first_choice';
  const result = { session_uuid, cache_uuid, event: clone(committed), cursor: session.cursor, opening_cursor: session.opening_cursor, revision: session.revision, state: session.state };
  if (id) rememberRequest(session, id, { kind: 'opening', fingerprint: requestFingerprint('opening', { event }), result });
  return clone(result);
}

/**
 * Stage a speculative narrative batch on a session. The batch MUST satisfy:
 *   * 1..4 narrative items (narration / dialogue / action / beat), each with
 *     a sequence 0..N-1 in order;
 *   * an OPTIONAL final tool call (kind=choice_required | story_finished);
 *   * the session must be in opening / awaiting_first_choice / realtime;
 *   * any existing pending batch is REPLACED (the runtime is expected to
 *     either re-stage after advancing revision or accept that the previous
 *     batch is gone). Replacing is intentional — a duplicate or stale
 *     stage must not silently keep dropped content alive.
 *
 * The batch never touches canonical history. Its events keep their
 * sequence numbers as staged; canonical event_seq is allocated only at
 * commit time.
 */
export function stageNarrativeBatch({ repository, session_uuid, items, tool_call, source, expected_revision, client_request_id }) {
  if (!repository) throw new Error('stageNarrativeBatch: repository required');
  const hasToolCall = tool_call !== undefined && tool_call !== null;
  const normalizedSource = typeof source === 'string' && source ? source : NARRATIVE_SOURCE;
  if (!Array.isArray(items)) {
    throw new Error('stageNarrativeBatch: items must be an array');
  }
  if (items.length === 0) {
    if (hasToolCall) {
      throw new Error('stageNarrativeBatch: at least one narrative item is required; tool-only batches are not allowed');
    }
    throw new Error('stageNarrativeBatch: at least one narrative item or a tool_call is required');
  }
  if (items.length > MAX_NARRATIVE_ITEMS) {
    throw new Error(`stageNarrativeBatch: items must contain at most ${MAX_NARRATIVE_ITEMS} narrative items`);
  }
  if (hasToolCall && (typeof tool_call !== 'object' || Array.isArray(tool_call))) {
    throw new Error('stageNarrativeBatch: tool_call must be an object when present');
  }
  const normalized = items.map((event, index) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new Error(`stageNarrativeBatch: items[${index}] must be an object`);
    }
    if (event.sequence !== undefined && event.sequence !== index) {
      throw new Error(`stageNarrativeBatch: items[${index}].sequence must equal ${index}`);
    }
    const eventType = event.type || event.event_type;
    if (!NARRATIVE_EVENT_TYPES.has(eventType)) {
      throw new Error(
        `stageNarrativeBatch: items[${index}].type must be one of ${[...NARRATIVE_EVENT_TYPES].join(',')}`,
      );
    }
    if (typeof event.text !== 'string' || event.text.length === 0) {
      throw new Error(`stageNarrativeBatch: items[${index}].text must be a non-empty string`);
    }
    if (event.speaker !== undefined && typeof event.speaker !== 'string') {
      throw new Error(`stageNarrativeBatch: items[${index}].speaker must be a string when present`);
    }
    return {
      type: eventType,
      sequence: index,
      text: event.text,
      ...(event.speaker !== undefined ? { speaker: event.speaker } : {}),
    };
  });
  const session = sessionForActive(repository, session_uuid);
  const id = requestId(client_request_id);
  const stageFingerprintInput = { payload: { items: normalized, tool_call: tool_call || null, source: normalizedSource } };
  if (id) {
    const prior = idempotentResult(session, id, 'stage', stageFingerprintInput);
    if (prior) return prior;
  }
  validateRevision(session, expected_revision);
  if (session.state !== 'opening' && session.state !== 'awaiting_first_choice' && session.state !== 'realtime') {
    throw new Error(`stageNarrativeBatch: session is not accepting narrative batches (state=${session.state})`);
  }
  // Active-pending concurrency guard (ClickUp 08 P1.2): if there is an
  // unconsumed pending batch (some items committed, but the final commit
  // has not landed), a fresh stage MUST NOT silently overwrite it. The
  // payload either matches the active pending (idempotent return) or it
  // is rejected. The only escape hatches for the caller are
  //   * commitNarrativeEvent to drain the active batch, or
  //   * interruptWithPlayerInput / discardPendingTail to drop it.
  // The same rule applies whether or not the caller supplied a
  // client_request_id: payload equality is the contract, not the request
  // id. A late-arriving provider with a different result for the same
  // logical request therefore fails closed instead of corrupting the
  // active pending.
  if (session.pending) {
    const active = session.pending;
    const samePayload = canonicalJsonStringify(stageFingerprintInput.payload)
      === canonicalJsonStringify({
        items: active.events.map((event) => ({
          type: event.type,
          sequence: event.sequence,
          text: event.text,
          ...(event.speaker !== undefined ? { speaker: event.speaker } : {}),
        })),
        tool_call: active.tool_call || null,
        source: active.source,
      });
    if (samePayload) {
      // Idempotent re-stage: surface the existing pending snapshot
      // instead of mutating it. The committed_count, produced_at, and
      // pending_id stay stable.
      return {
        session_uuid,
        pending_id: active.pending_id,
        events: clone(active.events),
        tool_call: active.tool_call ? clone(active.tool_call) : null,
        committed_count: active.committed_count,
        source: active.source,
        produced_at: active.produced_at,
        cursor: session.cursor,
        opening_cursor: session.opening_cursor,
        revision: session.revision,
        state: session.state,
      };
    }
    throw new Error(
      `stageNarrativeBatch: session already has an unconsumed pending batch (pending_id=${active.pending_id}, committed=${active.committed_count}/${active.events.length}); commit, interrupt, or discard it before staging a different batch`,
    );
  }
  const pending_id = randomUUID();
  const pending = {
    pending_id,
    events: clone(normalized),
    tool_call: tool_call ? clone(tool_call) : null,
    committed_count: 0,
    source: normalizedSource,
    produced_at: nowIso(),
    revision_at_stage: session.revision,
    request_id: id || null,
  };
  session.pending = pending;
  const result = {
    session_uuid,
    pending_id,
    events: clone(pending.events),
    tool_call: pending.tool_call ? clone(pending.tool_call) : null,
    committed_count: 0,
    source: pending.source,
    produced_at: pending.produced_at,
    cursor: session.cursor,
    opening_cursor: session.opening_cursor,
    revision: session.revision,
    state: session.state,
  };
  if (id) {
    rememberRequest(session, id, {
      kind: 'stage',
      fingerprint: requestFingerprint('stage', { payload: { items: normalized, tool_call: tool_call || null, source: pending.source } }),
      result,
    });
  }
  return clone(result);
}

/**
 * Commit exactly ONE displayed narrative event from the active pending
 * batch. The committed event is appended to canonical history with the
 * next event_seq; revision advances by 1.
 *
 * Strict invariants (fail closed):
 *   - session exists
 *   - pending matches session.pending.pending_id
 *   - sequence equals pending.committed_count (next un-committed index)
 *   - expected_revision equals session.revision
 *   - client_request_id (when present) replays identical calls and rejects
 *     different payloads under the same id.
 *
 * The optional final tool call is NEVER committed as a narrative event.
 * The application surfaces it to the player separately (it is part of
 * the staged batch but is not part of session.history). The result of the
 * FINAL commit exposes the staged tool_call under pending_tool_call so
 * callers can render it.
 */
export function commitNarrativeEvent({ repository, session_uuid, pending_id, sequence, expected_revision, client_request_id }) {
  if (!repository) throw new Error('commitNarrativeEvent: repository required');
  assertUuid('pending_id', pending_id);
  if (!Number.isInteger(sequence)) {
    throw new Error('commitNarrativeEvent: sequence must be an integer');
  }
  if (!Number.isInteger(expected_revision)) {
    throw new Error('commitNarrativeEvent: expected_revision must be an integer');
  }
  const session = sessionForActive(repository, session_uuid);
  const id = requestId(client_request_id);
  // Idempotency lookup comes FIRST: after the final commit clears
  // session.pending, a replay of that same commit must still return the
  // original result instead of failing the pending_id check (ClickUp 08
  // P1.5 final-commit idempotency). A reused id with a different
  // pending_id/sequence still fails closed via the fingerprint.
  if (id) {
    const prior = idempotentResult(session, id, 'commit', { pending_id, sequence });
    if (prior) return prior;
  }
  if (!session.pending || session.pending.pending_id !== pending_id) {
    throw new Error('commitNarrativeEvent: pending_id does not match the active pending batch');
  }
  const staged = session.pending.events[sequence];
  if (!staged) {
    throw new Error(
      `commitNarrativeEvent: sequence ${sequence} is out of range (batch has ${session.pending.events.length} items)`,
    );
  }
  if (sequence !== session.pending.committed_count) {
    throw new Error(
      `commitNarrativeEvent: sequence must equal pending.committed_count (${session.pending.committed_count}); out-of-order commits fail closed`,
    );
  }
  const current = session.revision;
  if (expected_revision !== current) {
    throw new Error(
      `commitNarrativeEvent: revision mismatch, expected ${expected_revision} but current is ${current}`,
    );
  }
  const canonical = append(repositoryState(repository), session, {
    event_id: randomUUID(),
    event_type: 'narrative_beat',
    origin: NARRATIVE_ORIGIN,
    source: session.pending.source,
    source_sequence: nextSourceSequence(session, session.pending.source),
    payload: clone(staged),
    occurred_at: nowIso(),
  }, id);
  session.pending.committed_count += 1;
  const totalCommitted = session.pending.committed_count;
  const totalEvents = session.pending.events.length;
  const cleared = totalCommitted >= totalEvents;
  const toolCallSurface = cleared ? clone(session.pending.tool_call) : null;
  if (cleared && toolCallSurface && toolCallSurface.name === 'finish_story') {
    // Keep a DIRECT reference to the terminal envelope on the session
    // (ClickUp 11 ending page). session.pending is cleared right after the
    // final commit, and callers that omit client_request_id leave no trace
    // in the idempotency map — without this reference the finish_story
    // envelope would be unreachable and GET /ending would 404 forever.
    // Only finish_story (the terminal tool) writes it, so a later
    // ask_player_choice batch can never clobber a finished story.
    session.finish_envelope = {
      tool_call: toolCallSurface,
      pending_id,
      committed_event_seq: canonical.event_seq,
      revision: session.revision,
      committed_at: nowIso(),
    };
  }
  if (cleared) session.pending = null;
  const result = {
    session_uuid,
    pending_id,
    event: clone(canonical),
    cursor: session.cursor,
    opening_cursor: session.opening_cursor,
    revision: session.revision,
    state: session.state,
    pending_committed_count: totalCommitted,
    pending_remaining: cleared ? 0 : totalEvents - totalCommitted,
    pending_tool_call: toolCallSurface,
  };
  if (id) {
    rememberRequest(session, id, {
      kind: 'commit',
      fingerprint: requestFingerprint('commit', { pending_id, sequence }),
      result,
    });
  }
  return clone(result);
}

/**
 * Player interrupts the session. Atomically:
 *   - discards the speculative pending tail (no canonical events added);
 *   - appends the player_input as a new canonical event;
 *   - switches state to 'realtime'.
 * After this call, the session has NO active pending batch.
 */
export function interruptWithPlayerInput({ repository, session_uuid, text, client_request_id, expected_revision }) {
  if (!repository) throw new Error('interruptWithPlayerInput: repository required');
  assertUuid('session_uuid', session_uuid);
  const session = sessionForActive(repository, session_uuid);
  const id = requestId(client_request_id);
  const prior = idempotentResult(session, id, 'interrupt', { text });
  if (prior) return prior;
  validateRevision(session, expected_revision);
  // ClickUp 09 acceptance criterion: "用户在任意普通消息之间都能打断".
  // Opening, awaiting_first_choice, and realtime are all interruptible.
  // stageNarrativeBatch already accepts all three; mirrors it here so the
  // input bar is never silently swallowed mid-narration.
  if (session.state !== 'opening' && session.state !== 'awaiting_first_choice' && session.state !== 'realtime') {
    throw new Error('interruptWithPlayerInput: session is not interruptible');
  }
  requiredString('text', text);
  // Discard speculative pending tail. If the runtime kept an un-displayed
  // tool call, it is dropped with the rest of the tail and never reaches
  // canonical history.
  const dropped = session.pending;
  session.pending = null;
  const canonical = append(repositoryState(repository), session, {
    event_id: randomUUID(),
    event_type: 'player_input',
    origin: 'user',
    source: 'player',
    source_sequence: nextSourceSequence(session, 'player'),
    payload: { text },
    occurred_at: nowIso(),
  }, id);
  session.state = 'realtime';
  const result = {
    session_uuid,
    cache_uuid: session.cache_uuid,
    event: clone(canonical),
    cursor: session.cursor,
    opening_cursor: session.opening_cursor,
    revision: session.revision,
    state: session.state,
    dropped_pending_id: dropped ? dropped.pending_id : null,
    dropped_pending_count: dropped ? dropped.events.length - dropped.committed_count : 0,
  };
  if (id) rememberRequest(session, id, { kind: 'interrupt', fingerprint: requestFingerprint('interrupt', { text }), result });
  return clone(result);
}

/**
 * Session-owned turn-level idempotency store (ClickUp 08 P1.5 HTTP
 * cross-request idempotency). The HTTP layer creates a fresh runtime per
 * request, so request_id dedup MUST live on the session, not on a
 * transient runtime instance. The runtime registers the full turn result
 * (turn_id / items / tool envelope / pending_id) here after a successful
 * stage; a later request with the same request_id + input + revision
 * replays that exact result without calling the provider again.
 */
export function lookupTurnRequest({ repository, session_uuid, request_id }) {
  if (!repository) throw new Error('lookupTurnRequest: repository required');
  assertUuid('session_uuid', session_uuid);
  if (typeof request_id !== 'string' || request_id.length === 0) {
    throw new Error('lookupTurnRequest: request_id must be a non-empty string');
  }
  const prior = sessionForActive(repository, session_uuid).turnRequests.get(request_id);
  return prior ? { fingerprint: prior.fingerprint, result: clone(prior.result) } : null;
}

/**
 * Register (or replay) a turn-level request result on the session. A
 * reused request_id with the SAME fingerprint replays the prior result; a
 * reused request_id with a DIFFERENT fingerprint fails closed.
 *
 * The store is bounded (see MAX_TRACKED_REQUESTS_PER_SESSION): inserting
 * beyond the cap evicts the oldest request_id. Beyond the window a turn is
 * no longer replayed — it is re-processed from scratch (fail-closed: the
 * normal revision / pending validation applies to the re-run).
 */
export function registerTurnRequest({ repository, session_uuid, request_id, fingerprint, result }) {
  if (!repository) throw new Error('registerTurnRequest: repository required');
  assertUuid('session_uuid', session_uuid);
  if (typeof request_id !== 'string' || request_id.length === 0) {
    throw new Error('registerTurnRequest: request_id must be a non-empty string');
  }
  const session = sessionForActive(repository, session_uuid);
  const prior = session.turnRequests.get(request_id);
  if (prior) {
    if (prior.fingerprint !== fingerprint) {
      throw new Error('sessionService: request_id was already used for a different request');
    }
    return clone(prior.result);
  }
  session.turnRequests.set(request_id, { fingerprint, result: clone(result) });
  while (session.turnRequests.size > MAX_TRACKED_REQUESTS_PER_SESSION) {
    const oldest = session.turnRequests.keys().next().value;
    session.turnRequests.delete(oldest);
  }
  return clone(result);
}

/**
 * Discard any speculative pending batch without committing.
 */
export function discardPendingTail({ repository, session_uuid }) {
  if (!repository) throw new Error('discardPendingTail: repository required');
  const session = sessionForActive(repository, session_uuid);
  const dropped = session.pending;
  session.pending = null;
  return {
    dropped_pending_id: dropped ? dropped.pending_id : null,
    dropped_pending_count: dropped ? dropped.events.length - dropped.committed_count : 0,
    state: session.state,
  };
}

export function getSession({ repository, session_uuid }) {
  if (!repository) throw new Error('getSession: repository required');
  assertUuid('session_uuid', session_uuid);
  return publicSession(sessionForActive(repository, session_uuid));
}

export function listSessionEvents({ repository, session_uuid }) {
  if (!repository) throw new Error('listSessionEvents: repository required');
  assertUuid('session_uuid', session_uuid);
  return clone(sessionForActive(repository, session_uuid).history);
}

/**
 * Read-only recovery. Returns the canonical session projection, the full
 * canonical history, and the active pending snapshot (if any). Never calls
 * the provider, never replays, never mutates state.
 *
 * ClickUp 08 P1.6 persistence boundary: the application-layer in-memory
 * repository (src/stories/repository.mjs) does NOT persist sessions
 * across process restarts, so `recoverSession` is only safe to call from
 * the SAME process that originally staged the session. It is NOT
 * cross-process recovery. A future MariaDB-backed DAO will replace the
 * in-memory map with the `game_sessions` table; until that DAO lands,
 * callers MUST NOT claim that the SQL migrations provide runtime
 * persistence — the migrations only pin the schema the future DAO will
 * write through. Tests and docs must not describe this as cross-process.
 */
export function recoverSession({ repository, session_uuid }) {
  if (!repository) throw new Error('recoverSession: repository required');
  assertUuid('session_uuid', session_uuid);
  const session = sessionForActive(repository, session_uuid);
  return {
    ...publicSession(session, true),
    pending: publicPending(ensurePendingShape(session.pending)),
  };
}

// ---------------------------------------------------------------------------
// ClickUp 10 — long-context compact
// ---------------------------------------------------------------------------
//
// The functions below mutate ONLY the compact state on the session object
// (context_compact_text, context_compact_payload, compacted_through_seq,
// token_estimate, etc.) and append a record to session.compact_history.
// They NEVER touch session.history (the canonical history mirror of
// session_events) and they NEVER touch any pending / speculative queue.
// The append-only contract on session_events is enforced by triggers in
// 0001; the in-memory mirror is treated identically here.
//
// All write functions return a deep-cloned snapshot of the new compact
// state so callers can chain on it without observing live mutation.

function requiredFiniteInt(label, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`sessionService: ${label} must be a non-negative integer`);
  }
  return value;
}

function positiveInt(label, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`sessionService: ${label} must be a positive integer`);
  }
  return value;
}

// Mirror of game_sessions.last_compact_error VARCHAR(500) (db/schema.sql).
const MAX_LAST_COMPACT_ERROR_LENGTH = 500;

function truncateCompactError(message) {
  return typeof message === 'string' ? message.slice(0, MAX_LAST_COMPACT_ERROR_LENGTH) : null;
}

function assertCompactInput({ summary_text, summary_payload, through_seq, folded_event_seqs, token_estimate, context_window, safety_ratio, reserved_completion_tokens, schema_version, prompt_version }, status = 'compacted') {
  // A 'skipped' attempt records that nothing new was foldable; there may be
  // no summary to persist (empty history or an already up-to-date compact),
  // so the summary fields are optional for that status only.
  const skipped = status === 'skipped';
  if ((!skipped || summary_text !== undefined) && (typeof summary_text !== 'string' || (!skipped && summary_text.length === 0))) {
    throw new Error('sessionService.recordCompact: summary_text required');
  }
  if ((!skipped || summary_payload !== undefined) && (!summary_payload || typeof summary_payload !== 'object')) {
    throw new Error('sessionService.recordCompact: summary_payload required');
  }
  requiredFiniteInt('through_seq', through_seq);
  if (!Array.isArray(folded_event_seqs) || !folded_event_seqs.every((seq) => Number.isInteger(seq) && seq >= 0)) {
    throw new Error('sessionService.recordCompact: folded_event_seqs must be an array of non-negative integers');
  }
  requiredFiniteInt('token_estimate', token_estimate);
  positiveInt('context_window', context_window);
  if (typeof safety_ratio !== 'number' || safety_ratio < 0 || safety_ratio >= 1) {
    throw new Error('sessionService.recordCompact: safety_ratio must be a number in [0, 1)');
  }
  requiredFiniteInt('reserved_completion_tokens', reserved_completion_tokens);
  requiredFiniteInt('schema_version', schema_version);
  requiredFiniteInt('prompt_version', prompt_version);
}

/**
 * Persist a compact result onto the session. The caller (typically the
 * agent runtime) provides the rendered summary, the structural payload,
 * the folded event_seq list, and the estimator snapshot.
 *
 * The function:
 *   - Verifies `through_seq` is strictly greater than the previously
 *     recorded `compacted_through_seq` (the monotonic invariant enforced by
 *     trg_game_sessions_compact_monotonic in db/schema.sql). A 'skipped'
 *     attempt is the one exception: it records "nothing new to fold" and
 *     may repeat the current cursor, but never move it backwards.
 *   - Replaces the compact snapshot in one logical step (status
 *     'compacted' only — 'skipped' / 'failed' attempts leave the previous
 *     compact snapshot intact).
 *   - Appends a record to `session.compact_history` (audit log).
 *   - Leaves `session.history` untouched.
 *   - Truncates `last_compact_error` to 500 chars, mirroring the
 *     VARCHAR(500) column in db/schema.sql.
 *
 * Returns a deep-cloned snapshot of the new compact state.
 *
 * @param {{ repository, session_uuid, attempt_uuid?: string, status?: 'compacted'|'skipped'|'failed', summary_text: string, summary_payload: object, through_seq: number, folded_event_seqs: number[], skipped_protected?: number, token_estimate: number, context_window: number, safety_ratio: number, reserved_completion_tokens: number, schema_version: number, prompt_version: number, occurred_at?: string, error_code?: string|null, error_message?: string|null }} args
 */
export function recordCompact(args) {
  if (!args || typeof args !== 'object') throw new Error('recordCompact: args required');
  if (!args.repository) throw new Error('recordCompact: repository required');
  assertUuid('session_uuid', args.session_uuid);
  const status = args.status === 'skipped' || args.status === 'failed' ? args.status : 'compacted';
  assertCompactInput(args, status);
  const session = sessionForActive(args.repository, args.session_uuid);
  if (Number.isInteger(session.compacted_through_seq)) {
    const strictlyGreaterRequired = status !== 'skipped';
    if (args.through_seq < session.compacted_through_seq
      || (strictlyGreaterRequired && args.through_seq === session.compacted_through_seq)) {
      throw new Error(`sessionService.recordCompact: through_seq must be strictly greater than current ${session.compacted_through_seq}`);
    }
  }
  const occurredAt = typeof args.occurred_at === 'string' ? args.occurred_at : nowIso();
  const attemptUuid = typeof args.attempt_uuid === 'string' && args.attempt_uuid.length > 0 ? args.attempt_uuid : randomUUID();
  const record = {
    attempt_uuid: attemptUuid,
    status,
    compacted_through_seq: args.through_seq,
    event_count: args.folded_event_seqs.length,
    skipped_protected: Number.isInteger(args.skipped_protected) ? args.skipped_protected : 0,
    estimated_tokens: args.token_estimate,
    context_window: args.context_window,
    prompt_version: args.prompt_version,
    context_schema_version: args.schema_version,
    error_code: typeof args.error_code === 'string' ? args.error_code : null,
    error_message: truncateCompactError(args.error_message),
    folded_event_seqs: clone(args.folded_event_seqs),
    summary_excerpt: typeof args.summary_text === 'string' ? args.summary_text.slice(0, 500) : null,
    created_at: occurredAt,
  };
  if (status === 'compacted') {
    session.context_compact_text = args.summary_text;
    session.context_compact_payload = clone(args.summary_payload);
    session.compacted_through_seq = args.through_seq;
    session.compacted_event_count = args.folded_event_seqs.length;
    session.token_estimate = args.token_estimate;
    session.context_window = args.context_window;
    session.context_safety_ratio = args.safety_ratio;
    session.reserved_completion_tokens = args.reserved_completion_tokens;
    session.context_schema_version = args.schema_version;
    session.prompt_version = args.prompt_version;
    session.last_compact_at = occurredAt;
  }
  session.last_compact_attempt_at = occurredAt;
  session.last_compact_status = status;
  session.last_compact_error = status === 'failed'
    ? truncateCompactError(
      typeof args.error_message === 'string'
        ? args.error_message
        : (typeof args.error_code === 'string' ? args.error_code : 'unknown'),
    )
    : null;
  if (!Array.isArray(session.compact_history)) session.compact_history = [];
  session.compact_history.push(record);
  return publicCompact(session);
}

/**
 * Mark the most recent compact attempt as failed WITHOUT advancing the
 * cursor. The previous compact state remains intact so the next request
 * can still use it. Returns the new public compact snapshot.
 */
export function recordCompactFailure(args) {
  if (!args || typeof args !== 'object') throw new Error('recordCompactFailure: args required');
  if (!args.repository) throw new Error('recordCompactFailure: repository required');
  assertUuid('session_uuid', args.session_uuid);
  const session = sessionForActive(args.repository, args.session_uuid);
  const occurredAt = typeof args.occurred_at === 'string' ? args.occurred_at : nowIso();
  const errorCode = typeof args.error_code === 'string' ? args.error_code : 'unknown';
  const errorMessage = typeof args.error_message === 'string' ? args.error_message : errorCode;
  const tokenEstimate = Number.isInteger(args.token_estimate) ? args.token_estimate : 0;
  const contextWindow = Number.isInteger(args.context_window) ? args.context_window : (session.context_window || 1);
  const record = {
    attempt_uuid: typeof args.attempt_uuid === 'string' && args.attempt_uuid.length > 0 ? args.attempt_uuid : randomUUID(),
    status: 'failed',
    compacted_through_seq: Number.isInteger(session.compacted_through_seq) ? session.compacted_through_seq : 0,
    event_count: 0,
    skipped_protected: 0,
    estimated_tokens: tokenEstimate,
    context_window: contextWindow,
    prompt_version: Number.isInteger(session.prompt_version) ? session.prompt_version : 1,
    context_schema_version: Number.isInteger(session.context_schema_version) ? session.context_schema_version : 1,
    error_code: errorCode,
    error_message: truncateCompactError(errorMessage),
    folded_event_seqs: [],
    summary_excerpt: null,
    created_at: occurredAt,
  };
  session.last_compact_attempt_at = occurredAt;
  session.last_compact_status = 'failed';
  session.last_compact_error = truncateCompactError(errorMessage);
  if (!Array.isArray(session.compact_history)) session.compact_history = [];
  session.compact_history.push(record);
  return publicCompact(session);
}

/**
 * Read-only snapshot of the current compact state.
 */
export function getSessionCompact({ repository, session_uuid }) {
  if (!repository) throw new Error('getSessionCompact: repository required');
  assertUuid('session_uuid', session_uuid);
  return publicCompact(sessionForActive(repository, session_uuid));
}

/**
 * Rebuild a compact from canonical history. Used when the operator wants
 * to force-recompute compact (e.g. after a schema_version bump or a prompt
 * upgrade). The provided builder is the same factory used by the runtime
 * (typically buildCompactSummary + renderCompactSummary from
 * src/agent/contextBuilder.mjs).
 *
 * Force-recompute contract: the builder ALWAYS receives the full canonical
 * prefix (every event before the recent verbatim tail), INCLUDING events
 * that a previous compact already folded. Rebuilding from only the
 * post-cursor delta would silently drop the facts captured by the previous
 * summary — the same loss the incremental assembleContext path guards
 * against by merging existing.summary_text.
 *
 * The function is read-only against session.history; it only writes a
 * fresh compact via recordCompact. If the rebuilt summary would not
 * strictly advance compacted_through_seq (e.g. nothing new to fold), it
 * records a 'skipped' attempt instead (last_compact_status='skipped'; the
 * previous compact snapshot stays intact) and returns it — it never throws
 * for the "nothing to do" case.
 *
 * @param {{ repository, session_uuid, builder: (events: object[]) => { summary_text: string, summary_payload: object, folded_event_seqs: number[] }, kept_recent?: number, estimator_snapshot?: { context_window: number, safety_ratio: number, reserved_completion_tokens: number, token_estimate: number, schema_version: number, prompt_version: number } }} args
 */
export function rebuildCompactFromHistory(args) {
  if (!args || typeof args !== 'object') throw new Error('rebuildCompactFromHistory: args required');
  if (!args.repository) throw new Error('rebuildCompactFromHistory: repository required');
  assertUuid('session_uuid', args.session_uuid);
  if (typeof args.builder !== 'function') {
    throw new Error('rebuildCompactFromHistory: builder function required');
  }
  const session = sessionForActive(args.repository, args.session_uuid);
  const history = session.history;
  const keptRecent = Number.isInteger(args.kept_recent) && args.kept_recent >= 0 ? args.kept_recent : 8;
  const tailStart = history.length > keptRecent ? history.length - keptRecent : history.length;
  // Full-history recompute: everything before the recent verbatim tail is
  // eligible, regardless of the current compact cursor.
  const prefix = history.filter((event) => Number.isInteger(event.event_seq) && event.event_seq > 0)
    .slice(0, tailStart);
  const already = Number.isInteger(session.compacted_through_seq) ? session.compacted_through_seq : 0;
  const estimatorSnapshot = args.estimator_snapshot || {};
  const skippedAttempt = (summaryText, summaryPayload) => recordCompact({
    repository: args.repository,
    session_uuid: args.session_uuid,
    status: 'skipped',
    summary_text: typeof summaryText === 'string' ? summaryText : (session.context_compact_text || ''),
    summary_payload: summaryPayload && typeof summaryPayload === 'object'
      ? summaryPayload
      : (session.context_compact_payload || {}),
    through_seq: already,
    folded_event_seqs: [],
    token_estimate: 0,
    context_window: Number.isInteger(estimatorSnapshot.context_window) && estimatorSnapshot.context_window > 0
      ? estimatorSnapshot.context_window
      : 1,
    safety_ratio: typeof estimatorSnapshot.safety_ratio === 'number' && estimatorSnapshot.safety_ratio >= 0 && estimatorSnapshot.safety_ratio < 1
      ? estimatorSnapshot.safety_ratio
      : 0,
    reserved_completion_tokens: Number.isInteger(estimatorSnapshot.reserved_completion_tokens) ? estimatorSnapshot.reserved_completion_tokens : 0,
    schema_version: Number.isInteger(estimatorSnapshot.schema_version) ? estimatorSnapshot.schema_version : 1,
    prompt_version: Number.isInteger(estimatorSnapshot.prompt_version) ? estimatorSnapshot.prompt_version : 1,
  });
  if (prefix.length === 0) {
    // Nothing foldable at all (empty history, or every event is inside the
    // recent verbatim tail): record the skipped attempt and return.
    return skippedAttempt();
  }
  const built = args.builder(prefix);
  if (!built || typeof built !== 'object') {
    throw new Error('rebuildCompactFromHistory: builder must return an object');
  }
  if (typeof built.summary_text !== 'string' || !built.summary_payload || typeof built.summary_payload !== 'object') {
    throw new Error('rebuildCompactFromHistory: builder must return summary_text + summary_payload');
  }
  if (!Array.isArray(built.folded_event_seqs)) {
    throw new Error('rebuildCompactFromHistory: builder must return folded_event_seqs');
  }
  const snapshot = estimatorSnapshot;
  const tokenEstimate = Number.isInteger(snapshot.token_estimate) ? snapshot.token_estimate : prefix.length;
  const contextWindow = Number.isInteger(snapshot.context_window) && snapshot.context_window > 0 ? snapshot.context_window : 1;
  const safetyRatio = typeof snapshot.safety_ratio === 'number' && snapshot.safety_ratio >= 0 && snapshot.safety_ratio < 1 ? snapshot.safety_ratio : 0;
  const reservedTokens = Number.isInteger(snapshot.reserved_completion_tokens) ? snapshot.reserved_completion_tokens : 0;
  const schemaVersion = Number.isInteger(snapshot.schema_version) ? snapshot.schema_version : 1;
  const promptVersion = Number.isInteger(snapshot.prompt_version) ? snapshot.prompt_version : 1;
  const lastSeq = built.folded_event_seqs[built.folded_event_seqs.length - 1];
  if (!Number.isInteger(lastSeq) || lastSeq <= already) {
    // The rebuilt summary does not strictly advance the compact cursor —
    // nothing new to fold. Record a skipped attempt (keeps the existing
    // compact intact) instead of failing the monotonic invariant.
    return skippedAttempt(built.summary_text, built.summary_payload);
  }
  return recordCompact({
    repository: args.repository,
    session_uuid: args.session_uuid,
    status: 'compacted',
    summary_text: built.summary_text,
    summary_payload: built.summary_payload,
    through_seq: lastSeq,
    folded_event_seqs: built.folded_event_seqs,
    token_estimate: tokenEstimate,
    context_window: contextWindow,
    safety_ratio: safetyRatio,
    reserved_completion_tokens: reservedTokens,
    schema_version: schemaVersion,
    prompt_version: promptVersion,
  });
}
