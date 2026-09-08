// public/scripts/homeHotModule.js — ClickUp 16.4 P1.v1-2 fix (2026-09-07).
//
// Home-page 知乎热榜 module. Independent `<script type="module">` so
// it cannot drag player.js / endingPage.js with it; loads its own DOM
// nodes under <section id="ecosystem-hot-module">. The static contract
// `grep -rE "/api/(admin|dev)/" public/` MUST stay zero — this file
// only reads /v1/ecosystem/hot (public surface).
//
// "相关才关联" UI contract (P1.v1-2 fix):
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
// P1.v1-2 TDZ fix (2026-09-07):
//   The previous PR #23 (ce7f03a) had `const X = X.field` in
//   `readActiveIdentity`, which threw a Temporal Dead Zone
//   ReferenceError the moment the function was invoked. v1-2 reads
//   the triple off `window.STORY_OUTSIDE_IDENTITY` with explicit
//   defaults on the INPUT parameter (no closure self-reference), so
//   the function works the instant it is called even when the global
//   is null.
//
// P1.v1-2 wiring (2026-09-07):
//   The producer lives in public/scripts/identity.js. This module
//   reads `window.STORY_OUTSIDE_IDENTITY` (set by identity.js on
//   page-load from sessionStorage when present) and listens for the
//   `story:identity-changed` CustomEvent to refresh the list when
//   the user picks / starts / finishes a story.

const ROOT_ID = 'ecosystem-hot-module';
const LIST_ID = 'ecosystem-hot-list';
const STATUS_ID = 'ecosystem-hot-status';
const ENDPOINT = '/v1/ecosystem/hot';
const RELATED_LABEL = '相关';
const HINT_LABEL = '选一个故事再看热榜关联';
const EMPTY_LABEL = '此刻还没有与书架相关的热议。';
const LOADING_LABEL = '载入中…';
const IDENTITY_EVENT = 'story:identity-changed';
const IDENTITY_GLOBAL_KEY = 'STORY_OUTSIDE_IDENTITY';
let latestRequest = 0;

function getRoot() {
  return document.getElementById(ROOT_ID);
}

function getList() {
  return document.getElementById(LIST_ID);
}

function getStatus() {
  return document.getElementById(STATUS_ID);
}

/**
 * Read the active identity triple directly off the producer's global.
 *
 * P1.v1-2 TDZ fix (2026-09-07): do NOT use a `const X = X.field` pattern.
 * We pull the global into a parameter, then destructure with explicit
 * defaults, so no identifier self-references itself in its own
 * declaration.
 *
 * @returns {{ story_uuid: string, story_version_uuid: string, community_profile_version: string } | null}
 */
function readActiveIdentity() {
  // Step 1: read the global into a local parameter (NOT a self-ref
  // const). This is the fix for the v1 TDZ — the previous code had
  // `const community_profile_version = typeof identity.community_profile_version === 'string' && community_profile_version ? ...`
  // which dereferenced `community_profile_version` inside its own
  // declaration and blew up with ReferenceError: Cannot access
  // 'community_profile_version' before initialization.
  const identity = /** @type {any} */ (window)[IDENTITY_GLOBAL_KEY];
  if (!identity || typeof identity !== 'object') return null;
  // Step 2: pull each field into its own local. The defaults use the
  // EMPTY STRING so the "all three required" check below can short-
  // circuit on any missing piece. Note: the third clause references
  // `identity.community_profile_version` (not the local being
  // declared) — this is the explicit TDZ fix.
  const story_uuid = typeof identity.story_uuid === 'string' && identity.story_uuid
    ? identity.story_uuid
    : '';
  const story_version_uuid = typeof identity.story_version_uuid === 'string' && identity.story_version_uuid
    ? identity.story_version_uuid
    : '';
  const community_profile_version = typeof identity.community_profile_version === 'string'
    && identity.community_profile_version
    ? identity.community_profile_version
    : '';
  if (!story_uuid || !story_version_uuid || !community_profile_version) return null;
  return { story_uuid, story_version_uuid, community_profile_version };
}

function setState(root, state) {
  if (!root) return;
  root.setAttribute('data-state', state);
  root.hidden = state !== 'plain' && state !== 'identity';
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
  if (Array.isArray(entry.related_stories)) {
    const stories = document.createElement('div'); stories.className = 'hot-related-stories';
    for (const story of entry.related_stories.slice(0, 2)) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'hot-story-link';
      if (story.cover_url) { const cover = document.createElement('img'); cover.src = story.cover_url; cover.alt = ''; cover.referrerPolicy = 'no-referrer'; button.appendChild(cover); }
      const title = document.createElement('span'); title.textContent = story.title; button.appendChild(title);
      button.addEventListener('click', () => window.dispatchEvent(new CustomEvent('story:open', { detail: {storyId: story.id} })));
      stories.appendChild(button);
    }
    titleWrap.appendChild(stories);
  }

  // Meta line: heat, related badge
  const meta = document.createElement('div');
  meta.className = 'ecosystem-hot-meta';
  const heat = document.createElement('span');
  heat.className = 'ecosystem-hot-heat';
  const heatValue = typeof entry.heat === 'number' ? entry.heat : 0;
  heat.textContent = `热度 ${heatValue.toLocaleString('zh-CN')}`;
  if (heatValue > 0) meta.appendChild(heat);
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
    setStatus(EMPTY_LABEL);
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
  setStatus(`${hot.length} 条与故事有关的热议`);
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
  const request = ++latestRequest;
  try {
    const payload = await fetchHotList(hasIdentity, identity || undefined);
    if (request !== latestRequest) return;
    const hot = (payload && Array.isArray(payload.hot) ? payload.hot : [])
      .filter(entry => entry && typeof entry === 'object');
    renderList(hot, hasIdentity);
    setState(root, hot.length ? (hasIdentity ? 'identity' : 'plain') : 'empty');
  } catch (err) {
    if (request !== latestRequest) return;
    // ClickUp 16.4 graceful degradation: a 5xx / network error must
    // NEVER break the home page. Render an empty list and a soft hint
    // so the user can still pick a story and play.
    setState(root, 'error');
    renderEmpty();
  }
}

/**
 * Re-render against a newly-set identity. The identity producer
 * (public/scripts/identity.js) fires `story:identity-changed` on
 * `document` whenever pickStory / startStory / endingPage runs;
 * `homeHotModule.js` listens for this event so it can switch from
 * the plain list to the "相关才关联" list without a full page reload.
 */
function attachIdentityListener() {
  document.addEventListener(IDENTITY_EVENT, () => { void loadInitial(); });
}

function init() {
  const root = getRoot();
  if (!root) return;
  attachIdentityListener();
  // Defer the initial load so the picker can finish wiring the
  // identity global first. 0 ms is enough — identity.js runs
  // synchronously inside its IIFE on script load, and player.js
  // (which may setActiveIdentity() on pickStory) loads AFTER
  // homeHotModule.js per public/index.html ordering.
  setTimeout(() => { loadInitial(); }, 0);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}