// public/scripts/communitySection.js — 「故事里的相遇」区块（2026-09-13 转正）。
//
// 这块以前是右下角一张悬浮 demo 卡片：有关闭按钮、有「加关注」（弹
// window.prompt 让人手输一串内部 UUID）、有「刷新关注流」，动态里只显示裸
// session UUID。那是联调夹具，不是产品。现在它是「我的」页面里的一个正式区块：
//
//   * 关注关系读自知乎官方接口（服务端 GET /v1/ecosystem/friend-timelines
//     代表当前登录用户调用 developer.zhihu.com /api/v1/user/followees）。
//     要增减关注请到知乎，本站不提供、也不需要「加关注」按钮。
//   * 因此关闭、加关注、刷新三个按钮都已取消。页面进入「我的」时自动加载，
//     唯一保留的操作是「公开 / 撤回当前这段故事」——那是本人对自己内容的处置。
//   * 版式复用站内既有语言：eyebrow + h2 + 卡片 + 空态文案，与「阅读历史」
//     一致，不再自带深色半透明面板和内联样式。
//
// 身份边界（保持不变）：
//   * 前端从不携带调用者身份。没有身份请求头，没有身份形状的请求体字段。
//     服务端用 `__Host-` 会话 Cookie 解析「你是谁」。
//   * 分享 / 撤回一律不带 body（服务端要求 Content-Length: 0）。
//   * 关注流响应是公开投影：只有对方的公开昵称、主页、头像、签名，以及会话
//     标识和公开时间。前端不从响应里推断任何服务端归属关系。
//
// 降级：任何状态都渲染出「为什么现在是空的」，绝不把失败显示成「没有人」。

const SECTION_ID = 'community-section';
const FEED_ID = 'community-feed';
const STATUS_ID = 'community-status';
const ACTION_ID = 'community-share-action';
const FEED_ENDPOINT = '/v1/ecosystem/friend-timelines?limit=20';

const COPY = {
  lead: '你在知乎关注的人，如果也走过这些故事，会出现在这里。',
  loading: '正在读取…',
  loginRequired: '登录知乎后，看看你关注的人走出了哪种结局。',
  unconfigured: '这项能力还没有在本次部署中启用。',
  unavailable: '暂时读不到知乎关注列表，稍后再看看。',
  emptyNoFollowee: '还没有读到你的知乎关注列表。',
  emptyNoMatch: '你关注的人里，还没有人在这里公开过自己的故事。',
  shareHint: '选一个故事、进入之后，就可以把这段经历公开给关注你的人。',
  shareIdle: '这段故事目前只有你自己能看到。',
  shareShared: '这段故事已经公开给在知乎关注你的人。',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  // textContent（而不是 createTextNode）：测试用的极简 DOM 没有实现
  // createTextNode，也不解析 innerHTML。
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function clear(node) {
  if (!node) return;
  if (typeof node.replaceChildren === 'function') { node.replaceChildren(); return; }
  while (node.firstChild) node.removeChild(node.firstChild);
  if (Array.isArray(node.children)) node.children.length = 0;
}

async function fetchJson(path, options) {
  const opts = options || {};
  const response = await fetch(path, opts);
  let data = null;
  try { data = await response.json(); } catch { /* 非 JSON 响应按失败处理 */ }
  return { status: response.status, data };
}

function section() {
  return document.getElementById(SECTION_ID);
}

// -------------------------------------------------------------------
// 结构：区块骨架只建一次，后续只更新内容节点。
// -------------------------------------------------------------------
function buildSection() {
  const host = section();
  if (!host) return null;
  if (host.getAttribute && host.getAttribute('data-community-ready') === 'true') return host;

  const lead = el('p', 'community-lead', COPY.lead);
  host.appendChild(lead);

  const action = el('div', 'community-share');
  action.id = ACTION_ID;
  const actionText = el('p', 'community-share-text', COPY.shareHint);
  actionText.id = 'community-share-text';
  action.appendChild(actionText);
  const shareBtn = el('button', 'btn', '公开这段故事');
  shareBtn.id = 'community-share-btn';
  shareBtn.type = 'button';
  shareBtn.hidden = true;
  action.appendChild(shareBtn);
  const unshareBtn = el('button', 'btn', '撤回');
  unshareBtn.id = 'community-unshare-btn';
  unshareBtn.type = 'button';
  unshareBtn.hidden = true;
  action.appendChild(unshareBtn);
  host.appendChild(action);

  const feed = el('ul', 'community-feed');
  feed.id = FEED_ID;
  feed.setAttribute('aria-label', '关注的人公开的故事');
  host.appendChild(feed);

  const status = el('p', 'community-status', COPY.loading);
  status.id = STATUS_ID;
  status.setAttribute('role', 'status');
  host.appendChild(status);

  shareBtn.addEventListener('click', () => { void handleShare(); });
  unshareBtn.addEventListener('click', () => { void handleUnshare(); });
  if (host.setAttribute) host.setAttribute('data-community-ready', 'true');
  return host;
}

function setStatus(text) {
  const node = document.getElementById(STATUS_ID);
  if (!node) return;
  node.textContent = text || '';
  node.hidden = !text;
}

function setShareText(text) {
  const node = document.getElementById('community-share-text');
  if (node) node.textContent = text;
}

// -------------------------------------------------------------------
// 当前会话：由 player.js 通过 /scripts/sessionContext.js 发布，唯一存储键是
// `story-outside:last-session`。这里只把它当「该公开哪一段」的路由提示，
// 不当作身份。
// -------------------------------------------------------------------
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

function readStoredSessionUuid(storage) {
  try {
    if (typeof storage === 'undefined' || !storage) return null;
    const raw = storage.getItem('story-outside:last-session');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.sessionUuid === 'string' && parsed.sessionUuid) return parsed.sessionUuid;
  } catch { /* 存储不可用或内容损坏 */ }
  return null;
}

async function currentShareTargetUuid() {
  const helper = await loadSessionContext();
  if (helper && typeof helper.getCurrentShareTargetUuid === 'function') {
    try {
      const uuid = helper.getCurrentShareTargetUuid();
      if (typeof uuid === 'string' && uuid) return uuid;
    } catch { /* 退回直接读存储 */ }
  }
  return readStoredSessionUuid(typeof sessionStorage !== 'undefined' ? sessionStorage : null)
    || readStoredSessionUuid(typeof localStorage !== 'undefined' ? localStorage : null);
}

// -------------------------------------------------------------------
// 登录态：只读取公开展示名，用来决定这块显示「请先登录」还是真实内容。
// -------------------------------------------------------------------
let _authenticated = false;

async function refreshAuthStatus() {
  const { status, data } = await fetchJson('/api/auth/status', { method: 'GET' });
  if (status !== 200 || !data) { _authenticated = false; return null; }
  // 两种部署形态：
  //   * 已启用 OAuth：响应带 `configured: true`，是否可用看 `authenticated`。
  //   * 未配置 OAuth 的本地开发：响应不带 `configured`，但仍给出 demo owner，
  //     此时按可用处理，与站内其他部分的行为保持一致。
  _authenticated = Boolean(data.owner) && (data.authenticated === true || data.configured !== true);
  return data.owner || null;
}

async function refreshShareAction() {
  const shareBtn = document.getElementById('community-share-btn');
  const unshareBtn = document.getElementById('community-unshare-btn');
  if (!shareBtn || !unshareBtn) return;
  const uuid = await currentShareTargetUuid();
  if (!uuid || !_authenticated) {
    shareBtn.hidden = true;
    unshareBtn.hidden = true;
    setShareText(_authenticated ? COPY.shareHint : COPY.loginRequired);
    return;
  }
  // 公开与撤回的最终权限由服务端按 canonical owner 判定；这里只是入口。
  // 先按服务端的分享状态恢复按钮：已公开的会话刷新页面后仍显示「撤回」，
  // 而不是回到「公开」并声称「只有你自己能看到」。
  let shared = false;
  const { status, data } = await fetchJson(`/v1/ecosystem/sessions/${uuid}/share-status`, { method: 'GET' });
  if (status === 200 && data && data.shared === true) shared = true;
  shareBtn.hidden = shared;
  unshareBtn.hidden = !shared;
  setShareText(shared ? COPY.shareShared : COPY.shareIdle);
}

function renderFeedItems(items) {
  const feed = document.getElementById(FEED_ID);
  if (!feed) return;
  clear(feed);
  for (const item of items) {
    const li = el('li', 'community-item');
    const author = item && item.author ? item.author : null;

    if (author && author.avatar_url) {
      const avatar = document.createElement('img');
      avatar.className = 'community-avatar';
      avatar.src = author.avatar_url;
      avatar.alt = '';
      avatar.setAttribute('loading', 'lazy');
      li.appendChild(avatar);
    }

    const body = el('div', 'community-item-body');
    const nameRow = el('p', 'community-item-name');
    if (author && author.url) {
      const link = el('a', null, author.fullname || '知乎用户');
      link.href = author.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      nameRow.appendChild(link);
    } else {
      nameRow.textContent = (author && author.fullname) || '一位你关注的人';
    }
    body.appendChild(nameRow);

    const storyTitle = item && typeof item.story_title === 'string' && item.story_title
      ? item.story_title
      : '一个故事';
    body.appendChild(el('p', 'community-item-story', `走过《${storyTitle}》`));

    const meta = [];
    if (author && author.headline) meta.push(author.headline);
    const sharedAt = item && typeof item.shared_at === 'string' ? item.shared_at : '';
    if (sharedAt) {
      const date = new Date(sharedAt);
      if (!Number.isNaN(date.getTime())) {
        meta.push(date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
      }
    }
    if (meta.length > 0) body.appendChild(el('p', 'community-item-meta', meta.join(' · ')));

    li.appendChild(body);
    feed.appendChild(li);
  }
}

async function refreshFeed() {
  const feed = document.getElementById(FEED_ID);
  if (!feed) return;
  const { status, data } = await fetchJson(FEED_ENDPOINT, { method: 'GET' });
  if (status === 401) {
    clear(feed);
    setStatus(COPY.loginRequired);
    return;
  }
  if (status !== 200 || !data) {
    clear(feed);
    setStatus(COPY.unavailable);
    return;
  }
  const items = Array.isArray(data.items) ? data.items : [];
  const state = typeof data.status === 'string' ? data.status : 'ok';
  if (state === 'login_required') { clear(feed); setStatus(COPY.loginRequired); return; }
  if (state === 'unconfigured' || state === 'missing_oauth_token') { clear(feed); setStatus(COPY.unconfigured); return; }
  if (state !== 'ok') { clear(feed); setStatus(COPY.unavailable); return; }
  if (items.length === 0) {
    clear(feed);
    setStatus(Number(data.followee_count) > 0 ? COPY.emptyNoMatch : COPY.emptyNoFollowee);
    return;
  }
  renderFeedItems(items);
  setStatus(`${items.length} 段来自你关注的人的故事`);
}

async function handleShare() {
  const uuid = await currentShareTargetUuid();
  if (!uuid) { setShareText(COPY.shareHint); return; }
  // 硬约束：不带任何 body。服务端按会话解析归属，浏览器不发送归属信息。
  const response = await fetch(`/v1/ecosystem/sessions/${uuid}/share`, { method: 'POST' });
  if (response.status !== 200) { setShareText('公开没有成功，请稍后再试。'); return; }
  const shareBtn = document.getElementById('community-share-btn');
  const unshareBtn = document.getElementById('community-unshare-btn');
  if (shareBtn) shareBtn.hidden = true;
  if (unshareBtn) unshareBtn.hidden = false;
  setShareText(COPY.shareShared);
  void refreshFeed();
}

async function handleUnshare() {
  const uuid = await currentShareTargetUuid();
  if (!uuid) { setShareText(COPY.shareHint); return; }
  const response = await fetch(`/v1/ecosystem/sessions/${uuid}/unshare`, { method: 'POST' });
  if (response.status !== 200) { setShareText('撤回没有成功，请稍后再试。'); return; }
  const shareBtn = document.getElementById('community-share-btn');
  const unshareBtn = document.getElementById('community-unshare-btn');
  if (shareBtn) shareBtn.hidden = false;
  if (unshareBtn) unshareBtn.hidden = true;
  setShareText(COPY.shareIdle);
  void refreshFeed();
}

// mount() 每个生命周期只跑一次：不轮询、不重建 DOM。会话变化通过
// `session:changed` 事件驱动公开/撤回入口刷新。
async function mount() {
  const host = buildSection();
  if (!host) return null;
  attachSessionChangedListener();
  setStatus(COPY.loading);
  await refreshAuthStatus();
  await refreshShareAction();
  await refreshFeed();
  return host;
}

function attachSessionChangedListener() {
  const target = (typeof window !== 'undefined') ? window
    : (typeof globalThis !== 'undefined' ? globalThis : null);
  if (!target || typeof target.addEventListener !== 'function') return;
  if (target.__COMMUNITY_SECTION_SESSION_BOUND__) return;
  target.__COMMUNITY_SECTION_SESSION_BOUND__ = true;
  target.addEventListener('session:changed', () => { void refreshShareAction(); });
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
  refreshShareAction,
  refreshAuthStatus,
  currentShareTargetUuid,
};

export default { start, mount };
