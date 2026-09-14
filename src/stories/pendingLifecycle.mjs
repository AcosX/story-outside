// src/stories/pendingLifecycle.mjs — thin facade over sessionService.
//
// Story 08 keeps this module as a strict, narrow API on top of the
// canonical sessionService. It MUST NOT own a parallel history, revision
// counter, or pending snapshot — the canonical store is sessionService.
//
// Public function shapes mirror what 06/07 callers used, so the runtime
// and HTTP layers can call them through one surface:
//
//   * stageNarrativeBatch              → sessionService.stageNarrativeBatch
//   * commitDisplayedEvent              → sessionService.commitNarrativeEvent
//   * interruptWithPlayerInputFromPending
//                                      → sessionService.interruptWithPlayerInput
//   * recoverPendingSession             → sessionService.recoverSession
//   * discardPendingTail                → sessionService.discardPendingTail
//   * dropPendingAfterLegacyInterrupt   → sessionService.discardPendingTail
//   * listPendingSessionUuids           → repo-level helper
//
// Two history arrays are not possible here: every commit goes through
// sessionService.append, which is the only writer to session.history.

import { repositoryState } from './sessionService.mjs';
import {
  commitNarrativeEvent,
  discardPendingTail as sessionServiceDiscardPendingTail,
  interruptWithPlayerInput as sessionServiceInterruptWithPlayerInput,
  recoverSession as sessionServiceRecoverSession,
  stageNarrativeBatch as sessionServiceStageNarrativeBatch,
} from './sessionService.mjs';

/**
 * Stage a narrative batch on a session. The batch is parked in the
 * session's `pending` slot owned by sessionService. It does NOT touch
 * canonical history. A subsequent stage() call replaces any prior pending
 * (fail-closed by revision check) so a stale or duplicated stage call
 * cannot reintroduce dropped content.
 *
 * The facade accepts both `items:` (Story 08 contract) and `events:`
 * (legacy 06/07 naming) so callers that already use the latter shape do
 * not need to change.
 */
export function stageNarrativeBatch(input) {
  if (input && Array.isArray(input.events) && !Array.isArray(input.items)) {
    return sessionServiceStageNarrativeBatch({ ...input, items: input.events, events: undefined });
  }
  return sessionServiceStageNarrativeBatch(input);
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
 */
export function commitDisplayedEvent(input) {
  return commitNarrativeEvent(input);
}

/**
 * Player interrupts the session. ONLY canonical events that were committed
 * remain in the history. Any speculative pending tail is dropped.
 * The player input itself is appended as a canonical event and the session
 * switches to 'realtime'.
 */
export function interruptWithPlayerInputFromPending(input) {
  return sessionServiceInterruptWithPlayerInput(input);
}

/**
 * Recover a session. Read-only. Returns canonical history + the current
 * pending snapshot (if any). Does NOT call the provider, does NOT replay,
 * does NOT append. revision / cursor are consistent with the canonical
 * history.
 */
export function recoverPendingSession(input) {
  return sessionServiceRecoverSession(input);
}

/**
 * Drop any speculative pending for a session without committing.
 */
export function discardPendingTail(input) {
  return sessionServiceDiscardPendingTail(input);
}

/**
 * Helper for callers using sessionService.interruptWithPlayerInput who
 * want to keep the pending lifecycle coherent. Drops any speculative
 * pending tail so the next stageNarrativeBatch call is the only pending
 * state.
 */
export function dropPendingAfterLegacyInterrupt(input) {
  return sessionServiceDiscardPendingTail(input);
}

/**
 * List the session uuids that currently hold an ACTIVE (un-consumed)
 * pending batch. Despite the name, earlier revisions returned every
 * session uuid; that was misleading (callers used it to resume players
 * stuck on an un-drained batch) and it now filters to sessions where
 * session.pending is set, matching the listPending* contract.
 */
export function listPendingSessionUuids(repository) {
  if (!repository) throw new Error('listPendingSessionUuids: repository required');
  const state = repositoryState(repository);
  const uuids = [];
  for (const [session_uuid, session] of state.sessions) {
    if (session && session.pending) uuids.push(session_uuid);
  }
  return uuids;
}
