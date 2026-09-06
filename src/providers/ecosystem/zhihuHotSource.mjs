// src/providers/ecosystem/zhihuHotSource.mjs — real Zhihu hot-list
// adapter for ClickUp 16.4.
//
// Product positioning:
//   * Hot list is the discovery rail on the home page ("知乎此刻热议").
//   * We DO NOT call this in story Runtime. We never turn a hot topic
//     into story beats / narrative / session events.
//   * This adapter is a thin, read-through wrapper over the public
//     Zhihu hot-list endpoint. It is OFF by default (mock is the
//     default per repo contract). The HTTP façade flips it on only
//     when STORY_OUTSIDE_HOT_PROVIDER=real AND the host allow-list
//     matches.
//
// Endpoint contract (Zhihu open API):
//   * GET https://api.zhihu.com/openapi/feed/hot
//   * No auth required (the endpoint is open per the public docs).
//   * Returns an array of { id, title, url, hot_score / heat, excerpt,
//     answer_count, target.question.id, target.question.topics[].name }
//     — the field names vary; we normalise here.
//
// Host safety:
//   * We re-use the same defence-in-depth pattern as
//   src/providers/realProvider.mjs: explicit host allow-list (only
//     api.zhihu.com, default port, HTTPS), manual redirect follow so
//     a 30x can never smuggle us to attacker.example, body-size cap,
//     AbortSignal.timeout so a stalled TCP read does not pin the
//     request forever.
//   * This adapter does NOT touch any OAuth header (Authorization,
//     X-OAuth-Token) — the hot endpoint is open. We refuse to set
//     those headers even when the caller passes them in.
//
// Failure modes we surface (the hot-list module turns them into
// `ecosystem_status: 'unavailable'`):
//   * fetch_unavailable — no fetch in this runtime
//   * unsupported_upstream_host — host allow-list mismatch
//   * unsupported_upstream_origin — non-HTTPS / non-default-port
//   * upstream_too_many_redirects — redirect chain > MAX_REDIRECTS
//   * upstream_5xx / upstream_4xx — server-side error
//   * upstream_timeout — AbortSignal.timeout fired
//   * upstream_shape_mismatch — payload missing data[] / data not array
//   * upstream_body_too_large — body exceeds cap
//
// The adapter is exported as a factory so tests / fixtures can
// inject a fake fetch implementation without monkey-patching globals.

import { ProviderError } from '../dto.mjs';

const ZHIHU_HOT_PATH = '/openapi/feed/hot';
const DEFAULT_BASE_URL = 'https://api.zhihu.com';
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024; // 256 KiB — hot-list is small
const MAX_REDIRECTS = 3;
const HOST_ALLOW_LIST = Object.freeze(['api.zhihu.com']);

/**
 * @typedef {import('./hot.mjs').HotSource} HotSource
 */

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
  // Reject IDN variants by canonicalising. We never expect api.zhihu.com
  // to be served from a Punycode alias — the official endpoint is the
  // literal ASCII hostname.
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
    const init = {
      // redirect: 'manual' so we can re-validate the destination host
      // ourselves. fetch with redirect: 'follow' would silently walk
      // off the allow-list.
      redirect: 'manual',
      headers: {
        accept: 'application/json',
        'user-agent': 'story-outside/0.1 (zhihu-hackathon-2026-p2; read-only)',
      },
    };
    if (signal) init.signal = signal;
    res = await fn(target.toString(), init);
  } catch (err) {
    if (err && err.name === 'TimeoutError') {
      throw new ProviderError('upstream_timeout', `Upstream timed out after ${ctx.timeoutMs}ms.`);
    }
    if (err && err.name === 'AbortError') {
      throw new ProviderError('upstream_aborted', 'Upstream request was aborted.');
    }
    throw new ProviderError('upstream_network_error', `Upstream network error: ${err && err.message ? err.message : 'unknown'}.`);
  }
  // Manual redirect handling.
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    if (!loc) {
      throw new ProviderError('upstream_redirect_missing_location', 'Upstream 3xx did not include a Location header.');
    }
    let nextUrl;
    try {
      nextUrl = new URL(loc, target).toString();
    } catch {
      throw new ProviderError('upstream_redirect_invalid_location', 'Upstream Location header could not be resolved.');
    }
    return followRedirect(fn, nextUrl, { ...ctx, hops: ctx.hops + 1 });
  }
  return res;
}

/**
 * Read the response body with a hard byte cap so a malicious / buggy
 * upstream cannot OOM the process.
 *
 * @param {Response} res
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function readBodyCapped(res, maxBytes) {
  if (!res.body) return '';
  // Read in chunks; abort as soon as the running total exceeds the cap.
  const reader = res.body.getReader();
  let total = 0;
  const chunks = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { reader.cancel(); } catch { /* ignore */ }
      throw new ProviderError('upstream_body_too_large', `Upstream body exceeded ${maxBytes} bytes.`, { total });
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const chunk of chunks) {
    merged.set(chunk, off);
    off += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(merged);
}

/**
 * Best-effort mapping from the raw Zhihu payload to our DTO. We do
 * not assume a single field name — different Zhihu endpoints use
 * different shapes (`data[].target.question.title`,
 * `data[].target.question.excerpt`, `data[].detail_text`, etc.).
 *
 * @param {unknown} raw
 * @returns {import('./hot.mjs').ZhihuHotTopic}
 */
function mapRawToHotTopic(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new ProviderError('upstream_shape_mismatch', 'Hot entry was not an object.');
  }
  const r = /** @type {any} */ (raw);
  // Zhihu wraps each feed entry under `target` (question / answer /
  // article). We accept either nested or flat shapes.
  const t = (r.target && typeof r.target === 'object') ? r.target : r;
  const q = (t.question && typeof t.question === 'object') ? t.question : t;

  const id = String(r.id ?? q.id ?? '');
  if (!id) throw new ProviderError('upstream_shape_mismatch', 'Hot entry missing id.');

  const title = String(t.title ?? q.title ?? r.title ?? '');
  if (!title) throw new ProviderError('upstream_shape_mismatch', `Hot entry ${id} missing title.`);

  const url = String(
    r.url
    ?? t.url
    ?? (q.id ? `https://www.zhihu.com/question/${q.id}` : '')
    ?? '',
  );
  if (!url) throw new ProviderError('upstream_shape_mismatch', `Hot entry ${id} missing url.`);

  // Hotness: different Zhihu endpoints name this `hot_score`,
  // `heat`, `detail_text_score`, or `score`. We coerce to number
  // when possible.
  const hotnessRaw = r.hot_score ?? r.heat ?? r.detail_text_score ?? r.score ?? q.hot_score ?? 0;
  const hotness = Number.isFinite(Number(hotnessRaw)) ? Number(hotnessRaw) : 0;

  // Excerpt: prefer the question's "优质回答摘要" field.
  const excerpt = String(
    r.excerpt
    ?? q.excerpt
    ?? q.detail
    ?? r.detail_text
    ?? '',
  );

  // Answer count: best-effort from the target.answer_count or a sibling.
  const ac = Number(r.answer_count ?? t.answer_count ?? q.answer_count ?? 0);
  const answer_count = Number.isFinite(ac) ? ac : 0;

  const question_id = String(q.id ?? r.question_id ?? '');

  // Tags: pull from target.question.topics[].name when present.
  const tags = [];
  if (Array.isArray(q.topics)) {
    for (const topic of q.topics) {
      if (topic && typeof topic === 'object' && typeof topic.name === 'string') {
        tags.push(topic.name);
      }
    }
  }
  if (Array.isArray(r.tag)) {
    for (const t2 of r.tag) {
      if (typeof t2 === 'string') tags.push(t2);
    }
  }

  return {
    id,
    title,
    url,
    hotness,
    excerpt,
    answer_count,
    question_id,
    tags,
  };
}

/**
 * Factory: build a HotSource that calls the real Zhihu hot-list
 * endpoint.
 *
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]    Override base URL (tests; must
 *                                    still pass the host allow-list).
 * @param {number} [opts.timeoutMs]  Override request timeout.
 * @param {number} [opts.maxBodyBytes] Override body-size cap.
 * @param {typeof fetch} [opts.fetchImpl] Override fetch (tests).
 * @returns {HotSource}
 */
export function createZhihuHotSource(opts = {}) {
  const baseUrl = typeof opts.baseUrl === 'string' && opts.baseUrl ? opts.baseUrl : DEFAULT_BASE_URL;
  const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = typeof opts.maxBodyBytes === 'number' && opts.maxBodyBytes > 0
    ? opts.maxBodyBytes
    : DEFAULT_MAX_BODY_BYTES;
  const fetchImpl = opts.fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);

  if (!fetchImpl) {
    // The adapter will throw on first use; that's fine — the caller
    // (HTTP façade) catches and degrades.
  }

  return Object.freeze({
    name: 'real',
    /**
     * @returns {Promise<ReadonlyArray<import('./hot.mjs').ZhihuHotTopic>>}
     */
    async fetchHotList() {
      if (typeof fetchImpl !== 'function') {
        throw new ProviderError('fetch_unavailable', 'No fetch implementation is available in this runtime.');
      }
      const url = `${baseUrl}${ZHIHU_HOT_PATH}`;
      const res = await followRedirect(fetchImpl, url, { timeoutMs, hops: 0, fetchImpl });

      if (res.status === 429) {
        throw new ProviderError('upstream_rate_limited', 'Upstream rate-limited the hot-list request.', { status: 429 });
      }
      if (res.status >= 500) {
        throw new ProviderError('upstream_5xx', `Upstream responded with ${res.status}.`, { status: res.status });
      }
      if (res.status >= 400) {
        throw new ProviderError('upstream_4xx', `Upstream responded with ${res.status}.`, { status: res.status });
      }
      if (res.status !== 200) {
        throw new ProviderError('upstream_unexpected_status', `Upstream responded with unexpected status ${res.status}.`, { status: res.status });
      }

      const body = await readBodyCapped(res, maxBodyBytes);
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (err) {
        throw new ProviderError('upstream_shape_mismatch', `Upstream body was not valid JSON: ${err && err.message ? err.message : 'parse_error'}.`);
      }

      // Zhihu hot-list response shape: { data: [...] } OR a bare array.
      // We accept both for forward-compatibility.
      const list = Array.isArray(payload)
        ? payload
        : (payload && typeof payload === 'object' && Array.isArray(/** @type {any} */ (payload).data)
            ? /** @type {any} */ (payload).data
            : null);
      if (!list) {
        throw new ProviderError('upstream_shape_mismatch', 'Upstream payload missing data[] array.');
      }

      const out = [];
      for (const entry of list) {
        try {
          out.push(mapRawToHotTopic(entry));
        } catch (err) {
          // Drop malformed entries but continue — the contract is
          // "best-effort list of N topics", not "all or nothing".
          if (!(err instanceof ProviderError)) throw err;
        }
      }
      return out;
    },
  });
}

export const ZHIHU_HOT_SOURCE_CONFIG = Object.freeze({
  DEFAULT_BASE_URL,
  ZHIHU_HOT_PATH,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BODY_BYTES,
  HOST_ALLOW_LIST,
});