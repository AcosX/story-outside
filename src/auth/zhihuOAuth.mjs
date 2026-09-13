import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

const COOKIE = '__Host-story_outside_session';
const FLOW_COOKIE = '__Host-story_outside_oauth';
const FLOW_MS = 10 * 60 * 1000;
const SESSION_MS = 8 * 60 * 60 * 1000;
const random = () => randomBytes(32).toString('base64url');
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });
const validSecret = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\s\x00-\x1f\x7f]/.test(value);

export function loadOAuthConfig(env = process.env) {
  let fields = {};
  try {
    const text = readFileSync(env.STORY_OUTSIDE_OAUTH_SECRET_FILE || new URL('../../secrets/secret', import.meta.url), 'utf8');
    fields = Object.fromEntries(text.split(/\r?\n/).map(line => {
      const i = line.indexOf(':');
      return i < 0 ? [] : [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }).filter(pair => pair.length));
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read OAuth configuration'); }
  const appId = env.ZHIHU_OAUTH_APP_ID || fields['OAuth App ID'];
  const mode = env.STORY_OUTSIDE_AUTH_MODE || (appId || env.ZHIHU_OAUTH_APP_KEY || fields['OAuth App Key'] || env.ZHIHU_OAUTH_REDIRECT_URI || fields['OAuth Redirect URI'] ? 'oauth' : 'demo');
  if (mode === 'demo') {
    if (env.NODE_ENV === 'production') throw new Error('Real deployments require OAuth configuration');
    return null;
  }
  if (mode !== 'oauth') throw new Error('Invalid authentication mode');
  const config = {
    appId,
    appKey: env.ZHIHU_OAUTH_APP_KEY || fields['OAuth App Key'],
    redirectUri: env.ZHIHU_OAUTH_REDIRECT_URI || fields['OAuth Redirect URI'],
  };
  if (!/^\d+$/.test(appId || '') || !validSecret(config.appKey)) throw new Error('OAuth credentials are incomplete');
  let callback;
  try { callback = new URL(config.redirectUri); } catch { throw new Error('OAuth callback must be a public HTTPS URL'); }
  if (callback.protocol !== 'https:' || callback.username || callback.password || callback.search || callback.hash || callback.pathname !== '/auth/callback' || /^(localhost|127\.|\[|0\.)/.test(callback.hostname)) throw new Error('OAuth callback must be a public HTTPS URL ending in /auth/callback');
  return Object.freeze({ ...config, origin: callback.origin });
}

function cookie(req, name) {
  const matches = (req.headers.cookie || '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
function setCookie(res, name, value, maxAge) {
  const next = `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
  const previous = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(previous) ? previous : previous ? [previous] : []), next]);
}
function same(a, b) {
  return typeof a === 'string' && typeof b === 'string' && /^[A-Za-z0-9_-]{43}$/.test(a) && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function safeReturn(value) {
  if (typeof value !== 'string' || !/^\/(?:\?|$)/.test(value) || /[\r\n\\]/.test(value) || value.length > 2048) return '/';
  const url = new URL(value, 'https://return.invalid');
  for (const key of ['code', 'authorization_code', 'state', 'oauth_error']) url.searchParams.delete(key);
  return url.pathname + url.search;
}
export function ownerFromProfile(payload, appId) {
  const source = payload?.uid !== undefined ? payload : payload?.data;
  if (payload?.code !== undefined && payload.code !== 20000) throw fail('oauth_identity_unavailable', 502);
  // Accept the documented stable uid only; never
  // derive identity from a display name, token, or Access Secret's account.
  const id = source?.uid;
  if (!source || Array.isArray(source) || !((typeof id === 'string' && /^[1-9][0-9]{0,19}$/.test(id)) || (Number.isSafeInteger(id) && id > 0))) throw fail('oauth_identity_unavailable', 502);
  const bytes = createHash('sha256').update(`zhihu:${appId}:${id}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50; bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex');
  return Object.freeze({
    user_uuid: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    display_name: typeof source.fullname === 'string' && source.fullname.trim() ? source.fullname.trim().slice(0, 100) : '知乎用户',
    auth_source: 'zhihu_oauth',
  });
}

export function createZhihuOAuth(config, { fetchImpl = (...args) => fetch(...args), now = Date.now, maxEntries = 10000 } = {}) {
  const flows = new Map();
  const sessions = new Map();
  const enabled = Boolean(config);
  function prune(map) {
    for (const [key, value] of map) if (value.expiresAt <= now()) map.delete(key);
  }
  function reserve(map) {
    prune(map);
    if (map.size >= maxEntries) throw fail('oauth_busy', 503);
  }
  function current(req) {
    const id = cookie(req, COOKIE);
    const session = sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= now()) { sessions.delete(id); return null; }
    return session;
  }
  async function request(url, options) {
    try {
      const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) });
      if (!response.ok) { await response.body?.cancel(); throw fail('oauth_upstream_failed', 502); }
      const chunks = []; let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 65536) throw fail('oauth_upstream_failed', 502);
        chunks.push(Buffer.from(chunk));
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw fail('oauth_upstream_failed', 502);
      return payload;
    } catch { throw fail('oauth_upstream_failed', 502); }
  }
  function assertOrigin(req) {
    if (req.headers.origin !== config.origin || req.headers['sec-fetch-site'] === 'cross-site') throw fail('csrf_rejected', 403);
  }
  function status(req) {
    const session = current(req);
    return { configured: enabled, authenticated: Boolean(session), owner: session?.owner || null, expires_at: session ? new Date(session.expiresAt).toISOString() : null, login_url: enabled ? '/auth/login' : null };
  }
  function start(req, res, url) {
    if (!enabled) throw fail('oauth_not_configured', 503);
    reserve(flows);
    // Re-starting in this browser invalidates its previous flow.
    flows.delete(cookie(req, FLOW_COOKIE));
    const id = random(); const state = random();
    flows.set(id, { state, expiresAt: now() + FLOW_MS, returnTo: safeReturn(url.searchParams.get('return_to')) });
    setCookie(res, FLOW_COOKIE, id, FLOW_MS / 1000);
    const authorize = new URL('https://openapi.zhihu.com/authorize');
    for (const [key, value] of Object.entries({ app_id: config.appId, redirect_uri: config.redirectUri, response_type: 'code', state })) authorize.searchParams.set(key, value);
    return authorize.href;
  }
  async function callback(req, res, url) {
    if (!enabled) throw fail('oauth_not_configured', 503);
    const id = cookie(req, FLOW_COOKIE);
    const flow = flows.get(id);
    // Consume before the first await, including failed callbacks and replays.
    if (!flow?.used) flows.delete(id);
    setCookie(res, FLOW_COOKIE, '', 0);
    if (!flow || flow.used || flow.expiresAt <= now() || url.searchParams.getAll('state').length !== 1 || !same(url.searchParams.get('state'), flow.state)) throw fail('oauth_state_invalid');
    if (url.searchParams.has('error')) throw fail('oauth_denied');
    const codes = [...url.searchParams.getAll('authorization_code'), ...url.searchParams.getAll('code')];
    if (codes.length !== 1 || !validSecret(codes[0])) throw fail('oauth_code_invalid');
    flow.used = true; flows.set(id, flow);
    try {
      reserve(sessions);
      const payload = await request('https://openapi.zhihu.com/access_token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ app_id: config.appId, app_key: config.appKey, redirect_uri: config.redirectUri, grant_type: 'authorization_code', code: codes[0] }).toString(),
      });
      const data = payload.access_token ? payload : payload.data || payload.Data;
      const ttl = Number(data?.expires_in);
      if (!validSecret(data?.access_token) || !Number.isFinite(ttl) || ttl <= 0 || (data.token_type && (typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer'))) throw fail('oauth_token_invalid', 502);
      const expiresAt = now() + Math.min(ttl * 1000, SESSION_MS);
      const profile = await request('https://openapi.zhihu.com/user', {
        headers: { Authorization: `Bearer ${data.access_token}`, 'content-type': 'application/json' },
      });
      const owner = ownerFromProfile(profile, config.appId);
      if (expiresAt <= now()) throw fail('oauth_token_invalid', 502);
      if (flows.get(id) !== flow || flow.expiresAt <= now()) throw fail('oauth_state_invalid');
      reserve(sessions);
      sessions.delete(cookie(req, COOKIE));
      const sessionId = random();
      // Tokens and sessions are process-local; restarting requires reauthorization.
      sessions.set(sessionId, { owner, expiresAt });
      setCookie(res, COOKIE, sessionId, Math.max(1, Math.floor((expiresAt - now()) / 1000)));
      return flow.returnTo;
    } finally { if (flows.get(id) === flow) flows.delete(id); }
  }
  function logout(req, res) {
    assertOrigin(req);
    sessions.delete(cookie(req, COOKIE)); flows.delete(cookie(req, FLOW_COOKIE));
    setCookie(res, COOKIE, '', 0); setCookie(res, FLOW_COOKIE, '', 0);
  }
  return { enabled, status, start, callback, logout, assertOrigin, owner: req => current(req)?.owner || null };
}
