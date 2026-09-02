// src/stories/observabilityHooks.mjs — Sidecar hooks for the stories layer.
//
// ClickUp 14 contract:
//   * Non-invasive: this file never mutates the session state machine.
//     It only emits structured logs and bumps metrics so the
//     sessionService / pendingLifecycle / opening cache paths remain
//     observability-free in their own source.
//   * Side-effects-only: every helper is best-effort and never throws
//     into business code.
//
// Hook points (matched by event name):
//
//   session.create                  new session pinned to a cache
//   session.opening.commit          opening cache event committed
//   session.interrupt               player input appended → realtime
//   session.tool.commit             tool call executed and recorded
//   session.state.transition        state machine transitions
//   session.cache.hit               opening cache served the session
//   session.compact                 compact_count incremented
//
// Tests and future middleware import these helpers directly. The
// sessionService source code stays untouched.

import { log, debug, info, warn } from '../observability/logger.mjs';
import {
  recordCommit,
  recordRealtimeTransition,
  observeSession,
  recordCompact,
} from '../observability/metrics.mjs';
import { recordHit as cacheRecordHit, recordMiss as cacheRecordMiss } from '../observability/cacheStats.mjs';

// ---------------------------------------------------------------------------
// Hook context
// ---------------------------------------------------------------------------

const ALLOWED_STATES = new Set(['opening', 'awaiting_first_choice', 'realtime', 'finished']);

/**
 * Build a small frozen context object that flows with the request.
 * @param {Object} input
 * @param {string} [input.session_uuid]
 * @param {string} [input.story_uuid]
 * @param {string} [input.story_version_uuid]
 * @param {string} [input.cache_uuid]
 * @param {string} [input.generation_hash]
 * @param {string} [input.state]
 */
export function createStoriesHookContext(input = {}) {
  return Object.freeze({
    session_uuid: typeof input.session_uuid === 'string' ? input.session_uuid : null,
    story_uuid: typeof input.story_uuid === 'string' ? input.story_uuid : null,
    story_version_uuid: typeof input.story_version_uuid === 'string' ? input.story_version_uuid : null,
    cache_uuid: typeof input.cache_uuid === 'string' ? input.cache_uuid : null,
    generation_hash: typeof input.generation_hash === 'string' ? input.generation_hash : null,
    state: typeof input.state === 'string' ? input.state : null,
  });
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export function onSessionCreate(hookCtx) {
  observeSession({ session_uuid: hookCtx.session_uuid, state: hookCtx.state });
  info('session.create', {
    session_uuid: hookCtx.session_uuid,
    component: 'stories',
    cache_uuid: hookCtx.cache_uuid,
    story_uuid: hookCtx.story_uuid,
    story_version_uuid: hookCtx.story_version_uuid,
    state: hookCtx.state,
  });
}

export function onOpeningCommit({ hookCtx, event = null, latency_ms = null } = {}) {
  if (Number.isFinite(latency_ms)) {
    recordCommit({ session_uuid: hookCtx.session_uuid, latency_ms });
  } else {
    recordCommit({ session_uuid: hookCtx.session_uuid, latency_ms: 0 });
  }
  debug('session.opening.commit', {
    session_uuid: hookCtx.session_uuid,
    component: 'stories',
    cache_uuid: hookCtx.cache_uuid,
    sequence: event && Number.isInteger(event.sequence) ? event.sequence : null,
    event_type: event && event.type ? event.type : null,
    latency_ms,
  });
}

export function onInterrupt({ hookCtx, text_length = null, latency_ms = null } = {}) {
  recordRealtimeTransition({ session_uuid: hookCtx.session_uuid });
  observeSession({ session_uuid: hookCtx.session_uuid, state: 'realtime' });
  info('session.interrupt', {
    session_uuid: hookCtx.session_uuid,
    component: 'stories',
    cache_uuid: hookCtx.cache_uuid,
    state: 'realtime',
    latency_ms,
    // The text itself is redacted by the logger; this length is for
    // triage only.
    extra: { text_length: Number.isFinite(text_length) ? text_length : null },
  });
}

export function onToolCommit({ hookCtx, tool_name = null, latency_ms = null } = {}) {
  info('session.tool.commit', {
    session_uuid: hookCtx.session_uuid,
    component: 'stories',
    tool_name,
    latency_ms,
  });
}

/**
 * Generic state-machine transition log. Use sparingly — most
 * transitions are covered by the dedicated hooks above.
 */
export function onStateTransition({ hookCtx, from_state = null, to_state = null } = {}) {
  if (!ALLOWED_STATES.has(to_state)) return;
  observeSession({ session_uuid: hookCtx.session_uuid, state: to_state });
  debug('session.state.transition', {
    session_uuid: hookCtx.session_uuid,
    component: 'stories',
    extra: { from_state, to_state },
  });
}

/**
 * Compact count bump. Currently unused by the session service (the
 * MariaDB migration is the single source of truth for compaction),
 * but the hook is here so future compact-on-write logic has a
 * dedicated event.
 */
export function onCompact(hookCtx) {
  recordCompact({ session_uuid: hookCtx.session_uuid });
  info('session.compact', {
    session_uuid: hookCtx.session_uuid,
    component: 'stories',
  });
}

// ---------------------------------------------------------------------------
// Cache layer
// ---------------------------------------------------------------------------

/**
 * Mark an opening cache hit. Used by the route layer when it serves
 * events from a pinned cache (e.g. fixed test story demo paths).
 */
export function onOpeningCacheHit(hookCtx) {
  cacheRecordHit({
    session_uuid: hookCtx.session_uuid,
    cache_uuid: hookCtx.cache_uuid,
    story_uuid: hookCtx.story_uuid,
    story_version_uuid: hookCtx.story_version_uuid,
    generation_hash: hookCtx.generation_hash,
  });
  info('session.cache.hit', {
    session_uuid: hookCtx.session_uuid,
    component: 'stories',
    cache_uuid: hookCtx.cache_uuid,
    story_uuid: hookCtx.story_uuid,
    story_version_uuid: hookCtx.story_version_uuid,
    cache_hit: true,
  });
}

export function onOpeningCacheMiss(hookCtx, reason = null) {
  cacheRecordMiss({ session_uuid: hookCtx.session_uuid });
  warn('session.cache.miss', {
    session_uuid: hookCtx.session_uuid,
    component: 'stories',
    cache_uuid: hookCtx.cache_uuid,
    story_uuid: hookCtx.story_uuid,
    story_version_uuid: hookCtx.story_version_uuid,
    extra: { reason: reason || 'unknown' },
  });
}

// ---------------------------------------------------------------------------
// Aggregate redaction helper (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Re-export the redaction helpers so tests can assert "no PII in logs"
 * without depending on the logger module directly.
 */
export { log, debug, info, warn };