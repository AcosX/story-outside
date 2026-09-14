// src/agent/observabilityHooks.mjs — Sidecar hooks for the agent runtime.
//
// Story 14 contract:
//   * Non-invasive: this file never modifies the runtime; it exposes
//     helpers that the runtime / tests can call at known points.
//   * Side-effects-only: every helper records metrics + emits a
//     structured log line. None of them mutate the input.
//   * Stable fields: the log fields below are part of the contract —
//     downstream log sinks depend on them.
//
// Hook points (referenced from runtime.mjs and tools.mjs):
//
//   agent.turn.start       right before provider.complete()
//   agent.turn.success     on a successful provider response
//   agent.turn.failure     on a provider or runtime error
//   agent.tool.dispatched  when a tool call is produced
//   agent.cache.hit        cache_read_input_tokens reported by provider
//
// The runtime does NOT import this file directly. Tests and future
// integrations import it explicitly. This keeps the runtime itself
// observability-free — the hooks layer is a thin pass-through.

import { log, debug, info, warn } from '../observability/logger.mjs';
import {
  recordAgentTurn,
  recordAgentFailure,
  recordToolCall,
} from '../observability/metrics.mjs';
import { timeAgentTurn } from '../observability/timing.mjs';

// ---------------------------------------------------------------------------
// Provider-shape contract
// ---------------------------------------------------------------------------

const PROVIDER_TOKEN_LIMITS = Object.freeze({
  in_tokens_max: 8192,
  out_tokens_max: 1024,
});

/**
 * The shape we expect from any provider result object. Mock / future
 * Real providers alike must surface these so observability can attribute
 * tokens & latency to the correct session.
 *
 * @typedef {Object} ProviderUsageShape
 * @property {number} [in_tokens]
 * @property {number} [out_tokens]
 * @property {number} [cache_read_input_tokens]
 * @property {string} [model]
 * @property {string} [prompt_version]
 * @property {string} [rate_limit_remaining]
 * @property {string} [retry_after]
 * @property {string} [truncated]
 */

// ---------------------------------------------------------------------------
// Public API — turn lifecycle
// ---------------------------------------------------------------------------

/**
 * Build the context shared by every hook below. Centralising the
 * schema keeps the call sites terse.
 *
 * @param {Object} input
 * @param {string} input.session_uuid
 * @param {string} [model]
 * @param {string} [prompt_version]
 * @param {string} [request_id]
 */
export function createHookContext({ session_uuid, model, prompt_version, request_id } = {}) {
  return Object.freeze({
    session_uuid: typeof session_uuid === 'string' ? session_uuid : null,
    model: typeof model === 'string' ? model : null,
    prompt_version: typeof prompt_version === 'string' ? prompt_version : null,
    request_id: typeof request_id === 'string' ? request_id : null,
  });
}

/**
 * `agent.turn.start` log + metric counter bump. Returns a `Stopwatch`
 * that callers pass back to `recordAgentTurnSuccess`.
 */
export function onTurnStart(hookCtx) {
  debug('agent.turn.start', {
    session_uuid: hookCtx.session_uuid,
    component: 'agent',
    model: hookCtx.model,
    prompt_version: hookCtx.prompt_version,
    request_id: hookCtx.request_id,
  });
  return { startedAt: Date.now() };
}

/**
 * Apply per-turn output caps. The providerAdapter layer is expected to
 * call this BEFORE returning to the runtime so a truncated stream is
 * flagged with `truncated=true` on the metric.
 *
 * @param {Object} args
 * @param {string} args.session_uuid
 * @param {{ in_tokens?: number, out_tokens?: number, [k: string]: unknown }} args.usage
 * @param {{ messages?: unknown[], tool_calls?: unknown[] }} args.result
 */
export function applyOutputLimits({ session_uuid, usage, result }) {
  const limits = PROVIDER_TOKEN_LIMITS;
  const inTokens = Number.isFinite(usage && usage.in_tokens) ? usage.in_tokens : 0;
  const outTokens = Number.isFinite(usage && usage.out_tokens) ? usage.out_tokens : 0;
  const truncated = outTokens > limits.out_tokens_max || inTokens > limits.in_tokens_max;
  if (!truncated) return { truncated: false, in_tokens: inTokens, out_tokens: outTokens };
  warn('agent.output.truncated', {
    session_uuid,
    component: 'agent',
    in_tokens: inTokens,
    out_tokens: outTokens,
    in_tokens_max: limits.in_tokens_max,
    out_tokens_max: limits.out_tokens_max,
    truncated: true,
  });
  // We do NOT mutate `result` here — adapter / runtime owns truncation
  // semantically. We only stamp the flag for metrics/logs.
  return { truncated: true, in_tokens: inTokens, out_tokens: outTokens };
}

/**
 * `agent.turn.success` log + metric aggregation. The runtime calls
 * this once per successful provider response.
 *
 * SINGLE-RECORDER CONTRACT: this hook is the ONLY caller of
 * metrics.recordAgentTurn. It must stay the single place that bumps
 * agentTurns / token counters / the agentLatency histogram for a turn;
 * the timing.mjs stopwatch (`timeAgentTurn`) is latency-only via
 * recordAgentLatency and must never record the same turn again. See
 * docs/observability.md §3.
 *
 * @param {Object} args
 * @param {Object} args.hookCtx
 * @param {{ startedAt: number }} args.timer
 * @param {{ in_tokens?: number, out_tokens?: number, cache_read_input_tokens?: number, model?: string, prompt_version?: string }} [args.usage]
 * @param {Object} [args.result]
 * @param {boolean} [args.truncated]
 * @param {boolean} [args.retry]
 */
export function onTurnSuccess({ hookCtx, timer, usage = {}, result = {}, truncated = false, retry = false } = {}) {
  const latency_ms = timer && Number.isFinite(timer.startedAt) ? Date.now() - timer.startedAt : null;
  const inTokens = Number.isFinite(usage.in_tokens) ? usage.in_tokens : 0;
  const outTokens = Number.isFinite(usage.out_tokens) ? usage.out_tokens : 0;
  const cacheReadTokens = Number.isFinite(usage.cache_read_input_tokens) ? usage.cache_read_input_tokens : 0;
  recordAgentTurn({
    session_uuid: hookCtx.session_uuid,
    latency_ms,
    in_tokens: inTokens,
    out_tokens: outTokens,
    cache_read_tokens: cacheReadTokens,
    truncated,
    retry,
  });
  if (cacheReadTokens > 0) {
    // recordAgentTurn already credited the cache_read counter; emit a
    // dedicated event for log-side routing (cache.hit vs turn.success).
    info('agent.cache.hit', {
      session_uuid: hookCtx.session_uuid,
      component: 'agent',
      cache_read_tokens: cacheReadTokens,
      model: usage.model || hookCtx.model,
    });
  }
  info('agent.turn.success', {
    session_uuid: hookCtx.session_uuid,
    component: 'agent',
    model: usage.model || hookCtx.model,
    prompt_version: usage.prompt_version || hookCtx.prompt_version,
    request_id: hookCtx.request_id,
    latency_ms,
    in_tokens: inTokens,
    out_tokens: outTokens,
    cache_read_tokens: cacheReadTokens,
    truncated,
    retried: retry,
    kind: result && Array.isArray(result.tool_calls) && result.tool_calls.length > 0 ? 'tool_call' : 'narrative',
  });
}

/**
 * `agent.turn.failure` log + metric counter. Does not rethrow.
 */
export function onTurnFailure({ hookCtx, error = null, retry = false } = {}) {
  recordAgentFailure({
    session_uuid: hookCtx && hookCtx.session_uuid,
    error_code: error && error.code ? error.code : (error && error.name) || 'unknown',
  });
  const code = (() => {
    if (!error) return 'unknown';
    if (error.code) return String(error.code);
    if (error.name) return String(error.name);
    return 'unknown';
  })();
  warn('agent.turn.failure', {
    session_uuid: hookCtx && hookCtx.session_uuid,
    component: 'agent',
    model: hookCtx && hookCtx.model,
    prompt_version: hookCtx && hookCtx.prompt_version,
    request_id: hookCtx && hookCtx.request_id,
    error_code: code,
    error_message: error && error.message ? String(error.message) : null,
    retried: retry,
  });
}

/**
 * `agent.tool.dispatched` log + counter. Called once per tool_call
 * the runtime receives from the provider.
 *
 * @param {Object} args
 * @param {Object} args.hookCtx
 * @param {{ name?: string, tool_call_id?: string }} args.toolCall
 */
export function onToolDispatched({ hookCtx, toolCall }) {
  const name = toolCall && typeof toolCall.name === 'string' ? toolCall.name : null;
  const id = toolCall && (toolCall.tool_call_id || toolCall.id);
  recordToolCall({ session_uuid: hookCtx && hookCtx.session_uuid, tool_name: name });
  debug('agent.tool.dispatched', {
    session_uuid: hookCtx && hookCtx.session_uuid,
    component: 'agent',
    tool_name: name,
    request_id: hookCtx && hookCtx.request_id,
    extra: { tool_call_id: typeof id === 'string' ? id : null },
  });
}

// ---------------------------------------------------------------------------
// Convenience: wrap an async provider call so the lifecycle is implicit.
// ---------------------------------------------------------------------------

/**
 * Run an async provider function and emit the full observability
 * lifecycle. This is the wrapper tests can use without modifying the
 * runtime. The runtime itself calls the individual helpers so the
 * existing happy-path API does not change.
 *
 * @template T
 * @param {Object} args
 * @param {Object} args.hookCtx
 * @param {(request: unknown) => Promise<T>} args.provider
 * @param {unknown} args.request
 * @param {boolean} [args.retry]
 */
export async function observeProviderCall({ hookCtx, provider, request, retry = false }) {
  const timer = onTurnStart(hookCtx);
  try {
    const result = await provider(request);
    const usage = (result && typeof result === 'object' && result.usage) || {};
    const limits = applyOutputLimits({ session_uuid: hookCtx.session_uuid, usage, result });
    onTurnSuccess({ hookCtx, timer, usage, result, truncated: limits.truncated, retry });
    return result;
  } catch (err) {
    onTurnFailure({ hookCtx, error: err, retry });
    throw err;
  }
}

/**
 * Convenience passthrough so other modules can `timeAgentTurn` without
 * importing the timing module directly. Remember: `timeAgentTurn` is a
 * latency-only stopwatch (see the single-recorder contract on
 * `onTurnSuccess`) — it never records turn counters.
 */
export { timeAgentTurn };

/**
 * Read-only access to the provider shape — exposed so adapter modules
 * can assert they expose the same fields the runtime expects.
 */
export const PROVIDER_USAGE = PROVIDER_TOKEN_LIMITS;
