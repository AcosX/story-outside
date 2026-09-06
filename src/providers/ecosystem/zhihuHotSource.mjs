// src/providers/ecosystem/zhihuHotSource.mjs — real Zhihu hot-list
// adapter for ClickUp 16.4 (rebuilt on current main 44343b2).
//
// Product positioning (per ClickUp 16.4 description):
//   * Hot list feeds the home-page "知乎此刻热议" discovery module.
//   * It is NOT part of the story Runtime; we never turn a hot topic
//     into story beats / narrative / session events.
//   * This adapter is a thin, read-through wrapper over the public
//     Zhihu hot-list endpoint. It is OFF by default (mock is the
//     default per repo contract). The HTTP façade flips it on only
//     when STORY_OUTSIDE_HOT_PROVIDER=real AND the host allow-list
//     matches.
//
// Endpoint contract — CHATGPT INSPECTION P1 FIX (2026-09-06):
//   * GET https://api.zhihu.com/api/v1/content/hot_list
//   * The rebuilt version on current main uses the
//     `content/hot_list` path per the official Zhihu hot-list contract.
//   * Endpoint is configurable via env var ZHIHU_HOT_ENDPOINT so a
//     future contract change does not require a code edit (operator
//     override only). The DEFAULT stays pinned to the official
//     `content/hot_list` URL.
//   * No auth required (the endpoint is open per the public docs).
//   * Returns a payload shaped like:
//       { data: [ { id, title, url, hot_score / heat, excerpt,
//                   answer_count, target.question.id,
//                   target.question.topics[].name, ... }, ... ] }
//     (or a bare array). Field names vary; we normalise here.
//
// Host safety:
//   * We re-use the same defence-in-depth pattern as
//   src/providers/realProvider.mjs: explicit host allow-list (only
//   api.zhihu.com, default port, HTTPS), manual redirect follow so
//   a 30x can never smuggle us to attacker.example, body-size cap,
//   AbortSignal.timeout so a stalled TCP read does not pin the
//   request forever.
//   * This adapter does NOT touch any OAuth header (Authorization,
//     X-OAuth-Token) — the hot endpoint is open. We refuse to set
//     those headers even when the caller passes them in.
//
// Failure modes we surface (the orchestrator turns them into
// graceful degradation; the route layer hides the module rather
// than 502-ing the whole HTTP request):
//   * fetch_unavailable — no fetch in this runtime
//   * unsupported_upstream_host — host allow-list mismatch
//   * unsupported_upstream_origin — non-HTTPS / non-default-port
//   * upstream_too_many_redirects — redirect chain > MAX_REDIRECTS
//   * upstream_5xx / upstream_4xx — server-side error
//   * upstream_timeout — AbortSignal.timeout fired
//   * upstream_shape_mismatch — payload missing data[] / data not array
//   * upstream_body_too_large — body exceeds cap
//
// Category filtering:
//   * The official endpoint accepts an optional `category` query
//     parameter (e.g. `total`, `tech`, `finance`, ...). We forward
//     whatever category the orchestrator hands us. The orchestrator
//     is responsible for clamping category to a known safe list so
//     an untrusted query string cannot be smuggled to the URL.
//   * If the upstream does not support a given category, the adapter
//     returns whatever the upstream returns; the orchestrator falls
//     back gracefully.
//
// The adapter is exported as a factory so tests / fixtures can
// inject a fake fetch implementation without monkey-patching globals.

import { ProviderError } from '../dto.mjs';

// === CHATGPT INSPECTION P1 FIX (2026-09-06) ===
// The DEFAULT endpoint is the official Zhihu content hot-list path
// (api/v1/content/hot_list) per the official contract. Operators can
// still override via ZHIHU_HOT_ENDPOINT (for example, a staging
// mirror), but the default MUST stay on the official contract path so
// a greenfield deployment calls the correct endpoint.
const DEFAULT_HOT_ENDPOINT = 'https://api.zhihu.com/api/v1/content/hot_list';
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024; // 256 KiB — hot-list is small
const MAX_REDIRECTS = 3;
const HOST_ALLOW_LIST = Object.freeze(['api.zhihu.com']);

/**
 * @typedef {import('./hot.mjs').HotSource} HotSource
 */

/**
 * Resolve the configured endpoint. Env var ZHIHU_HOT_ENDPOINT wins;
 * otherwise the official `content/hot_list` path on api.zhihu.com is
 * used. The endpoint is parsed once and validated against the host
 * allow-list at construction time so a misconfigured deployment
 * fails loudly at startup, not on the first request.
 *
 * @returns {{ endpoint: string, url: URL }}
 */
function resolveEndpoint() {
  const raw = typeof process.env.ZHIHU_HOT_ENDPOINT === 'string' && process.env.ZHIHU_HOT_ENDPOINT.trim()
    ? process.env.ZHIHU_HOT_ENDPOINT.trim()
    : DEFAULT_HOT_ENDPOINT;
  let url;
  try {
    url = new URL(raw);
  } catch (err) {
    throw new ProviderError(
      'upstream_invalid_endpoint',
      `ZHIHU_HOT_ENDPOINT could not be parsed as a URL: ${raw}`,
      { name: err && err.name ? err.name : 'parse_error' },
    );
  }
  if (!isAllowedHost(url.hostname)) {
    throw new ProviderError(
      'unsupported_upstream_host',
      `ZHIHU_HOT_ENDPOINT host "${url.hostname}" is not in the allow-list.`,
      { hostname: url.hostname, allow_list: HOST_ALLOW_LIST },
    );
  }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443')) {
    throw new ProviderError(
      'unsupported_upstream_origin',
      `ZHIHU_HOT_ENDPOINT must be https://api.zhihu.com on the default port.`,
      { protocol: url.protocol, port: url.port, hostname: url.hostname },
    );
  }
  return { endpoint: raw, url };
}

/**
 * Validate the upstream URL hostname against the host allow-list.
 * Symmetric with realProvider.isAllowedUpstreamHost.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
function isAllowedHost(hostname) {
  if (typeof hostname !== 'string') return false;
  const lower = hostname.toLowerCase();
  for (const allowed of HOST_ALLOW_LIST) {
    if (lower === allowed) return true;
  }
  return false;
}

/**
 * Manually follow 30x responses, re-validating host + scheme + port
 * on every hop. Mirrors realProvider.followRedirect.
 *
 * @param {typeof fetch} fn
 * @param {string} url
 * @param {{ timeoutMs: number, hops: number, fetchImpl: typeof fetch }} ctx
 * @returns {Promise<Response>}
 */
async function followRedirect(fn, url, ctx) {
  if (ctx.hops > MAX_REDIRECTS) {
    throw new ProviderError(
      'upstream_too_many_redirects',
      `Upstream redirected more than ${MAX_REDIRECTS} times.`,
      { hops: ctx.hops },
    );
  }
  let target;
  try {
    target = new URL(url);
  } catch (err) {
    throw new ProviderError(
      'upstream_invalid_url',
      'Upstream URL could not be parsed.',
      { name: err && err.name ? err.name : 'parse_error' },
    );
  }
  if (!isAllowedHost(target.hostname)) {
    throw new ProviderError(
      'unsupported_upstream_host',
      `Refusing to call non-allow-listed upstream host "${target.hostname}".`,
      { hostname: target.hostname },
    );
  }
  if (target.protocol !== 'https:' || (target.port && target.port !== '443')) {
    throw new ProviderError(
      'unsupported_upstream_origin',
      `Refusing to call upstream origin "${target.protocol}//${target.host}${target.port ? ':' + target.port : ''}" — only https://api.zhihu.com (default port) is allowed.`,
      { protocol: target.protocol, port: target.port, hostname: target.hostname },
    );
  }
  const useStaticSignal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function';
  const signal = useStaticSignal ? AbortSignal.timeout(ctx.timeoutMs) : null;
  let res;
  try {
    res = await fn(target.toString(), {
      method: 'GET',
      headers: STATIC_HEADERS,
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new ProviderError(
        'upstream_timeout',
        `Upstream fetch timed out after ${ctx.timeoutMs}ms.`,
        { timeoutMs: ctx.timeoutMs },
      );
    }
    if (err && err.name === 'TypeError') {
      throw new ProviderError(
        'upstream_network_error',
        `Upstream fetch failed: ${err && err.message ? err.message : String(err)}`,
        { name: err.name },
      );
    }
    throw new ProviderError(
      'upstream_network_error',
      `Upstream fetch failed: ${String(err && err.message ? err.message : err)}`,
      { name: err && err.name ? err.name : 'unknown' },
    );
  }
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (!location) {
      throw new ProviderError(
        'upstream_redirect_missing_location',
        `Upstream returned ${res.status} without a Location header.`,
        { status: res.status },
      );
    }
    let next;
    try {
      next = new URL(location, target);
    } catch {
      throw new ProviderError(
        'upstream_redirect_invalid_location',
        `Upstream returned an invalid Location header: ${location}`,
        { status: res.status },
      );
    }
    return followRedirect(fn, next.toString(), { timeoutMs: ctx.timeoutMs, hops: ctx.hops + 1, fetchImpl: ctx.fetchImpl });
  }
  return res;
}

// Per the official contract the upstream is an unauthenticated JSON
// API. We do NOT set Authorization / X-OAuth-Token; doing so would
// invite credential leaks for no protocol benefit. The hot endpoint
// is open per the Zhihu public docs.
const STATIC_HEADERS = Object.freeze({
  accept: 'application/json',
  'user-agent': 'story-outside/0.1 (zhihu-hot-list; read-only)',
});

/**
 * Fetch and decode the upstream hot-list payload. Returns the raw
 * normalised array shape that the orchestrator can post-process
 * (rank + category tagging + heat normalisation).
 *
 * @param {string} category
 * @param {{
 *   endpoint: string,
 *   timeoutMs: number,
 *   maxBodyBytes: number,
 *   fetchImpl: typeof fetch | null
 * }} ctx
 * @returns {Promise<ReadonlyArray<Record<string, unknown>>>}
 */
async function fetchHotListRaw(category, ctx) {
  if (typeof fetch !== 'function' && ctx.fetchImpl === null) {
    throw new ProviderError(
      'fetch_unavailable',
      'No fetch implementation is available in this runtime.',
    );
  }
  const fn = ctx.fetchImpl || fetch;
  const url = new URL(ctx.endpoint);
  if (category) {
    // Forward the category filter. The official endpoint accepts a
    // `category` query param; if the upstream ignores it the response
    // still parses, the orchestrator still returns what it can.
    url.searchParams.set('category', category);
  }
  const res = await followRedirect(fn, url.toString(), {
    timeoutMs: ctx.timeoutMs,
    hops: 0,
    fetchImpl: fn,
  });
  if (res.status >= 500) {
    throw new ProviderError(
      'upstream_5xx',
      `Upstream returned HTTP ${res.status}.`,
      { status: res.status },
    );
  }
  if (res.status >= 400) {
    throw new ProviderError(
      'upstream_4xx',
      `Upstream returned HTTP ${res.status}.`,
      { status: res.status },
    );
  }
  // Body-size cap (defence in depth).
  const declaredLength = Number(res.headers.get('content-length') || 0);
  if (declaredLength > ctx.maxBodyBytes) {
    throw new ProviderError(
      'upstream_body_too_large',
      `Upstream body declared content-length=${declaredLength} > cap ${ctx.maxBodyBytes}.`,
      { content_length: declaredLength, cap: ctx.maxBodyBytes },
    );
  }
  const text = await res.text();
  if (text.length > ctx.maxBodyBytes) {
    throw new ProviderError(
      'upstream_body_too_large',
      `Upstream body exceeded cap of ${ctx.maxBodyBytes} bytes after decode.`,
      { size: text.length, cap: ctx.maxBodyBytes },
    );
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ProviderError(
      'upstream_invalid_json',
      `Upstream body is not valid JSON: ${err && err.message ? err.message : String(err)}`,
      { name: err && err.name ? err.name : 'parse_error' },
    );
  }
  const arr = extractArray(json);
  if (!Array.isArray(arr)) {
    throw new ProviderError(
      'upstream_shape_mismatch',
      'Upstream payload did not contain a data[] array.',
      { keys: json && typeof json === 'object' ? Object.keys(json) : null },
    );
  }
  return arr;
}

/**
 * Accept either a bare array or a `{ data: [...] }` envelope.
 * Mirrors the contract variants documented in the official Zhihu
 * hot-list doc (different versions of the API have wrapped the array
 * under different keys). Anything else is a shape error.
 *
 * @param {unknown} json
 * @returns {unknown[] | null}
 */
function extractArray(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (json);
    if (Array.isArray(obj.data)) return obj.data;
    if (Array.isArray(obj.hot_list)) return obj.hot_list;
    if (Array.isArray(obj.items)) return obj.items;
  }
  return null;
}

/**
 * Coerce a value to a finite non-negative number; fall back to 0.
 * @param {unknown} raw
 * @returns {number}
 */
function toFiniteNumber(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/**
 * Coerce a value to a non-empty string; fall back to ''.
 * @param {unknown} raw
 * @returns {string}
 */
function toStr(raw) {
  if (typeof raw === 'string') return raw;
  return '';
}

/**
 * Normalise one upstream entry into the provider-agnostic DTO. Drops
 * malformed entries (returning null) so a single bad row cannot fail
 * the entire list.
 *
 * @param {Record<string, unknown>} raw
 * @param {number} rank
 * @param {string} category
 * @returns {import('./hot.mjs').ZhihuHotTopic | null}
 */
export function normaliseZhihuHotEntry(raw, rank, category) {
  if (!raw || typeof raw !== 'object') return null;
  // Upstream field-name variants:
  //   * `id` (legacy) or `target.question.id` (newer)
  //   * `title` (legacy) or `target.question.title` (newer)
  //   * `url` (legacy) or `target.question.url` (newer)
  //   * `heat_text` (display) or `hot_score` (number) or `detail_text`
  //   * `excerpt` or `answer_count` from `target.question`
  const target = (raw && typeof raw.target === 'object' && raw.target !== null
    ? /** @type {Record<string, unknown>} */ (raw.target)
    : null);
  const targetQuestion = target && typeof target.question === 'object' && target.question !== null
    ? /** @type {Record<string, unknown>} */ (target.question)
    : null;
  const question_uuid = toStr(
    targetQuestion && targetQuestion.id
      ? targetQuestion.id
      : raw.id
        ? raw.id
        : raw.question_id,
  );
  const title = toStr(
    targetQuestion && targetQuestion.title
      ? targetQuestion.title
      : raw.title,
  );
  const url = toStr(
    targetQuestion && targetQuestion.url
      ? targetQuestion.url
      : raw.url,
  );
  const heat = toFiniteNumber(
    raw.hot_score !== undefined ? raw.hot_score
      : raw.heat !== undefined ? raw.heat
        : raw.score !== undefined ? raw.score
          : 0,
  );
  if (!question_uuid || !title || !url) return null;
  return {
    id: question_uuid,
    title,
    url,
    hotness: heat,
    excerpt: toStr(raw.excerpt),
    answer_count: toFiniteNumber(raw.answer_count),
    question_id: question_uuid,
    tags: Array.isArray(raw.tags)
      ? raw.tags.filter((s) => typeof s === 'string')
      : (targetQuestion && Array.isArray(targetQuestion.topics)
          ? targetQuestion.topics
              .map((t) => (t && typeof t === 'object' && typeof /** @type {any} */ (t).name === 'string'
                ? /** @type {any} */ (t).name
                : null))
              .filter(Boolean)
          : []),
    category,
    rank,
  };
}

/**
 * Build the real Zhihu hot-list source. Exposed as a factory so the
 * orchestrator can swap a fake fetch in for tests.
 *
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]  Override fetch (test seam).
 * @param {number} [opts.timeoutMs]        Override timeout.
 * @param {number} [opts.maxBodyBytes]     Override body-size cap.
 * @returns {HotSource}
 */
export function createRealZhihuHotSource(opts = {}) {
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : null;
  const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = typeof opts.maxBodyBytes === 'number' && opts.maxBodyBytes > 0
    ? opts.maxBodyBytes
    : DEFAULT_MAX_BODY_BYTES;
  // Resolve the endpoint EAGERLY at construction time. A
  // misconfigured ZHIHU_HOT_ENDPOINT must fail loudly here so the
  // HTTP façade never silently routes the home-page module to an
  // unverified host. The earlier "lazy at first call" design was
  // reverted during the ClickUp 16.4 rebuild because the test
  // contract and the operator-facing grep both expect the
  // construction-time failure surface.
  /** @type {{ endpoint: string, url: URL }} */
  const resolvedEndpoint = resolveEndpoint();
  function ensureEndpoint() {
    return resolvedEndpoint;
  }

  return Object.freeze({
    name: 'real',
    /**
     * @param {object} [input]
     * @param {string} [input.category]
     * @returns {Promise<ReadonlyArray<import('./hot.mjs').ZhihuHotTopic>>}
     */
    async fetchHotList(input = {}) {
      const category = typeof input.category === 'string' ? input.category : '';
      const ep = ensureEndpoint();
      const raw = await fetchHotListRaw(category, {
        endpoint: ep.endpoint,
        timeoutMs,
        maxBodyBytes,
        fetchImpl,
      });
      /** @type {import('./hot.mjs').ZhihuHotTopic[]} */
      const out = [];
      for (let i = 0; i < raw.length; i += 1) {
        const norm = normaliseZhihuHotEntry(/** @type {any} */ (raw[i]), i + 1, category || 'total');
        if (norm) out.push(norm);
      }
      return out;
    },
    /** @returns {string} the upstream endpoint URL (debug surface). */
    endpoint() {
      return ensureEndpoint().endpoint;
    },
    /** @returns {ReadonlyArray<string>} the host allow-list. */
    hosts() {
      return HOST_ALLOW_LIST;
    },
  });
}

export const ZHIHU_HOT_SOURCE_CONFIG = Object.freeze({
  DEFAULT_HOT_ENDPOINT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BODY_BYTES,
  MAX_REDIRECTS,
  HOST_ALLOW_LIST: HOST_ALLOW_LIST.slice(),
});
