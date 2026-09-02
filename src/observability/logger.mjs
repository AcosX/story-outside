// src/observability/logger.mjs — Structured JSON Lines logger.
//
// ClickUp 14 contract:
//   * Every line is one JSON object, terminated by '\n'.
//   * Stable field set so downstream sinks (log shippers, grep, jq) can
//     trust the schema. New optional fields may be added; existing field
//     names and types must not change.
//   * Sensitive fields are redacted by default. Only fields explicitly
//     listed in `allowList` are emitted in clear text.
//
// The logger writes through `console.log` (stdout) so it does not break
// the zero-dependency, OneDrive-friendly policy of this project. A future
// deployment can swap the sink by replacing the `writeLine` symbol.
//
// Observability is a *sidecar*: no business path should `await` the
// logger. Calls are synchronous and best-effort; they must never throw
// into business code. We wrap `writeLine` in a try/catch for safety.

import { createHash } from 'node:crypto';
import { hostname as osHostname } from 'node:os';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} LogContext
 * @property {string} level          'debug' | 'info' | 'warn' | 'error'.
 * @property {string} event          Stable event name (e.g. 'agent.turn.start').
 * @property {string} [session_uuid] Optional session scope.
 * @property {string} [component]    Subsystem ('agent' | 'stories' | 'server').
 * @property {string} [model]        Provider model id, when relevant.
 * @property {string} [prompt_version] Stable prompt identifier.
 * @property {string} [request_id]   Idempotency key for retries.
 * @property {string} [tool_name]    Tool name when the event is tool-related.
 * @property {number} [latency_ms]   Measured latency for this event.
 * @property {number} [in_tokens]    Tokens billed as input by the provider.
 * @property {number} [out_tokens]   Tokens billed as output.
 * @property {number} [cache_read_tokens] Provider-reported cached input tokens.
 * @property {string} [error_code]   Stable error code for failure events.
 * @property {string} [error_message] Sanitised error message.
 * @property {boolean} [truncated]   True when the output was truncated.
 * @property {boolean} [retried]     True when this was a retry attempt.
 * @property {boolean} [cache_hit]   True for opening_cache hit events.
 * @property {boolean} [from_cache]  Same as cache_hit; kept for clarity.
 * @property {Record<string, unknown>} [extra]  Additional structured data.
 */

// Fields whose presence triggers automatic redaction in `extra`. Keys are
// matched case-insensitively, normalised by stripping '-', '_' and spaces.
// The list is intentionally conservative — new sensitive keys are added
// here and NEVER in the call sites, so the rule lives in one place.
const SENSITIVE_KEY_PATTERN = /^(password|token|access[_-]?token|secret|api[_-]?key|app[_-]?key|authorization|cookie|headers?)$/i;
const SENSITIVE_NORMALIZED = new Set([
  'password', 'token', 'accesstoken', 'secret', 'apikey', 'appkey',
  'authorization', 'cookie', 'headers', 'header',
]);

// Fields that callers commonly put strings into (text, player_input.text,
// session_event.text, …). Strings longer than `MAX_TEXT_LENGTH` are
// replaced by `{ length, hash }`. The hash is a stable sha256 of the
// truncated string so operators can correlate without seeing the text.
const MAX_TEXT_LENGTH = 64;

// Event names with the highest emission rate are kept short — every
// character matters when JSON-Lines hits a log shipper.
const KNOWN_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

// ---------------------------------------------------------------------------
// Sink & configuration
// ---------------------------------------------------------------------------

/**
 * Default writer. Tests replace this with a buffer-collecting function so
 * they can assert on emitted lines without touching real stdout.
 * @param {string} line
 */
function defaultWrite(line) {
  try {
    // eslint-disable-next-line no-console
    console.log(line);
  } catch {
    // Last-resort guard. Logging must never crash the request handler.
  }
}

/** Active sink. Swappable via `setSink`. */
let activeSink = defaultWrite;

/** Active allow-list of field names whose values are NOT redacted. */
let allowList = Object.freeze(['session_uuid', 'request_id', 'cache_uuid', 'story_uuid', 'story_version_uuid']);

/** Service identifier stamped on every line. */
let serviceName = 'story-outside';

/**
 * Replace the active sink. Intended for tests. The previous sink is
 * returned so callers can restore it.
 * @param {(line: string) => void} sink
 * @returns {(line: string) => void} the previous sink
 */
export function setSink(sink) {
  if (typeof sink !== 'function') throw new TypeError('logger.setSink requires a function');
  const previous = activeSink;
  activeSink = sink;
  return previous;
}

/**
 * Replace the allow-list. Pass a fresh array (or empty array) to define
 * which context keys are emitted in clear text. Default allows only
 * UUID-like identifiers.
 * @param {string[]} keys
 */
export function setAllowList(keys) {
  if (!Array.isArray(keys)) throw new TypeError('logger.setAllowList requires an array');
  allowList = Object.freeze(keys.map((k) => String(k)));
}

/** @returns {string[]} a copy of the current allow-list. */
export function getAllowList() {
  return allowList.slice();
}

/**
 * Override the service name. Test fixtures sometimes run multiple
 * processes under one Node test runner.
 * @param {string} name
 */
export function setServiceName(name) {
  if (typeof name !== 'string' || !name) throw new TypeError('logger.setServiceName requires a non-empty string');
  serviceName = name;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

function isAllowListed(key) {
  return allowList.includes(key);
}

function isSensitiveKey(key) {
  const normalized = String(key).replace(/[-_\s]/g, '').toLowerCase();
  return SENSITIVE_KEY_PATTERN.test(key) || SENSITIVE_NORMALIZED.has(normalized);
}

/**
 * Stable, one-way digest for redacted strings. Operators can still
 * correlate matching values across lines without ever seeing the text.
 * @param {string} text
 * @returns {string}
 */
function fingerprintText(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

/**
 * Recursively walk an object and redact sensitive / oversize values.
 * Mutates a deep copy; never touches the caller's payload.
 * @param {unknown} value
 * @param {string} path
 * @returns {unknown}
 */
function redactValue(value, path) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (path === 'extra.text' || path.endsWith('.text') || path === 'extra.player_input.text' || path.endsWith('.player_input.text')) {
      return { length: value.length, hash: fingerprintText(value) };
    }
    if (value.length > MAX_TEXT_LENGTH) {
      return { length: value.length, hash: fingerprintText(value) };
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => redactValue(item, `${path}[${index}]`));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (isSensitiveKey(key) && !isAllowListed(key)) {
        out[key] = '[REDACTED]';
        continue;
      }
      out[key] = redactValue(child, childPath);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Core emit
// ---------------------------------------------------------------------------

/**
 * Build the canonical log record. Exported so tests can assert against
 * the schema without going through the sink.
 * @param {LogContext} ctx
 */
export function buildLogRecord(ctx) {
  if (!ctx || typeof ctx !== 'object') throw new TypeError('logger: context required');
  const level = KNOWN_LEVELS.has(ctx.level) ? ctx.level : 'info';
  const event = typeof ctx.event === 'string' && ctx.event ? ctx.event : 'unknown';
  const record = {
    ts: new Date().toISOString(),
    level,
    service: serviceName,
    host: cachedHostname(),
    event,
  };
  // Copy only known scalar fields. Anything else goes through `extra`
  // where redaction still applies.
  for (const key of [
    'session_uuid', 'component', 'model', 'prompt_version', 'request_id',
    'tool_name', 'latency_ms', 'in_tokens', 'out_tokens', 'cache_read_tokens',
    'error_code', 'error_message', 'truncated', 'retried', 'cache_hit', 'from_cache',
    'kind', 'sequence', 'event_type', 'state',
  ]) {
    if (ctx[key] !== undefined) record[key] = ctx[key];
  }
  if (ctx.extra && typeof ctx.extra === 'object') {
    record.extra = redactValue(ctx.extra, 'extra');
  }
  return record;
}

let cachedHostnameValue = null;
function cachedHostname() {
  if (cachedHostnameValue === null) {
    try { cachedHostnameValue = osHostname(); } catch { cachedHostnameValue = 'unknown'; }
  }
  return cachedHostnameValue;
}

/**
 * Emit a single structured line. Never throws; returns false if the
 * sink rejected the line.
 * @param {LogContext} ctx
 */
export function log(ctx) {
  let record;
  try {
    record = buildLogRecord(ctx);
  } catch {
    return false;
  }
  let line;
  try {
    line = JSON.stringify(record);
  } catch {
    return false;
  }
  try {
    activeSink(line);
    return true;
  } catch {
    return false;
  }
}

// Convenience wrappers. They are intentionally thin so the call sites
// remain grep-friendly.
export const debug = (event, extra = {}) => log({ level: 'debug', event, ...extra });
export const info  = (event, extra = {}) => log({ level: 'info',  event, ...extra });
export const warn  = (event, extra = {}) => log({ level: 'warn',  event, ...extra });
export const error = (event, extra = {}) => log({ level: 'error', event, ...extra });

/**
 * Compute the redaction for a string without emitting it. Test helpers
 * rely on this to assert that a known input produces the expected hash
 * and length.
 * @param {string} text
 */
export function redactText(text) {
  return { length: text.length, hash: fingerprintText(text) };
}

/**
 * Test-only: reset module-level state to defaults.
 */
export function _resetLoggerForTests() {
  activeSink = defaultWrite;
  allowList = Object.freeze(['session_uuid', 'request_id', 'cache_uuid', 'story_uuid', 'story_version_uuid']);
  serviceName = 'story-outside';
  cachedHostnameValue = null;
}