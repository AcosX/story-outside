// src/providers/ecosystem/zhihuFolloweeSource.mjs — 知乎官方「用户关注」接口适配层。
//
// 契约来源：官方 zhihu Skill 的 references/user-api.md + references/oauth.md
// （2026-09-13 复核，并以真实 Access Secret 实测 `Code:0` 通过）。
//
//   GET https://developer.zhihu.com/api/v1/user/followees?Offset=&Limit=
//   Authorization:      Bearer <开放平台 Access Secret>   —— 鉴权调用方
//   X-OAuth-Token:      <该用户的 OAuth access token>     —— 指明被代表的用户
//   X-Request-Timestamp: <秒级 Unix 时间戳>
//   Content-Type:       application/json
//
// 硬约束：
//   * 两类凭证职责分离。Access Secret 认的是「本应用」，OAuth token 认的是
//     「当前登录的这个人」。缺少 OAuth token 时**绝不**降级为 Access Secret
//     所属账号的关注列表——那会把运营方的关注关系当成玩家自己的。
//   * host 固定 developer.zhihu.com，HTTPS 默认端口；redirect 手动处理并逐跳
//     重新校验，防止被重定向到非白名单主机。
//   * 响应体有大小上限；超时、非 2xx、业务 Code≠0、非 JSON 一律抛 typed error，
//     不循环重试、不回显上游 body、不把凭证写进错误信息。
//   * 只保留展示所需的公开字段（昵称 / 主页标识 / 主页链接 / 头像 / 签名），
//     丢弃粉丝数之外的一切可用于画像的冗余数据。

const ALLOWED_HOST = 'developer.zhihu.com';
const ALLOWED_BASE = `https://${ALLOWED_HOST}`;
const FOLLOWEES_PATH = '/api/v1/user/followees';
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;
const MAX_LIMIT = 50;

/**
 * Typed error so the route layer can distinguish「没配置」「没登录」
 * 「上游挂了」，并对玩家一律降级为「暂时看不到」而不是 5xx。
 */
export class ZhihuFolloweeError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ZhihuFolloweeError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * 从环境变量读取开放平台 Access Secret。缺失时返回 null——调用方据此把
 * 相遇模块标成 `unconfigured`，而不是抛错阻断「我的」页面。
 */
export function readAccessSecret(env = process.env) {
  const secret = env && typeof env.ZHIHU_ACCESS_SECRET === 'string' ? env.ZHIHU_ACCESS_SECRET.trim() : '';
  return secret || null;
}

export function hasFolloweeCredentials(env = process.env) {
  return readAccessSecret(env) !== null;
}

function isAllowedUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { return false; }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.hostname.toLowerCase() !== ALLOWED_HOST) return false;
  if (parsed.port && parsed.port !== '443') return false;
  return true;
}

async function readBoundedBody(response, limit = MAX_RESPONSE_BYTES) {
  const reader = response.body && response.body.getReader ? response.body.getReader() : null;
  if (!reader) return response.text();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let received = 0;
  let acc = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel().catch(() => {});
      throw new ZhihuFolloweeError('upstream_body_too_large', `upstream response exceeds ${limit} bytes`);
    }
    acc += decoder.decode(value, { stream: true });
  }
  acc += decoder.decode();
  return acc;
}

async function fetchOnce({ url, accessSecret, oauthToken, timeoutMs, fetchImpl, depth = 0 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessSecret}`,
        'x-oauth-token': oauthToken,
        'x-request-timestamp': String(Math.floor(Date.now() / 1000)),
        'content-type': 'application/json',
        accept: 'application/json',
      },
      signal: controller.signal,
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new ZhihuFolloweeError('upstream_redirect_missing_location', 'upstream returned 30x with no Location');
      const next = new URL(location, url).toString();
      if (!isAllowedUrl(next)) throw new ZhihuFolloweeError('upstream_redirect_blocked', 'redirect target is not allowlisted');
      if (depth >= MAX_REDIRECTS) throw new ZhihuFolloweeError('upstream_redirect_too_deep', `too many redirects (>${MAX_REDIRECTS})`);
      return fetchOnce({ url: next, accessSecret, oauthToken, timeoutMs, fetchImpl, depth: depth + 1 });
    }
    if (response.status === 401 || response.status === 403) {
      throw new ZhihuFolloweeError('upstream_unauthorized', `upstream returned ${response.status}`, { status: response.status });
    }
    if (response.status === 429) {
      throw new ZhihuFolloweeError('upstream_rate_limited', 'upstream returned 429', { status: response.status });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ZhihuFolloweeError('upstream_http_error', `upstream returned ${response.status}`, { status: response.status });
    }
    const text = await readBoundedBody(response);
    let payload;
    try { payload = JSON.parse(text); } catch {
      throw new ZhihuFolloweeError('upstream_invalid_json', 'upstream body is not valid JSON');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ZhihuFolloweeError('upstream_invalid_json', 'upstream body is not a JSON object');
    }
    // 业务错误可能带 HTTP 200；必须按 Code 判定。20001 是鉴权失败。
    const code = Number(payload.Code);
    if (Number.isFinite(code) && code !== 0) {
      const mapped = code === 20001 ? 'upstream_unauthorized'
        : (code === 30001 || code === 30002) ? 'upstream_rate_limited'
          : 'upstream_business_error';
      throw new ZhihuFolloweeError(mapped, `upstream business code ${code}`, { business_code: code });
    }
    return payload;
  } catch (error) {
    if (error instanceof ZhihuFolloweeError) throw error;
    if (error && error.name === 'AbortError') {
      throw new ZhihuFolloweeError('upstream_timeout', `upstream timed out after ${timeoutMs}ms`);
    }
    throw new ZhihuFolloweeError('upstream_network_error', 'upstream request failed');
  } finally {
    clearTimeout(timer);
  }
}

function normaliseItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const urlToken = typeof raw.UrlToken === 'string' ? raw.UrlToken.trim() : '';
  if (!urlToken) return null;
  const profileUrl = typeof raw.Url === 'string' && /^https:\/\/(www\.)?zhihu\.com\//.test(raw.Url)
    ? raw.Url
    : `https://www.zhihu.com/people/${encodeURIComponent(urlToken)}`;
  const avatar = typeof raw.AvatarUrl === 'string' && /^https:\/\//.test(raw.AvatarUrl) ? raw.AvatarUrl : '';
  return Object.freeze({
    url_token: urlToken,
    fullname: typeof raw.Fullname === 'string' && raw.Fullname.trim() ? raw.Fullname.trim().slice(0, 100) : '知乎用户',
    url: profileUrl,
    avatar_url: avatar,
    headline: typeof raw.Headline === 'string' ? raw.Headline.trim().slice(0, 140) : '',
  });
}

/**
 * 读取「当前登录用户」的知乎关注列表。
 *
 * @param {object} input
 * @param {string} input.oauthToken       当前会话的知乎用户 access token。
 * @param {number} [input.limit]          单页条数，1..50。
 * @param {number} [input.offset]         分页偏移。
 * @param {number} [input.maxPages]       最多翻几页（默认 4，即 ≤200 人）。
 * @param {object} [options]
 * @returns {Promise<{ items: object[], total: number|null, truncated: boolean }>}
 */
export async function fetchFollowees(input, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const accessSecret = readAccessSecret(env);
  if (!accessSecret) {
    throw new ZhihuFolloweeError('unconfigured', 'ZHIHU_ACCESS_SECRET is not configured');
  }
  const oauthToken = typeof input?.oauthToken === 'string' ? input.oauthToken : '';
  // 没有用户 token 就没有「这个人」，绝不退回 Access Secret 所属账号。
  if (!oauthToken || /[\s\x00-\x1f\x7f]/.test(oauthToken)) {
    throw new ZhihuFolloweeError('missing_oauth_token', 'a per-user OAuth access token is required');
  }
  const limit = Number.isInteger(input?.limit) && input.limit > 0 ? Math.min(input.limit, MAX_LIMIT) : 20;
  const maxPages = Number.isInteger(options.maxPages) && options.maxPages > 0 ? Math.min(options.maxPages, 10) : 4;

  const items = [];
  const seen = new Set();
  let offset = Number.isInteger(input?.offset) && input.offset >= 0 ? input.offset : 0;
  let total = null;
  let truncated = false;

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(ALLOWED_BASE + FOLLOWEES_PATH);
    url.searchParams.set('Offset', String(offset));
    url.searchParams.set('Limit', String(limit));
    if (!isAllowedUrl(url.toString())) {
      throw new ZhihuFolloweeError('upstream_url_not_allowlisted', 'constructed URL is not allowlisted');
    }
    const payload = await fetchOnce({ url: url.toString(), accessSecret, oauthToken, timeoutMs, fetchImpl });
    const data = payload && typeof payload.Data === 'object' && payload.Data ? payload.Data : {};
    const rawItems = Array.isArray(data.Items) ? data.Items : [];
    for (const raw of rawItems) {
      const item = normaliseItem(raw);
      if (!item || seen.has(item.url_token)) continue;
      seen.add(item.url_token);
      items.push(item);
    }
    const paging = data.Paging && typeof data.Paging === 'object' ? data.Paging : null;
    if (paging && Number.isFinite(Number(paging.Totals))) total = Number(paging.Totals);
    if (!paging || paging.IsEnd !== false) break;
    // 文档：请求参数 Offset 是 Int64，响应 NextOffset 却是 String。严格解析，
    // 解析失败就停在当前页，不静默截断成 0 重新拉第一页。
    const nextOffset = Number.parseInt(String(paging.NextOffset ?? ''), 10);
    if (!Number.isInteger(nextOffset) || nextOffset <= offset) break;
    offset = nextOffset;
    if (page === maxPages - 1) truncated = true;
  }

  return { items: Object.freeze(items), total, truncated };
}

export const _internals = Object.freeze({
  ALLOWED_BASE,
  FOLLOWEES_PATH,
  isAllowedUrl,
  normaliseItem,
});
