// src/stories/sessionService.mjs — canonical session store.
//
// ClickUp 05 / 08 contract (unified):
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
//   * recoverSession is read-only: returns canonical history + revision +
//     cursor + the active pending snapshot. Never calls the provider,
//     never replays, never mutates state.
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

function append(session, canonical, clientRequestId = null) {
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
  // Opening order is enforced against the OPENING cursor (the number of
  // opening events already displayed), not the canonical cursor.
  if (event.sequence !== session.opening_cursor) throw new Error(`commitOpeningEvent: event.sequence must equal opening cursor ${session.opening_cursor}`);
  const cache = repository.findOpeningCacheByUuid(session.cache_uuid);
  if (!cache || cache.status !== 'valid') throw new Error('commitOpeningEvent: pinned cache is no longer valid');
  const pinned = validatePinnedCache(cache, session.story_uuid, session.story_version_uuid)
    .find((candidate) => candidate && candidate.sequence === event.sequence);
  const canonical = normalizeCacheEvent(event, pinned, cache_uuid, session.session_uuid);
  const committed = append(session, canonical, id);
  session.opening_cursor += 1;
  if (session.opening_cursor >= cache.content_payload.event_count) session.state = 'awaiting_first_choice';
  const result = { session_uuid, cache_uuid, event: clone(committed), cursor: session.cursor, opening_cursor: session.opening_cursor, revision: session.revision, state: session.state };
  if (id) session.requestIds.set(id, { kind: 'opening', fingerprint: requestFingerprint('opening', { event }), result });
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
  if (!Array.isArray(items)) {
    throw new Error('stageNarrativeBatch: items must be an array');
  }
  if (items.length === 0 && !hasToolCall) {
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
  const session = sessionFor(repository, session_uuid);
  const id = requestId(client_request_id);
  const stageFingerprintInput = { payload: { items: normalized, tool_call: tool_call || null, source: source || NARRATIVE_SOURCE } };
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
  const session = sessionFor(repository, session_uuid);
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
  const canonical = append(session, {
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
  const session = sessionFor(repository, session_uuid);
  const id = requestId(client_request_id);
  const prior = idempotentResult(session, id, 'interrupt', { text });
  if (prior) return prior;
  validateRevision(session, expected_revision);
  if (session.state !== 'opening' && session.state !== 'awaiting_first_choice' && session.state !== 'realtime') {
    throw new Error('interruptWithPlayerInput: session is not interruptible');
  }
  requiredString('text', text);
  // Discard speculative pending tail. If the runtime kept an un-displayed
  // tool call, it is dropped with the rest of the tail and never reaches
  // canonical history.
  const dropped = session.pending;
  session.pending = null;
  const canonical = append(session, {
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
  if (id) session.requestIds.set(id, { kind: 'interrupt', fingerprint: requestFingerprint('interrupt', { text }), result });
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
  const prior = sessionFor(repository, session_uuid).turnRequests.get(request_id);
  return prior ? { fingerprint: prior.fingerprint, result: clone(prior.result) } : null;
}

/**
 * Register (or replay) a turn-level request result on the session. A
 * reused request_id with the SAME fingerprint replays the prior result; a
 * reused request_id with a DIFFERENT fingerprint fails closed.
 */
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
  const session = sessionFor(repository, session_uuid);
  return {
    ...publicSession(session, true),
    pending: publicPending(ensurePendingShape(session.pending)),
  };
}

/**
 * Adapter hook used by tests and future DAOs that need to snapshot the
 * raw session row. Not part of the public HTTP surface.
 */
export function _peekSession({ repository, session_uuid }) {
  return sessionFor(repository, session_uuid);
}