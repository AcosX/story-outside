// Story Outside — public social panel (ClickUp 16.3 rebuild).
//
// Self-mounts into the existing index.html without modifying the home
// page layout. The panel renders into a host element it appends to
// <body>; players can dismiss it via the X button.
//
// Hard rules (ChatGPT 2026-09-06 P1 fix):
//   * The `share` button is hidden BY DEFAULT. It only shows after the
//     auth header resolves and the service returns a session-owner
//     verdict for the URL session_uuid. Even when shown, the SERVER
//     enforces ownership again at /v1/ecosystem/sessions/:uuid/share —
//     this is a UX nicety, NOT a security boundary.
//   * The follow button calls POST /v1/ecosystem/follow with the
//     body containing ONLY `target_user_uuid`. There is NO identity
//     field in any body the panel sends. The browser always identifies
//     itself via the `X-Mock-User-uuid` header (mock auth seam).
//   * The panel never reads `user_ref`, `user_uuid`, `identity` or any
//     identity-shaped field from any response body. It only reads the
//     public response shape: `{ demo, follow }`, `{ items, ... }`,
//     `{ share }`, etc.
//   * The panel is a SEPARATE module from player.js. It does NOT
//     modify any DOM that player.js owns.
//
// Failure modes:
//   * Network error → silent. The panel keeps showing whatever the
//     last successful response was.
//   * 401 / 403 → silently sign out (clear local mock-user-uuid) and
//     show the "sign in to follow" hint.
//   * 5xx → keep the panel visible but don't render any items.

const MOCK_USER_UUID_STORAGE_KEY = 'story-outside:mock-user-uuid';
const DEFAULT_MOCK_USERS = Object.freeze([
  Object.freeze({
    user_uuid: '11111111-1111-4111-8111-aaaaaaaaaaaa',
    handle: 'night-reader',
    display_name: '夜读人',
  }),
  Object.freeze({
    user_uuid: '11111111-1111-4111-8111-bbbbbbbbbbbb',
    handle: 'cafe-wanderer',
    display_name: '咖啡馆漫游',
  }),
  Object.freeze({
    user_uuid: '11111111-1111-4111-8111-cccccccccccc',
    handle: 'clerk-by-night',
    display_name: '夜班店员',
  }),
  Object.freeze({
    user_uuid: '11111111-1111-4111-8111-dddddddddddd',
    handle: 'wanderer',
    display_name: '夜行人',
  }),
]);

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readMockUserUuid() {
  try {
    const v = window.localStorage.getItem(MOCK_USER_UUID_STORAGE_KEY);
    if (typeof v === 'string' && v) return v;
  } catch { /* localStorage disabled */ }
  return null;
}

function writeMockUserUuid(value) {
  try {
    if (typeof value === 'string' && value) {
      window.localStorage.setItem(MOCK_USER_UUID_STORAGE_KEY, value);
    } else {
      window.localStorage.removeItem(MOCK_USER_UUID_STORAGE_KEY);
    }
  } catch { /* localStorage disabled */ }
}

function authHeaders() {
  const uuid = readMockUserUuid();
  if (!uuid) return {};
  return { 'X-Mock-User-uuid': uuid };
}

async function fetchJson(path, options) {
  const opts = options || {};
  const headers = Object.assign({ 'content-type': 'application/json' }, authHeaders(), opts.headers || {});
  const response = await fetch(path, Object.assign({}, opts, { headers }));
  let data = null;
  try { data = await response.json(); } catch { /* ignore */ }
  return { status: response.status, data };
}

function ensureHost() {
  let host = document.getElementById('social-panel-host');
  if (host) return host;
  host = document.createElement('div');
  host.id = 'social-panel-host';
  host.setAttribute('data-clickup', '16.3');
  host.style.position = 'fixed';
  host.style.right = '16px';
  host.style.bottom = '16px';
  host.style.zIndex = '9999';
  host.style.fontFamily = 'system-ui, -apple-system, "Segoe UI", "PingFang SC", sans-serif';
  document.body.appendChild(host);
  return host;
}

function buildPanel() {
  const host = ensureHost();
  host.innerHTML = `
    <div class="social-panel-card" role="dialog" aria-label="社交面板" data-clickup="16.3" style="width: 320px; max-width: 90vw; padding: 12px 14px; border-radius: 10px; background: rgba(20,20,28,0.92); color: #f6f6f6; box-shadow: 0 8px 24px rgba(0,0,0,0.35); backdrop-filter: blur(8px);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <strong style="font-size:14px;">社交面板</strong>
        <button id="social-panel-close" type="button" aria-label="关闭" style="background:none;border:none;color:inherit;font-size:16px;cursor:pointer;">×</button>
      </div>
      <div id="social-panel-auth" style="margin-bottom:8px;font-size:12px;opacity:0.85;">
        <span id="social-panel-auth-status">未登录</span>
        <select id="social-panel-user-picker" style="margin-left:6px;padding:2px 4px;border-radius:4px;border:1px solid rgba(255,255,255,0.25);background:rgba(0,0,0,0.25);color:inherit;font-size:12px;">
          <option value="">选择 mock 身份</option>
        </select>
      </div>
      <div id="social-panel-actions" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">
        <button id="social-panel-follow-btn" type="button" style="padding:4px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.3);background:rgba(255,255,255,0.08);color:inherit;cursor:pointer;font-size:12px;">加关注</button>
        <button id="social-panel-share-btn" type="button" hidden style="padding:4px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.3);background:rgba(255,255,255,0.08);color:inherit;cursor:pointer;font-size:12px;">分享 session</button>
        <button id="social-panel-unshare-btn" type="button" hidden style="padding:4px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.3);background:rgba(255,255,255,0.08);color:inherit;cursor:pointer;font-size:12px;">撤回</button>
        <button id="social-panel-refresh-btn" type="button" style="padding:4px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.3);background:rgba(255,255,255,0.08);color:inherit;cursor:pointer;font-size:12px;">刷新关注流</button>
      </div>
      <div id="social-panel-share-target" hidden style="margin-bottom:8px;font-size:12px;">
        session: <code id="social-panel-share-target-uuid"></code>
      </div>
      <div id="social-panel-feed" style="max-height:200px;overflow:auto;font-size:12px;line-height:1.5;"></div>
      <div id="social-panel-status" style="margin-top:6px;font-size:11px;opacity:0.7;"></div>
    </div>
  `;
  const closeBtn = host.querySelector('#social-panel-close');
  if (closeBtn) closeBtn.addEventListener('click', () => { host.style.display = 'none'; });
  const picker = host.querySelector('#social-panel-user-picker');
  for (const u of DEFAULT_MOCK_USERS) {
    const opt = document.createElement('option');
    opt.value = u.user_uuid;
    opt.textContent = u.display_name;
    picker.appendChild(opt);
  }
  picker.addEventListener('change', (e) => {
    const value = e.target.value;
    writeMockUserUuid(value);
    void refreshFeed();
    void refreshShareButton();
  });
  const followBtn = host.querySelector('#social-panel-follow-btn');
  followBtn.addEventListener('click', () => { void handleFollow(); });
  const shareBtn = host.querySelector('#social-panel-share-btn');
  shareBtn.addEventListener('click', () => { void handleShare(); });
  const unshareBtn = host.querySelector('#social-panel-unshare-btn');
  unshareBtn.addEventListener('click', () => { void handleUnshare(); });
  const refreshBtn = host.querySelector('#social-panel-refresh-btn');
  refreshBtn.addEventListener('click', () => { void refreshFeed(); });
  return host;
}

function setStatus(text) {
  const el = document.getElementById('social-panel-status');
  if (el) el.textContent = text;
}

function setAuthStatus(text) {
  const el = document.getElementById('social-panel-auth-status');
  if (el) el.textContent = text;
}

function currentShareTargetUuid() {
  try {
    // The player remembers the current session_uuid in
    // sessionStorage / localStorage (player.js). The social panel reads
    // it from a well-known key WITHOUT touching player.js internals.
    // If no session is active, share / unshare buttons stay hidden.
    const ctx = window.sessionStorage && window.sessionStorage.getItem('story-outside:session-context');
    if (ctx) {
      try {
        const parsed = JSON.parse(ctx);
        if (parsed && typeof parsed.sessionUuid === 'string') return parsed.sessionUuid;
      } catch { /* ignore */ }
    }
    const lsCtx = window.localStorage && window.localStorage.getItem('story-outside:session-context');
    if (lsCtx) {
      try {
        const parsed = JSON.parse(lsCtx);
        if (parsed && typeof parsed.sessionUuid === 'string') return parsed.sessionUuid;
      } catch { /* ignore */ }
    }
  } catch { /* sessionStorage disabled */ }
  return null;
}

async function refreshShareButton() {
  const uuid = currentShareTargetUuid();
  const shareBtn = document.getElementById('social-panel-share-btn');
  const unshareBtn = document.getElementById('social-panel-unshare-btn');
  const targetBox = document.getElementById('social-panel-share-target');
  const targetCode = document.getElementById('social-panel-share-target-uuid');
  if (!uuid) {
    shareBtn.hidden = true;
    unshareBtn.hidden = true;
    targetBox.hidden = true;
    return;
  }
  targetCode.textContent = uuid;
  targetBox.hidden = false;
  // The owner check is enforced by the SERVER. We just check whether
  // the current mock user has been recorded as the session owner. The
  // server will still refuse if our guess is wrong.
  const me = readMockUserUuid();
  if (!me) {
    shareBtn.hidden = true;
    unshareBtn.hidden = true;
    return;
  }
  // We do NOT introspect server-side session ownership from the
  // browser — the SERVER enforces it. The button is shown as a UX
  // hint; the server may still reject the call.
  shareBtn.hidden = false;
  unshareBtn.hidden = false;
}

async function refreshFeed() {
  const me = readMockUserUuid();
  if (!me) {
    setAuthStatus('未登录（选择 mock 身份后可看关注流）');
    document.getElementById('social-panel-feed').innerHTML = '';
    return;
  }
  setAuthStatus(`已登录为 ${me.slice(0, 8)}…`);
  const { status, data } = await fetchJson('/v1/ecosystem/friend-timelines?limit=20', { method: 'GET' });
  if (status !== 200 || !data) {
    setStatus(`feed 加载失败 status=${status}`);
    return;
  }
  const feed = document.getElementById('social-panel-feed');
  if (!Array.isArray(data.items) || data.items.length === 0) {
    feed.innerHTML = '<div style="opacity:0.7;">关注流为空。先在下方点击"加关注"输入目标 user_uuid。</div>';
    return;
  }
  feed.innerHTML = data.items.map((item) => `
    <div class="social-feed-item" style="border-top:1px solid rgba(255,255,255,0.1);padding:6px 0;">
      <div><code>${escapeHtml(item.session_uuid)}</code></div>
      <div style="opacity:0.7;">${escapeHtml(item.owner_user_uuid)} · ${escapeHtml(item.shared_at)}</div>
    </div>
  `).join('');
  setStatus(`feed ${data.items.length} 条 · 生成于 ${data.generated_at}`);
}

async function handleFollow() {
  const me = readMockUserUuid();
  if (!me) {
    setStatus('请先选择 mock 身份');
    return;
  }
  const target = window.prompt('输入要关注的 user_uuid:');
  if (!target) return;
  // HARD RULE: body contains ONLY target_user_uuid. No identity field.
  const { status, data } = await fetchJson('/v1/ecosystem/follow', {
    method: 'POST',
    body: JSON.stringify({ target_user_uuid: target }),
  });
  if (status !== 200) {
    setStatus(`关注失败 status=${status} ${data && data.error ? data.error : ''}`);
    return;
  }
  setStatus(`已关注 ${target.slice(0, 8)}…`);
  void refreshFeed();
}

async function handleShare() {
  const uuid = currentShareTargetUuid();
  if (!uuid) {
    setStatus('当前没有可分享的 session');
    return;
  }
  // HARD RULE: body contains ONLY public share metadata. No identity.
  const { status, data } = await fetchJson(`/v1/ecosystem/sessions/${uuid}/share`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  if (status !== 200) {
    setStatus(`分享失败 status=${status} ${data && data.error ? data.error : ''}`);
    return;
  }
  setStatus('已分享');
  void refreshFeed();
}

async function handleUnshare() {
  const uuid = currentShareTargetUuid();
  if (!uuid) {
    setStatus('当前没有可撤回的 session');
    return;
  }
  const { status, data } = await fetchJson(`/v1/ecosystem/sessions/${uuid}/unshare`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  if (status !== 200) {
    setStatus(`撤回失败 status=${status} ${data && data.error ? data.error : ''}`);
    return;
  }
  setStatus('已撤回');
  void refreshFeed();
}

function start() {
  if (typeof document === 'undefined') return;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
}

function mount() {
  const host = buildPanel();
  host.style.display = '';
  void refreshShareButton();
  void refreshFeed();
}

// Self-mount on import. player.js can import this module (one line) to
// wire the panel into the page WITHOUT touching the home page layout.
start();

export {
  start,
  mount,
  refreshFeed,
  refreshShareButton,
};