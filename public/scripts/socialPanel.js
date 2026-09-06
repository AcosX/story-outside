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
//     `POST /v1/ecosystem/sessions/:uuid/{share,unshare}` WITHOUT a
//     body. The server resolves the canonical owner through
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
  const shareBtn = document.createElement('button');
  shareBtn.id = 'social-panel-share-btn';
  shareBtn.type = 'button';
  shareBtn.textContent = '分享 session';
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

// The panel reads the current session UUID from a public, read-only
// helper that lives on `window.sessionContext` (set by player.js when
// a session is bootstrapped) and falls back to the same
// `story-outside:session-context` storage slot the player uses for
// deep-link recovery. The panel does NOT interpret the value as
// caller principal — it is just a routing hint to know which session
// the share / unshare buttons should target.
function currentShareTargetUuid() {
  if (typeof window !== 'undefined') {
    const ctx = window.sessionContext;
    if (ctx && typeof ctx.sessionUuid === 'string') return ctx.sessionUuid;
  }
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      const raw = window.sessionStorage.getItem('story-outside:session-context');
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.sessionUuid === 'string') return parsed.sessionUuid;
        } catch { /* ignore */ }
      }
    }
    if (typeof window !== 'undefined' && window.localStorage) {
      const raw = window.localStorage.getItem('story-outside:session-context');
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.sessionUuid === 'string') return parsed.sessionUuid;
        } catch { /* ignore */ }
      }
    }
  } catch { /* sessionStorage / localStorage disabled */ }
  return null;
}

async function refreshAuthStatus() {
  const { status, data } = await fetchJson('/api/auth/status', { method: 'GET' });
  if (status !== 200 || !data || !data.owner) {
    setAuthStatus(`未登录 (auth status ${status})`);
    return null;
  }
  const name = data.owner.display_name || OAUTH_PENDING_DISPLAY_NAME;
  setAuthStatus(`已登录 · ${name}`);
  return data.owner;
}

async function refreshShareButton() {
  const uuid = currentShareTargetUuid();
  const shareBtn = document.getElementById('social-panel-share-btn');
  const unshareBtn = document.getElementById('social-panel-unshare-btn');
  const targetBox = document.getElementById('social-panel-share-target');
  const targetCode = document.getElementById('social-panel-share-target-uuid');
  if (!uuid) {
    if (shareBtn) shareBtn.hidden = true;
    if (unshareBtn) unshareBtn.hidden = true;
    if (targetBox) targetBox.hidden = true;
    return;
  }
  if (targetCode) targetCode.textContent = uuid;
  if (targetBox) targetBox.hidden = false;
  // The owner check is enforced by the SERVER. The share / unshare
  // buttons are UX hints — the server may still reject the call with
  // 400 if it sees a principal-shaped body, which it will because the
  // panel sends no body on purpose.
  if (shareBtn) shareBtn.hidden = false;
  if (unshareBtn) unshareBtn.hidden = false;
}

async function refreshFeed() {
  const { status, data } = await fetchJson('/v1/ecosystem/friend-timelines?limit=20', { method: 'GET' });
  if (status !== 200 || !data) {
    setStatus(`feed 加载失败 status=${status}`);
    return;
  }
  const feed = document.getElementById('social-panel-feed');
  if (!feed) return;
  if (!Array.isArray(data.items) || data.items.length === 0) {
    feed.innerHTML = '<div style="opacity:0.7;">关注流为空。先在下方点击"加关注"输入目标 UUID。</div>';
    setStatus(`feed 空 · 生成于 ${data.generated_at || 'n/a'}`);
    return;
  }
  feed.innerHTML = data.items.map((item) => `
    <div class="social-feed-item" style="border-top:1px solid rgba(255,255,255,0.1);padding:6px 0;">
      <div><code>${escapeHtml(item.session_uuid)}</code></div>
      <div style="opacity:0.7;">${escapeHtml(item.shared_at || '')}</div>
    </div>
  `).join('');
  setStatus(`feed ${data.items.length} 条 · 生成于 ${data.generated_at || 'n/a'}`);
}

async function handleFollow() {
  const target = window.prompt('输入要关注的目标 UUID:');
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
  const uuid = currentShareTargetUuid();
  if (!uuid) {
    setStatus('当前没有可分享的 session');
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
  const uuid = currentShareTargetUuid();
  if (!uuid) {
    setStatus('当前没有可撤回的 session');
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

async function mount() {
  const host = buildPanel();
  host.style.display = '';
  await refreshAuthStatus();
  await refreshShareButton();
  await refreshFeed();
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
