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
import { SessionNotFoundError, SessionConflictError } from '../providers/dto.mjs';
import { importStoryAndEnsureCache } from './storyService.mjs';

// ---------------------------------------------------------------------------
// ClickUp 09 / issue #9 — public-session bootstrap helper
//
// `bootstrapSessionFromWork` is the application-layer seam the issue-9
// /api/sessions POST façade needs. The helper takes the ONLY two fields
// the browser knows (work_id + role_id) and runs the canonical flow:
//
//   work_id
//     → importStoryAndEnsureCache   (provider → import/reuse story →
//                                   import/reuse version →
//                                   ensure/reuse opening cache)
//     → createSession              (create + pin canonical session)
//
// The helper is atomic on a single repository call chain and idempotent
// across retries: importStoryAndEnsureCache reuses existing story/version
//   /opening cache rows, and createSession fails closed on duplicate
// session_uuid. It MUST NOT be called with a session_uuid that already
// exists for this repository — the caller owns uuid allocation and is
// expected to randomise on every bootstrap.
//
// The helper returns the new canonical session record PLUS the opening
// payload it pinned (so the route layer can stream opening_events to
// the browser without making a second read). Both pieces are deep-cloned
// so the caller can serialise them straight into an HTTP response.
// ---------------------------------------------------------------------------

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

// In-memory demo session store bound. Persistent repositories retain the
// complete projection until the adapter supports lazy loading from SQL.
// PR #7 only capped three auxiliary Maps
// (sessionPinnedMetadata, turnRequests-by-session, sessionMetrics); the
// canonical session store itself could still grow without limit. This
// demo-grade bound evicts the LEAST RECENTLY TOUCHED session when the
// store is full. Touch points (commitOpeningEvent, stageNarrativeBatch,
// commitNarrativeEvent, interruptWithPlayerInput, recoverSession,
// recordCompact) call `touchSession(...)` to refresh the LRU position;
// `createSession` also touches after insertion. The eviction drops
// history / pending / requestIds / turnRequests for the evicted session
// AND drops its entries from the cross-session request tracking index so
// future replays are not silently prevented. Anonymous /api/dev traffic
// can therefore grow the canonical store up to this bound and no
// further; documented as a demo bound in docs/observability.md.
const MAX_CANONICAL_SESSIONS = 2000;

// Bounded request tracking window per process. SQL idempotency is scoped
// by (session_id, client_request_id), matching the service's per-session
// replay contract. This auxiliary index limits the number of distinct ids
// tracked by the process; it does not enforce cross-session uniqueness:
//
//   * SAME-session replay with the same id and the same payload
//     continues to return the prior result (per-session idempotency,
//     still enforced by `session.requestIds`).
//   * SAME-session replay with the same id and a DIFFERENT payload
//     still fails closed (per-session fingerprint check).
//   * CROSS-session reuse of an id that is still in the window is now
//     ACCEPTED in both the in-memory service and the SQL schema.
//
// When the cap is reached a NEW (previously unseen) id is refused with
// a stable 'too_many_client_request_ids' code so operators can see the
// demo ceiling; the per-session replay maps continue to evict their
// oldest entries as before because their semantic is 'replay window',
// not 'uniqueness index'.
const MAX_TRACKED_CLIENT_REQUEST_IDS = 50000;
const persistentSessionStates = new WeakSet();
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

// Register by shared state so a repository and its persistence proxy have
// identical retention behavior. The marker is internal and not serialized.
export function registerPersistentSessionRepository(repository) {
  persistentSessionStates.add(repositoryState(repository));
}

/**
 * Wire the repository's pinned-cache resolver to the canonical session
 * store so the opening-cache eviction loop (PR #7 ChatGPT 2026-09-05
 * follow-up) knows which cache_uuids are still pinned by an active
 * session. Without this hook the eviction loop happily drops the very
 * cache `commitOpeningEvent` needs, surfacing as
 * `commitOpeningEvent: pinned cache is no longer valid` mid-stream.
 *
 * The resolver returns a FRESH Set on every call because the eviction
 * loop runs on the hot path and we do not want to expose the live
 * internal Map (callers must not mutate it). The set is built from
 * `state.sessions`, so it automatically shrinks when sessions are
 * evicted — no separate bookkeeping is required.
 *
 * @param {object} repository
 */
export function bindPinnedCacheResolver(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new Error('bindPinnedCacheResolver: repository required');
  }
  const state = repositoryState(repository);
  if (typeof repository._setPinnedCacheResolver !== 'function') {
    // The repository layer is expected to expose the hook; if it does
    // not, fail loud at boot rather than silently dropping the safety
    // net.
    throw new Error('bindPinnedCacheResolver: repository does not expose _setPinnedCacheResolver');
  }
  repository._setPinnedCacheResolver(() => {
    const pinned = new Set();
    for (const session of state.sessions.values()) {
      if (session && typeof session.cache_uuid === 'string' && session.cache_uuid) {
        pinned.add(session.cache_uuid);
      }
    }
    return pinned;
  });
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
  if (!session) throw new SessionNotFoundError(session_uuid);
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

const MAX_CLIENT_REQUEST_ID_LENGTH = 255;

function requestId(value) {
  if (value === undefined || value === null) return null;
  requiredString('client_request_id', value);
  if (value.length > MAX_CLIENT_REQUEST_ID_LENGTH) {
    throw new Error(`sessionService: client_request_id must be at most ${MAX_CLIENT_REQUEST_ID_LENGTH} characters`);
  }
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
 * Enforce the bounded cross-session tracking window on canonical
 * events. Called from append() — the only writer of canonical events.
 *
 * Contract (PR #7 follow-up, ChatGPT 2026-09-05 re-review, Blocker 3):
 *   * A cross-session reuse of an id that is ALREADY in the window IS
 *     ALLOWED. The index is a bounded sliding window per process, not a
 *     SQL uniqueness check. Any session may reuse the id, including
 *     while another session still owns it. Same-session idempotency is enforced
 *     earlier by `session.requestIds` (with a different fingerprint
 *     failure mode); this function only deals with the cross-session
 *     case.
 *   * A previously unseen id is refused with a stable
 *     'too_many_client_request_ids' code when the window is full so
 *     operators see the demo ceiling instead of silent eviction.
 *
 * @returns {void}
 */
function registerCanonicalRequestId(state, session, clientRequestId) {
  if (!clientRequestId) return;
  if (!state.clientRequestIndex) state.clientRequestIndex = new Map();
  // B3 follow-up: cross-session reuse is now accepted. The previous
  // behaviour tried to mirror SQL UNIQUE by refusing the new owner with
  // `duplicate_client_request_id`; that contract was inconsistent with
  // `evictSession` clearing the index on eviction. We keep the same
  // SET semantics for the index, drop the per-id owner check, and
  // refuse only when the window is full for an UNSEEN id.
  if (!state.clientRequestIndex.has(clientRequestId) && state.clientRequestIndex.size >= MAX_TRACKED_CLIENT_REQUEST_IDS) {
    const err = new Error(
      `sessionService: too many distinct client_request_id values have been committed across sessions (limit ${MAX_TRACKED_CLIENT_REQUEST_IDS})`,
    );
    err.code = 'too_many_client_request_ids';
    throw err;
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
 * a session object rebuilt from persisted history (MariaDB hydrate) derives
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

export function createSession({ repository, session_uuid, story_uuid, story_version_uuid, user_ref, role_id, model, prompt, generation_profile, user_uuid }) {
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
  // ClickUp 16.3 P1.2 (ChatGPT 2026-09-07 review): canonical session
  // owner identity is `user_uuid`, persisted in the canonical session
  // record so share / unshare handlers can verify ownership from
  // internal state. The field is OPTIONAL to keep the historical
  // createSession contract working for callers that do not need
  // owner-bound shares (e.g. legacy demo-mode /api/dev/sessions tests
  // that never invoke the share surface). When omitted, the session
  // has no canonical owner and any share attempt will fail-closed.
  let canonicalOwnerUuid = null;
  if (typeof user_uuid === 'string' && UUID_PATTERN.test(user_uuid)) {
    canonicalOwnerUuid = user_uuid;
  } else if (user_uuid !== undefined && user_uuid !== null) {
    throw new Error('createSession: user_uuid must be a UUID when provided');
  }
  const session = {
    session_uuid,
    story_uuid,
    story_version_uuid,
    story_version_checksum: version.checksum,
    cache_uuid: cache.cache_uuid,
    opening_cache_status: cache.status,
    generation_profile: clone(generation_profile),
    user_ref,
    user_uuid: canonicalOwnerUuid,
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
  // Only demo repositories may evict. Persistent reads currently depend
  // on the complete hydrated projection; eviction would make a durable
  // session appear missing until restart.
  if (!persistentSessionStates.has(state) && state.sessions.size >= MAX_CANONICAL_SESSIONS) {
    evictOldestSession(state);
  }
  state.sessions.set(session_uuid, session);
  session.lastTouchedAt = nowIso();
  return publicSession(session);
}

function mapEntries(map) {
  return map instanceof Map ? [...map.entries()].map(([key, value]) => [key, clone(value)]) : [];
}

/**
 * Serialize the session state that is not represented by the normalized
 * story/session tables. `session_events` remains the canonical history; the
 * runtime payload carries the idempotency windows, pending envelope, owner,
 * finish envelope, and compact audit needed for an exact process restart.
 */
export function exportSessionPersistenceSnapshot(repository) {
  const state = repositoryState(repository);
  return [...state.sessions.values()].map((session) => ({
    session_uuid: session.session_uuid,
    story_uuid: session.story_uuid,
    story_version_uuid: session.story_version_uuid,
    story_version_checksum: session.story_version_checksum,
    cache_uuid: session.cache_uuid,
    opening_cache_status: session.opening_cache_status,
    generation_profile: clone(session.generation_profile),
    user_ref: session.user_ref,
    user_uuid: session.user_uuid || null,
    role_id: session.role_id,
    model: session.model,
    prompt: session.prompt,
    state: session.state,
    cursor: session.cursor,
    opening_cursor: session.opening_cursor,
    revision: session.revision,
    history: clone(session.history),
    runtime_payload: {
      pending: clone(session.pending),
      requestIds: mapEntries(session.requestIds),
      turnRequests: mapEntries(session.turnRequests),
      sourceSeq: mapEntries(session.sourceSeq),
      finish_envelope: clone(session.finish_envelope),
      compact_history: clone(session.compact_history),
      lastTouchedAt: session.lastTouchedAt || null,
    },
    compact: publicCompact(session),
  }));
}

/**
 * Rehydrate one session from the MariaDB projection. This deliberately lives
 * beside createSession so the restored object has exactly the same shape and
 * Map-backed idempotency semantics as a newly created session.
 */
export function hydrateSessionPersistence({ repository, row, history = [], runtime_payload = {}, pending = null }) {
  if (!repository || !row || typeof row !== 'object') {
    throw new Error('hydrateSessionPersistence: repository and row required');
  }
  assertUuid('session_uuid', row.session_uuid);
  assertUuid('story_uuid', row.story_uuid);
  assertUuid('story_version_uuid', row.story_version_uuid);
  assertUuid('cache_uuid', row.cache_uuid);
  const state = repositoryState(repository);
  if (state.sessions.has(row.session_uuid)) return state.sessions.get(row.session_uuid);
  const runtime = runtime_payload && typeof runtime_payload === 'object' ? runtime_payload : {};
  const compact = row.compact && typeof row.compact === 'object' ? row.compact : {};
  const restoredHistory = Array.isArray(history) ? clone(history) : [];
  const restoredPending = runtime.pending && typeof runtime.pending === 'object'
    ? clone(runtime.pending)
    : (pending && typeof pending === 'object' ? clone(pending) : null);
  const session = {
    session_uuid: row.session_uuid,
    story_uuid: row.story_uuid,
    story_version_uuid: row.story_version_uuid,
    story_version_checksum: row.story_version_checksum || null,
    cache_uuid: row.cache_uuid,
    opening_cache_status: row.opening_cache_status || 'valid',
    generation_profile: clone(row.generation_profile || {}),
    user_ref: row.user_ref,
    user_uuid: row.user_uuid || runtime.user_uuid || null,
    role_id: row.role_id,
    model: row.model,
    prompt: row.prompt,
    state: runtime.state || row.state || (row.status === 'ended' ? 'finished' : 'opening'),
    cursor: Number.isInteger(runtime.cursor) ? runtime.cursor : restoredHistory.length,
    opening_cursor: Number.isInteger(runtime.opening_cursor) ? runtime.opening_cursor : Number(row.opening_cursor || 0),
    revision: Number.isInteger(runtime.revision) ? runtime.revision : Number(row.session_revision || restoredHistory.length),
    history: restoredHistory,
    pending: restoredPending,
    requestIds: new Map(Array.isArray(runtime.requestIds) ? clone(runtime.requestIds) : []),
    turnRequests: new Map(Array.isArray(runtime.turnRequests) ? clone(runtime.turnRequests) : []),
    sourceSeq: new Map(Array.isArray(runtime.sourceSeq) ? clone(runtime.sourceSeq) : []),
    finish_envelope: clone(runtime.finish_envelope || null),
    context_compact_text: row.context_compact_text ?? compact.context_compact_text ?? null,
    context_compact_payload: clone(row.context_compact_payload ?? compact.context_compact_payload ?? null),
    compacted_through_seq: row.compacted_through_seq == null ? (compact.compacted_through_seq ?? null) : Number(row.compacted_through_seq),
    compacted_event_count: row.compacted_event_count == null ? (compact.compacted_event_count ?? null) : Number(row.compacted_event_count),
    token_estimate: row.token_estimate == null ? (compact.token_estimate ?? null) : Number(row.token_estimate),
    context_window: row.context_window == null ? (compact.context_window ?? null) : Number(row.context_window),
    context_safety_ratio: row.context_safety_ratio == null ? (compact.context_safety_ratio ?? null) : Number(row.context_safety_ratio),
    reserved_completion_tokens: row.reserved_completion_tokens == null ? (compact.reserved_completion_tokens ?? null) : Number(row.reserved_completion_tokens),
    context_schema_version: row.context_schema_version == null ? (compact.context_schema_version ?? null) : Number(row.context_schema_version),
    prompt_version: row.prompt_version == null ? (compact.prompt_version ?? null) : Number(row.prompt_version),
    last_compact_at: row.last_compact_at || compact.last_compact_at || null,
    last_compact_attempt_at: row.last_compact_attempt_at || compact.last_compact_attempt_at || null,
    last_compact_status: row.last_compact_status || compact.last_compact_status || 'idle',
    last_compact_error: row.last_compact_error || compact.last_compact_error || null,
    compact_history: Array.isArray(runtime.compact_history) ? clone(runtime.compact_history) : [],
    lastTouchedAt: runtime.lastTouchedAt || row.updated_at || nowIso(),
  };
  state.sessions.set(session.session_uuid, session);
  for (const event of session.history) {
    if (event && event.client_request_id) state.clientRequestIndex.set(event.client_request_id, session.session_uuid);
  }
  return session;
}

/**
 * Drop the least-recently-touched session from the canonical store.
 * Eviction is a hard cut: history / pending / per-session request maps
 * are gone, and every entry the session contributed to the cross-session
 * clientRequestIndex is removed.
 *
 * B3 follow-up (ChatGPT 2026-09-05 re-review): the previous contract
 * claimed that cross-session id uniqueness survived eviction. In
 * practice `evictSession` already cleared the per-owner entries, so the
 * claim was internally inconsistent. The new contract explicitly
 * downgrades the in-memory index to a bounded sliding window — after
 * eviction a freed id MAY be reused by a fresh session, and the SQL
 * UNIQUE constraint is no longer claimed here. See the comment on
 * `MAX_TRACKED_CLIENT_REQUEST_IDS` and `registerCanonicalRequestId`.
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
  // B3 follow-up: clean up the per-session slots in the cross-session
  // window so future inserts under those ids do not appear to still be
  // owned by the now-evicted session. Note: cross-session reuse is now
  // accepted by `registerCanonicalRequestId` once the index no longer
  // remembers the evicted session — the new contract documents this as
  // a bounded sliding window, not a mirror of SQL UNIQUE.
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

// ClickUp 16.3 P1.2 owner binding (ChatGPT 2026-09-07 review):
//   * `findOwnerBySession` returns the canonical session owner persisted
//     at session creation. The repository is the single source of truth —
//     the HTTP layer never trusts the request body for the caller
//     identity.
//   * Returns `null` for unknown sessions so the share handler can answer
//     401 cleanly (the caller is not the owner of a session that does
//     not exist).
//   * Returns `null` for legacy sessions created without a `user_uuid`
//     so the share surface fails closed: an old demo-mode session cannot
//     accidentally become shareable because the field is missing.
export function findOwnerBySession({ repository, session_uuid }) {
  if (!repository) throw new Error('findOwnerBySession: repository required');
  assertUuid('session_uuid', session_uuid);
  const session = repositoryState(repository).sessions.get(session_uuid);
  if (!session) return null;
  return session.user_uuid || null;
}

// ClickUp 16.3 P1.2 owner binding: persist the canonical owner on a
// session that was created without one. Used by the public `/api/sessions`
// bootstrap route AFTER reading the (or minting a fresh) cookie-scoped
// user_uuid. Fail-closed: rejects re-binding an owner that does not match
// the persisted value (so an attacker cannot rotate the owner through
// repeated bootstrap calls on the same session_uuid). No-ops when the
// session already has the same owner.
export function bindSessionOwner({ repository, session_uuid, user_uuid }) {
  if (!repository) throw new Error('bindSessionOwner: repository required');
  assertUuid('session_uuid', session_uuid);
  assertUuid('user_uuid', user_uuid);
  const session = repositoryState(repository).sessions.get(session_uuid);
  if (!session) return false;
  if (session.user_uuid && session.user_uuid !== user_uuid) {
    throw new Error('bindSessionOwner: session already bound to a different user_uuid');
  }
  session.user_uuid = user_uuid;
  touchSessionRecord(session);
  return true;
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

/**
 * Issue #9 — atomic public-session bootstrap.
 *
 * Inputs (only what the browser knows):
 *   * work_id   : stable story slug returned by /api/stories
 *   * role_id   : role selected from the same story
 *
 * Outputs:
 *   * session record (the createSession return value, deep-cloned)
 *   * opening payload straight from the pinned opening cache so the
 *     caller can stream opening_events[] to the browser without a
 *     second read.
 *
 * `session_uuid` MUST be a fresh UUID (randomUUID() at the route
 * layer) — the helper does not invent one. `user_ref`, `model`, and
 * `prompt` are intentionally NOT part of the public API contract: the
 * browser must not know about the model catalog or any prompt
 * template, so the helper injects stable in-process defaults the
 * downstream runtime pins.
 *
 * Validation summary (matching the dev route's contract):
 *   * work_id  → provider story; StoryNotFoundError on unknown slug.
 *   * role_id  → must exist in the imported story_version.roles_payload.
 *   * cache    → ensureOpeningCache always returns a non-null cache
 *     with status='valid'; we re-validate here defensively so a caller
 *     cannot bootstrap a session pinned to a 'failed' cache row.
 *
 * Errors raised are the same stable codes the dev route already
 * surfaces (invalid_input / story_not_found / invalid_cache /
 * duplicate_session / session_not_found), so a single sessionError
 * classifier at the HTTP layer handles both surfaces identically.
 *
 * @param {object} input
 * @param {import('./repository.mjs').StoryRepository} input.repository
 * @param {object} input.provider  Object exposing `getStory` (StoryProvider).
 * @param {string} input.session_uuid
 * @param {string} input.work_id
 * @param {string} input.role_id
 * @param {object} [input.identity]
 * @param {string} [input.identity.user_ref]
 * @param {string} [input.identity.model]
 * @param {string} [input.identity.prompt]
 * @param {import('../community/repository.mjs').CommunityProfileRepository} [input.profileRepository]
 *        ClickUp 16.1 server.mjs wiring fix (2026-09-06): when the
 *        public real-provider path supplies a community-profile repo,
 *        the underlying `importStoryAndEnsureCache` call ensures a
 *        profile for the freshly imported story_version, tagged with
 *        the supplied `profileOptions.source` (default `mock-generated`).
 * @param {{ source?: string, locale?: string, seed?: object }} [input.profileOptions]
 *        Forwarded to `importStoryAndEnsureCache` so the public
 *        real-provider path can surface freshly-built profiles as
 *        `source: 'real-generated'`. Omitting this argument keeps the
 *        historical default (`mock-generated`).
 * @returns {Promise<{ session: object, opening_events: object[], cache_uuid: string, cache_status: string|null, story_uuid: string, story_version_uuid: string }>}
 */
export async function bootstrapSessionFromWork({ repository, provider, session_uuid, work_id, role_id, identity, profileRepository, profileOptions, user_uuid }) {
  if (!repository) throw new Error('bootstrapSessionFromWork: repository required');
  if (!provider || typeof provider.getStory !== 'function') {
    throw new Error('bootstrapSessionFromWork: provider with getStory required');
  }
  assertUuid('session_uuid', session_uuid);
  if (typeof work_id !== 'string' || !work_id) {
    throw new Error('bootstrapSessionFromWork: work_id required');
  }
  if (typeof role_id !== 'string' || !role_id) {
    throw new Error('bootstrapSessionFromWork: role_id required');
  }
  // ClickUp 16.3 P1.2 (ChatGPT 2026-09-07 review): accept the canonical
  // owner identity from the auth layer (cookie-derived `user_uuid`),
  // NEVER from the request body. The HTTP route layer is responsible
  // for reading the cookie and passing the value through; this helper
  // merely validates and forwards it to `createSession`.
  let canonicalOwnerUuid = null;
  if (typeof user_uuid === 'string' && UUID_PATTERN.test(user_uuid)) {
    canonicalOwnerUuid = user_uuid;
  } else if (user_uuid !== undefined && user_uuid !== null) {
    throw new Error('bootstrapSessionFromWork: user_uuid must be a UUID when provided');
  }
  // Idempotency window: if a caller (a retried browser, a test harness)
  // reuses the same session_uuid we MUST refuse rather than silently
  // reset the session — the dev route uses the same fail-closed code so
  // both surfaces agree on the same wire contract.
  const state = repositoryState(repository);
  if (state.sessions.has(session_uuid)) {
    throw new Error('createSession: session already exists');
  }
  // Reuse the existing story_uuid for the same work_id when present so
  // repeated imports do not create duplicate catalog rows. The seeded
  // fixture has no row for arbitrary work_ids, so a fresh UUID is
  // allocated otherwise.
  const existing = repository.findStoryBySlug(work_id);
  const story_uuid = existing ? existing.story_uuid : randomUUID();

  // Step 1: import (or reuse) the story + version + opening cache.
  const ensured = await importStoryAndEnsureCache({
    repository,
    provider,
    slug: work_id,
    story_uuid,
    profileRepository,
    profileOptions,
  });
  // Step 2: read the resulting cache so we can return opening_events[].
  const cache = repository.findOpeningCacheByUuid(ensured.opening_cache_uuid);
  if (!cache || cache.status !== 'valid') {
    // importStoryAndEnsureCache already enforces this invariant; the
    // double-check keeps the helper safe if a future caller passes in
    // a non-default profile or generator that produces a non-'valid'
    // cache row.
    throw new Error('sessionService: pinned cache must be valid');
  }
  const opening_events = Array.isArray(cache.content_payload && cache.content_payload.events)
    ? cache.content_payload.events.map((ev) => clone(ev))
    : [];
  // Step 3: defaults the public player API does NOT expose. They are
  // server-side identity/policy values the browser cannot influence.
  const user_ref = identity && identity.user_ref ? String(identity.user_ref) : 'public-player';
  const model = identity && identity.model ? String(identity.model) : 'story-outside-default';
  const prompt = identity && identity.prompt ? String(identity.prompt) : 'public-player prompt';
  // Step 4: build the canonical session. We pass through the cache's
  // pinned profile directly so the session is pinned to the same
  // generation as the cache we just streamed to the browser.
  const generation_profile = clone(cache.generation_profile);
  generation_profile.cache_uuid = cache.cache_uuid;
  const session = createSession({
    repository,
    session_uuid,
    story_uuid: ensured.story_uuid,
    story_version_uuid: ensured.story_version_uuid,
    user_ref,
    role_id,
    model,
    prompt,
    generation_profile,
    user_uuid: canonicalOwnerUuid,
  });
  return {
    session,
    opening_events,
    cache_uuid: cache.cache_uuid,
    cache_status: cache.status,
    story_uuid: ensured.story_uuid,
    story_version_uuid: ensured.story_version_uuid,
    cache_reused: !!ensured.cache_reused,
    version_reused: !!ensured.version_reused,
    community_profile_version: ensured.community_profile_version || null,
    community_profile_uuid: ensured.community_profile_uuid || null,
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
 * ClickUp 08 P1.6 persistence boundary: this service keeps a synchronous
 * in-memory projection and is intentionally unaware of the database. When
 * the server is configured with MariaDB, `src/db/mariaPersistence.mjs`
 * hydrates this projection before traffic and flushes it transactionally
 * before JSON responses, so the same `recoverSession` contract also works
 * across process restarts. Without a configured database, the projection is
 * process-local by design.
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
