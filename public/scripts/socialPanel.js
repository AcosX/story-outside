// Story Outside — public social panel (ClickUp 16.3 P1 v1-3 rebuild).
//
// Self-mounts into the existing index.html without modifying the home
// page layout. The panel renders into a host element it appends to
// <body>; players can dismiss it via the X button.
//
// Hard rules (主人 2026-09-07 05:xx 巡检 + ChatGPT 复核 v1-3):
//
//   * The panel NEVER carries caller principal. There is no
//     `X-Mock-User-uuid` header, no `story_outside_session` cookie,
//     and no caller-shaped field in any body the panel sends. The
//     server resolves the principal through `currentUserProvider(req)`
//     (always OAUTH_PENDING_USER in this build); the panel is the UI
//     surface for that fixed principal.
//   * The panel does NOT read any principal-shaped value from
//     `localStorage`, `document.cookie`, `window.*`, or any response
//     body — those values are the server's responsibility. The panel
//     only renders the public display name fetched from
//     `GET /api/auth/status` so the player can see *who they are* in
//     the OAuth-pending build. That single display_name is purely a
//     presentation hint; it is not used to call any other endpoint.
//   * The `follow` button calls `POST /v1/ecosystem/follow` with the
//     body containing ONLY the server-required wire field. There is
//     NO caller-shaped field in any body the panel sends.
//   * The `share` and `unshare` buttons call
//     `/v1/ecosystem/sessions/:uuid/{share,unshare}` (HTTP POST)
//     WITHOUT a body. The server resolves the canonical owner through
//     `currentUserProvider(req)`; a missing / invalid body is a 400
//     by design, and the panel does NOT attempt to work around it.
//   * The `friend-timelines` button calls `GET
//     /v1/ecosystem/friend-timelines?limit=20`. The response is read
//     as a public projection — the panel never introspects
//     server-side ownership from a response payload.
//
// Failure modes:
//   * Network error → silent. The panel keeps showing whatever the
//     last successful response was.
//   * 4xx / 5xx → the status line surfaces the error code and the
//     server's `error` field; the panel keeps its last rendered state.
//   * The panel is a SEPARATE module from player.js. It does NOT
//     modify any DOM that player.js owns, and it does NOT touch any
//     persistence layer.
//
// Lifecycle (ClickUp 16.3 P1 v1-3):
//   * The panel is mounted by player.js via a lazy `import()` so the
//     home page DOM stays untouched.
//   * The test harness rewrites that `import()` into a
//     `globalThis.__HARNESS_IMPORT_SOCIAL_PANEL__()` call so existing
//     09 / endingPage / 16.3 test files do not break when the panel is
//     loaded from a Node-side harness.

const OAUTH_PENDING_DISPLAY_NAME = '待接入用户 (OAuth pending)';

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function fetchJson(path, options) {
  const opts = options || {};
  const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
  const response = await fetch(path, Object.assign({}, opts, { headers }));
  let data = null;
  try { data = await response.json(); } catch { /* ignore non-JSON */ }
  return { status: response.status, data };
}

function ensureHost() {
  let host = document.getElementById('social-panel-host');
  if (host) return host;
  host = document.createElement('div');
  host.id = 'social-panel-host';
  host.setAttribute('data-clickup', '16.3-v1-3');
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
  // Build the panel DOM via createElement + appendChild so the
  // element graph is real (real browsers and the test harness both
  // expose the children through getElementById / querySelector).
  // We deliberately do NOT use `innerHTML = '...'` because the test
  // harness's minimal DOM polyfill does not parse HTML into elements.
  const card = document.createElement('div');
  card.className = 'social-panel-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', '社交面板');
  card.setAttribute('data-clickup', '16.3-v1-3');
  Object.assign(card.style, {
    width: '320px',
    maxWidth: '90vw',
    padding: '12px 14px',
    borderRadius: '10px',
    background: 'rgba(20,20,28,0.92)',
    color: '#f6f6f6',
    boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
    backdropFilter: 'blur(8px)',
  });
  host.appendChild(card);

  const headerRow = document.createElement('div');
  Object.assign(headerRow.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '8px',
  });
  card.appendChild(headerRow);
  const title = document.createElement('strong');
  title.style.fontSize = '14px';
  title.textContent = '社交面板';
  headerRow.appendChild(title);
  const closeBtn = document.createElement('button');
  closeBtn.id = 'social-panel-close';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '关闭');
  Object.assign(closeBtn.style, {
    background: 'none',
    border: 'none',
    color: 'inherit',
    fontSize: '16px',
    cursor: 'pointer',
  });
  closeBtn.textContent = '×';
  headerRow.appendChild(closeBtn);

  const authRow = document.createElement('div');
  authRow.id = 'social-panel-auth';
  Object.assign(authRow.style, { marginBottom: '8px', fontSize: '12px', opacity: '0.85' });
  card.appendChild(authRow);
  const authStatus = document.createElement('span');
  authStatus.id = 'social-panel-auth-status';
  authStatus.textContent = '未登录';
  authRow.appendChild(authStatus);

  const actions = document.createElement('div');
  actions.id = 'social-panel-actions';
  Object.assign(actions.style, {
    display: 'flex',
    gap: '6px',
    flexWrap: 'wrap',
    marginBottom: '8px',
  });
  card.appendChild(actions);
  const followBtn = document.createElement('button');
  followBtn.id = 'social-panel-follow-btn';
  followBtn.type = 'button';
  followBtn.textContent = '加关注';
  actions.appendChild(followBtn);
  // ClickUp 16.3 P1 v1-5: the panel NEVER creates a session. The
  // panel is a passive UI surface; the player is the single source
  // of truth for session lifecycle, and only the player can call
  // `bootstrapSession` (with a real story + role picked by the
  // user). Without a session the share / unshare buttons stay
  // hidden and the panel surfaces a "请先选择故事 + 角色" hint.
  const shareBtn = document.createElement('button');
  shareBtn.id = 'social-panel-share-btn';
  shareBtn.type = 'button';
  shareBtn.textContent = '分享这段故事';
  shareBtn.hidden = true;
  actions.appendChild(shareBtn);
  const unshareBtn = document.createElement('button');
  unshareBtn.id = 'social-panel-unshare-btn';
  unshareBtn.type = 'button';
  unshareBtn.textContent = '撤回';
  unshareBtn.hidden = true;
  actions.appendChild(unshareBtn);
  const refreshBtn = document.createElement('button');
  refreshBtn.id = 'social-panel-refresh-btn';
  refreshBtn.type = 'button';
  refreshBtn.textContent = '刷新关注流';
  actions.appendChild(refreshBtn);
  for (const btn of [followBtn, shareBtn, unshareBtn, refreshBtn]) {
    Object.assign(btn.style, {
      padding: '4px 10px',
      borderRadius: '6px',
      border: '1px solid rgba(255,255,255,0.3)',
      background: 'rgba(255,255,255,0.08)',
      color: 'inherit',
      cursor: 'pointer',
      fontSize: '12px',
    });
  }

  const shareTargetBox = document.createElement('div');
  shareTargetBox.id = 'social-panel-share-target';
  shareTargetBox.hidden = true;
  // We use textContent (rather than createTextNode + appendChild) so
  // the panel works under both real browsers AND the test harness's
  // minimal DOM polyfill — the harness does not implement
  // `document.createTextNode`.
  shareTargetBox.textContent = 'session: ';
  Object.assign(shareTargetBox.style, { marginBottom: '8px', fontSize: '12px' });
  card.appendChild(shareTargetBox);
  const shareTargetCode = document.createElement('code');
  shareTargetCode.id = 'social-panel-share-target-uuid';
  shareTargetBox.appendChild(shareTargetCode);

  // ClickUp 16.3 P1 v1-5: when no session is remembered (fresh tab,
  // last-session wiped, or deep link with no history) the panel
  // surfaces a hint instead of a create-session button. The panel
  // does NOT create sessions — only `player.bootstrapSession` does,
  // after a real story + role is picked through the picker.
  const shareHint = document.createElement('div');
  shareHint.id = 'social-panel-share-hint';
  shareHint.textContent = '请先选择故事 + 角色';
  Object.assign(shareHint.style, { marginBottom: '8px', fontSize: '12px', opacity: '0.7' });
  card.appendChild(shareHint);

  const feed = document.createElement('div');
  feed.id = 'social-panel-feed';
  Object.assign(feed.style, {
    maxHeight: '200px',
    overflow: 'auto',
    fontSize: '12px',
    lineHeight: '1.5',
  });
  card.appendChild(feed);

  const status = document.createElement('div');
  status.id = 'social-panel-status';
  Object.assign(status.style, { marginTop: '6px', fontSize: '11px', opacity: '0.7' });
  card.appendChild(status);

  closeBtn.addEventListener('click', () => { host.style.display = 'none'; });
  followBtn.addEventListener('click', () => { void handleFollow(); });
  shareBtn.addEventListener('click', () => { void handleShare(); });
  unshareBtn.addEventListener('click', () => { void handleUnshare(); });
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

// ClickUp 16.3 P1 v1-4 (主人 2026-09-07 06:24 巡检 + ChatGPT
// 复核): the panel reads the current session UUID from the single
// helper module `/scripts/sessionContext.js` (loaded lazily by
// player.js and re-imported here for resilience). The helper owns
// exactly ONE storage key (`story-outside:last-session`) and
// dispatches a `session:changed` CustomEvent on `window` whenever
// that key changes — the panel listens for the event in `mount()`
// and calls `refreshShareButton()` instead of re-mounting. The
// previous bogus global session-context object on `window` and the
// secondary session-context slot are GONE. The panel does NOT
// interpret the value as caller principal — it is just a routing
// hint for which session the share / unshare buttons should target.
let _sessionContextModule = null;
async function loadSessionContext() {
  if (_sessionContextModule) return _sessionContextModule;
  try {
    _sessionContextModule = await import('/scripts/sessionContext.js');
  } catch {
    _sessionContextModule = null;
  }
  return _sessionContextModule;
}

async function currentShareTargetUuid() {
  const helper = await loadSessionContext();
  if (helper && typeof helper.getCurrentShareTargetUuid === 'function') {
    try {
      const uuid = helper.getCurrentShareTargetUuid();
      if (typeof uuid === 'string' && uuid) return uuid;
    } catch { /* fall through to direct read */ }
  }
  // Synchronous fallback so the panel always has a value: read the
  // SINGLE storage key directly. There is no secondary key.
  try {
    if (typeof sessionStorage !== 'undefined') {
      const raw = sessionStorage.getItem('story-outside:last-session');
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.sessionUuid === 'string' && parsed.sessionUuid) return parsed.sessionUuid;
        } catch { /* ignore */ }
      }
    }
  } catch { /* sessionStorage disabled */ }
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem('story-outside:last-session');
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.sessionUuid === 'string' && parsed.sessionUuid) return parsed.sessionUuid;
        } catch { /* ignore */ }
      }
    }
  } catch { /* localStorage disabled */ }
  return null;
}

async function refreshAuthStatus() {
  const { status, data } = await fetchJson('/api/auth/status', { method: 'GET' });
  if (status === 200 && data?.configured && !data.authenticated) {
    setAuthStatus('登录知乎后，查看朋友的故事');
    for (const id of ['social-panel-follow-btn', 'social-panel-share-btn', 'social-panel-unshare-btn']) {
      const button = document.getElementById(id); if (button) button.disabled = true;
    }
    return null;
  }
  if (status !== 200 || !data || !data.owner) {
    setAuthStatus('暂时无法读取账户');
    return null;
  }
  for (const id of ['social-panel-follow-btn', 'social-panel-share-btn', 'social-panel-unshare-btn']) {
    const button = document.getElementById(id); if (button) button.disabled = false;
  }
  const name = data.owner.display_name || OAUTH_PENDING_DISPLAY_NAME;
  setAuthStatus(`已登录 · ${name}`);
  return data.owner;
}

async function refreshShareButton() {
  const uuid = await currentShareTargetUuid();
  const shareBtn = document.getElementById('social-panel-share-btn');
  const unshareBtn = document.getElementById('social-panel-unshare-btn');
  const targetBox = document.getElementById('social-panel-share-target');
  const targetCode = document.getElementById('social-panel-share-target-uuid');
  const hintEl = document.getElementById('social-panel-share-hint');
  if (!uuid) {
    if (shareBtn) shareBtn.hidden = true;
    if (unshareBtn) unshareBtn.hidden = true;
    if (targetBox) targetBox.hidden = true;
    if (hintEl) hintEl.hidden = false;
    return;
  }
  if (targetCode) targetCode.textContent = uuid;
  if (targetBox) targetBox.hidden = false;
  if (hintEl) hintEl.hidden = true;
  // The owner check is enforced by the SERVER. The share / unshare
  // buttons are UX hints — the server may still reject the call with
  // 400 if it sees a principal-shaped body, which it will because the
  // panel sends no body on purpose.
  if (shareBtn) shareBtn.hidden = false;
  if (unshareBtn) unshareBtn.hidden = false;
}

async function refreshFeed() {
  const { status, data } = await fetchJson('/v1/ecosystem/friend-timelines?limit=20', { method: 'GET' });
  if (status === 401) {
    setStatus('请点击页面上方的知乎登录。');
    return;
  }
  if (status !== 200 || !data) {
    setStatus('动态暂时未能加载，请稍后刷新。');
    return;
  }
  const feed = document.getElementById('social-panel-feed');
  if (!feed) return;
  if (!Array.isArray(data.items) || data.items.length === 0) {
    feed.innerHTML = '<div style="opacity:0.7;">还没有关注的故事。关注一位朋友，看看他们的选择。</div>';
    setStatus('');
    return;
  }
  feed.innerHTML = data.items.map((item) => `
    <div class="social-feed-item" style="border-top:1px solid rgba(255,255,255,0.1);padding:6px 0;">
      <div><code>${escapeHtml(item.session_uuid)}</code></div>
      <div style="opacity:0.7;">${escapeHtml(item.shared_at || '')}</div>
    </div>
  `).join('');
  setStatus(`${data.items.length} 条故事动态`);
}

async function handleFollow() {
  const target = window.prompt('输入朋友的用户编号：');
  if (!target) return;
  // HARD RULE: body contains ONLY the server-required wire field.
  // The follow endpoint names that wire field after the target of
  // the follow action (NOT a caller-shaped field); the browser never
  // sends any caller-shaped field; the server resolves owner via
  // currentUserProvider(req).
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
  const uuid = await currentShareTargetUuid();
  if (!uuid) {
    setStatus('当前没有可分享的故事');
    return;
  }
  // HARD RULE: no body at all. The OAuth-pending share endpoint
  // demands Content-Length: 0 — even `{}` is a 400. The server
  // resolves principal via currentUserProvider(req); the browser
  // never sends one.
  const response = await fetch(`/v1/ecosystem/sessions/${uuid}/share`, { method: 'POST' });
  let data = null;
  try { data = await response.json(); } catch { /* ignore non-JSON */ }
  if (response.status !== 200) {
    setStatus(`分享失败 status=${response.status} ${data && data.error ? data.error : ''}`);
    return;
  }
  setStatus('已分享');
  void refreshFeed();
}

async function handleUnshare() {
  const uuid = await currentShareTargetUuid();
  if (!uuid) {
    setStatus('当前没有可撤回的故事');
    return;
  }
  // HARD RULE: no body. Unshare rejects any non-empty body to keep
  // principal out of the wire. Server resolves owner through
  // currentUserProvider(req).
  const response = await fetch(`/v1/ecosystem/sessions/${uuid}/unshare`, { method: 'POST' });
  let data = null;
  try { data = await response.json(); } catch { /* ignore non-JSON */ }
  if (response.status !== 200) {
    setStatus(`撤回失败 status=${response.status} ${data && data.error ? data.error : ''}`);
    return;
  }
  setStatus('已撤回');
  void refreshFeed();
}

// mount() runs once per panel lifetime. It does NOT poll, does NOT
// re-build the DOM, and does NOT loop. The panel subscribes to the
// `session:changed` CustomEvent dispatched by the
// `/scripts/sessionContext.js` helper (and by player.js directly)
// whenever the active session UUID changes, and the handler calls
// `refreshShareButton()` so the share / unshare buttons appear and
// point at the new UUID without re-mounting. ClickUp 16.3 P1 v1-5:
// the panel does NOT create sessions itself — `player.bootstrapSession`
// is the only legitimate entry point. When no session is remembered
// the panel surfaces "请先选择故事 + 角色" via the hint element and
// keeps the share / unshare buttons hidden.
async function mount() {
  const host = buildPanel();
  host.style.display = '';
  // Subscribe BEFORE the first refresh so we never miss the
  // bootstrap dispatch that lands while the network calls are in
  // flight (the event listeners on `window` keep firing even after
  // `refreshAuthStatus` resolves).
  attachSessionChangedListener();
  await refreshAuthStatus();
  await refreshShareButton();
  await refreshFeed();
}

function attachSessionChangedListener() {
  const target = (typeof window !== 'undefined') ? window
    : (typeof globalThis !== 'undefined' ? globalThis : null);
  if (!target || typeof target.addEventListener !== 'function') return;
  if (target.__SOCIAL_PANEL_SESSION_CHANGED_BOUND__) return;
  target.__SOCIAL_PANEL_SESSION_CHANGED_BOUND__ = true;
  target.addEventListener('session:changed', () => {
    // The player is the single source of truth for session changes;
    // re-render only what depends on the session UUID.
    void refreshShareButton();
  });
}

function start() {
  if (typeof document === 'undefined') return;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { void mount(); }, { once: true });
  } else {
    void mount();
  }
}

export {
  start,
  mount,
  refreshFeed,
  refreshShareButton,
  refreshAuthStatus,
  currentShareTargetUuid,
};

export default { start, mount };
