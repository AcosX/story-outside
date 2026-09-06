// src/providers/ecosystem/zhihuKnowledgeSource.mjs — ClickUp 16.5 (v2
// rebuild on current main, NOT a54aebd).
//
// Real knowledge provider for the public POST /v1/ecosystem/knowledge
// façade. Per the ClickUp 16.5 task notes:
//
//   "**当前没完整 endpoint/字段契约**" — the upstream URL and the
//   response shape are NOT finalised. The provider MUST NOT hard-code
//   any endpoint or pretend to honour a contract we do not have.
//
// ChatGPT review P1.v2 (2026-09-07 02:23) explicitly flagged the old
// PR #25 (a54aebd) for using `query_id` (a stable identifier inside
// the canonical profile) as the upstream subject — meaning two
// completely different canonical queries with two completely
// different `q.query` strings resolved to the same upstream cache
// row. This v2 source MUST consume the `query` string verbatim:
//
//   * `fetchKnowledge({ query, limit })` — the query string is part
//     of the URL query so a slow upstream / log / cache layer can
//     demonstrate the query was actually the subject of the call.
//   * The provider has no concept of `query_id` / `topic_id` /
//     `topic_label` / `theme` / `subject`. Those free-form surface
//     fields are explicitly banned by the P1.v2 whitelist.
//
// ChatGPT review P1 also flagged the old PR #15 for pre-baking a
// fake URL into the source code. We respect that constraint at three
// layers:
//
//   1. The base URL is sourced from the `ZHIHU_KNOWLEDGE_ENDPOINT`
//      environment variable and only. When the variable is unset,
//      empty, or whitespace, the provider factory raises
//      `unconfigured` so the orchestrator can fall back to the mock.
//   2. There is no default URL — `DEFAULT_BASE_URL = ''` is empty,
//      never `https://api.zhihu.com/km-indep-home/...`. The route
//      layer never sees a real URL until an operator sets the env
//      var with the final contract.
//   3. The response normaliser is generic. It accepts ANY JSON shape
//      that exposes an `entries` / `data` / `items` array (in that
//      preference order) or any top-level array; per-entry it only
//      reads `id` + `title` + `summary|excerpt|content` + `url|link`
//      + `related_topics|labels|topics`. We do NOT pretend the
//      upstream is the same shape as the eventual hackathon
//      knowledge contract — the normaliser is forgiving so a future
//      contract change does not require a code change here.
//
// Hard rules (do not relax without a contract document):
//   * No Access Secret. No OAuth. No Authorization / X-OAuth-Token.
//   * The default timeout (5 s) and the default byte cap (1 MiB) are
//     generous for a JSON list endpoint; both are overridable via
//     env (`ZHIHU_KNOWLEDGE_TIMEOUT_MS`, `ZHIHU_KNOWLEDGE_MAX_BYTES`).
//   * The body never contains an embedded credential.
//   * The fetch is wrapped in `AbortController` so a slow upstream
//     cannot block the public façade forever.
//   * Errors never echo the upstream response body. The route layer
//     sees only a typed `ProviderError`.

import { ProviderError, ValidationError } from '../dto.mjs';

const ENV_BASE_URL = 'ZHIHU_KNOWLEDGE_ENDPOINT';
const ENV_TIMEOUT_MS = 'ZHIHU_KNOWLEDGE_TIMEOUT_MS';
const ENV_MAX_BYTES = 'ZHIHU_KNOWLEDGE_MAX_BYTES';
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 1024 * 1024;

const SURFACE_DISCLAIMER = '以下内容属于现实/知乎知识延伸，不是原作设定或 AI 世界线事实';

/**
 * Read a positive integer env var; falls back to `fallback` on missing /
 * non-numeric / negative / NaN values.
 *
 * @param {string|undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
function readIntEnv(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/**
 * Read the configured base URL out of env. Empty string when unset —
 * never a default placeholder URL.
 *
 * @returns {string}
 */
export function readKnowledgeBaseUrl() {
  const raw = typeof process !== 'undefined' && process.env
    ? process.env[ENV_BASE_URL]
    : undefined;
  if (typeof raw !== 'string') return '';
  return raw.trim();
}

/**
 * Identity string of this source for diagnostics.
 * @returns {string}
 */
export function knowledgeSourceName() {
  return 'real';
}

/**
 * Pull a string field out of an unknown upstream entry, falling back
 * through common alternates.
 *
 * @param {Record<string, unknown>} obj
 * @param {string[]} keys
 * @returns {string}
 */
function pickString(obj, keys) {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

/**
 * Normalise a single upstream entry. We only ever read five logical
 * fields so a future upstream contract change does not break the
 * normalisation layer.
 *
 * @param {Record<string, unknown>} raw
 * @returns {{
 *   id: string,
 *   title: string,
 *   summary: string,
 *   source: string,
 *   url: string,
 *   related_topics: string[],
 *   disclaimer: string,
 * }}
 */
function normaliseEntry(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError('normaliseEntry: entry must be an object');
  }
  const obj = /** @type {Record<string, unknown>} */ (raw);
  const related = pickStringArray(obj, ['related_topics', 'labels', 'topics']);
  return {
    id: pickString(obj, ['id', 'entry_id', 'uuid']) || 'unknown',
    title: pickString(obj, ['title', 'name', 'subject']) || '(无标题)',
    summary: pickString(obj, ['summary', 'excerpt', 'content', 'snippet']) || '',
    source: pickString(obj, ['source', 'site']) || 'zhihu-knowledge-real',
    url: pickString(obj, ['url', 'link', 'href']) || '',
    related_topics: related,
    disclaimer: SURFACE_DISCLAIMER,
  };
}

/**
 * Pull a string[] field out of an unknown upstream entry.
 *
 * @param {Record<string, unknown>} obj
 * @param {string[]} keys
 * @returns {string[]}
 */
function pickStringArray(obj, keys) {
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) {
      const strings = value.filter((v) => typeof v === 'string');
      if (strings.length > 0) return strings;
    }
  }
  return [];
}

/**
 * Extract the entry array from an unknown upstream payload. We try
 * `entries` first, then `data`, then `items`, then any top-level
 * array. Anything else → ValidationError.
 *
 * @param {unknown} payload
 * @returns {ReadonlyArray<Record<string, unknown>>}
 */
function extractEntries(payload) {
  if (Array.isArray(payload)) {
    return /** @type {Record<string, unknown>[]} */ (payload);
  }
  if (!payload || typeof payload !== 'object') {
    throw new ValidationError('extractEntries: payload must be an array or object');
  }
  const obj = /** @type {Record<string, unknown>} */ (payload);
  for (const key of ['entries', 'data', 'items']) {
    const value = obj[key];
    if (Array.isArray(value)) {
      return /** @type {Record<string, unknown>[]} */ (value);
    }
  }
  throw new ValidationError(
    'extractEntries: payload does not expose entries / data / items array',
  );
}

/**
 * Build the real source factory. Returns a controller object exposing
 * `isConfigured`, `baseUrl`, and `fetchKnowledge`. The orchestrator
 * never calls upstream directly.
 *
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]   Test injection.
 * @param {string} [opts.baseUrl]          Test injection.
 * @param {number} [opts.timeoutMs]        Test injection.
 * @param {number} [opts.maxBytes]         Test injection.
 * @returns {{
 *   isConfigured: () => boolean,
 *   baseUrl: () => string | null,
 *   fetchKnowledge: (input: { query: string, limit?: number }) => Promise<ReadonlyArray<{
 *     id: string, title: string, summary: string, source: string,
 *     url: string, related_topics: string[], disclaimer: string,
 *   }>>,
 *   name: () => string,
 * }}
 */
export function createRealZhihuKnowledgeProvider(opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const explicitBaseUrl = typeof opts.baseUrl === 'string' && opts.baseUrl.trim()
    ? opts.baseUrl.trim()
    : null;
  const configuredBaseUrl = explicitBaseUrl || readKnowledgeBaseUrl();
  const timeoutMs = readIntEnv(
    typeof process !== 'undefined' && process.env && process.env[ENV_TIMEOUT_MS],
    typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS,
  );
  const maxBytes = readIntEnv(
    typeof process !== 'undefined' && process.env && process.env[ENV_MAX_BYTES],
    typeof opts.maxBytes === 'number' && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_BYTES,
  );

  /**
   * @returns {boolean}
   */
  function isConfigured() {
    return typeof configuredBaseUrl === 'string' && configuredBaseUrl.length > 0;
  }

  /**
   * @returns {string | null}
   */
  function baseUrl() {
    return configuredBaseUrl;
  }

  /**
   * Fetch the upstream knowledge list for a SINGLE canonical query.
   * The query string is appended to the configured base URL as
   * `?q=<encoded>` so the upstream cache / log / CDN can demonstrate
   * the query was actually the subject of the call. When the
   * provider is unconfigured, throws `unconfigured` so the caller
   * can decide to fall back to the mock.
   *
   * @param {{ query: string, limit?: number }} input
   * @returns {Promise<ReadonlyArray<{
   *   id: string, title: string, summary: string, source: string,
   *   url: string, related_topics: string[], disclaimer: string,
   * }>>}
   */
  async function fetchKnowledge(input = {}) {
    if (!isConfigured()) {
      throw new ProviderError(
        'unconfigured',
        'Real knowledge provider is not configured. Set ZHIHU_KNOWLEDGE_ENDPOINT to enable.',
        { envKey: ENV_BASE_URL },
      );
    }
    if (!fetchImpl || typeof fetchImpl !== 'function') {
      throw new ProviderError(
        'fetch_unavailable',
        'No fetch implementation is available in this runtime.',
      );
    }
    if (!input || typeof input !== 'object') {
      throw new ValidationError('fetchKnowledge: input required');
    }
    if (typeof input.query !== 'string' || !input.query) {
      throw new ValidationError('fetchKnowledge: query required');
    }
    const limit = Number.isInteger(input.limit) && input.limit > 0
      ? Math.min(input.limit, 32)
      : 4;

    const url = new URL(configuredBaseUrl);
    url.searchParams.set('q', input.query);
    url.searchParams.set('limit', String(limit));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url.toString(), {
        method: 'GET',
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response || !response.ok) {
        throw new ProviderError(
          'upstream_failure',
          `Knowledge upstream returned HTTP ${response && response.status ? response.status : 'no-response'}.`,
        );
      }
      // Hard cap on body size — refuse to read past `maxBytes` even
      // if the upstream forgets Content-Length.
      const reader = response.body && typeof response.body.getReader === 'function'
        ? response.body.getReader()
        : null;
      let total = 0;
      let payloadText = '';
      if (reader) {
        const decoder = new TextDecoder();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            throw new ProviderError(
              'upstream_too_large',
              `Knowledge upstream exceeded ${maxBytes} bytes; refusing to buffer.`,
            );
          }
          payloadText += decoder.decode(value, { stream: true });
        }
        payloadText += decoder.decode();
      } else if (typeof response.text === 'function') {
        payloadText = await response.text();
        if (payloadText.length > maxBytes) {
          throw new ProviderError(
            'upstream_too_large',
            `Knowledge upstream exceeded ${maxBytes} bytes; refusing to buffer.`,
          );
        }
      } else {
        throw new ProviderError(
          'fetch_unreadable',
          'Knowledge upstream body is not readable in this runtime.',
        );
      }
      let payload;
      try {
        payload = JSON.parse(payloadText);
      } catch (err) {
        throw new ProviderError(
          'upstream_bad_json',
          'Knowledge upstream returned non-JSON.',
        );
      }
      const entries = extractEntries(payload).map(normaliseEntry);
      return Object.freeze(entries.map((e) => Object.freeze(e)));
    } catch (err) {
      if (err instanceof ProviderError || err instanceof ValidationError) throw err;
      if (err && err.name === 'AbortError') {
        throw new ProviderError(
          'upstream_timeout',
          `Knowledge upstream aborted after ${timeoutMs}ms.`,
        );
      }
      throw new ProviderError(
        'upstream_failure',
        err && err.message ? String(err.message) : 'Real knowledge provider failed.',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    isConfigured,
    baseUrl,
    fetchKnowledge,
    name: knowledgeSourceName,
  });
}

/**
 * Real knowledge source config (frozen for tests / diagnostics).
 */
export const REAL_KNOWLEDGE_SOURCE_CONFIG = Object.freeze({
  name: 'real',
  envKey: ENV_BASE_URL,
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  defaultMaxBytes: DEFAULT_MAX_BYTES,
  surfaceDisclaimer: SURFACE_DISCLAIMER,
});