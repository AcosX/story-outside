// src/stories/pendingLifecycle.mjs — speculative narrative/event batches.
//
// ClickUp 08 contract (minimum application-layer slice):
//
//   1. provider / runtime yields a narrative batch. The batch MUST land in a
//      per-session speculative "pending" structure. It MUST NOT be persisted
//      to the canonical history until each item is explicitly committed by
//      the client after the player actually sees it.
//
//   2. Each commit MUST be exactly one displayed item, strictly validated:
//        - session_uuid must exist and belong to the caller
//        - pending_id must identify the staged batch (and still be the
//          active pending on that session)
//        - sequence must equal the next un-committed index inside the batch
//        - expected_revision must equal the session's current revision
//        - client_request_id must match (idempotency) or be absent
//      Out-of-order / stale / concurrent calls fail closed.
//
//   3. A player interrupt:
//        - keeps ONLY events that were already committed to canonical
//          history (each commit is itself append-only and advances the
//          session revision atomically);
//        - discards every pending tail;
//        - writes the player_input as a new canonical event;
//        - switches state from 'opening' / 'awaiting_first_choice' /
//          'realtime' to 'realtime' so subsequent generation paths use the
//          realtime flow.
//
//   4. recover/resume MUST only read the canonical history and the current
//      pending snapshot. It MUST NOT call the provider, MUST NOT replay
//      items that were committed, and MUST leave revision/cursor consistent
//      with the canonical history.
//
// The functions here are intentionally narrow. They do not change the
// existing opening-cache commit path (commitOpeningEvent) which already
// implements the contiguous-sequence + revision + idempotency checks for
// the public opening playback. They add a parallel "realtime-batch" path
// that mirrors the same invariants for narrative events that arrive after
// the player takes the first turn.
//
// Coupling with sessionService:
//   * Each pending-aware call resolves the canonical session via the
//     sessionService public APIs (getSession + listSessionEvents). It never
//     reaches into sessionService internals.
//   * Canonical events produced here are written into a parallel history
//     array owned by the lifecycle map. The sessionService view of the
//     session (used by HTTP routes that go through recoverSession /
//     commitOpeningEvent / interruptWithPlayerInput) is independent —
//     routes that mix the two surfaces within one request must use the
//     same surface for read AND write.
//   * dropPendingAfterLegacyInterrupt can be wired into existing
//     interruptWithPlayerInput routes to keep the parallel state coherent.

import { randomUUID } from 'node:crypto';
import { canonicalJsonStringify, canonicalSha256 } from './canonicalHash.mjs';
import {
  getSession as sessionServiceGetSession,
} from './sessionService.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PENDING_EVENT_TYPES = new Set(['narration', 'dialogue', 'action', 'beat']);
const SESSION_STATE = 'pendingLifecycleState';

function lifecycleState(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new Error('pendingLifecycle: repository required');
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
    throw new Error(`pendingLifecycle: ${label} must be a UUID`);
  }
}

function requiredString(label, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`pendingLifecycle: ${label} required`);
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function ensureLifecycleEntry(repository, session_uuid) {
  assertUuid('session_uuid', session_uuid);
  const state = lifecycleState(repository);
  const existing = state.sessions.get(session_uuid);
  if (existing) return existing;
  // Bind the lifecycle entry to the canonical sessionService session.
  // If the canonical session is missing we fail closed: a pending lifecycle
  // can never exist without a sessionService session behind it.
  const canonical = sessionServiceGetSession({ repository, session_uuid });
  const entry = {
    session_uuid,
    story_uuid: canonical.story_uuid,
    story_version_uuid: canonical.story_version_uuid,
    cache_uuid: canonical.cache_uuid,
    state: canonical.state,
    history: [],
    pending: null,
    requestIds: new Map(),
  };
  state.sessions.set(session_uuid, entry);
  return entry;
}

function sessionFor(repository, session_uuid) {
  const session = lifecycleState(repository).sessions.get(session_uuid);
  if (!session) throw new Error(`pendingLifecycle: unknown session '${session_uuid}'`);
  return session;
}

function validatePendingEvent(event, index) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error(`pendingLifecycle: events[${index}] must be an object`);
  }
  if (!Number.isInteger(event.sequence)) {
    throw new Error(`pendingLifecycle: events[${index}].sequence must be an integer`);
  }
  const eventType = event.type || event.event_type;
  if (!PENDING_EVENT_TYPES.has(eventType)) {
    throw new Error(
      `pendingLifecycle: events[${index}].type must be one of ${[...PENDING_EVENT_TYPES].join(',')}`,
    );
  }
  if (typeof event.text !== 'string' || event.text.length === 0) {
    throw new Error(`pendingLifecycle: events[${index}].text must be a non-empty string`);
  }
  if (event.speaker !== undefined && typeof event.speaker !== 'string') {
    throw new Error(`pendingLifecycle: events[${index}].speaker must be a string when present`);
  }
  return {
    type: eventType,
    sequence: event.sequence,
    text: event.text,
    ...(event.speaker !== undefined ? { speaker: event.speaker } : {}),
  };
}

function revisionOf(entry) {
  // revision == number of canonical events recorded by this lifecycle map.
  return entry.history.length;
}

function validateRevision(entry, expected_revision) {
  if (expected_revision === undefined || expected_revision === null) return;
  if (!Number.isInteger(expected_revision)) {
    throw new Error('pendingLifecycle: expected_revision must be an integer');
  }
  const current = revisionOf(entry);
  if (expected_revision !== current) {
    throw new Error(
      `pendingLifecycle: revision mismatch, expected ${expected_revision} but current is ${current}`,
    );
  }
}

function requestFingerprint(kind, input) {
  return canonicalJsonStringify(kind === 'commit'
    ? { kind, pending_id: input.pending_id, sequence: input.sequence, text: input.text }
    : { kind, text: input.text });
}

function idempotentResult(entry, id, kind, input) {
  if (!id || !entry.requestIds.has(id)) return null;
  const prior = entry.requestIds.get(id);
  if (prior.kind !== kind || prior.fingerprint !== requestFingerprint(kind, input)) {
    throw new Error('pendingLifecycle: client_request_id was already used for a different request');
  }
  return clone(prior.result);
}

function publicPending(pending) {
  if (!pending) return null;
  return {
    pending_id: pending.pending_id,
    events: clone(pending.events),
    committed_count: pending.committed_count,
    source: pending.source,
    produced_at: pending.produced_at,
    revision_at_stage: pending.revision_at_stage,
  };
}

function appendCanonical(entry, canonical, clientRequestId = null) {
  const eventSeq = entry.history.length + 1;
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
  entry.history.push(committed);
  return committed;
}

/**
 * Stage a narrative batch on a session. The batch is parked in a per-session
 * speculative "pending" structure. It does NOT touch canonical history. A
 * subsequent stage() call replaces any prior pending (fail-closed by
 * revision check) so a stale or duplicated stage call cannot reintroduce
 * dropped content.
 *
 * @param {object} input
 * @param {object} input.repository
 * @param {string} input.session_uuid
 * @param {Array<object>} input.events               Array of { type, sequence, text, speaker? }.
 *                                                  sequences MUST be contiguous integers
 *                                                  starting from 0.
 * @param {string} [input.source]                    Short tag for audit (e.g. 'runtime', 'mock-batch').
 * @param {number} [input.expected_revision]         If set, must equal session revision.
 * @param {string} [input.client_request_id]         Optional idempotency key.
 * @returns {{ session_uuid: string, pending_id: string, events: Array<object>,
 *           committed_count: number, source: string, produced_at: string,
 *           revision: number, state: string }}
 */
export function stageNarrativeBatch({ repository, session_uuid, events, source, expected_revision, client_request_id }) {
  if (!repository) throw new Error('stageNarrativeBatch: repository required');
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('stageNarrativeBatch: events must be a non-empty array');
  }
  const normalized = events.map((event, index) => validatePendingEvent(event, index));
  for (let i = 0; i < normalized.length; i += 1) {
    if (normalized[i].sequence !== i) {
      throw new Error(
        `pendingLifecycle: events[${i}].sequence must equal ${i} (contiguous, 0-based)`,
      );
    }
  }
  const entry = ensureLifecycleEntry(repository, session_uuid);
  const id = typeof client_request_id === 'string' && client_request_id.length > 0 ? client_request_id : null;
  if (id) {
    const prior = idempotentResult(entry, id, 'stage', { text: canonicalJsonStringify(normalized) });
    if (prior) return prior;
  }
  validateRevision(entry, expected_revision);
  if (entry.state !== 'opening' && entry.state !== 'awaiting_first_choice' && entry.state !== 'realtime') {
    throw new Error(`pendingLifecycle: session is not accepting narrative batches (state=${entry.state})`);
  }
  // Replacing any prior pending is intentional: the runtime should not be
  // able to silently re-stage a batch the player already discarded by
  // interrupting. revision is NOT advanced during stage, so the caller can
  // either re-stage after advancing revision (e.g. by committing +
  // interrupting) or accept that the previous batch is gone.
  const pending_id = randomUUID();
  entry.pending = {
    pending_id,
    events: clone(normalized),
    committed_count: 0,
    source: typeof source === 'string' && source ? source : 'runtime',
    produced_at: nowIso(),
    revision_at_stage: revisionOf(entry),
  };
  const result = {
    session_uuid,
    pending_id,
    events: clone(normalized),
    committed_count: 0,
    source: entry.pending.source,
    produced_at: entry.pending.produced_at,
    revision: revisionOf(entry),
    state: entry.state,
  };
  if (id) {
    entry.requestIds.set(id, {
      kind: 'stage',
      fingerprint: requestFingerprint('stage', { text: canonicalJsonStringify(normalized) }),
      result,
    });
  }
  return clone(result);
}

/**
 * Commit exactly one displayed event from the active pending batch.
 *
 * Strict invariants (fail closed):
 *   - session_uuid exists
 *   - pending_id identifies the active pending on that session
 *   - sequence equals the next un-committed index inside the batch
 *   - expected_revision equals the current revision
 *   - client_request_id (when present) is idempotent for an identical call;
 *     a different request reusing the same id is rejected
 *
 * On success: append exactly one canonical event, advance revision by 1,
 * advance committed_count by 1. When all pending items are committed, the
 * pending snapshot is cleared (so the next stage() starts fresh).
 *
 * @param {object} input
 * @param {object} input.repository
 * @param {string} input.session_uuid
 * @param {string} input.pending_id
 * @param {number} input.sequence                  0-based index inside the staged batch.
 * @param {number} input.expected_revision
 * @param {string} [input.client_request_id]
 * @returns {{ session_uuid: string, pending_id: string, event: object,
 *           cursor: number, revision: number, state: string,
 *           pending_committed_count: number, pending_remaining: number }}
 */
export function commitDisplayedEvent({ repository, session_uuid, pending_id, sequence, expected_revision, client_request_id }) {
  if (!repository) throw new Error('commitDisplayedEvent: repository required');
  assertUuid('pending_id', pending_id);
  if (!Number.isInteger(sequence)) {
    throw new Error('commitDisplayedEvent: sequence must be an integer');
  }
  if (!Number.isInteger(expected_revision)) {
    throw new Error('commitDisplayedEvent: expected_revision must be an integer');
  }
  const entry = ensureLifecycleEntry(repository, session_uuid);
  if (!entry.pending || entry.pending.pending_id !== pending_id) {
    throw new Error('commitDisplayedEvent: pending_id does not match the active pending batch');
  }
  const staged = entry.pending.events[sequence];
  if (!staged) {
    throw new Error(
      `commitDisplayedEvent: sequence ${sequence} is out of range (batch has ${entry.pending.events.length} items)`,
    );
  }
  const id = typeof client_request_id === 'string' && client_request_id.length > 0 ? client_request_id : null;
  // Idempotency check must run BEFORE the order/revision guards so a
  // replay of an identical request always succeeds.
  if (id) {
    const prior = idempotentResult(entry, id, 'commit', { pending_id, sequence, text: staged.text });
    if (prior) return prior;
  }
  if (sequence !== entry.pending.committed_count) {
    throw new Error(
      `commitDisplayedEvent: sequence must equal pending.committed_count (${entry.pending.committed_count}); out-of-order commits fail closed`,
    );
  }
  const current = revisionOf(entry);
  if (expected_revision !== current) {
    throw new Error(
      `commitDisplayedEvent: revision mismatch, expected ${expected_revision} but current is ${current}`,
    );
  }
  const canonical = appendCanonical(entry, {
    event_id: randomUUID(),
    event_type: 'narrative',
    origin: 'runtime',
    source: entry.pending.source,
    source_sequence: sequence,
    payload: clone(staged),
    occurred_at: nowIso(),
  }, id);
  entry.pending.committed_count += 1;
  const totalCommitted = entry.pending.committed_count;
  const totalEvents = entry.pending.events.length;
  const cleared = totalCommitted >= totalEvents;
  if (cleared) entry.pending = null;
  const result = {
    session_uuid,
    pending_id,
    event: clone(canonical),
    cursor: entry.history.length,
    revision: entry.history.length,
    state: entry.state,
    pending_committed_count: cleared ? totalCommitted : totalCommitted,
    pending_remaining: cleared ? 0 : totalEvents - totalCommitted,
  };
  if (id) {
    entry.requestIds.set(id, {
      kind: 'commit',
      fingerprint: requestFingerprint('commit', { pending_id, sequence, text: staged.text }),
      result,
    });
  }
  return clone(result);
}

/**
 * Player interrupts the session. ONLY canonical events that were committed
 * remain in the history. Any speculative pending tail is dropped.
 * The player input itself is appended as a canonical event and the session
 * switches to 'realtime'.
 *
 * @param {object} input
 * @param {object} input.repository
 * @param {string} input.session_uuid
 * @param {string} input.text
 * @param {number} [input.expected_revision]
 * @param {string} [input.client_request_id]
 * @returns {{ session_uuid: string, event: object, cursor: number,
 *           revision: number, state: string, dropped_pending_id: string|null,
 *           dropped_pending_count: number }}
 */
export function interruptWithPlayerInputFromPending({ repository, session_uuid, text, expected_revision, client_request_id }) {
  if (!repository) throw new Error('interruptWithPlayerInput: repository required');
  requiredString('text', text);
  const entry = ensureLifecycleEntry(repository, session_uuid);
  const id = typeof client_request_id === 'string' && client_request_id.length > 0 ? client_request_id : null;
  if (id) {
    const prior = idempotentResult(entry, id, 'interrupt', { text });
    if (prior) return prior;
  }
  validateRevision(entry, expected_revision);
  if (entry.state !== 'opening' && entry.state !== 'awaiting_first_choice' && entry.state !== 'realtime') {
    throw new Error('pendingLifecycle: session is not interruptible');
  }
  const dropped = entry.pending;
  entry.pending = null;
  const canonical = appendCanonical(entry, {
    event_id: randomUUID(),
    event_type: 'player_input',
    origin: 'user',
    source: 'player',
    source_sequence: entry.history.length + 1,
    payload: { text },
    occurred_at: nowIso(),
  }, id);
  entry.state = 'realtime';
  const result = {
    session_uuid,
    event: clone(canonical),
    cursor: entry.history.length,
    revision: entry.history.length,
    state: entry.state,
    dropped_pending_id: dropped ? dropped.pending_id : null,
    dropped_pending_count: dropped ? dropped.events.length - dropped.committed_count : 0,
  };
  if (id) {
    entry.requestIds.set(id, {
      kind: 'interrupt',
      fingerprint: requestFingerprint('interrupt', { text }),
      result,
    });
  }
  return clone(result);
}

/**
 * Recover a session. Read-only. Returns canonical history + the current
 * pending snapshot (if any). Does NOT call the provider, does NOT replay,
 * does NOT append. revision / cursor are consistent with the canonical
 * history.
 *
 * @param {object} input
 * @param {object} input.repository
 * @param {string} input.session_uuid
 * @returns {{ session_uuid: string, story_uuid: string,
 *           story_version_uuid: string, cache_uuid: string,
 *           state: string, cursor: number, revision: number,
 *           history: Array<object>, pending: object|null }}
 */
export function recoverPendingSession({ repository, session_uuid }) {
  if (!repository) throw new Error('recoverPendingSession: repository required');
  const entry = ensureLifecycleEntry(repository, session_uuid);
  return {
    session_uuid: entry.session_uuid,
    story_uuid: entry.story_uuid,
    story_version_uuid: entry.story_version_uuid,
    cache_uuid: entry.cache_uuid,
    state: entry.state,
    cursor: entry.history.length,
    revision: entry.history.length,
    history: clone(entry.history),
    pending: publicPending(entry.pending),
  };
}

/**
 * Drop any speculative pending for a session without committing. Useful for
 * a player-side "skip" or for keeping the lifecycle in sync when the legacy
 * sessionService interrupt path is used.
 *
 * @param {object} input
 * @param {object} input.repository
 * @param {string} input.session_uuid
 * @returns {{ dropped_pending_id: string|null,
 *           dropped_pending_count: number, state: string }}
 */
export function discardPendingTail({ repository, session_uuid }) {
  if (!repository) throw new Error('discardPendingTail: repository required');
  const entry = ensureLifecycleEntry(repository, session_uuid);
  const dropped = entry.pending;
  entry.pending = null;
  return {
    dropped_pending_id: dropped ? dropped.pending_id : null,
    dropped_pending_count: dropped ? dropped.events.length - dropped.committed_count : 0,
    state: entry.state,
  };
}

/**
 * Helper for callers using sessionService.interruptWithPlayerInput who want
 * to keep the pending lifecycle coherent. Drops any speculative pending tail
 * so the next stageNarrativeBatch call is the only pending state.
 *
 * @param {object} input
 * @param {object} input.repository
 * @param {string} input.session_uuid
 * @returns {{ dropped_pending_id: string|null }}
 */
export function dropPendingAfterLegacyInterrupt({ repository, session_uuid }) {
  return discardPendingTail({ repository, session_uuid });
}

export function listPendingSessionUuids(repository) {
  if (!repository) throw new Error('listPendingSessionUuids: repository required');
  return clone([...lifecycleState(repository).sessions.keys()]);
}