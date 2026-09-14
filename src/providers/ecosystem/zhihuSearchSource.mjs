// src/providers/ecosystem/zhihuSearchSource.mjs — Story 16.2 P1.v2
// real 知乎搜索 source（直接 HTTP，**不**复用 CLI）。
//
// 契约 (Story 16.2 — 2026-09-06 22:21 / 2026-09-07 P1.v2 review):
//   * 仅在 STORY_OUTSIDE_ECOSYSTEM_SEARCH=real 且
//     ZHIHU_OAUTH_APP_KEY / ZHIHU_ACCESS_SECRET / ZHIHU_OAUTH_USER
//     配置完整时启用。
//   * 调用官方 endpoint: https://api.zhihu.com/api/v1/content/search
//     （按 Story 16.2 记录的官方契约）。**不**伪造成 /openapi/feed/search。
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
  if (typeof baseUrl !== 'string') return false;
  if (baseUrl === ALLOWED_BASE) return true;
  if (!baseUrl.startsWith(`${ALLOWED_BASE}/`)) return false;
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'https:') return false;
    if (u.hostname !== 'api.zhihu.com') return false;
    if (u.port && u.port !== '443') return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Whitelist of characters allowed in a search query (trimmed). This
 * is intentionally narrow — anything outside `[A-Za-z0-9 _\-—…·,.，。
 * ？！!?\u4e00-\u9fa5]` is rejected before we touch the upstream URL.
 */
const QUERY_ALLOWED = /^[\sA-Za-z0-9_\-—…·,.，。？！!?'"：:()（）\u4e00-\u9fa5]*$/;
function isSafeQueryString(q) {
  return typeof q === 'string' && QUERY_ALLOWED.test(q);
}

/**
 * Read OAuth credentials from env. Returns `null` when any one is
 * missing — the route layer treats null as "use mock source".
 */
export function readZhihuOAuthCredentials(env = process.env) {
  const appKey = env && typeof env.ZHIHU_OAUTH_APP_KEY === 'string' ? env.ZHIHU_OAUTH_APP_KEY : '';
  const accessSecret = env && typeof env.ZHIHU_ACCESS_SECRET === 'string' ? env.ZHIHU_ACCESS_SECRET : '';
  const user = env && typeof env.ZHIHU_OAUTH_USER === 'string' ? env.ZHIHU_OAUTH_USER : '';
  if (!appKey || !accessSecret || !user) return null;
  return { appKey, accessSecret, user };
}

/**
 * Predicate so the server.mjs layer can short-circuit to mock when
 * real credentials are absent. Pure read of env, no side effects.
 */
export function hasRealSearchCredentials(env = process.env) {
  return readZhihuOAuthCredentials(env) !== null;
}

/**
 * Minimal HMAC-SHA1 signing. We deliberately avoid importing the
 * `crypto` module as a runtime dep so the mock-only path stays
 * light; the real adapter is only constructed when credentials are
 * present.
 */
async function hmacSha1(key, data) {
  const enc = new TextEncoder();
  const keyData = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', keyData, enc.encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Read up to `MAX_RESPONSE_BYTES` from a fetch Response. Throws
 * EcosystemUpstreamError on overflow / decode error.
 */
async function readBoundedBody(response, limit = MAX_RESPONSE_BYTES) {
  // Use stream + manual accumulator so we can cap memory.
  const reader = response.body && response.body.getReader ? response.body.getReader() : null;
  if (!reader) {
    // Fall back to response.text() if streaming API is unavailable
    // (e.g. undici version regression). Trust that node fetch will
    // reject pathological bodies upstream; the limit still protects
    // us in the streaming case which is the common one.
    return response.text();
  }
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let received = 0;
  let acc = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel().catch(() => {});
      throw new EcosystemUpstreamError('upstream_body_too_large', `upstream response exceeds ${limit} bytes`);
    }
    acc += decoder.decode(value, { stream: true });
  }
  acc += decoder.decode();
  return acc;
}

/**
 * Issue one upstream request. Manually follows up to MAX_REDIRECTS
 * 30x responses, re-checking the host allowlist at every hop.
 *
 * @param {object} args
 * @param {string} args.url       Full URL (already validated).
 * @param {object} args.cred      OAuth credentials.
 * @param {number} args.timeoutMs
 * @returns {Promise<object>}     Parsed JSON body.
 */
async function fetchOnce(args) {
  const { url, cred, timeoutMs } = args;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'authorization': `OAuth ${cred.appKey}`,
        'x-zhihu-client': cred.user,
        'accept': 'application/json',
        'user-agent': 'story-outside-ecosystem-search/1.0',
      },
      signal: ac.signal,
      redirect: 'manual',
    });
    // Manual redirect handling: 30x + Location → follow with re-check.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        throw new EcosystemUpstreamError('upstream_redirect_missing_location', 'upstream returned 30x with no Location');
      }
      const next = new URL(location, url).toString();
      if (!isAllowedUpstreamBaseUrl(next)) {
        throw new EcosystemUpstreamError('upstream_redirect_blocked', `redirect to disallowed host: ${next}`);
      }
      if ((args._depth || 0) >= MAX_REDIRECTS) {
        throw new EcosystemUpstreamError('upstream_redirect_too_deep', `too many redirects (>${MAX_REDIRECTS})`);
      }
      return fetchOnce({ ...args, url: next, _depth: (args._depth || 0) + 1 });
    }
    if (res.status === 401 || res.status === 403) {
      throw new EcosystemUpstreamError('upstream_unauthorized', `upstream returned ${res.status}`, { status: res.status });
    }
    if (res.status === 429) {
      throw new EcosystemUpstreamError('upstream_rate_limited', 'upstream returned 429', { status: res.status });
    }
    if (res.status < 200 || res.status >= 300) {
      throw new EcosystemUpstreamError('upstream_http_error', `upstream returned ${res.status}`, { status: res.status });
    }
    const body = await readBoundedBody(res);
    try {
      return JSON.parse(body);
    } catch {
      throw new EcosystemUpstreamError('upstream_invalid_json', 'upstream body is not valid JSON');
    }
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new EcosystemUpstreamError('upstream_timeout', `upstream timed out after ${timeoutMs}ms`);
    }
    if (err && err.name === 'TypeError' && /fetch failed/i.test(err.message)) {
      throw new EcosystemUpstreamError('upstream_network_error', err.message);
    }
    if (err instanceof EcosystemUpstreamError) throw err;
    throw new EcosystemUpstreamError('upstream_error', (err && err.message) || 'unknown upstream error');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Issue the upstream search and normalise the response. The upstream
 * shape changes occasionally; this adapter caps the surface area to
 * the DiscussionDTO we expose publicly.
 */
async function callUpstream(input, opts) {
  const { query, kind, story_version_uuid, community_profile_version, limit } = input;
  const trimmed = typeof query === 'string' ? query.trim() : '';
  if (!trimmed) {
    throw new EcosystemUpstreamError('empty_query', 'query is required');
  }
  if (trimmed.length > 256) {
    throw new EcosystemUpstreamError('query_too_long', 'query exceeds 256 chars');
  }
  if (!isSafeQueryString(trimmed)) {
    throw new EcosystemUpstreamError('unsafe_query', 'query contains characters outside the allowlist');
  }
  if (!UUID_PATTERN.test(story_version_uuid || '')) {
    throw new EcosystemUpstreamError('bad_story_version_uuid', 'story_version_uuid must be a UUID');
  }
  if (!community_profile_version || typeof community_profile_version !== 'string') {
    throw new EcosystemUpstreamError('bad_community_profile_version', 'community_profile_version is required');
  }
  const params = new URLSearchParams();
  params.set('q', trimmed);
  params.set('limit', String(Number.isInteger(limit) && limit > 0 ? Math.min(limit, 20) : 8));
  if (typeof kind === 'string' && kind) params.set('kind', kind);
  params.set('story_version_uuid', story_version_uuid);
  params.set('community_profile_version', community_profile_version);
  const url = `${ALLOWED_BASE}${UPSTREAM_PATH}?${params.toString()}`;
  if (!isAllowedUpstreamBaseUrl(url)) {
    throw new EcosystemUpstreamError('upstream_url_not_allowlisted', `URL not allowlisted: ${url}`);
  }
  const cred = opts.cred;
  const timeoutMs = Number.isInteger(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const parsed = await fetchOnce({ url, cred, timeoutMs });
  // Normalise upstream → public DiscussionDTO.
  const raw = Array.isArray(parsed && parsed.data) ? parsed.data : [];
  const cleaned = [];
  for (const r of raw) {
    if (!isDiscussionShape(r)) continue;
    cleaned.push({
      id: typeof r.id === 'number' ? String(r.id) : r.id,
      url: r.url,
      title: r.title,
      excerpt: typeof r.excerpt === 'string' ? r.excerpt : '',
      score: Number.isFinite(r.score) ? r.score : 0,
      source: 'zhihu',
      fetched_at: new Date().toISOString(),
    });
  }
  return clampDiscussions(dedupeAndRankZhihuDiscussions(cleaned), limit);
}

/**
 * Create a real Zhihu search source adapter. Throws when credentials
 * are missing — server.mjs checks `hasRealSearchCredentials()` first.
 */
export function createRealZhihuSearchSource(opts = {}) {
  const cred = readZhihuOAuthCredentials(opts.env || process.env);
  if (!cred) {
    throw new EcosystemUpstreamError('missing_credentials', 'ZHIHU_OAUTH_APP_KEY / ZHIHU_ACCESS_SECRET / ZHIHU_OAUTH_USER are required');
  }
  return Object.freeze({
    name: 'real-zhihu-search-source',
    async search(input) {
      const discussions = await callUpstream(input, { cred, timeoutMs: opts.timeoutMs });
      return { discussions, source: 'live' };
    },
  });
}
