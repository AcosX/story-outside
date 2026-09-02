// src/agent/tokenEstimator.mjs — pluggable token estimator used by the
// long-context compact pipeline (ClickUp 10).
//
// DEPENDENCY NOTE — in-memory vs SQL boundary:
// This module is pure and stateless; it does not know about repositories
// and does not touch any database. The compact pipeline (see
// src/agent/contextBuilder.mjs and the compact hooks added to
// src/agent/runtime.mjs / src/stories/sessionService.mjs) calls into the
// estimator to measure how big a context payload would be *before* sending
// it to the provider. The estimator is intentionally side-effect free so it
// can be re-used by the future MariaDB DAO compact job without rewiring.
//
// MariaDB contract: session_events is append-only and never truncated, even
// when compact fires. Compact only writes new rows into
// game_sessions (context_compact / compacted_through_seq / token_estimate)
// and into the new compact_compacted_events audit table defined by
// db/migrations/0005_compact_and_context.sql. session_events remains the
// canonical history; rebuildCompactFromHistory() can rebuild the compact
// purely from session_events rows.

import { canonicalJsonStringify } from '../stories/canonicalHash.mjs';

/**
 * Default model context windows. These are safe public defaults used when
 * no explicit window is configured. They MUST stay well below the vendor
 * maximums (e.g. Anthropic Claude Sonnet 4.5 = 1M, but we keep the default
 * conservative). Update via MODEL_CONTEXT_WINDOWS override when the
 * deployment pins a different contract.
 *
 * Each entry returns the *raw* window. The compact threshold reserves an
 * extra safety margin (see DEFAULT_SAFETY_RATIO) on top of the prompt +
 * expected completion budget.
 */
export const DEFAULT_MODEL_CONTEXT_WINDOWS = Object.freeze({
  'anthropic/claude-sonnet-4.5': 200_000,
  'anthropic/claude-opus-4':     200_000,
  'anthropic/claude-3.5-sonnet': 200_000,
  'openai/gpt-4o':               128_000,
  'openai/gpt-4o-mini':          128_000,
  'openai/gpt-4.1':              1_000_000,
  'openai/o1-preview':           128_000,
  'openai/o3-mini':              200_000,
  'qwen/qwen-3.5-72b':            32_000,
  'qwen/qwen-long':              1_000_000,
  'deepseek/deepseek-v4-flash':   64_000,
  'mock/test':                    8_000,
});

export const DEFAULT_SAFETY_RATIO = 0.10; // reserve 10% of window for completion + system overhead
export const DEFAULT_RESERVED_COMPLETION_TOKENS = 1_024;

/**
 * Heuristic character-per-token ratio used by the fallback estimator.
 * English averages roughly 4 characters per token; CJK text averages closer
 * to 1 character per token because most Han glyphs encode a single token.
 * The fallback picks the higher of the two ratios so we never underestimate.
 */
export const FALLBACK_CHARS_PER_TOKEN_LATIN = 4;
export const FALLBACK_CHARS_PER_TOKEN_CJK = 1;

function countCjkChars(text) {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x4E00 && code <= 0x9FFF) || // CJK Unified Ideographs
      (code >= 0x3400 && code <= 0x4DBF) || // CJK Extension A
      (code >= 0x20000 && code <= 0x2A6DF) // CJK Extension B
    ) {
      count += 1;
    }
  }
  return count;
}

function stringTokenEstimate(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const cjk = countCjkChars(text);
  const latin = text.length - cjk;
  const latinTokens = Math.ceil(latin / FALLBACK_CHARS_PER_TOKEN_LATIN);
  const cjkTokens = cjk; // 1 char ~ 1 token worst-case
  // Add a small overhead per whitespace boundary to model sub-word splits.
  const whitespaceTokens = (text.match(/\s+/g) || []).length;
  return latinTokens + cjkTokens + whitespaceTokens;
}

function walkValue(value, sink) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    sink(stringTokenEstimate(value));
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    sink(1);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkValue(item, sink);
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      sink(stringTokenEstimate(key) + 2); // key overhead
      walkValue(child, sink);
    }
  }
}

/**
 * Default fallback estimator: walks a JSON-safe value and approximates its
 * token count using the CJK + Latin heuristic above.
 */
export function fallbackEstimateTokens(value) {
  let total = 0;
  walkValue(value, (delta) => { total += delta; });
  return total;
}

/**
 * Resolve the context window for a model.
 * - explicit override (object argument)
 * - DEFAULT_MODEL_CONTEXT_WINDOWS lookup
 * - very conservative fallback (8k) when the model is unknown — better to
 *   compact too early than to overflow a vendor that does not advertise a
 *   large window.
 */
export function resolveContextWindow(model, override = {}) {
  if (override && Number.isInteger(override.window) && override.window > 0) {
    return override.window;
  }
  if (typeof model === 'string' && Object.prototype.hasOwnProperty.call(DEFAULT_MODEL_CONTEXT_WINDOWS, model)) {
    return DEFAULT_MODEL_CONTEXT_WINDOWS[model];
  }
  return 8_000;
}

/**
 * @typedef {Object} TokenEstimator
 * @property {(value: unknown) => number} estimate       Estimate tokens of a JSON-safe value.
 * @property {() => number}                              contextWindow  Raw window.
 * @property {() => number}                              compactThreshold
 *   Maximum *usable* tokens before compact should fire. Below this
 *   threshold, the request goes through verbatim. Above it, the compact
 *   pipeline runs.
 * @property {() => number}                              reservedCompletionTokens
 * @property {() => string}                             model
 * @property {() => { window: number, threshold: number, safetyRatio: number, reservedCompletionTokens: number }} describe
 */

/**
 * Build a pluggable token estimator. The factory accepts an optional
 * custom estimator function (e.g. a binding to a vendor tokenizer); when
 * none is supplied the fallback heuristic is used.
 *
 * The estimator NEVER throws on arbitrary input: anything that cannot be
 * measured is treated as zero tokens so a malformed payload never blocks
 * the request. Callers that need stricter validation should pre-validate
 * JSON before passing it in.
 *
 * @param {{ model?: string, estimator?: (value: unknown) => number, window?: number, safetyRatio?: number, reservedCompletionTokens?: number }} [options]
 * @returns {TokenEstimator}
 */
export function createTokenEstimator(options = {}) {
  const model = typeof options.model === 'string' && options.model.length > 0 ? options.model : 'mock/test';
  const estimator = typeof options.estimator === 'function' ? options.estimator : fallbackEstimateTokens;
  const window = resolveContextWindow(model, { window: options.window });
  const safetyRatio = typeof options.safetyRatio === 'number' && options.safetyRatio >= 0 && options.safetyRatio < 1
    ? options.safetyRatio
    : DEFAULT_SAFETY_RATIO;
  const reservedCompletionTokens = Number.isInteger(options.reservedCompletionTokens) && options.reservedCompletionTokens >= 0
    ? options.reservedCompletionTokens
    : DEFAULT_RESERVED_COMPLETION_TOKENS;
  const threshold = Math.max(1, Math.floor(window * (1 - safetyRatio)) - reservedCompletionTokens);

  function safe(value) {
    try {
      // canonicalJsonStringify throws on non-finite values; if so we fall
      // back to walking the original value so the estimator still produces
      // a number instead of failing the whole pipeline.
      const json = JSON.parse(canonicalJsonStringify(value));
      const result = estimator(json);
      return Number.isFinite(result) && result >= 0 ? Math.floor(result) : 0;
    } catch {
      try {
        const result = estimator(value);
        return Number.isFinite(result) && result >= 0 ? Math.floor(result) : 0;
      } catch {
        return 0;
      }
    }
  }

  return Object.freeze({
    estimate: safe,
    contextWindow: () => window,
    compactThreshold: () => threshold,
    reservedCompletionTokens: () => reservedCompletionTokens,
    model: () => model,
    describe: () => Object.freeze({ window, threshold, safetyRatio, reservedCompletionTokens }),
  });
}

export const __testing = {
  countCjkChars,
  stringTokenEstimate,
  fallbackEstimateTokens,
  walkValue,
};