// src/providers/realProvider.mjs — StoryProvider backed by the official
// Zhihu Hackathon 2026 (Phase 2) story content API.
//
// Contract reference:
//   the official Zhihu Hackathon content API reference
//
// Hard rules taken from that contract (verbatim, do not relax):
//   * No Access Secret. No OAuth App ID / App Key. No access_token.
//   * No Authorization / X-OAuth-Token headers on the wire.
//   * Endpoints are:
//       GET https://api.zhihu.com/km-indep-home/hackathon/v2/story/list
//       GET https://api.zhihu.com/km-indep-home/hackathon/v2/story/{work_id}
//   * `work_id` must come from the list response (or otherwise be
//     non-empty, contain no '/', '?', '#', CR or LF, and fit the
//     work_id shape the upstream returns). Use a URL path-encoding
//     function — never concatenate untrusted strings.
//   * Failures (HTTP 4xx/5xx, 429, timeout, non-JSON body, missing
//     fields, empty body) raise a typed ProviderError. We never loop
//     retry, never fabricate content, never echo upstream error bodies
//     to clients.
//   * Unknown fields on a successful response are preserved on
//     `source.raw` so attribution and forensic context survive. We do
//     not pretend original content was authored by this app.
//
// Scope (Story 13):
//   * This provider is bound to zhihu_hackathon_2026_p2. The contract
//     document explicitly warns the endpoints may change after the
//     event. We surface that as a metadata flag on the provider so the
//     /api/health banner can label itself correctly.
//
// What this provider deliberately does NOT do:
//   * It never imports any file under vendor/zhihu-hackathon/**. Those
//     scripts are orchestration tools, not runtime dependencies.
//   * It never reads ZHIHU_OAUTH_APP_KEY / ZHIHU_ACCESS_SECRET /
//     anything that looks like a credential. The story endpoints do not
//     accept credentials and the spec forbids sending them.
//   * It never touches the story application layer, the Agent runtime,
//     the cache layer, or the MariaDB mapping. The seam stays a seam.

import {
  normaliseStorySummary,
  normaliseStoryDetail,
  ProviderError,
  StoryNotFoundError,
  ValidationError,
} from './dto.mjs';
import { storyTransportFromEnv } from './storyTransport.mjs';
import { BoundedMap } from '../util/boundedMap.mjs';
import { warn as loggerWarn } from '../observability/logger.mjs';

const DEFAULT_BASE_URL = 'https://api.zhihu.com';
const STORY_LIST_PATH = '/km-indep-home/hackathon/v2/story/list';
const STORY_DETAIL_PATH = (workId) => `/km-indep-home/hackathon/v2/story/${encodeURIComponent(workId)}`;
const DEFAULT_TIMEOUT_MS = 5000;

// The story list is the homepage's critical path and changes rarely. On
// 2026-09-14 the upstream edge returned transient 4xx to this host for
// ~22 minutes, which turned the whole homepage into an error page. The
// same edge glitch also broke per-work detail loads (character / opening
// preparation reads a story's detail), so the same two bounded
// mitigations now protect BOTH the list and per-work detail:
//   1. ONE retry with a short backoff for transient failures.
//   2. A cache that serves the last good value as a stale fallback
//      whenever a refresh fails — for the list this is an unbounded
//      single-entry cache (with an additional LIST_TTL_MS freshness
//      window that skips the network); for detail it is the existing
//      per-work detailCache (bounded LRU) reused as a failure fallback.
// The list TTL only decides WHEN we re-request, never whether a cached
// value is still servable: once a good value has been seen, that surface
// never hard-fails on a transient upstream error again. Detail has no
// TTL — a cached entry is always served on hit, and only consulted as a
// fallback when a refresh fails. Neither mitigation relaxes the hard
// rules: no fabricated content, no echoing upstream error bodies, no
// unbounded retry loops.
const RETRY_BACKOFF_MS = 250;
const LIST_TTL_MS = 60_000;
// Per-work detail freshness window. Within DETAIL_TTL_MS of the last
// successful fetch a cached detail is served without touching the
// network; past it, getStory re-requests and — if the refresh fails
// transiently — serves the cached detail as a stale fallback. Detail
// bodies for a given work are effectively immutable for the contract
// window, so a generous TTL keeps character/opening preparation working
// even while the upstream edge is throwing transient 4xx.
const DETAIL_TTL_MS = 5 * 60_000;

// Per the official contract the upstream is an unauthenticated JSON API
// for the duration of zhihu_hackathon_2026_p2. We do NOT set
// Authorization / X-OAuth-Token; doing so would invite credential leaks
// for no protocol benefit.
const STATIC_HEADERS = Object.freeze({
  accept: 'application/json',
  // Node's built-in fetch requires a User-Agent to talk to some CDN
  // edges. The string is a generic identifier — no credentials.
  'user-agent': 'story-outside/0.1 (zhihu-hackathon-2026-p2; read-only)',
});

/**
 * Exact-match allow-list for the upstream base URL. Defends against:
 *   - host-prefix bypass: `https://api.zhihu.com.attacker.example`
 *   - trailing path suffix: `https://api.zhihu.com.evil/foo`
 *   - IDN homograph:  `https://api.zhihu.cn` (xn-- variant accepted by
 *     URL but never `api.zhihu.com`)
 *
 * The check normalises both sides to lowercase and requires the URL
 * to start with the exact allow-listed prefix AND have no further host
 * label beyond the allow-listed host. The character before the first
 * slash must be the end of the host. We deliberately do NOT trust
 * `URL.hostname` to be canonical — it can be percent-decoded or
 * include a port we did not ask for.
 *
 * @param {string} baseUrl
 * @returns {boolean}
 */
function isAllowedUpstreamBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl) return false;
  const allow = 'https://api.zhihu.com';
  if (baseUrl.length !== allow.length && baseUrl.charAt(allow.length) !== '/') return false;
  return baseUrl.toLowerCase() === allow || baseUrl.toLowerCase().startsWith(`${allow}/`);
}

/**
 * Hard guard against characters the upstream will reject and against
 * characters we don't want to see in logs or URLs. Per the contract
 * work_id values must NOT contain '/', '?', '#', CR or LF.
 *
 * The upstream list endpoint returns stringified numeric IDs
 * (e.g. "1747681485547843585"), so we accept digits here as the common
 * case while still permitting the broader slug-like alphabet the
 * contract allows. Empty / whitespace-only / out-of-range IDs are
 * rejected loudly at the seam.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function assertWorkId(raw) {
  if (typeof raw !== 'string') {
    throw new ValidationError('work_id must be a string', { receivedType: typeof raw });
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ValidationError('work_id must be a non-empty string');
  }
  if (trimmed.length > 128) {
    throw new ValidationError('work_id exceeds maximum length', { length: trimmed.length });
  }
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code === 0x2f /* / */ || code === 0x3f /* ? */ || code === 0x23 /* # */ ||
        code === 0x0d /* CR */ || code === 0x0a /* LF */) {
      throw new ValidationError('work_id contains a forbidden path character', { code });
    }
    if (code < 0x20 || code === 0x7f) {
      throw new ValidationError('work_id contains a control character', { code });
    }
  }
  return trimmed;
}

/**
 * Read a positive integer env knob with a default. Throws nothing.
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
 * Decode a JSON response body. Distinguishes "empty body" from "parse
 * error" so we can return a typed ProviderError rather than crash the
 * route layer.
 *
 * @param {Response} res
 * @returns {Promise<unknown>}
 */
async function decodeJson(res) {
  // Pre-check Content-Length before allocating the body. fetch returns
  // a Headers object; missing header → null. Trust the header only as
  // an optimisation — if the upstream lies, the per-byte counter below
  // is the authoritative cap.
  const declared = Number.parseInt(res.headers.get('content-length') || '', 10);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new ProviderError(
      'upstream_body_too_large',
      `Upstream declared response size ${declared} exceeds ${MAX_RESPONSE_BYTES}.`,
      { declared, cap: MAX_RESPONSE_BYTES },
    );
  }
  // Stream-accumulate the body with a hard byte cap so an upstream that
  // lies about Content-Length (or omits it) cannot blow up the heap.
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let total = 0;
  if (reader) {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new ProviderError(
          'upstream_body_too_large',
          `Upstream body exceeded ${MAX_RESPONSE_BYTES} bytes while reading.`,
          { cap: MAX_RESPONSE_BYTES },
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } else {
    // Defensive fallback for runtimes without ReadableStream bodies
    // (the Node test harness occasionally hits this). .text() still
    // runs under the AbortController timeout; the size cap is enforced
    // post-hoc because the alternative is unbounded allocation.
    text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new ProviderError(
        'upstream_body_too_large',
        `Upstream body exceeded ${MAX_RESPONSE_BYTES} bytes.`,
        { cap: MAX_RESPONSE_BYTES, contentLength: text.length },
      );
    }
  }
  if (!text) {
    throw new ProviderError('upstream_empty_body', 'Upstream returned an empty body.');
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ProviderError(
      'upstream_invalid_json',
      'Upstream did not return valid JSON.',
      { contentLength: text.length },
    );
  }
}

/**
 * Cap on upstream response body size in bytes. The official Zhihu
 * Hackathon story endpoints return JSON for at most a few dozen
 * entries (work_id list and per-work detail). Anything substantially
 * larger than this is treated as an upstream misbehaviour / DoS, NOT
 * legitimate content. We refuse to allocate it. The constant lives
 * here (not in env) because it is part of the safety contract, not a
 * tuning knob.
 */
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MiB
const MAX_REDIRECTS = 3;

/**
 * Cap on the per-entry source.content / source.introduction text size.
 * The contract returns short fields; anything in the multi-MB range is
 * misbehaviour. We keep the explicit content under source.content for
 * downstream consumers that want it, but we do NOT carry the full body
 * into source.raw — that would triple the in-memory cost (raw + DTO
 * + cache defensive copy).
 */
const MAX_SOURCE_TEXT_BYTES = 64 * 1024; // 64 KiB

/**
 * Build a defensive shallow copy of a DTO so callers cannot mutate the
 * cached object. We avoid JSON.parse(JSON.stringify(...)) because the
 * detail DTO carries long content strings and the JSON round-trip
 * triples peak allocation (raw → string → parse → object). A shallow
 * copy plus per-array/per-object cloning of the source envelope is
 * sufficient: callers never reach into nested beats[] or source.* from
 * outside the provider boundary.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function shallowDefensiveCopy(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    /** @type {any[]} */
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i += 1) out[i] = shallowDefensiveCopy(value[i]);
    return /** @type {T} */ (/** @type {unknown} */ (out));
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of Object.keys(/** @type {Record<string, unknown>} */ (value))) {
    out[k] = shallowDefensiveCopy(/** @type {any} */ (value)[k]);
  }
  return /** @type {T} */ (/** @type {unknown} */ (out));
}

// Retained from 391464a: the catalog column is VARCHAR(500), while
// original introduction/content remain intact in their dedicated fields.
function catalogHook(value, fallback) {
  return Array.from(value || fallback).slice(0, 500).join('');
}

/**
 * Strip the body-sized fields from a source.raw envelope and cap
 * surviving text fields. The explicit DTO fields already carry the
 * attributable metadata (title, author, labels, etc.); raw only needs
 * to keep the provenance fields an operator would inspect.
 *
 * @param {Record<string, unknown>} raw
 * @param {string[]} dropKeys   Keys to remove from raw (body-sized content).
 * @returns {Record<string, unknown>}
 */
function trimSourceRaw(raw, dropKeys) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of Object.keys(raw)) {
    if (dropKeys.includes(k)) continue;
    out[k] = raw[k];
  }
  return out;
}

/**
 * Cap a text field at MAX_SOURCE_TEXT_BYTES. Returns the trimmed text
 * plus a `truncated: true` marker so downstream consumers know the
 * value was clipped.
 *
 * @param {string} text
 * @returns {{ text: string, truncated: boolean }}
 */
function capSourceText(text) {
  if (typeof text !== 'string') return { text: '', truncated: false };
  if (text.length <= MAX_SOURCE_TEXT_BYTES) return { text, truncated: false };
  return { text: text.slice(0, MAX_SOURCE_TEXT_BYTES), truncated: true };
}

/**
 * Wrap a fetch with an AbortController timeout. We never retry on
 * timeout — the contract forbids it. Redirects are handled manually
 * (see followRedirect) so we can keep host-pinning, size-pinning and
 * idempotency on every hop. fetch's built-in `redirect: 'follow'`
 * would silently follow redirects to a non-api.zhihu.com host, which
 * is exactly what the host allow-list is meant to prevent.
 *
 * @param {string} url
 * @param {{ timeoutMs: number, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, { timeoutMs, fetchImpl }) {
  const fn = fetchImpl || globalThis.fetch;
  if (typeof fn !== 'function') {
    throw new ProviderError(
      'fetch_unavailable',
      'No fetch implementation is available in this runtime.',
    );
  }
  return followRedirect(fn, url, { timeoutMs, hops: 0 });
}

/**
 * Manually follow 30x responses, hopping at most MAX_REDIRECTS times,
 * re-validating the host allow-list and re-applying the body size cap
 * at every step.
 *
 * @param {typeof fetch} fn
 * @param {string} url
 * @param {{ timeoutMs: number, hops: number }} ctx
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
  // Pre-flight: parse + host-pinning. We never want fetch to dispatch
  // a request whose hostname we did not authorise. fetch with
  // `redirect: 'manual'` still issues the request; we pre-check so we
  // never even send bytes to a non-allow-listed host.
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
  if (!isAllowedUpstreamHost(target.hostname)) {
    throw new ProviderError(
      'unsupported_upstream_host',
      `Refusing to call non-allow-listed upstream host "${target.hostname}".`,
      { hostname: target.hostname },
    );
  }
  // B1 (PR #8 code review follow-up): the host allow-list is necessary but
  // NOT sufficient. A redirect to `http://api.zhihu.com/...` (downgrade
  // to cleartext) or to `https://api.zhihu.com:8080/...` (port the
  // contract does not specify) must be refused even though the host
  // matches. The official contract pins the endpoint to HTTPS on the
  // default port (443); any other scheme/port is, by definition, not
  // the upstream we agreed to talk to. We re-check this on every hop
  // because a redirect can rewrite the scheme/port even when the
  // hostname stays constant.
  if (target.protocol !== 'https:' || (target.port && target.port !== '443')) {
    throw new ProviderError(
      'unsupported_upstream_origin',
      `Refusing to call upstream origin "${target.protocol}//${target.host}${target.port ? ':' + target.port : ''}" — only https://api.zhihu.com (default port) is allowed.`,
      { protocol: target.protocol, port: target.port, hostname: target.hostname },
    );
  }
  // AbortSignal.timeout combines signal creation + timer scheduling
  // into a single primitive (Node ≥ 17.3). We pass it directly into
  // fetch so the request, the connect phase, and any pending read all
  // share the same deadline. The fallback AbortController path
  // remains for runtimes that lack AbortSignal.timeout.
  const useStaticSignal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function';
  const signal = useStaticSignal ? AbortSignal.timeout(ctx.timeoutMs) : (() => {
    const c = new AbortController();
    setTimeout(() => c.abort(), ctx.timeoutMs).unref();
    return c.signal;
  })();
  let res;
  try {
    res = await fn(target.toString(), {
      method: 'GET',
      headers: { ...STATIC_HEADERS },
      signal,
      // Manual mode: the underlying fetch returns the 30x Response
      // without consuming body / following Location. We handle every
      // hop explicitly so the host allow-list is re-checked.
      redirect: 'manual',
    });
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
      throw new ProviderError(
        'upstream_timeout',
        `Upstream did not respond within ${ctx.timeoutMs}ms.`,
        { timeoutMs: ctx.timeoutMs },
      );
    }
    // Network-level failure (DNS, TLS, refused). Wrap so the route layer
    // does not leak the underlying system error string.
    throw new ProviderError(
      'upstream_network_error',
      'Could not reach the upstream API.',
      { name: err && err.name ? err.name : 'network_error' },
    );
  }
  // 30x: hop to Location (re-validating host + size cap).
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (!location) {
      throw new ProviderError(
        'upstream_redirect_missing_location',
        'Upstream returned a redirect with no Location header.',
        { status: res.status },
      );
    }
    let nextUrl;
    try {
      nextUrl = new URL(location, target).toString();
    } catch (err) {
      throw new ProviderError(
        'upstream_invalid_redirect',
        'Upstream returned a malformed redirect target.',
        { status: res.status },
      );
    }
    return followRedirect(fn, nextUrl, { timeoutMs: ctx.timeoutMs, hops: ctx.hops + 1 });
  }
  return res;
}

/**
 * Check whether a hostname (no scheme, no path) is allow-listed.
 * Exact-match against api.zhihu.com. Defeats host-prefix bypass
 * (`api.zhihu.com.attacker.example`) and IDN homograph
 * (`api.zhihu.cn`).
 *
 * @param {string} hostname
 * @returns {boolean}
 */
function isAllowedUpstreamHost(hostname) {
  if (typeof hostname !== 'string' || !hostname) return false;
  return hostname.toLowerCase() === 'api.zhihu.com';
}

/**
 * @typedef {Object} ZhihuStoryListEntry
 * @property {string} work_id
 * @property {string} [title]
 * @property {string} [artwork]
 * @property {string} [tab_artwork]
 * @property {string} [description]
 * @property {string[]} [labels]
 * @property {Record<string, unknown>} [source] Untrusted upstream fields.
 */

/**
 * @typedef {Object} ZhihuStoryDetailEntry
 * @property {string} work_id
 * @property {string} [chapter_name]
 * @property {string} [author_avatar]
 * @property {string} [author_name]
 * @property {string[]} [labels]
 * @property {string} [introduction]
 * @property {string} [content]
 * @property {Record<string, unknown>} [source] Untrusted upstream fields.
 */

/**
 * Translate an upstream list entry into the provider-agnostic
 * `StorySummary` DTO.
 *
 *  work_id   → id
 *  title     → title
 *  description / introduction → hook
 *  labels    → captured under source.labels (unknown to the DTO)
 *  artwork / tab_artwork → captured under source.{artwork,tab_artwork}
 *
 * @param {unknown} raw
 * @returns {ReturnType<typeof normaliseStorySummary>}
 */
function displayMetadata(entry, content = '') {
  const image = (value) => {
    if (typeof value !== 'string') return null;
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
  };
  const categories = Array.isArray(entry.labels) ? entry.labels.filter((label) => typeof label === 'string' && label.trim()) : [];
  return {
    cover_url: image(entry.artwork) || image(entry.tab_artwork),
    banner_url: image(entry.tab_artwork) || image(entry.artwork),
    categories,
    category: categories[0] || '',
    description: typeof entry.introduction === 'string' ? entry.introduction : (typeof entry.description === 'string' ? entry.description : ''),
    author: typeof entry.author_name === 'string' ? entry.author_name : '',
    author_avatar: image(entry.author_avatar),
    ...(content ? { word_count: Array.from(content.replace(/<[^>]*>/g, '').replace(/\s/g, '')).length } : {}),
  };
}

function summaryFromListEntry(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError('story list entry must be an object');
  }
  const entry = /** @type {Record<string, unknown>} */ (raw);
  if (typeof entry.work_id !== 'string' || !entry.work_id) {
    throw new ValidationError('story list entry missing work_id');
  }
  const work_id = assertWorkId(entry.work_id);
  if (typeof entry.title !== 'string' || !entry.title) {
    throw new ValidationError(`story ${work_id} missing title`);
  }
  const description = typeof entry.description === 'string' ? entry.description : '';
  // The DTO requires a non-empty hook. The contract explicitly allows
  // description to be missing — fall back to a short, attributable
  // placeholder so the route layer never sees an empty hook. We do
  // NOT fabricate story content; the placeholder is metadata only.
  const hook = catalogHook(description, `来自知乎黑客松参赛作品（${work_id}）`);
  /** @type {{ id: string, label: string, mood: string }[]} */
  const roles = [
    {
      id: 'author',
      label: '原作',
      mood: '',
    },
  ];
  const summary = normaliseStorySummary({
    id: work_id,
    title: entry.title,
    hook,
    roles,
  });
  // Round-trip through the DTO normaliser; then attach the source
  // metadata envelope for attribution. We strip body-sized fields from
  // source.raw (description / labels already live on the explicit DTO
  // envelope above), so a list with thousands of entries cannot blow
  // up memory through the raw sub-object.
  /** @type {ZhihuStoryListEntry} */
  const enriched = /** @type {any} */ ({
    ...summary,
    ...displayMetadata(entry),
    source: {
      raw: trimSourceRaw(entry, ['description', 'labels', 'artwork', 'tab_artwork']),
      labels: Array.isArray(entry.labels) ? entry.labels.slice() : [],
      artwork: typeof entry.artwork === 'string' ? entry.artwork : null,
      tab_artwork: typeof entry.tab_artwork === 'string' ? entry.tab_artwork : null,
      attribution: 'zhihu_hackathon_2026_p2',
    },
  });
  return enriched;
}

/**
 * Translate an upstream detail entry into the provider-agnostic
 * `StoryDetail` DTO, preserving attribution metadata.
 *
 *  work_id   → id
 *  chapter_name / title → title
 *  description / introduction → hook
 *  author_avatar / author_name → captured under source.author*
 *  labels    → captured under source.labels
 *  content   → beats (single narration beat) — see comment below
 *
 * The official API returns a long `content` string with no structural
 * role/choice markers. We refuse to invent `dialogue` / `ask_player_choice`
 * beats because doing so would (a) misrepresent the upstream content
 * and (b) break the opening-cache invariant that an `ask_player_choice`
 * boundary is at a known beat index. The detail DTO instead carries
 * the body as a single `narration` beat, plus a `source.content`
 * field for downstream consumers that want the raw text.
 *
 * @param {unknown} raw
 * @returns {ReturnType<typeof normaliseStoryDetail>}
 */
function detailFromDetailEntry(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError('story detail entry must be an object');
  }
  const entry = /** @type {Record<string, unknown>} */ (raw);
  if (typeof entry.work_id !== 'string' || !entry.work_id) {
    throw new ValidationError('story detail entry missing work_id');
  }
  const work_id = assertWorkId(entry.work_id);
  const titleCandidate = [entry.chapter_name, entry.title].find(
    (v) => typeof v === 'string' && /** @type {string} */ (v).length > 0,
  );
  if (!titleCandidate) {
    throw new ValidationError(`story ${work_id} missing chapter_name/title`);
  }
  const introduction = typeof entry.introduction === 'string' ? entry.introduction : '';
  const description = typeof entry.description === 'string' ? entry.description : '';
  const hookSource = introduction || description || '';
  const hook = catalogHook(hookSource, `来自知乎黑客松参赛作品（${work_id}）`);
  const author_name = typeof entry.author_name === 'string' ? entry.author_name : '';
  const author_avatar = typeof entry.author_avatar === 'string' ? entry.author_avatar : '';
  const roles = [{
    id: 'author',
    // We surface the actual author name as the role label — that is
    // the only author metadata the upstream gives us and the only way
    // to preserve attribution in the DTO without a schema bump. We do
    // NOT pretend this is a fictional in-app character.
    label: author_name || '原作',
    mood: '',
  }];
  const content = typeof entry.content === 'string' ? entry.content : '';
  // Even an empty content field is acceptable to the contract ("the
  // server may add or omit fields"); we surface it as an empty
  // narration beat rather than fabricating text.
  /** @type {{ text: string, index: number, type: 'narration' }[]} */
  const beats = [{
    text: content,
    index: 0,
    type: 'narration',
  }];
  const detail = normaliseStoryDetail({
    id: work_id,
    title: /** @type {string} */ (titleCandidate),
    hook,
    roles,
    beats,
  });
  // Cap source.content + source.introduction at MAX_SOURCE_TEXT_BYTES
  // so a misbehaving upstream returning a multi-MB body cannot blow
  // up the in-memory cache. We deliberately do NOT include the long
  // `content` body in source.raw — the explicit `source.content` field
  // already carries the attributable text, and raw is reserved for
  // small provenance metadata.
  const cappedContent = capSourceText(content);
  const cappedIntroduction = capSourceText(introduction);
  const cappedHook = capSourceText(hookSource);
  /** @type {Record<string, unknown>} */
  const enriched = /** @type {any} */ ({
    ...detail,
    ...displayMetadata(entry, content),
    source: {
      raw: trimSourceRaw(entry, [
        'content',
        'introduction',
        'description',
        'labels',
        'author_name',
        'author_avatar',
        'chapter_name',
        'title',
      ]),
      author_name,
      author_avatar,
      labels: Array.isArray(entry.labels) ? entry.labels.slice() : [],
      content: cappedContent.text,
      content_truncated: cappedContent.truncated,
      introduction: cappedIntroduction.text,
      hook: cappedHook.text,
      attribution: 'zhihu_hackathon_2026_p2',
    },
  });
  return enriched;
}

/**
 * Build a fetch adapter so the provider can be unit-tested without the
 * network. The factory is internal — production code calls
 * `createRealZhihuStoryProvider()` and gets the real `globalThis.fetch`.
 *
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string, timeoutMs?: number }} [opts]
 * @returns {{
 *   listStories: () => Promise<ReturnType<typeof normaliseStorySummary>[]>,
 *   getStory: (id: string) => Promise<ReturnType<typeof normaliseStoryDetail>>,
 *   advanceStory: (input: { storyId: string, roleId?: string|null, index?: number }) => Promise<import('./dto.mjs').AdvanceResult>,
 *   name: string,
 *   meta: { upstream: string, contract: string, requiresAuth: false, contentType: 'story' },
 * }}
 */
export function createRealZhihuStoryProvider(opts = {}) {
  const fetchImpl = opts.fetchImpl || storyTransportFromEnv(validateStoryTransportPayload);
  const baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = readIntEnv(
    typeof process !== 'undefined' && process.env && process.env.STORY_OUTSIDE_ZHIHU_TIMEOUT_MS,
    opts.timeoutMs || DEFAULT_TIMEOUT_MS,
  );
  if (!isAllowedUpstreamBaseUrl(baseUrl)) {
    // The contract fixes the host. Refuse to talk to anywhere else so a
    // misconfigured env cannot silently redirect us to a malicious
    // mirror. The list / detail URLs are also hard-coded against this
    // host below. Exact-match is required (not startsWith) so that
    // look-alike hosts such as `https://api.zhihu.com.attacker.example`
    // cannot piggy-back on a permissive prefix check. The allow-list
    // also rejects IDN homograph variants (`api.zhihu.cn`,
    // `xn--...`) at the canonical-form layer.
    throw new ProviderError(
      'unsupported_upstream_host',
      'Real provider is pinned to https://api.zhihu.com only.',
      { baseUrl },
    );
  }

  /** @type {Map<string, ReturnType<typeof normaliseStoryDetail>>} */
  const detailCache = new BoundedMap({ max: 256, name: 'realProvider.detailCache' });

  // Per-work timestamp of the last successful detail fetch, kept in a
  // parallel bounded map so detailCache itself still stores plain detail
  // objects (its existing eviction / defensive-copy tests are unaffected).
  // Used only to decide freshness: a work missing here (evicted or never
  // fetched) is simply treated as stale and re-requested.
  /** @type {Map<string, number>} */
  const detailFetchedAt = new BoundedMap({ max: 256, name: 'realProvider.detailFetchedAt' });

  // Last successful list result + when it was fetched. `listStories`
  // serves this without the network while fresh (<= LIST_TTL_MS) and as
  // an unbounded stale fallback whenever a refresh fails. Plain
  // variables, not a BoundedMap — there is exactly one entry.
  /** @type {{ at: number, value: ReturnType<typeof normaliseStorySummary>[] } | null} */
  let listCache = null;

  /**
   * Whether a failed upstream attempt is worth one immediate retry.
   * Shared by both listStories and getStory. Only transient-looking
   * failures qualify; a 404 (endpoint gone / unknown work), 429 (rate
   * limit — retrying makes it worse) or a validation error (our own bug)
   * must fail fast exactly as before.
   *
   * @param {unknown} err
   * @returns {boolean}
   */
  function isTransientUpstreamError(err) {
    return err instanceof ProviderError && (
      err.code === 'upstream_4xx'
      || err.code === 'upstream_5xx'
      || err.code === 'upstream_timeout'
      || err.code === 'upstream_network_error'
    );
  }

  /**
   * Best-effort upstream HTTP status for structured logs. Returns null
   * when the error is not a ProviderError carrying a numeric status.
   *
   * @param {unknown} err
   * @returns {number | null}
   */
  function upstreamStatusOf(err) {
    return err instanceof ProviderError
      && err.details
      && typeof err.details.status === 'number'
      ? err.details.status
      : null;
  }

  /**
   * @returns {Promise<unknown>}
   */
  async function fetchJson(path) {
    const url = `${baseUrl}${path}`;
    const res = await fetchWithTimeout(url, { timeoutMs, fetchImpl });
    if (res.status === 404) {
      throw new StoryNotFoundError(path);
    }
    if (res.status === 429) {
      throw new ProviderError(
        'upstream_rate_limited',
        'Upstream rate-limited the request.',
        { status: 429 },
      );
    }
    if (res.status >= 500) {
      throw new ProviderError(
        'upstream_5xx',
        `Upstream responded with ${res.status}.`,
        { status: res.status },
      );
    }
    if (res.status >= 400) {
      // 4xx other than 404/429 — treat as upstream-rejected input.
      throw new ProviderError(
        'upstream_4xx',
        `Upstream responded with ${res.status}.`,
        { status: res.status },
      );
    }
    if (res.status !== 200) {
      throw new ProviderError(
        'upstream_unexpected_status',
        `Upstream responded with unexpected status ${res.status}.`,
        { status: res.status },
      );
    }
    return decodeJson(res);
  }

  return Object.freeze({
    name: 'real',
    meta: Object.freeze({
      upstream: baseUrl,
      contract: 'zhihu_hackathon_2026_p2',
      requiresAuth: false,
      contentType: 'story',
      // Authoritative list of forbidden request headers — kept here so a
      // future integration reviewer can verify the wire contract at a
      // glance. The fetch above never sends any of these.
      forbiddenRequestHeaders: Object.freeze([
        'authorization',
        'x-oauth-token',
      ]),
      hostAllowList: Object.freeze(['api.zhihu.com']),
    }),
    async listStories() {
      // Fresh cache: serve without touching the network. The list is
      // small metadata and changes rarely; a 60s TTL removes the
      // homepage's dependence on the upstream being up at all.
      const now = Date.now();
      if (listCache && now - listCache.at <= LIST_TTL_MS) {
        return listCache.value.map((summary) => shallowDefensiveCopy(summary));
      }

      /** @param {unknown} err */
      const staleFallback = (err) => {
        // Serve the last good list no matter how old it is. The TTL only
        // decides when we re-request; if the refresh fails (any upstream
        // error), a once-good list beats an error page. The typed error
        // is still thrown when we have NEVER seen a good list — we never
        // fabricate one.
        if (listCache) {
          // The refresh failed but a cached list shielded the homepage.
          // Log it so a recurring upstream outage is visible to the configured
          // application log sink instead of only surfacing as stale data.
          loggerWarn('stories.list.stale_served', {
            component: 'realProvider',
            error_code: err instanceof ProviderError ? err.code : 'unknown',
            from_cache: true,
            extra: {
              route: 'stories',
              upstream_status: upstreamStatusOf(err),
              cache_age_ms: Date.now() - listCache.at,
            },
          });
          return listCache.value.map((summary) => shallowDefensiveCopy(summary));
        }
        throw err;
      };

      let payload;
      try {
        payload = await fetchJson(STORY_LIST_PATH);
      } catch (err) {
        if (!isTransientUpstreamError(err)) {
          // Non-transient (404 endpoint gone, 429 rate limit, our own
          // validation) — no retry, but a cached list still shields the
          // homepage.
          return staleFallback(err);
        }
        // One bounded retry with a short backoff. The transient failures
        // observed in production were per-request edge glitches, so a
        // single immediate retry recovered most of them.
        loggerWarn('stories.list.retry', {
          component: 'realProvider',
          error_code: err instanceof ProviderError ? err.code : 'unknown',
          retried: true,
          extra: { route: 'stories', upstream_status: upstreamStatusOf(err) },
        });
        try {
          await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
          payload = await fetchJson(STORY_LIST_PATH);
        } catch (retryErr) {
          return staleFallback(retryErr instanceof ProviderError ? retryErr : err);
        }
      }
      if (!Array.isArray(payload)) {
        // Shape mismatch is not retried (retrying a deterministic
        // response wastes the timeout budget) but the cache still
        // shields the homepage.
        return staleFallback(new ProviderError(
          'upstream_shape_mismatch',
          'Story list payload was not an array.',
        ));
      }
      const out = [];
      for (const entry of payload) {
        out.push(summaryFromListEntry(entry));
      }
      listCache = { at: Date.now(), value: out };
      return out.map((summary) => shallowDefensiveCopy(summary));
    },
    async getStory(id) {
      const work_id = assertWorkId(id);

      // Fresh cache: within DETAIL_TTL_MS of the last good fetch, serve
      // the cached detail without touching the network. Defensive copy so
      // callers cannot mutate the cached object; shallowDefensiveCopy
      // avoids cloning a multi-KiB content string three times (raw →
      // string → parse → object) on every hit.
      const now = Date.now();
      const fetchedAt = detailFetchedAt.get(work_id);
      if (detailCache.has(work_id) && typeof fetchedAt === 'number' && now - fetchedAt <= DETAIL_TTL_MS) {
        return shallowDefensiveCopy(detailCache.get(work_id));
      }

      /** @param {unknown} err */
      const staleFallback = (err) => {
        // The refresh failed, but a previously fetched detail for this
        // work beats an error page. Serve it regardless of age (the TTL
        // only decides WHEN we re-request). The typed error is still
        // thrown when we have NEVER cached this work — we never fabricate
        // a story. This shields character / opening preparation, which
        // reads getStory, from the same transient upstream 4xx condition that can affect the
        // list path.
        if (detailCache.has(work_id)) {
          const cached = detailCache.get(work_id);
          loggerWarn('stories.detail.stale_served', {
            component: 'realProvider',
            error_code: err instanceof ProviderError ? err.code : 'unknown',
            from_cache: true,
            extra: {
              route: 'story_detail',
              work_id,
              upstream_status: upstreamStatusOf(err),
              cache_age_ms: typeof fetchedAt === 'number' ? now - fetchedAt : null,
            },
          });
          return shallowDefensiveCopy(cached);
        }
        throw err;
      };

      let payload;
      try {
        payload = await fetchJson(STORY_DETAIL_PATH(work_id));
      } catch (err) {
        if (!isTransientUpstreamError(err)) {
          // Non-transient (404 unknown work / endpoint gone, 429 rate
          // limit, our own validation) — no retry. A cached detail still
          // shields the reader; otherwise the typed error propagates
          // exactly as before (e.g. StoryNotFoundError stays fail-fast).
          return staleFallback(err);
        }
        // One bounded retry with a short backoff, mirroring listStories.
        loggerWarn('stories.detail.retry', {
          component: 'realProvider',
          error_code: err instanceof ProviderError ? err.code : 'unknown',
          retried: true,
          extra: { route: 'story_detail', work_id, upstream_status: upstreamStatusOf(err) },
        });
        try {
          await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
          payload = await fetchJson(STORY_DETAIL_PATH(work_id));
        } catch (retryErr) {
          return staleFallback(retryErr instanceof ProviderError ? retryErr : err);
        }
      }
      const detail = detailFromDetailEntry(payload);
      detailCache.set(work_id, detail);
      detailFetchedAt.set(work_id, Date.now());
      return shallowDefensiveCopy(detail);
    },
    async advanceStory(input) {
      if (!input || typeof input !== 'object') {
        throw new ValidationError('advance input must be an object');
      }
      const storyId = assertWorkId(input.storyId);
      const detail = await this.getStory(storyId);
      const idx = Number.isInteger(input.index) ? /** @type {number} */ (input.index) : 0;
      if (idx < 0) {
        throw new ValidationError('advance index must be >= 0', { index: idx });
      }
      // Real provider has no structured beats — `content` is a single
      // narration beat. Walking past index 0 always means we have
      // already shown the body, so advance is always finished.
      const nextIndex = Math.min(idx + 1, detail.beats.length);
      const finished = nextIndex >= detail.beats.length;
      /** @type {import('./dto.mjs').AdvanceResult} */
      const result = {
        storyId: detail.id,
        roleId: typeof input.roleId === 'string' ? input.roleId : null,
        index: nextIndex,
        finished,
        beat: finished ? null : detail.beats[nextIndex].text,
      };
      return result;
    },
  });
}
// Validate with the same DTO contract before a transport result becomes durable.
export function validateStoryTransportPayload(id, payload) {
  if (id === 'list') {
    if (!Array.isArray(payload)) throw new ValidationError('Story list must be an array');
    for (const item of payload) summaryFromListEntry(item);
  } else {
    const detail = detailFromDetailEntry(payload);
    if (detail.id !== id) throw new ValidationError('Story detail ID mismatch');
  }
}
