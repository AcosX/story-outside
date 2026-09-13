// Followed players and account-wide activity visibility. Identity is resolved by the server.

const SECTION_ID = 'community-section';
const FEED_ID = 'community-feed';
const STATUS_ID = 'community-status';
const ACTION_ID = 'community-share-action';
const FEED_ENDPOINT = '/v1/ecosystem/friend-timelines?limit=20';

const COPY = {
  lead: '看看你关注的人都在玩什么。',
  loading: '正在读取…',
  loginRequired: '登录知乎后，看看你关注的人都在玩什么。',
  unconfigured: '这项能力还没有在本次部署中启用。',
  unavailable: '暂时读不到知乎关注列表，稍后再看看。',
  emptyNoFollowee: '还没有读到你的知乎关注列表。',
  emptyNoMatch: '你关注的人暂时还没有可见的游戏动态。',
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
  const actionText = el('p', 'community-share-text', '让关注我的人看到我在玩什么');
  actionText.id = 'community-share-text';
  action.appendChild(actionText);
  const toggle = el('button', 'community-visibility-toggle');
  toggle.id = 'community-visibility-toggle';
  toggle.type = 'button';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-label', '让关注我的人看到我在玩什么');
  toggle.setAttribute('aria-checked', 'true');
  toggle.disabled = true;
  toggle.addEventListener('click', () => { void changeVisibility(); });
  action.appendChild(toggle);
  host.appendChild(action);

  const feed = el('ul', 'community-feed');
  feed.id = FEED_ID;
  feed.setAttribute('aria-label', '关注的人在玩的故事');
  host.appendChild(feed);

  const status = el('p', 'community-status', COPY.loading);
  status.id = STATUS_ID;
  status.setAttribute('role', 'status');
  host.appendChild(status);

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

let visibilityRevision = 0;
async function refreshShareAction() {
  const revision = ++visibilityRevision;
  const toggle = document.getElementById('community-visibility-toggle');
  if (!toggle) return;
  toggle.disabled = true;
  if (!_authenticated) return;
  try {
    const { status, data } = await fetchJson('/v1/ecosystem/visibility');
    if (revision !== visibilityRevision) return;
    if (status !== 200 || typeof data?.visible !== 'boolean') throw new Error('unavailable');
    toggle.setAttribute('aria-checked', String(data.visible));
    toggle.disabled = false;
    setShareText('让关注我的人看到我在玩什么');
  } catch { if (revision === visibilityRevision) setShareText('暂时无法读取可见性设置，请稍后再试。'); }
}
async function changeVisibility() {
  const toggle = document.getElementById('community-visibility-toggle');
  if (!toggle || toggle.disabled) return;
  const revision = ++visibilityRevision;
  const visible = toggle.getAttribute('aria-checked') !== 'true';
  toggle.disabled = true;
  try {
    const { status, data } = await fetchJson('/v1/ecosystem/visibility', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visible }),
    });
    if (revision !== visibilityRevision) return;
    if (status !== 200 || data?.visible !== visible) throw new Error('unavailable');
    toggle.setAttribute('aria-checked', String(visible));
    setShareText('让关注我的人看到我在玩什么');
  } catch { if (revision === visibilityRevision) setShareText('设置未保存，请重试。'); }
  finally { if (revision === visibilityRevision) toggle.disabled = false; }
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
    body.appendChild(el('p', 'community-item-story', `${item?.state === 'finished' ? '已完成' : '在玩'}《${storyTitle}》`));

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

// mount() 每个生命周期只跑一次：不轮询、不重建 DOM。会话变化通过
// `session:changed` 事件驱动设置刷新。
async function mount() {
  const host = buildSection();
  if (!host) return null;
  attachSessionChangedListener();
  setStatus(COPY.loading);
  try {
    await refreshAuthStatus();
    await refreshShareAction();
    await refreshFeed();
  } catch { setStatus(COPY.unavailable); }
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
};

export default { start, mount };
