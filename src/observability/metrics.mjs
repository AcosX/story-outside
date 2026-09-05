// src/observability/metrics.mjs — In-memory counter / histogram store.
//
// ClickUp 14 contract:
//   * Metrics live in a process-local Map. Restart resets everything —
//     this is documented in docs/observability.md so the eventual
//     Prometheus/StatsD bridge is a drop-in replacement.
//   * Two aggregation axes:
//       - session_uuid → SessionMetrics (per-session totals)
//       - global      → GlobalMetrics (process totals)
//   * Histograms use a fixed bucket layout so log-side post-processing
//     doesn't have to discover the buckets again.
//   * All counters/timers/histograms are best-effort. They MUST NOT
//     throw into business code; the store wraps every mutator in a
//     try/catch.
//
// Schema is intentionally narrow: the admin endpoint just serialises
// the snapshot. New metric families are added by extending this file in
// a backward-compatible way (additive only).

// ---------------------------------------------------------------------------
// Types (JSDoc only — this project is plain ES modules, no TypeScript)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} LatencyBuckets
 * @property {number} le_50        count of samples with latency ≤ 50 ms.
 * @property {number} le_100       count of samples with latency ≤ 100 ms.
 * @property {number} le_250       count of samples with latency ≤ 250 ms.
 * @property {number} le_1000      count of samples with latency ≤ 1000 ms.
 * @property {number} le_5000      count of samples with latency ≤ 5000 ms.
 * @property {number} le_30000     count of samples with latency ≤ 30000 ms.
 * @property {number} gt_30000     count of samples with latency > 30000 ms.
 * @property {number} sum          Total ms across all samples.
 * @property {number} count        Number of samples.
 */

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** @type {Map<string, SessionMetrics>} */
const sessionMetrics = new Map();

// Session keys are externally controllable (request bodies), so the store
// must stay bounded: unbounded growth would let anonymous /api/dev traffic
// balloon process memory. Eviction is LRU (Map iteration order = least
// recently touched first — touchSession re-inserts on every hit); the
// global counters are NOT rolled back on eviction.
const MAX_SESSION_METRICS = 1000;
let globalMetrics = newGlobalMetrics();
let mutationCount = 0;

function newLatencyBuckets() {
  return { le_50: 0, le_100: 0, le_250: 0, le_1000: 0, le_5000: 0, le_30000: 0, gt_30000: 0, sum: 0, count: 0 };
}

function newSessionMetrics() {
  return {
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    agentTurns: 0,
    agentRetries: 0,
    agentFailures: 0,
    toolCalls: 0,
    openingCacheHits: 0,
    realtimeTransitions: 0,
    inTokens: 0,
    outTokens: 0,
    cacheReadTokens: 0,
    truncated: 0,
    compactCount: 0,
    providerErrors: 0,
    providerRateLimits: 0,
    agentLatency: newLatencyBuckets(),
    commitLatency: newLatencyBuckets(),
    providerLatency: newLatencyBuckets(),
    dbLatency: newLatencyBuckets(),
  };
}

function newGlobalMetrics() {
  return {
    startedAt: new Date().toISOString(),
    lastResetAt: new Date().toISOString(),
    sessionsObserved: 0,
    agentTurns: 0,
    agentRetries: 0,
    agentFailures: 0,
    toolCalls: 0,
    openingCacheHits: 0,
    openingCacheMisses: 0,
    realtimeTransitions: 0,
    inTokens: 0,
    outTokens: 0,
    cacheReadTokens: 0,
    truncated: 0,
    compactCount: 0,
    providerErrors: 0,
    providerRateLimits: 0,
    sessionsByState: { opening: 0, awaiting_first_choice: 0, realtime: 0, finished: 0 },
    agentLatency: newLatencyBuckets(),
    commitLatency: newLatencyBuckets(),
    providerLatency: newLatencyBuckets(),
    dbLatency: newLatencyBuckets(),
  };
}

function touchSession(session_uuid, record) {
  let prev = sessionMetrics.get(session_uuid);
  if (prev) {
    // LRU refresh: delete + re-set moves the key to the end of the Map's
    // iteration order so eviction below targets the least recently
    // ACTIVE session, not merely the oldest-inserted one. Without this,
    // a long-lived busy session could be evicted by a burst of new keys.
    // Snapshot shape is unchanged; only iteration order follows recency.
    sessionMetrics.delete(session_uuid);
    sessionMetrics.set(session_uuid, prev);
  } else {
    if (sessionMetrics.size >= MAX_SESSION_METRICS) {
      const oldestKey = sessionMetrics.keys().next().value;
      if (oldestKey !== undefined) {
        const evicted = sessionMetrics.get(oldestKey);
        // M5 follow-up: roll the gauge back when a session is evicted
        // from the per-session map so sessionsByState stays consistent
        // with the per-session map size. Without this the gauge could
        // exceed the per-session map size (over-count) or, if a session
        // re-touched after eviction, leave a stale bucket (under-count).
        if (evicted && typeof evicted.lastState === 'string'
            && Object.prototype.hasOwnProperty.call(globalMetrics.sessionsByState, evicted.lastState)
            && globalMetrics.sessionsByState[evicted.lastState] > 0) {
          globalMetrics.sessionsByState[evicted.lastState] -= 1;
        }
        sessionMetrics.delete(oldestKey);
      }
    }
    prev = newSessionMetrics();
    sessionMetrics.set(session_uuid, prev);
    globalMetrics.sessionsObserved += 1;
  }
  prev.lastSeenAt = record.lastSeenAt || new Date().toISOString();
  // Initialise lastState on first sight so observeSession can rely on a
  // defined previous-state value (== 'never observed') without re-deriving
  // it inside the hot path.
  if (prev.lastState === undefined) prev.lastState = null;
  return prev;
}

function bumpLatency(bucket, ms) {
  if (!Number.isFinite(ms) || ms < 0) return;
  bucket.sum += ms;
  bucket.count += 1;
  if (ms <= 50) bucket.le_50 += 1;
  else if (ms <= 100) bucket.le_100 += 1;
  else if (ms <= 250) bucket.le_250 += 1;
  else if (ms <= 1000) bucket.le_1000 += 1;
  else if (ms <= 5000) bucket.le_5000 += 1;
  else if (ms <= 30000) bucket.le_30000 += 1;
  else bucket.gt_30000 += 1;
}

// ---------------------------------------------------------------------------
// Public mutators (each one is wrapped — see `safe`)
// ---------------------------------------------------------------------------

function safe(fn) {
  return (...args) => {
    try {
      fn(...args);
      mutationCount += 1;
    } catch {
      // intentionally swallowed: metrics never crash business code
    }
  };
}

export const recordAgentTurn = safe(({ session_uuid, latency_ms, in_tokens = 0, out_tokens = 0, cache_read_tokens = 0, truncated = false, retry = false } = {}) => {
  if (typeof session_uuid !== 'string' || !session_uuid) return;
  const s = touchSession(session_uuid, {});
  s.agentTurns += 1;
  if (retry) s.agentRetries += 1;
  if (truncated) s.truncated += 1;
  s.inTokens += Number.isFinite(in_tokens) && in_tokens > 0 ? in_tokens : 0;
  s.outTokens += Number.isFinite(out_tokens) && out_tokens > 0 ? out_tokens : 0;
  s.cacheReadTokens += Number.isFinite(cache_read_tokens) && cache_read_tokens > 0 ? cache_read_tokens : 0;
  if (Number.isFinite(latency_ms)) bumpLatency(s.agentLatency, latency_ms);

  globalMetrics.agentTurns += 1;
  if (retry) globalMetrics.agentRetries += 1;
  if (truncated) globalMetrics.truncated += 1;
  globalMetrics.inTokens += Number.isFinite(in_tokens) && in_tokens > 0 ? in_tokens : 0;
  globalMetrics.outTokens += Number.isFinite(out_tokens) && out_tokens > 0 ? out_tokens : 0;
  globalMetrics.cacheReadTokens += Number.isFinite(cache_read_tokens) && cache_read_tokens > 0 ? cache_read_tokens : 0;
  if (Number.isFinite(latency_ms)) bumpLatency(globalMetrics.agentLatency, latency_ms);
});

// ---------------------------------------------------------------------------
// SINGLE-RECORDER CONTRACT (agent turn)
//
// `recordAgentTurn` (turn counter + tokens + latency) must be called
// EXACTLY ONCE per successful agent turn, by
// agent/observabilityHooks.onTurnSuccess — the only place that has the
// full usage / truncated / retry context. `timeAgentTurn`
// (observability/timing.mjs) is a latency-only stopwatch and must use
// `recordAgentLatency` below, never `recordAgentTurn`. If both ran for
// the same turn, every agent counter and the latency histogram would be
// double-counted. See docs/observability.md §3.
// ---------------------------------------------------------------------------

/**
 * Latency-only recording for the `agent` timing category. Feeds the
 * agentLatency histogram WITHOUT bumping turn/token counters — this is
 * what `timeAgentTurn` calls so a stopwatch wrapper can coexist with
 * the hooks layer without double-counting the turn.
 */
export const recordAgentLatency = safe(({ session_uuid, latency_ms } = {}) => {
  if (typeof session_uuid !== 'string' || !session_uuid) return;
  if (!Number.isFinite(latency_ms)) return;
  bumpLatency(touchSession(session_uuid, {}).agentLatency, latency_ms);
  bumpLatency(globalMetrics.agentLatency, latency_ms);
});

export const recordAgentFailure = safe(({ session_uuid, error_code = null } = {}) => {
  if (typeof session_uuid !== 'string' || !session_uuid) return;
  const s = touchSession(session_uuid, {});
  s.agentFailures += 1;
  globalMetrics.agentFailures += 1;
  if (error_code) {
    // error_code is captured as an opaque label, never used to gate behavior.
    s.lastErrorCode = String(error_code);
  }
});

export const recordToolCall = safe(({ session_uuid, tool_name = null } = {}) => {
  if (typeof session_uuid !== 'string' || !session_uuid) return;
  const s = touchSession(session_uuid, {});
  s.toolCalls += 1;
  if (tool_name) s.lastToolName = String(tool_name);
  globalMetrics.toolCalls += 1;
});

export const recordOpeningCacheHit = safe(({ session_uuid } = {}) => {
  if (typeof session_uuid !== 'string' || !session_uuid) return;
  const s = touchSession(session_uuid, {});
  s.openingCacheHits += 1;
  globalMetrics.openingCacheHits += 1;
});

export const recordOpeningCacheMiss = safe(() => {
  globalMetrics.openingCacheMisses += 1;
});

export const recordRealtimeTransition = safe(({ session_uuid } = {}) => {
  if (typeof session_uuid !== 'string' || !session_uuid) return;
  const s = touchSession(session_uuid, {});
  s.realtimeTransitions += 1;
  globalMetrics.realtimeTransitions += 1;
});

export const recordCommit = safe(({ session_uuid, latency_ms } = {}) => {
  if (typeof session_uuid !== 'string' || !session_uuid) return;
  const s = touchSession(session_uuid, {});
  if (Number.isFinite(latency_ms)) bumpLatency(s.commitLatency, latency_ms);
  if (Number.isFinite(latency_ms)) bumpLatency(globalMetrics.commitLatency, latency_ms);
});

export const recordProviderRequest = safe(({ session_uuid, latency_ms, success = true } = {}) => {
  if (typeof session_uuid !== 'string' || !session_uuid) return;
  if (Number.isFinite(latency_ms)) bumpLatency(touchSession(session_uuid, {}).providerLatency, latency_ms);
  if (Number.isFinite(latency_ms)) bumpLatency(globalMetrics.providerLatency, latency_ms);
  if (!success) globalMetrics.providerErrors += 1;
});

export const recordProviderRateLimit = safe(({ session_uuid } = {}) => {
  if (typeof session_uuid !== 'string' || !session_uuid) return;
  touchSession(session_uuid, {}).providerRateLimits += 1;
  globalMetrics.providerRateLimits += 1;
});

export const recordDbQuery = safe(({ session_uuid, latency_ms } = {}) => {
  if (typeof session_uuid !== 'string' || !session_uuid) return;
  if (Number.isFinite(latency_ms)) bumpLatency(touchSession(session_uuid, {}).dbLatency, latency_ms);
  if (Number.isFinite(latency_ms)) bumpLatency(globalMetrics.dbLatency, latency_ms);
});

export const recordCacheReadTokens = safe(({ session_uuid, cache_read_tokens = 0 } = {}) => {
  if (typeof session_uuid !== 'string' || !session_uuid) return;
  const s = touchSession(session_uuid, {});
  // Cache read tokens are tracked alongside in_tokens (which already counts
  // ALL input tokens). The dedicated counter lets operators compute the
  // cache-hit ratio without re-scanning the request log.
  s.cacheReadTokens += Number.isFinite(cache_read_tokens) && cache_read_tokens > 0 ? cache_read_tokens : 0;
  globalMetrics.cacheReadTokens += Number.isFinite(cache_read_tokens) && cache_read_tokens > 0 ? cache_read_tokens : 0;
});

export const recordCompact = safe(({ session_uuid } = {}) => {
  if (typeof session_uuid !== 'string' || !session_uuid) return;
  const s = touchSession(session_uuid, {});
  s.compactCount += 1;
  globalMetrics.compactCount += 1;
});

export const observeSession = safe(({ session_uuid, state = null } = {}) => {
  if (typeof session_uuid !== 'string' || !session_uuid) return;
  // touchSession always inserts the record (and counts a new session in
  // sessionsObserved exactly once), so there is nothing left to do for
  // insertion here — only the state label below is conditional.
  const s = touchSession(session_uuid, {});
  if (typeof state === 'string' && Object.prototype.hasOwnProperty.call(globalMetrics.sessionsByState, state)) {
    // M5 follow-up: sessionsByState is a CURRENT gauge, not a transition
    // counter. The previous implementation incremented the new bucket
    // whenever the state changed, but never decremented the old bucket,
    // so a session that moved opening → realtime → opening produced
    // {opening: 2, realtime: 1} even though only one session existed.
    // The gauge contract: at any moment
    // `sum(sessionsByState[*])` equals the number of distinct sessions
    // that have called observeSession in a known state. On eviction of
    // a session from sessionMetrics (MAX_SESSION_METRICS = 1000) the
    // LRU sweep below rolls the bucket back so the global count stays
    // consistent with the per-session map.
    if (s.lastState !== state) {
      if (typeof s.lastState === 'string' && Object.prototype.hasOwnProperty.call(globalMetrics.sessionsByState, s.lastState)
          && globalMetrics.sessionsByState[s.lastState] > 0) {
        globalMetrics.sessionsByState[s.lastState] -= 1;
      }
      globalMetrics.sessionsByState[state] += 1;
      s.lastState = state;
    }
  }
});

// ---------------------------------------------------------------------------
// Snapshot (read-only — used by the admin endpoint)
// ---------------------------------------------------------------------------

/**
 * Snapshot of every per-session metric known to the process. Returned
 * shape is stable; callers should treat additional fields as additive.
 * @param {string} session_uuid
 */
export function snapshotSession(session_uuid) {
  const m = sessionMetrics.get(session_uuid);
  if (!m) return null;
  return JSON.parse(JSON.stringify(m));
}

/**
 * Snapshot of all session metrics keyed by session_uuid, plus the
 * process-wide global counters. Order of `sessions` is LRU recency
 * order (least recently touched first) — it follows the eviction order
 * and is not part of the API contract.
 */
export function snapshotAll() {
  const sessions = {};
  for (const [uuid, m] of sessionMetrics.entries()) {
    sessions[uuid] = JSON.parse(JSON.stringify(m));
  }
  return {
    global: JSON.parse(JSON.stringify(globalMetrics)),
    sessions,
    mutationCount,
  };
}

/** Test-only: wipe everything. */
export function _resetMetricsForTests() {
  sessionMetrics.clear();
  globalMetrics = newGlobalMetrics();
  mutationCount = 0;
}
