// public/scripts/homeHotModule.js — ClickUp 16.4 P1 fix (2026-09-07).
//
// Home-page 知乎热榜 module. Independent `<script type="module">` so
// it cannot drag player.js / endingPage.js with it; loads its own DOM
// nodes under <section id="ecosystem-hot-module">. The static contract
// `grep -rE "/api/(admin|dev)/" public/` MUST stay zero — this file
// only reads /v1/ecosystem/hot (public surface).
//
// "相关才关联" UI contract (P1 fix):
//   * Every hot entry that matches the active story's community
//     profile (`relevant.score > 0`) is rendered with a "相关" badge
//     AND sorted to the top.
//   * Unrelated entries (no badge) follow, sorted by heat (the
//     server already returns them pre-sorted by relevance + heat, so
//     the client just renders in order).
//   * When the user has not picked a story yet (no identity triple),
//     the request returns a plain list with no badges — the module
//     shows a soft hint instead.
//
// Public surface:
//   * Reads `window.STORY_OUTSIDE_ACTIVE_IDENTITY` (set by player.js)
//     for { story_uuid, story_version_uuid, community_profile_version }.
//   * Falls back to a no-identity GET /v1/ecosystem/hot when the
//     identity is missing — same endpoint, no params.
//   * Exposes no global API; integration with the picker happens via
//     DOM mutation only.

const ROOT_ID = 'ecosystem-hot-module';
const LIST_ID = 'ecosystem-hot-list';
const STATUS_ID = 'ecosystem-hot-status';
const ENDPOINT = '/v1/ecosystem/hot';
const RELATED_LABEL = '相关';
const HINT_LABEL = '选一个故事再看热榜关联';
const EMPTY_LABEL = '暂时无法获取知乎热议';
const LOADING_LABEL = '载入中…';

function getRoot() {
  return document.getElementById(ROOT_ID);
}

function getList() {
  return document.getElementById(LIST_ID);
}

function getStatus() {
  return document.getElementById(STATUS_ID);
}

function readActiveIdentity() {
  const identity = /** @type {any} */ (window).STORY_OUTSIDE_ACTIVE_IDENTITY;
  if (!identity || typeof identity !== 'object') return null;
  const story_uuid = typeof identity.story_uuid === 'string' && identity.story_uuid
    ? identity.story_uuid
    : '';
  const story_version_uuid = typeof identity.story_version_uuid === 'string' && identity.story_version_uuid
    ? identity.story_version_uuid
    : '';
  const community_profile_version = typeof identity.community_profile_version === 'string' && community_profile_version
    ? identity.community_profile_version
    : '';
  if (!story_uuid || !story_version_uuid || !community_profile_version) return null;
  return { story_uuid, story_version_uuid, community_profile_version };
}

function setState(root, state) {
  if (!root) return;
  root.setAttribute('data-state', state);
}

function setStatus(text) {
  const node = getStatus();
  if (node) node.textContent = text;
}

function clearList() {
  const list = getList();
  if (list) list.replaceChildren();
}

function renderEntry(entry, isRelated) {
  const li = document.createElement('li');
  li.className = 'ecosystem-hot-item' + (isRelated ? ' is-related' : '');
  li.setAttribute('data-related', isRelated ? 'true' : 'false');
  // Rank chip
  const rank = document.createElement('span');
  rank.className = 'ecosystem-hot-rank';
  rank.textContent = typeof entry.rank === 'number' ? String(entry.rank) : '–';
  // Title link
  const titleWrap = document.createElement('div');
  titleWrap.className = 'ecosystem-hot-title-wrap';
  const titleLink = document.createElement('a');
  titleLink.className = 'ecosystem-hot-title';
  titleLink.href = typeof entry.url === 'string' && entry.url ? entry.url : '#';
  titleLink.target = '_blank';
  titleLink.rel = 'noopener noreferrer';
  titleLink.textContent = typeof entry.title === 'string' && entry.title ? entry.title : '(无题)';
  titleWrap.appendChild(titleLink);
  // Meta line: heat, related badge
  const meta = document.createElement('div');
  meta.className = 'ecosystem-hot-meta';
  const heat = document.createElement('span');
  heat.className = 'ecosystem-hot-heat';
  const heatValue = typeof entry.heat === 'number' ? entry.heat : 0;
  heat.textContent = `热度 ${heatValue.toLocaleString('zh-CN')}`;
  meta.appendChild(heat);
  if (isRelated) {
    // The "相关" badge. The acceptance rule in the task says: every
    // entry whose `relevant.score > 0` MUST show "相关才关联" — this
    // is exactly that badge.
    const badge = document.createElement('span');
    badge.className = 'ecosystem-hot-related-badge';
    badge.setAttribute('aria-label', '与所选故事相关');
    badge.setAttribute('title', '与所选故事相关');
    badge.textContent = RELATED_LABEL;
    meta.appendChild(badge);
    // Optional: matched terms tooltip.
    if (entry.relevant && Array.isArray(entry.relevant.matched_terms) && entry.relevant.matched_terms.length > 0) {
      const tip = document.createElement('span');
      tip.className = 'ecosystem-hot-related-tip';
      tip.textContent = `命中: ${entry.relevant.matched_terms.join(' / ')}`;
      meta.appendChild(tip);
    }
  }
  titleWrap.appendChild(meta);
  li.appendChild(rank);
  li.appendChild(titleWrap);
  return li;
}

function renderEmpty() {
  setStatus(EMPTY_LABEL);
  clearList();
}

function renderHint() {
  setStatus(HINT_LABEL);
  clearList();
}

/**
 * Render the hot list. The server has already pre-sorted by relevance
 * (related first, then by score desc / heat desc) so we just iterate
 * in order. Related entries get a "相关" badge.
 *
 * @param {Array<any>} hot
 * @param {boolean} hasIdentity
 */
function renderList(hot, hasIdentity) {
  const list = getList();
  if (!list) return;
  list.replaceChildren();
  if (!Array.isArray(hot) || hot.length === 0) {
    setStatus(hasIdentity ? EMPTY_LABEL : EMPTY_LABEL);
    return;
  }
  let relatedCount = 0;
  for (const entry of hot) {
    if (!entry || typeof entry !== 'object') continue;
    const rel = entry.relevant;
    const isRelated = hasIdentity && rel && typeof rel.score === 'number' && rel.score > 0;
    if (isRelated) relatedCount += 1;
    list.appendChild(renderEntry(entry, isRelated));
  }
  if (hasIdentity) {
    if (relatedCount === 0) {
      setStatus(`${hot.length} 条热议 · 与本故事无强相关（按热度排序）`);
    } else {
      setStatus(`${relatedCount} 条相关 · ${hot.length - relatedCount} 条按热度`);
    }
  } else {
    setStatus(`${hot.length} 条热议 · 选一个故事后可看相关才关联`);
  }
}

/**
 * Fetch the hot list. When the active identity is present, pass it on
 * the URL so the server attaches `relevant_to_story`. Otherwise the
 * server returns a plain hot list.
 *
 * @param {boolean} hasIdentity
 * @param {{ story_uuid: string, story_version_uuid: string, community_profile_version: string }} [identity]
 */
async function fetchHotList(hasIdentity, identity) {
  const params = new URLSearchParams();
  if (hasIdentity && identity) {
    params.set('story_uuid', identity.story_uuid);
    params.set('story_version_uuid', identity.story_version_uuid);
    params.set('community_profile_version', identity.community_profile_version);
  }
  const url = params.toString() ? `${ENDPOINT}?${params.toString()}` : ENDPOINT;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  /** @type {{ hot?: Array<any>, relevant_to_story?: object }} */
  const payload = await res.json();
  return payload;
}

/**
 * Initial load. Renders a plain hot list when no identity is pinned;
 * waits for the identity event when one is required (UI rule: we
 * never block the picker / player flow on identity).
 */
async function loadInitial() {
  const root = getRoot();
  if (!root) return;
  setState(root, 'loading');
  setStatus(LOADING_LABEL);
  clearList();
  const identity = readActiveIdentity();
  const hasIdentity = Boolean(identity);
  try {
    const payload = await fetchHotList(hasIdentity, identity || undefined);
    const hot = payload && Array.isArray(payload.hot) ? payload.hot : [];
    renderList(hot, hasIdentity);
    setState(root, hasIdentity ? 'identity' : 'plain');
  } catch (err) {
    // ClickUp 16.4 graceful degradation: a 5xx / network error must
    // NEVER break the home page. Render an empty list and a soft hint
    // so the user can still pick a story and play.
    setState(root, 'error');
    renderEmpty();
  }
}

/**
 * Re-render against a newly-set identity. The picker/player can call
 * this via a custom event:
 *
 *   document.dispatchEvent(new CustomEvent('story-outside:identity', {
 *     detail: { story_uuid, story_version_uuid, community_profile_version },
 *   }));
 *
 * `homeHotModule.js` listens for this event so it can switch from
 * the plain list to the "相关才关联" list without a full page reload.
 */
function attachIdentityListener() {
  document.addEventListener('story-outside:identity', async (event) => {
    const detail = event && /** @type {any} */ (event).detail;
    if (!detail || typeof detail !== 'object') return;
    const identity = {
      story_uuid: typeof detail.story_uuid === 'string' ? detail.story_uuid : '',
      story_version_uuid: typeof detail.story_version_uuid === 'string' ? detail.story_version_uuid : '',
      community_profile_version: typeof detail.community_profile_version === 'string' ? detail.community_profile_version : '',
    };
    if (!identity.story_uuid || !identity.story_version_uuid || !identity.community_profile_version) {
      await loadInitial();
      return;
    }
    /** @type {any} */ (window).STORY_OUTSIDE_ACTIVE_IDENTITY = identity;
    const root = getRoot();
    if (!root) return;
    setState(root, 'loading');
    setStatus(LOADING_LABEL);
    try {
      const payload = await fetchHotList(true, identity);
      const hot = payload && Array.isArray(payload.hot) ? payload.hot : [];
      renderList(hot, true);
      setState(root, 'identity');
    } catch {
      setState(root, 'error');
      renderEmpty();
    }
  });
}

function init() {
  const root = getRoot();
  if (!root) return;
  attachIdentityListener();
  // Defer the initial load so the picker can finish wiring the
  // `STORY_OUTSIDE_ACTIVE_IDENTITY` global first. 0 ms is enough —
  // the picker script's `DOMContentLoaded` handler runs first because
  // player.js is loaded BEFORE homeHotModule.js.
  setTimeout(() => { loadInitial(); }, 0);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}