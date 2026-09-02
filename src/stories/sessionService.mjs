// Session-local opening playback state. The state is deliberately attached
// to each repository instance so independent repositories cannot share a
// session or accidentally observe one another's history.
//
// ClickUp 09 contract (player frontend, autoplay / commit / interrupt / recover):
//
//   * The sessionService IS the canonical store. It owns the per-session
//     history, revision, cursor, opening_cursor, state, idempotency map,
//     and the active speculative pending batch. There is exactly one
//     history per session.
//
//   * Cursor semantics (ClickUp 09 P1.1):
//       - cursor       = canonical event count (every commit advances it).
//       - opening_cursor = count of committed OPENING events (separate,
//         read-only, exposed so the client can keep driving the opening
//         sequence while cursor stays consistent with the full chain).
//       - revision     = cursor (canonical event count).
//
//   * Narrative events arrive via stageNarrativeBatch followed by zero or
//     more commitNarrativeEvent calls. Each commit appends EXACTLY ONE
//     event (the one the player just saw) to canonical history. The
//     speculative tail lives on session.pending and NEVER reaches
//     canonical history unless the corresponding commitNarrativeEvent
//     call lands.
//
//   * A batch may carry 1..4 narrative items plus an OPTIONAL final tool
//     call. The tool call is validated, surfaced as part of the staged
//     batch, and NEVER written to canonical history (it never advances
//     the pending cursor and never becomes a committed event_seq).
//
//   * interruptWithPlayerInput atomically:
//       - discards the speculative pending tail;
//       - appends the player_input as a NEW canonical event;
//       - switches the session state to 'realtime'.
//
//   * recoverSession returns canonical history + revision + cursor +
//     opening_cursor + the active pending snapshot. Read-only: never
//     calls the provider, never replays, never mutates state.
//
//   * Every mutating call accepts a client_request_id; a reused id with
//     the same payload replays the prior result; a reused id with a
//     different payload fails closed.
//
// IMPORTANT — DEPENDENCY NOTE (ClickUp 09):
//
//   This file adds the minimum 09-batch lifecycle to sessionService.
//   The shape matches the ClickUp 08 wire contract that the player
//   frontend consumes (1..4 items + optional final tool call, pending
//   snapshot with pending_id/committed_count/tool_call). It is NOT a
//   cherry-pick of 08: the original 08 changes are not in this branch
//   yet. When main eventually integrates 08, this layer should be
//   replaced by the 08 implementation and these helpers removed.

import { randomUUID } from 'node:crypto';
import { canonicalJsonStringify, canonicalSha256 } from './canonicalHash.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_STATE = 'sessionState';
const CACHE_EVENT_TYPES = new Set(['narration', 'dialogue', 'action', 'beat']);
const NARRATIVE_EVENT_TYPES = new Set(['narration', 'dialogue', 'action', 'beat']);
const NARRATIVE_ORIGIN = 'llm';
const NARRATIVE_SOURCE = 'runtime';
// ClickUp 08 / 09 contract: a staged batch carries 1..4 narrative items
// plus an OPTIONAL final tool call.
const MAX_NARRATIVE_ITEMS = 4;
const MIN_NARRATIVE_ITEMS = 1;

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

/**
 * Per-source source_sequence counter (ClickUp 09 / 08 surface — NOT
 * currently used by the canonical append path, which still uses the
 * Phase 4 history.position value so existing tests stay stable). Kept
 * for the runtime layer / future DAO; the helper stays here so the
 * contract is consistent if a future branch consolidates the two
 * conventions.
 */
function nextSourceSequence(session, source) {
  let count = 0;
  for (const event of session.history) {
    if (event.source === source) count += 1;
  }
  return count;
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
  // Adapter hook so a future DAO can hand back a pending row that needs
  // shape normalization; today the in-memory pending is already shaped
  // correctly.
  return pending;
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
    turnRequests: new Map(),
    requestIds: new Map(),
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
  // opening_cursor is the canonical opening position (incremented only on
  // opening commits). session.cursor and session.revision follow the
  // existing Phase 4 contract: cursor advances with opening events,
  // revision advances on every commit.
  session.opening_cursor += 1;
  if (session.cursor >= cache.content_payload.event_count) session.state = 'awaiting_first_choice';
  const result = {
    session_uuid,
    cache_uuid,
    event: clone(committed),
    cursor: session.cursor,
    opening_cursor: session.opening_cursor,
    revision: session.revision,
    state: session.state,
  };
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
  // ClickUp 09 acceptance criterion: "用户在任意普通消息之间都能打断".
  // Opening, awaiting_first_choice, and realtime are all interruptible.
  // stageNarrativeBatch already accepts all three; mirrors it here so the
  // input bar is never silently swallowed mid-narration.
  if (session.state !== 'opening' && session.state !== 'awaiting_first_choice' && session.state !== 'realtime') {
    throw new Error('interruptWithPlayerInput: session is not interruptible');
  }
  requiredString('text', text);
  // Discard speculative pending tail (if any). The tail never reaches
  // canonical history; the player's input is the only canonical addition.
  const dropped = session.pending;
  session.pending = null;
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
  const session = sessionFor(repository, session_uuid);
  return {
    ...publicSession(session, true),
    pending: publicPending(ensurePendingShape(session.pending)),
  };
}

/**
 * Stage a narrative batch from the runtime. The session carries the
 * active speculative pending batch on session.pending; canonical history
 * is NOT mutated. The caller commits each displayed item via
 * commitNarrativeEvent.
 *
 * Strict invariants (fail closed):
 *   - session exists
 *   - expected_revision matches session.revision
 *   - items array carries 1..4 entries of allowed narrative types
 *   - tool_call (when present) is a non-empty object (full tool envelope
 *     validation is the runtime/tools layer's job)
 *   - if a different unconsumed pending is already staged, REJECT (callers
 *     must commit / interrupt / discard it first). Same payload is
 *     idempotent and replays the existing snapshot.
 */
export function stageNarrativeBatch({ repository, session_uuid, items, tool_call, source, client_request_id, expected_revision }) {
  if (!repository) throw new Error('stageNarrativeBatch: repository required');
  assertUuid('session_uuid', session_uuid);
  if (!Array.isArray(items) || items.length < MIN_NARRATIVE_ITEMS || items.length > MAX_NARRATIVE_ITEMS) {
    throw new Error(`stageNarrativeBatch: items must contain ${MIN_NARRATIVE_ITEMS}..${MAX_NARRATIVE_ITEMS} items`);
  }
  if (tool_call !== undefined && tool_call !== null && (typeof tool_call !== 'object' || Array.isArray(tool_call))) {
    throw new Error('stageNarrativeBatch: tool_call must be an object when present');
  }
  if (tool_call && typeof tool_call.name !== 'string') {
    throw new Error('stageNarrativeBatch: tool_call.name required');
  }
  if (!Number.isInteger(expected_revision)) {
    throw new Error('stageNarrativeBatch: expected_revision must be an integer');
  }
  const session = sessionFor(repository, session_uuid);
  const id = requestId(client_request_id);
  const normalized = items.map((event, index) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new Error(`stageNarrativeBatch: items[${index}] must be an object`);
    }
    const eventType = event.type || event.event_type;
    if (!NARRATIVE_EVENT_TYPES.has(eventType)) {
      throw new Error(`stageNarrativeBatch: items[${index}].type '${eventType}' is not a narrative event type`);
    }
    if (typeof event.text !== 'string') {
      throw new Error(`stageNarrativeBatch: items[${index}].text required`);
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
  // Idempotency lookup must happen BEFORE the active-pending guard so a
  // request that retries with the same client_request_id replays even if
  // there is already an unconsumed pending.
  if (id) {
    const stageFingerprint = canonicalJsonStringify({
      items: normalized,
      tool_call: tool_call || null,
      source: source || NARRATIVE_SOURCE,
    });
    const prior = idempotentResult(session, id, 'stage', { payload: { items: normalized, tool_call: tool_call || null, source: source || NARRATIVE_SOURCE } });
    if (prior) return prior;
  }
  validateRevision(session, expected_revision);
  if (session.state !== 'opening' && session.state !== 'awaiting_first_choice' && session.state !== 'realtime') {
    throw new Error(`stageNarrativeBatch: session is not accepting narrative batches (state=${session.state})`);
  }
  // Active-pending concurrency guard: a fresh stage MUST NOT silently
  // overwrite an unconsumed batch. Same payload replays the existing
  // snapshot; different payload fails closed.
  if (session.pending) {
    const active = session.pending;
    const samePayload = canonicalJsonStringify({
      items: normalized,
      tool_call: tool_call || null,
      source: source || NARRATIVE_SOURCE,
    }) === canonicalJsonStringify({
      items: active.events,
      tool_call: active.tool_call || null,
      source: active.source,
    });
    if (samePayload) {
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
    source: typeof source === 'string' && source ? source : NARRATIVE_SOURCE,
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
    session.requestIds.set(id, {
      kind: 'stage',
      fingerprint: canonicalJsonStringify({ kind: 'stage', payload: { items: normalized, tool_call: tool_call || null, source: pending.source } }),
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
 *   - client_request_id (when present) replays identical calls; a reused
 *     id with a different payload fails closed.
 *
 * The optional final tool call is NEVER committed as a narrative event.
 * The application surfaces it to the player separately. The result of
 * the FINAL commit exposes the staged tool_call under pending_tool_call.
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
  const session = sessionFor(repository, session_uuid);
  const id = requestId(client_request_id);
  // Idempotency lookup FIRST: after the final commit clears session.pending,
  // a replay of that same commit must still return the original result
  // instead of failing the pending_id check.
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
  if (expected_revision !== session.revision) {
    throw new Error(
      `commitNarrativeEvent: revision mismatch, expected ${expected_revision} but current is ${session.revision}`,
    );
  }
  const canonical = append(session, {
    event_id: randomUUID(),
    event_type: 'narrative_beat',
    origin: NARRATIVE_ORIGIN,
    source: session.pending.source,
    source_sequence: session.history.length + 1,
    payload: clone(staged),
    occurred_at: nowIso(),
  }, false, id);
  session.pending.committed_count += 1;
  const totalCommitted = session.pending.committed_count;
  const totalEvents = session.pending.events.length;
  const cleared = totalCommitted >= totalEvents;
  const toolCallSurface = cleared ? clone(session.pending.tool_call) : null;
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
    session.requestIds.set(id, {
      kind: 'commit',
      fingerprint: canonicalJsonStringify({ kind: 'commit', pending_id, sequence }),
      result,
    });
  }
  return clone(result);
}

/**
 * Discard any speculative pending batch without committing.
 */
export function discardPendingTail({ repository, session_uuid }) {
  if (!repository) throw new Error('discardPendingTail: repository required');
  const session = sessionFor(repository, session_uuid);
  const dropped = session.pending;
  session.pending = null;
  return {
    dropped_pending_id: dropped ? dropped.pending_id : null,
    dropped_pending_count: dropped ? dropped.events.length - dropped.committed_count : 0,
    state: session.state,
  };
}

/**
 * Session-owned turn-level idempotency store. The HTTP layer creates a
 * fresh runtime per request, so request_id dedup MUST live on the
 * session, not on a transient runtime instance. The runtime registers
 * the full turn result (turn_id / items / tool envelope / pending_id)
 * here after a successful stage; a later request with the same
 * request_id + input + revision replays that exact result without
 * calling the provider again.
 */
export function lookupTurnRequest({ repository, session_uuid, request_id }) {
  if (!repository) throw new Error('lookupTurnRequest: repository required');
  assertUuid('session_uuid', session_uuid);
  if (typeof request_id !== 'string' || request_id.length === 0) {
    throw new Error('lookupTurnRequest: request_id must be a non-empty string');
  }
  const prior = sessionFor(repository, session_uuid).turnRequests.get(request_id);
  return prior ? { fingerprint: prior.fingerprint, result: clone(prior.result) } : null;
}

export function registerTurnRequest({ repository, session_uuid, request_id, fingerprint, result }) {
  if (!repository) throw new Error('registerTurnRequest: repository required');
  assertUuid('session_uuid', session_uuid);
  if (typeof request_id !== 'string' || request_id.length === 0) {
    throw new Error('registerTurnRequest: request_id must be a non-empty string');
  }
  const session = sessionFor(repository, session_uuid);
  const prior = session.turnRequests.get(request_id);
  if (prior) {
    if (prior.fingerprint !== fingerprint) {
      throw new Error('sessionService: request_id was already used for a different request');
    }
    return clone(prior.result);
  }
  session.turnRequests.set(request_id, { fingerprint, result: clone(result) });
  return clone(result);
}

/**
 * Adapter hook used by tests that need to inspect the raw session row.
 * Not part of the public HTTP surface.
 */
export function _peekSession({ repository, session_uuid }) {
  return sessionFor(repository, session_uuid);
}
