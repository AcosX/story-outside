// src/providers/ecosystem/zhihuSearchSource.mjs — ClickUp 16.2 real
// 知乎搜索 source（直接 HTTP，**不**复用 CLI）。
//
// 契约（主人 2026-09-06 22:21）：
//   * 仅在 STORY_OUTSIDE_PROVIDER=real 且 ZHIHU_OAUTH_APP_KEY /
//     ZHIHU_ACCESS_SECRET / ZHIHU_OAUTH_USER 配置完整时启用。
//   * 调用官方 endpoint: https://api.zhihu.com/api/v1/content/search
//     （按 ClickUp 16.2 记录的官方契约）。**不**伪造成 /openapi/feed/search。
//   * host allowlist 仅 `https://api.zhihu.com` (default port only)。
//   * 30x 重定向手动处理（每次 Location 重新校验 host allowlist）。
//   * timeout / 非 2xx / 网络异常 → 抛 `EcosystemUpstreamError`，
//     由 server.mjs 转 ecosystem_status='unavailable'，**不**影响
//     核心游戏链路（POST /api/sessions 链不会失败）。
//
// 安全契约：
//   * 不把 credential 写入日志 / 错误信息。
//   * 不 trust URL.hostname（IDN / port suffix 攻击面）。
//   * 不 trust fetch 默认的 redirect='follow'（lib 静默跳到非 allowlist）。
//   * query 严格 trim + 长度上限 + 字符白名单（防注入到 upstream URL）。
//   * 响应 body 大小有上限（默认 1 MiB），防 OOM。

import { setTimeout as delay } from 'node:timers/promises';
import { clampDiscussions, dedupeAndRankZhihuDiscussions, isDiscussionShape } from './dto.mjs';

const ALLOWED_BASE = 'https://api.zhihu.com';
const UPSTREAM_PATH = '/api/v1/content/search';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MiB
const MAX_REDIRECTS = 3;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Stable error class so the route layer can distinguish
 * "upstream is down" from "we are misconfigured". Never echoes
 * upstream body / credentials.
 */
export class EcosystemUpstreamError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'EcosystemUpstreamError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * Hard-validate a base URL against the allowlist. Exact match OR
 * starts-with `https://api.zhihu.com/`. Default port only.
 */
export function isAllowedUpstreamBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl) return false;
  const allow = ALLOWED_BASE;
  if (baseUrl.length < allow.length) return false;
  if (baseUrl.slice(0, allow.length).toLowerCase() !== allow) return false;
  if (baseUrl.length === allow.length) return true;
  const tail = baseUrl.charAt(allow.length);
  if (tail !== '/' && tail !== '?' && tail !== '#') return false;
  return true;
}

function assertQuery(raw) {
  if (typeof raw !== 'string') {
    throw new EcosystemUpstreamError('bad_query', 'query must be a string');
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new EcosystemUpstreamError('empty_query', 'query must be non-empty');
  }
  if (trimmed.length > 256) {
    throw new EcosystemUpstreamError('query_too_long', 'query exceeds 256 chars');
  }
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      throw new EcosystemUpstreamError('forbidden_char', 'query contains a control character');
    }
  }
  return trimmed;
}

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Build the Authorization header from credentials. We deliberately do
 * NOT include the credential in the URL or the body.
 */
function buildAuthHeader(creds) {
  if (!creds || typeof creds !== 'object') return null;
  // The hackathon OAuth contract uses app_key + access_secret; we
  // surface it as a Bearer-like header so the upstream sees a clean
  // auth surface. Real wiring depends on the deployed token issuer.
  if (typeof creds.app_key !== 'string' || !creds.app_key) return null;
  if (typeof creds.access_secret !== 'string' || !creds.access_secret) return null;
  const token = `${creds.app_key}.${creds.access_secret}`;
  return `Bearer ${token}`;
}

/**
 * Normalise one raw upstream discussion entry into our DTO shape.
 * Returns null if the entry is malformed (caller filters out).
 */
function normaliseUpstreamEntry(raw, idx) {
  if (!raw || typeof raw !== 'object') return null;
  const threadUuid = typeof raw.id === 'string' && isUuid(raw.id)
    ? raw.id
    : `zhihu-${stableHex(raw.id ?? idx)}-${idx}`;
  const title = pickString(raw, ['title', 'excerpt_title', 'question_title']) || '(无标题)';
  const snippet = pickString(raw, ['excerpt', 'content', 'summary', 'snippet']) || '';
  const url = pickString(raw, ['url', 'link', 'target_url']);
  if (!url) return null;
  let safeUrl = url;
  try {
    const u = new URL(url);
    if (u.hostname !== 'www.zhihu.com' && u.hostname !== 'zhihu.com') {
      // Accept only canonical Zhihu domains for `url`. Upstream host
      // trust is checked separately (see fetchUpstream).
      return null;
    }
    safeUrl = u.toString();
  } catch {
    return null;
  }
  const score = pickNumber(raw, ['score', 'hot_score', 'rank']) || (100 - idx);
  return {
    thread_uuid: threadUuid,
    title,
    snippet,
    url: safeUrl,
    score,
    source: 'zhihu',
  };
}

function pickString(obj, keys) {
  for (const key of keys) {
    if (typeof obj[key] === 'string' && obj[key]) return obj[key];
  }
  return null;
}

function pickNumber(obj, keys) {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function stableHex(input) {
  let h = 0x811c9dc5;
  const s = String(input ?? '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Walk a redirect chain manually. Each step MUST satisfy the host
 * allowlist; otherwise abort with EcosystemUpstreamError.
 */
async function fetchUpstream({ url, headers, timeoutMs, maxBytes, redirectLeft, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new EcosystemUpstreamError('fetch_unavailable', 'global fetch is not available');
  }
  let currentUrl = url;
  let redirectCount = 0;
  while (true) {
    if (!isAllowedUpstreamBaseUrl(currentUrl)) {
      throw new EcosystemUpstreamError('forbidden_redirect', `refusing to follow to non-allowlisted host: ${currentUrl}`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await doFetch(currentUrl, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const code = err && err.name === 'AbortError' ? 'upstream_timeout' : 'upstream_unavailable';
      throw new EcosystemUpstreamError(code, `upstream fetch failed: ${err && err.message ? err.message : String(err)}`);
    }
    clearTimeout(timer);
    // Manual redirect handling.
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) {
        throw new EcosystemUpstreamError('redirect_no_location', `upstream returned ${res.status} without Location`);
      }
      redirectCount += 1;
      if (redirectCount > MAX_REDIRECTS) {
        throw new EcosystemUpstreamError('redirect_too_many', `exceeded ${MAX_REDIRECTS} redirects`);
      }
      let nextUrl;
      try {
        nextUrl = new URL(loc, currentUrl).toString();
      } catch {
        throw new EcosystemUpstreamError('bad_redirect', 'upstream returned unparseable Location');
      }
      currentUrl = nextUrl;
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new EcosystemUpstreamError('upstream_status', `upstream returned status ${res.status}`, { status: res.status });
    }
    // Body cap. Tolerate two body shapes: Web ReadableStream
    // (res.body.getReader) and our test double that yields the entire
    // body as a single Uint8Array via res.body.getReader() returning a
    // { read() } object whose .read() returns { value, done }.
    if (!res.body) {
      throw new EcosystemUpstreamError('no_body', 'upstream response has no body');
    }
    let received = 0;
    let chunks = null;
    if (typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      chunks = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          try { await reader.cancel(); } catch { /* ignore */ }
          throw new EcosystemUpstreamError('upstream_body_too_large', `upstream body exceeded ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    } else if (res.body && typeof res.body[Symbol.asyncIterator] === 'symbol' || typeof res.body[Symbol.asyncIterator] === 'function') {
      chunks = [];
      for await (const value of res.body) {
        received += value.byteLength;
        if (received > maxBytes) {
          throw new EcosystemUpstreamError('upstream_body_too_large', `upstream body exceeded ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    } else {
      throw new EcosystemUpstreamError('unsupported_body', 'upstream body shape not supported');
    }
    const totalLen = chunks.reduce((n, c) => n + c.byteLength, 0);
    const body = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  }
}

/**
 * Real adapter factory. Returns an object matching the mock contract.
 * Use `createRealZhihuSearchSource({ fetcher, baseUrl })` to override
 * the network layer for tests.
 */
export function createRealZhihuSearchSource(opts = {}) {
  const baseUrl = opts.baseUrl || ALLOWED_BASE;
  if (!isAllowedUpstreamBaseUrl(baseUrl)) {
    throw new EcosystemUpstreamError('forbidden_base', `refusing to use non-allowlisted base: ${baseUrl}`);
  }
  const timeoutMs = Number.isInteger(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxBytes = Number.isInteger(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : MAX_RESPONSE_BYTES;
  const fetchImpl = opts.fetcher || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  const creds = opts.credentials || null;

  return Object.freeze({
    name: 'real-zhihu-search',
    source: 'zhihu',
    isReal: true,
    baseUrl,
    /**
     * @param {object} input
     * @param {string} input.query
     * @param {string} [input.story_uuid]
     * @param {string} [input.story_version_uuid]
     * @param {string} [input.community_profile_version]
     * @param {number} [input.limit]
     * @returns {Promise<{ discussions: object[], source: 'zhihu' }>}
     * @throws EcosystemUpstreamError on any network / parse failure
     */
    async search(input) {
      const query = assertQuery(input && input.query);
      const limit = Number.isInteger(input && input.limit) && input.limit > 0
        ? Math.min(input.limit, 20) : 8;
      const url = `${baseUrl}${UPSTREAM_PATH}?q=${encodeURIComponent(query)}&count=${limit}&type=content`;
      const headers = {
        accept: 'application/json',
        'user-agent': 'story-outside/0.1 (zhihu-hackathon-2026-p2; read-only)',
      };
      const auth = buildAuthHeader(creds);
      if (auth) headers.authorization = auth;
      const body = await fetchUpstream({
        url,
        headers,
        timeoutMs,
        maxBytes,
        redirectLeft: MAX_REDIRECTS,
        fetchImpl,
      });
      let parsed;
      try {
        parsed = JSON.parse(Buffer.from(body).toString('utf-8'));
      } catch {
        throw new EcosystemUpstreamError('upstream_body_invalid', 'upstream returned non-JSON');
      }
      const rawList = Array.isArray(parsed && parsed.data)
        ? parsed.data
        : Array.isArray(parsed) ? parsed : [];
      const out = [];
      for (let i = 0; i < rawList.length; i += 1) {
        const normalised = normaliseUpstreamEntry(rawList[i], i);
        if (normalised && isDiscussionShape(normalised)) out.push(normalised);
      }
      const ranked = dedupeAndRankZhihuDiscussions(out);
      const clamped = clampDiscussions(ranked, limit);
      return { discussions: clamped, source: 'zhihu' };
    },
  });
}

export { delay };

/**
 * Probe whether real-source auth is configured. Reads env via opts.env
 * only — never reaches into globalThis. Used by server.mjs to decide
 * real vs mock at startup.
 */
export function hasRealSearchCredentials(env = process.env) {
  if (!env || typeof env !== 'object') return false;
  const appKey = env.ZHIHU_OAUTH_APP_KEY;
  const secret = env.ZHIHU_ACCESS_SECRET;
  const hasKey = typeof appKey === 'string' && appKey.length > 0;
  const hasSecret = typeof secret === 'string' && secret.length > 0;
  return !!(hasKey && hasSecret);
}
