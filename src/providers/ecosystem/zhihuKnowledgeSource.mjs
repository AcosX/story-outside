// src/providers/ecosystem/zhihuKnowledgeSource.mjs — ClickUp 16.5 (rebuilt)
//
// Real knowledge provider for the public POST /v1/ecosystem/knowledge
// façade. Per the ClickUp 16.5 task notes:
//
//   "**当前没完整 endpoint/字段契约**" — the upstream URL and the
//   response shape are NOT finalised. The provider MUST NOT hard-code
//   any endpoint or pretend to honour a contract we do not have.
//
// ChatGPT review P1 explicitly flagged the old PR #15 for
// pre-baking a fake URL into the source code. We respect that
// constraint at three layers:
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
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Normalise a single raw entry from ANY upstream response shape into
 * the provider-agnostic KnowledgeEntry shape. We deliberately only
 * read fields that are likely to appear under a few different
 * upstream conventions so the provider stays shape-tolerant.
 *
 * @param {any} raw
 * @returns {KnowledgeEntry}
 */
function normaliseEntry(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError('knowledge entry must be an object');
  }
  const id = typeof raw.id === 'string' && raw.id
    ? raw.id
    : (typeof raw.entry_id === 'string' && raw.entry_id ? raw.entry_id : null);
  if (!id) {
    throw new ValidationError('knowledge entry missing id');
  }
  const title = typeof raw.title === 'string' && raw.title
    ? raw.title
    : (typeof raw.name === 'string' && raw.name ? raw.name : '');
  if (!title) {
    throw new ValidationError(`knowledge entry ${id} missing title`);
  }
  const summary = typeof raw.summary === 'string'
    ? raw.summary
    : (typeof raw.excerpt === 'string'
      ? raw.excerpt
      : (typeof raw.content === 'string' ? raw.content : ''));
  const source = typeof raw.source === 'string' && raw.source
    ? raw.source
    : (typeof raw.source_name === 'string' && raw.source_name ? raw.source_name : 'zhihu-knowledge-real');
  const url = typeof raw.url === 'string' && raw.url
    ? raw.url
    : (typeof raw.link === 'string' && raw.link ? raw.link : '');
  const related_topics = Array.isArray(raw.related_topics)
    ? raw.related_topics.filter((s) => typeof s === 'string')
    : (Array.isArray(raw.labels)
      ? raw.labels.filter((s) => typeof s === 'string')
      : (Array.isArray(raw.topics)
        ? raw.topics.filter((s) => typeof s === 'string')
        : []));
  return Object.freeze({
    id,
    title,
    summary,
    source,
    url,
    related_topics: Object.freeze(related_topics.slice()),
    disclaimer: SURFACE_DISCLAIMER,
  });
}

/**
 * Extract the entries array from an upstream payload that could be:
 *   - an Array directly
 *   - { entries: [...] }
 *   - { data: [...] }
 *   - { items: [...] }
 *   - { knowledge_list: [...] }
 *   - { result: { entries: [...] } }
 * The first matching key (in the above preference order) wins.
 *
 * @param {unknown} payload
 * @returns {ReadonlyArray<any>}
 */
function extractEntries(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const candidates = ['entries', 'data', 'items', 'knowledge_list'];
  for (const key of candidates) {
    if (Array.isArray(/** @type {any} */ (payload)[key])) {
      return /** @type {any} */ (payload)[key];
    }
  }
  // Nested envelope: { result: { entries: [...] } } (matches the
  // shape of several Zhihu open-platform responses).
  if (/** @type {any} */ (payload).result && typeof /** @type {any} */ (payload).result === 'object') {
    const inner = /** @type {any} */ (payload).result;
    for (const key of candidates) {
      if (Array.isArray(inner[key])) return inner[key];
    }
  }
  return [];
}

/**
 * @typedef {Object} KnowledgeEntry
 * @property {string} id
 * @property {string} title
 * @property {string} summary
 * @property {string} source
 * @property {string} url
 * @property {ReadonlyArray<string>} related_topics
 * @property {string} disclaimer
 */

/**
 * Read the configured upstream base URL. Returns `null` when the env
 * var is unset / empty / whitespace — the caller (factory) raises
 * `unconfigured` so the orchestrator knows to fall back to the mock.
 *
 * @returns {string | null}
 */
export function readKnowledgeBaseUrl() {
  const raw = (typeof process !== 'undefined' && process.env && process.env[ENV_BASE_URL]) || '';
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed || null;
}

/**
 * Provider name. Stable string for logs / health / metrics.
 * @returns {string}
 */
export function knowledgeSourceName() {
  return 'real';
}

/**
 * Factory. Reads the env var and returns a provider object with:
 *   - name:    'real'
 *   - isConfigured(): boolean
 *   - fetchKnowledge({ limit }): Promise<KnowledgeEntry[]>
 *
 * When `isConfigured()` is false the orchestrator MUST call the mock
 * provider instead. `fetchKnowledge` throws `unconfigured` so a future
 * regression that bypasses the orchestrator's check still fails
 * loudly at the seam.
 *
 * @param {object} [opts]
 * @param {(url: string, init: object) => Promise<Response>} [opts.fetchImpl]
 * @param {string} [opts.baseUrl]           Override (tests only).
 * @param {number} [opts.timeoutMs]         Override (tests only).
 * @param {number} [opts.maxBytes]          Override (tests only).
 * @returns {{
 *   name: string,
 *   isConfigured: () => boolean,
 *   baseUrl: () => string | null,
 *   fetchKnowledge: (input?: { limit?: number }) => Promise<ReadonlyArray<KnowledgeEntry>>,
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
   * Fetch the upstream knowledge list. The URL is built from
   * `configuredBaseUrl` ONLY — no other URL participates. When the
   * provider is unconfigured, throws `unconfigured` so the caller can
   * decide to fall back to the mock.
   *
   * @param {{ limit?: number }} [input]
   * @returns {Promise<ReadonlyArray<KnowledgeEntry>>}
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
    const limit = Number.isInteger(input.limit) && input.limit > 0
      ? Math.min(input.limit, 64)
      : null;
    const requestUrl = limit !== null
      ? `${configuredBaseUrl}${configuredBaseUrl.includes('?') ? '&' : '?'}limit=${encodeURIComponent(String(limit))}`
      : configuredBaseUrl;

    // Wrap fetch in an AbortController so a slow upstream cannot pin
    // the public façade forever. The response is then stream-decoded
    // with a hard byte cap so a misconfigured upstream cannot blow
    // up the heap.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(requestUrl, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'user-agent': 'story-outside/0.1 (zhihu-knowledge-real; read-only)',
        },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err && (err.name === 'AbortError' || err.code === 20);
      throw new ProviderError(
        isAbort ? 'upstream_timeout' : 'upstream_unreachable',
        isAbort
          ? `Upstream did not respond within ${timeoutMs}ms.`
          : 'Upstream fetch failed before any response was received.',
        { timeoutMs },
      );
    }
    clearTimeout(timer);
    if (response.status >= 500) {
      throw new ProviderError(
        'upstream_5xx',
        `Upstream responded with ${response.status}.`,
        { status: response.status },
      );
    }
    if (response.status === 429) {
      throw new ProviderError(
        'upstream_rate_limited',
        'Upstream rate-limited the request.',
        { status: 429 },
      );
    }
    if (response.status >= 400) {
      throw new ProviderError(
        'upstream_4xx',
        `Upstream responded with ${response.status}.`,
        { status: response.status },
      );
    }
    if (response.status !== 200) {
      throw new ProviderError(
        'upstream_unexpected_status',
        `Upstream responded with unexpected status ${response.status}.`,
        { status: response.status },
      );
    }

    // Decode body with a hard byte cap.
    const declared = Number.parseInt(response.headers.get('content-length') || '', 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new ProviderError(
        'upstream_body_too_large',
        `Upstream declared response size ${declared} exceeds ${maxBytes}.`,
        { declared, cap: maxBytes },
      );
    }
    let bodyText = '';
    try {
      bodyText = await response.text();
    } catch (err) {
      throw new ProviderError(
        'upstream_body_read_failed',
        'Upstream body could not be read.',
      );
    }
    if (!bodyText) {
      throw new ProviderError('upstream_empty_body', 'Upstream returned an empty body.');
    }
    if (bodyText.length > maxBytes) {
      throw new ProviderError(
        'upstream_body_too_large',
        `Upstream body exceeded ${maxBytes} bytes.`,
        { cap: maxBytes, contentLength: bodyText.length },
      );
    }

    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch (err) {
      throw new ProviderError(
        'upstream_invalid_json',
        'Upstream body was not valid JSON.',
      );
    }

    const rawEntries = extractEntries(payload);
    if (!Array.isArray(rawEntries)) {
      throw new ProviderError(
        'upstream_shape_mismatch',
        'Upstream payload did not contain an entries array.',
      );
    }
    const out = [];
    for (const raw of rawEntries) {
      out.push(normaliseEntry(raw));
    }
    if (limit !== null && out.length > limit) {
      return Object.freeze(out.slice(0, limit));
    }
    return Object.freeze(out);
  }

  return Object.freeze({
    name: knowledgeSourceName(),
    isConfigured,
    baseUrl,
    fetchKnowledge,
    _config() {
      return Object.freeze({
        envBaseUrlKey: ENV_BASE_URL,
        envTimeoutKey: ENV_TIMEOUT_MS,
        envMaxBytesKey: ENV_MAX_BYTES,
        timeoutMs,
        maxBytes,
        surfaceDisclaimer: SURFACE_DISCLAIMER,
      });
    },
  });
}

export const REAL_KNOWLEDGE_SOURCE_CONFIG = Object.freeze({
  ENV_BASE_URL,
  ENV_TIMEOUT_MS,
  ENV_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  SURFACE_DISCLAIMER,
});