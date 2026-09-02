// Session-local opening playback state. The state is deliberately attached
// to each repository instance so independent repositories cannot share a
// session or accidentally observe one another's history.
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

function repositoryState(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new Error('sessionService: repository required');
  }
  if (!repository[SESSION_STATE]) {
    Object.defineProperty(repository, SESSION_STATE, {
      value: { sessions: new Map() },
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
  return repository[SESSION_STATE];
}

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
    : { kind, text: input.text });
}

function idempotentResult(session, id, kind, input) {
  if (!id || !session.requestIds.has(id)) return null;
  const prior = session.requestIds.get(id);
  if (prior.kind !== kind || prior.fingerprint !== requestFingerprint(kind, input)) {
    throw new Error('sessionService: client_request_id was already used for a different request');
  }
  return clone(prior.result);
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

function cacheEvents(cache) {
  const events = cache && cache.content_payload && cache.content_payload.events;
  if (!Array.isArray(events)) throw new Error('sessionService: pinned cache events required');
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

function append(session, canonical, advancesCursor, clientRequestId = null) {
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
  if (advancesCursor) session.cursor += 1;
  session.revision += 1;
  return committed;
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
    revision: session.revision,
  };
  if (includeHistory) result.history = clone(session.history);
  return result;
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
    revision: 0,
    history: [],
    requestIds: new Map(),
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
  state.sessions.set(session_uuid, session);
  return publicSession(session);
}

export function commitOpeningEvent({ repository, session_uuid, cache_uuid, event, client_request_id, expected_revision }) {
  if (!repository) throw new Error('commitOpeningEvent: repository required');
  assertUuid('session_uuid', session_uuid);
  assertUuid('cache_uuid', cache_uuid);
  const session = sessionFor(repository, session_uuid);
  if (session.cache_uuid !== cache_uuid) throw new Error('commitOpeningEvent: cache_uuid does not match session cache');
  const id = requestId(client_request_id);
  const prior = idempotentResult(session, id, 'opening', { event });
  if (prior) return prior;
  validateRevision(session, expected_revision);
  if (session.state !== 'opening') throw new Error('commitOpeningEvent: session is not in opening state');
  if (!Number.isInteger(event && event.sequence)) throw new Error('commitOpeningEvent: event.sequence must be an integer');
  if (event.sequence !== session.cursor) throw new Error(`commitOpeningEvent: event.sequence must equal cursor ${session.cursor}`);
  const cache = repository.findOpeningCacheByUuid(session.cache_uuid);
  if (!cache || cache.status !== 'valid') throw new Error('commitOpeningEvent: pinned cache is no longer valid');
  const pinned = validatePinnedCache(cache, session.story_uuid, session.story_version_uuid)
    .find((candidate) => candidate && candidate.sequence === event.sequence);
  const canonical = normalizeCacheEvent(event, pinned, cache_uuid, session.session_uuid);
  const committed = append(session, canonical, true, id);
  if (session.cursor >= cache.content_payload.event_count) session.state = 'awaiting_first_choice';
  const result = { session_uuid, cache_uuid, event: clone(committed), cursor: session.cursor, revision: session.revision, state: session.state };
  if (id) session.requestIds.set(id, { kind: 'opening', fingerprint: requestFingerprint('opening', { event }), result });
  return clone(result);
}

export function interruptWithPlayerInput({ repository, session_uuid, text, client_request_id, expected_revision }) {
  if (!repository) throw new Error('interruptWithPlayerInput: repository required');
  assertUuid('session_uuid', session_uuid);
  const session = sessionFor(repository, session_uuid);
  const id = requestId(client_request_id);
  const prior = idempotentResult(session, id, 'interrupt', { text });
  if (prior) return prior;
  validateRevision(session, expected_revision);
  if (session.state !== 'opening' && session.state !== 'awaiting_first_choice') {
    throw new Error('interruptWithPlayerInput: session is not interruptible');
  }
  requiredString('text', text);
  const sourceSequence = session.history.length + 1;
  const canonical = append(session, {
    event_id: randomUUID(),
    event_type: 'player_input',
    origin: 'user',
    source: 'player',
    source_sequence: sourceSequence,
    payload: { text },
    occurred_at: nowIso(),
  }, false, id);
  session.state = 'realtime';
  const result = { session_uuid, cache_uuid: session.cache_uuid, event: clone(canonical), cursor: session.cursor, revision: session.revision, state: session.state };
  if (id) session.requestIds.set(id, { kind: 'interrupt', fingerprint: requestFingerprint('interrupt', { text }), result });
  return clone(result);
}

export function getSession({ repository, session_uuid }) {
  if (!repository) throw new Error('getSession: repository required');
  assertUuid('session_uuid', session_uuid);
  return publicSession(sessionFor(repository, session_uuid));
}

export function listSessionEvents({ repository, session_uuid }) {
  if (!repository) throw new Error('listSessionEvents: repository required');
  assertUuid('session_uuid', session_uuid);
  return clone(sessionFor(repository, session_uuid).history);
}

export function recoverSession({ repository, session_uuid }) {
  if (!repository) throw new Error('recoverSession: repository required');
  assertUuid('session_uuid', session_uuid);
  return publicSession(sessionFor(repository, session_uuid), true);
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

function assertCompactInput({ summary_text, summary_payload, through_seq, folded_event_seqs, token_estimate, context_window, safety_ratio, reserved_completion_tokens, schema_version, prompt_version }) {
  if (typeof summary_text !== 'string' || summary_text.length === 0) {
    throw new Error('sessionService.recordCompact: summary_text required');
  }
  if (!summary_payload || typeof summary_payload !== 'object') {
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
 *     trg_game_sessions_compact_monotonic in db/schema.sql).
 *   - Replaces the compact snapshot in one logical step.
 *   - Appends a record to `session.compact_history` (audit log).
 *   - Leaves `session.history` untouched.
 *
 * Returns a deep-cloned snapshot of the new compact state.
 *
 * @param {{ repository, session_uuid, attempt_uuid?: string, status?: 'compacted'|'skipped'|'failed', summary_text: string, summary_payload: object, through_seq: number, folded_event_seqs: number[], skipped_protected?: number, token_estimate: number, context_window: number, safety_ratio: number, reserved_completion_tokens: number, schema_version: number, prompt_version: number, occurred_at?: string, error_code?: string|null, error_message?: string|null }} args
 */
export function recordCompact(args) {
  if (!args || typeof args !== 'object') throw new Error('recordCompact: args required');
  if (!args.repository) throw new Error('recordCompact: repository required');
  assertUuid('session_uuid', args.session_uuid);
  assertCompactInput(args);
  const session = sessionFor(args.repository, args.session_uuid);
  if (Number.isInteger(session.compacted_through_seq) && args.through_seq <= session.compacted_through_seq) {
    throw new Error(`sessionService.recordCompact: through_seq must be strictly greater than current ${session.compacted_through_seq}`);
  }
  const status = args.status === 'skipped' || args.status === 'failed' ? args.status : 'compacted';
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
    error_message: typeof args.error_message === 'string' ? args.error_message : null,
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
    ? (typeof args.error_message === 'string' ? args.error_message : (typeof args.error_code === 'string' ? args.error_code : 'unknown'))
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
  const session = sessionFor(args.repository, args.session_uuid);
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
    error_message: errorMessage,
    folded_event_seqs: [],
    summary_excerpt: null,
    created_at: occurredAt,
  };
  session.last_compact_attempt_at = occurredAt;
  session.last_compact_status = 'failed';
  session.last_compact_error = errorMessage;
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
  return publicCompact(sessionFor(repository, session_uuid));
}

/**
 * Rebuild a compact from canonical history. Used when the operator wants
 * to force-recompute compact (e.g. after a schema_version bump or a prompt
 * upgrade). The provided builder is the same factory used by the runtime
 * (typically buildCompactSummary + renderCompactSummary from
 * src/agent/contextBuilder.mjs).
 *
 * The function is read-only against session.history; it only writes a
 * fresh compact via recordCompact. If the rebuilt summary would not
 * strictly advance compacted_through_seq (e.g. nothing new to fold), it
 * records a 'skipped' attempt instead and returns it.
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
  const session = sessionFor(args.repository, args.session_uuid);
  const history = session.history;
  const keptRecent = Number.isInteger(args.kept_recent) ? args.kept_recent : 8;
  const tailStart = history.length > keptRecent ? history.length - keptRecent : history.length;
  const prefix = history.slice(0, tailStart);
  const already = Number.isInteger(session.compacted_through_seq) ? session.compacted_through_seq : 0;
  const eligible = prefix.filter((event) => Number.isInteger(event.event_seq) && event.event_seq > already);
  if (eligible.length === 0) {
    return recordCompact({
      repository: args.repository,
      session_uuid: args.session_uuid,
      status: 'skipped',
      summary_text: session.context_compact_text || '',
      summary_payload: session.context_compact_payload || {},
      through_seq: already,
      folded_event_seqs: [],
      token_estimate: 0,
      context_window: (args.estimator_snapshot && args.estimator_snapshot.context_window) || 1,
      safety_ratio: (args.estimator_snapshot && args.estimator_snapshot.safety_ratio) || 0,
      reserved_completion_tokens: (args.estimator_snapshot && args.estimator_snapshot.reserved_completion_tokens) || 0,
      schema_version: (args.estimator_snapshot && args.estimator_snapshot.schema_version) || 1,
      prompt_version: (args.estimator_snapshot && args.estimator_snapshot.prompt_version) || 1,
    });
  }
  const built = args.builder(eligible);
  if (!built || typeof built !== 'object') {
    throw new Error('rebuildCompactFromHistory: builder must return an object');
  }
  if (typeof built.summary_text !== 'string' || !built.summary_payload || typeof built.summary_payload !== 'object') {
    throw new Error('rebuildCompactFromHistory: builder must return summary_text + summary_payload');
  }
  if (!Array.isArray(built.folded_event_seqs)) {
    throw new Error('rebuildCompactFromHistory: builder must return folded_event_seqs');
  }
  const snapshot = args.estimator_snapshot || {};
  const tokenEstimate = Number.isInteger(snapshot.token_estimate) ? snapshot.token_estimate : eligible.length;
  const contextWindow = Number.isInteger(snapshot.context_window) && snapshot.context_window > 0 ? snapshot.context_window : 1;
  const safetyRatio = typeof snapshot.safety_ratio === 'number' && snapshot.safety_ratio >= 0 && snapshot.safety_ratio < 1 ? snapshot.safety_ratio : 0;
  const reservedTokens = Number.isInteger(snapshot.reserved_completion_tokens) ? snapshot.reserved_completion_tokens : 0;
  const schemaVersion = Number.isInteger(snapshot.schema_version) ? snapshot.schema_version : 1;
  const promptVersion = Number.isInteger(snapshot.prompt_version) ? snapshot.prompt_version : 1;
  const lastSeq = built.folded_event_seqs[built.folded_event_seqs.length - 1];
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
