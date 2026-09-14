// src/observability/timing.mjs — Latency tracker for slow-point triage.
//
// Story 14 contract:
//   * Five timing categories match the slow-point triage columns:
//
//        | category   | source                                                  |
//        |------------|---------------------------------------------------------|
//        | agent      | Server-side: how long the LLM took to generate.         |
//        | commit     | Server-side: how long the opening event commit took.     |
//        | provider   | Network: how long we waited on the upstream provider.    |
//        | db         | Storage: how long session/event persistence took.       |
//        | frontend   | Client-side: how long the browser took to play a line.   |
//
//   * Frontend playback timing is NOT measured server-side. The browser
//     stamps `client_playback_at` on each event commit; the diff vs
//     `server_commit_at` is exposed in the metrics summary so an operator
//     can blame the right side.
//   * All timing helpers are non-throwing; they swallow Date arithmetic
//     errors so a misbehaving timer can never break a request.

import {
  recordAgentLatency,
  recordCommit,
  recordDbQuery,
  recordProviderRequest,
} from './metrics.mjs';

// ---------------------------------------------------------------------------
// Stopwatch helpers
// ---------------------------------------------------------------------------

/**
 * High-resolution stopwatch. Uses `performance.now()` when available so
 * sub-millisecond precision survives the round-trip to process.hrtime.
 */
export class Stopwatch {
  constructor() {
    this.startedAtNs = nowNs();
    this.endedAtNs = null;
  }

  /** Mark the stopwatch as stopped. Idempotent. */
  stop() {
    if (this.endedAtNs === null) this.endedAtNs = nowNs();
    return this;
  }

  /** Elapsed milliseconds (floored). 0 if not stopped. */
  elapsedMs() {
    if (this.endedAtNs === null) return 0;
    return Math.max(0, Math.floor((this.endedAtNs - this.startedAtNs) / 1_000_000));
  }

  /** Convenience for {latency_ms}. */
  toLatency() {
    return { latency_ms: this.elapsedMs() };
  }
}

function nowNs() {
  try {
    const t = performance.now();
    return Math.floor(t * 1_000_000);
  } catch {
    return Date.now() * 1_000_000;
  }
}

// ---------------------------------------------------------------------------
// Server-side: Agent generation vs commit
// ---------------------------------------------------------------------------

/**
 * Wrap a server-side Agent generation call. The returned object exposes
 * `.stop({ in_tokens, out_tokens, cache_read_tokens, truncated, retry })`
 * which records latency to metrics under the `agent` category.
 *
 * SINGLE-RECORDER CONTRACT: this wrapper is a LATENCY-ONLY stopwatch.
 * It feeds the agentLatency histogram via `recordAgentLatency` and does
 * NOT bump agentTurns / token counters. Turn counters are recorded
 * exactly once per turn by agent/observabilityHooks.onTurnSuccess (the
 * single recorder, which owns the usage/truncated/retry context). Do
 * not "fix" this by calling recordAgentTurn here — wiring both paths
 * for the same turn would double-count every agent metric. See
 * docs/observability.md §3.
 *
 * The wrapper is intentionally non-throwing: an exception inside `fn`
 * still records the failure latency so observability stays accurate.
 *
 * @template T
 * @param {{ session_uuid: string }} ctx
 * @param {() => Promise<T>} fn
 */
export async function timeAgentTurn(ctx, fn) {
  const stopwatch = new Stopwatch();
  try {
    return await fn();
  } finally {
    stopwatch.stop();
    recordAgentLatency({
      session_uuid: ctx && ctx.session_uuid,
      latency_ms: stopwatch.elapsedMs(),
    });
  }
}

/**
 * Wrap a server-side commit call (opening event, tool commit).
 */
export async function timeCommit(ctx, fn) {
  const stopwatch = new Stopwatch();
  try {
    return await fn();
  } finally {
    stopwatch.stop();
    recordCommit({
      session_uuid: ctx && ctx.session_uuid,
      latency_ms: stopwatch.elapsedMs(),
    });
  }
}

/**
 * Wrap a provider HTTP call. Records success/failure latency under the
 * `provider` category. `success=false` increments the provider error
 * counter.
 */
export async function timeProvider(ctx, fn) {
  const stopwatch = new Stopwatch();
  try {
    const result = await fn();
    stopwatch.stop();
    recordProviderRequest({
      session_uuid: ctx && ctx.session_uuid,
      latency_ms: stopwatch.elapsedMs(),
      success: true,
    });
    return result;
  } catch (err) {
    stopwatch.stop();
    recordProviderRequest({
      session_uuid: ctx && ctx.session_uuid,
      latency_ms: stopwatch.elapsedMs(),
      success: false,
    });
    throw err;
  }
}

/**
 * Wrap a database (or repository) call. MariaDB flushes and the synchronous
 * projection both report under `db` so slow-point triage remains comparable
 * when the configured backend changes.
 */
export async function timeDb(ctx, fn) {
  const stopwatch = new Stopwatch();
  try {
    return await fn();
  } finally {
    stopwatch.stop();
    recordDbQuery({
      session_uuid: ctx && ctx.session_uuid,
      latency_ms: stopwatch.elapsedMs(),
    });
  }
}

// ---------------------------------------------------------------------------
// Frontend playback timing
// ---------------------------------------------------------------------------

/**
 * Compute the server-observed playback delay given the browser-stamped
 * commit timestamp. Returns null when either side is missing so the
 * metrics endpoint can expose `frontend_playback_ms: null` without
 * forcing every caller to special-case missing values.
 *
 * The formula is intentionally simple — operators want raw diffs to do
 * their own aggregation. Anything fancier (rolling avg, histogram) goes
 * to the metrics endpoint or the dashboard.
 *
 * @param {{ server_commit_at?: string, client_playback_at?: string }} input
 * @returns {number | null}
 */
export function computeFrontendPlaybackMs(input) {
  if (!input || typeof input !== 'object') return null;
  const serverTs = parseIso(input.server_commit_at);
  const clientTs = parseIso(input.client_playback_at);
  if (serverTs === null || clientTs === null) return null;
  const diff = clientTs - serverTs;
  if (!Number.isFinite(diff)) return null;
  // Negative diffs (client clock behind the server clock) are clamped
  // to 0. Trade-off, kept deliberately: clamping hides client clock
  // skew instead of surfacing it, but it also guarantees a non-negative
  // ms value so operators can sum/avg results without filtering
  // negatives. Do NOT change the return type to carry a `clamped`
  // marker — that would break every existing caller for a signal that
  // today's demo (same-machine browser) never needs. If skew ever
  // matters in production, add a separate sidecar field instead.
  return diff >= 0 ? Math.floor(diff) : 0;
}

function parseIso(value) {
  if (typeof value !== 'string' || !value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * Convenience: wrap a server-side commit so that, after the commit
 * resolves, the client can hand back its playback timestamp and we
 * will fold it into the next `timeCommit` window. Today the diff is
 * exposed only via `computeFrontendPlaybackMs` — we keep it sidecar
 * to avoid coupling commit latency to client behaviour.
 */
export function diffFrontendPlayback(input) {
  return computeFrontendPlaybackMs(input);
}
