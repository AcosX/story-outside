// Story Outside — player frontend (Story 09).
//
// The whole UI is a single state machine over the session-service contract:
//
//   status      : 'idle' | 'loading' | 'picker' | 'playing' | 'paused'
//               | 'awaiting-choice' | 'finished' | 'error'
//   pending     : { pending_id, events[], tool_call|null, committed_count }
//                 | null   — active speculative batch
//   pendingIdx  : number   — index of the NEXT line to display from pending
//   finished    : boolean  — terminal finish_story tool call has been
//                            rendered for this session
//
// The state machine guarantees:
//   * displayed lines come ONLY from canonical history; pending items are
//     rendered with a "pending" hint and never counted in committed events;
//   * each displayed pending line triggers a /narrative-events commit, and
//     the next line is NOT scheduled until that commit returns 200;
//   * pausing freezes the scheduler; resuming re-runs it from where it
//     stopped (without re-displaying already-committed lines);
//   * /interrupt drops the pending tail and switches to realtime;
//   * /finish (terminal tool call after final commit) stops the scheduler
//     and renders the ending card; further commits are blocked; the
//     terminal envelope is queued in state so a pause inside the
//     deferred-render window cannot drop it — resume surfaces it first;
//   * /recover on reload rebuilds the displayed lines from canonical
//     history + active pending without re-running the provider; when no
//     pending remains and the committed ending projection answers 200,
//     the session is already finished and the ending page mounts
//     instead of continuing playback;
//   * share is a Web Share API call with a Clipboard / URL fallback and a
//     non-blocking toast on every path.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const STATUS_LABEL = {
  'idle': '准备',
  'loading': '载入中',
  'picker': '选起点',
  'playing': '自动播放',
  'paused': '已暂停',
  'awaiting-choice': '等你选',
  'finished': '已结束',
  'error': '出错了',
};

const state = {
  status: 'idle',
  story: null,
  role: null,
  sessionUuid: null,
  storyUuid: null,
  storyVersionUuid: null,
  cacheUuid: null,
  generationProfile: null,
  // Story 16.2 P1.v2 (2026-09-07): canonical community-profile
  // pointer returned by /api/sessions. Forwarded verbatim to
  // /v1/ecosystem/discussions; the handler resolves the canonical
  // profile server-side from these three values.
  communityProfileVersion: null,
  communityProfileQueries: null,
  pending: null,        // { pending_id, events[], tool_call, committed_count }
  pendingIdx: 0,        // index of the NEXT pending event to display
  finished: false,      // terminal tool_call has been rendered
  // Tool call envelope whose deferred render has not happened yet. It
  // lives in state (not only in the timer closure) so a pause inside
  // the ~STEP_DELAY/2 window cannot swallow a choice/finish node.
  queuedToolCall: null,
  inputInFlight: false, // an interrupt request is in flight (double-submit guard)
  autoplayTimer: null,
  lastPlayerRequestId: 1,
};

// -------- DOM helpers --------

function setText(sel, text) {
  const el = $(sel);
  if (el) el.textContent = text;
}

function showScreen(name) {
  document.body.dataset.view = name;
  $('#nav-stories')?.classList.toggle('active', name !== 'mine');
  $('#nav-mine')?.classList.toggle('active', name === 'mine');
  $$('.screen').forEach((s) => {
    const isActive = s.dataset.screen === name;
    s.classList.toggle('active', isActive);
    s.hidden = !isActive;
  });
  const url = new URL(window.location.href);
  if (name === 'detail' && state.story?.id) url.searchParams.set('story', state.story.id);
  else url.searchParams.delete('story');
  if (name === 'picker') url.searchParams.delete('s');
  else url.searchParams.set('s', name);
  history.replaceState(null, '', url);
}

function setStatus(next) {
  state.status = next;
  setText('#status-label', STATUS_LABEL[next] || next);
  // When the session reaches a terminal state (finished), the progress
  // bar should snap to 100% regardless of the last plot estimate
  // (the player has reached the end; there is no more work to do).
  if (next === 'finished') {
    setProgress(1);
  } else {
    setProgress(computeProgress());
  }
  const finished = next === 'finished';
  $('#player-input-form').hidden = finished;
  $('#pause-btn').hidden = finished || next === 'awaiting-choice';
  $('#player-choices').hidden = next !== 'awaiting-choice';
  if (next !== 'awaiting-choice' && $('#player-choices').parentNode === $('#story-log')) $('#screen-player').appendChild($('#player-choices'));
  $('#player-ending').hidden = !finished;
  $('#pause-btn-label').textContent = next === 'paused' ? '自动播放' : '暂停播放';
  $('#pause-btn').setAttribute(
    'aria-label', next === 'paused' ? '继续自动播放' : '暂停自动播放'
  );
  if (finished) {
    if (state.autoplayTimer) clearTimeout(state.autoplayTimer);
    if (state.toolCallTimer) clearTimeout(state.toolCallTimer);
    state.autoplayTimer = null;
    state.toolCallTimer = null;
    // The terminal render is on screen; nothing may stay queued.
    state.queuedToolCall = null;
  }
  if (next !== 'playing') {
    if (state.autoplayTimer) clearTimeout(state.autoplayTimer);
    if (state.toolCallTimer) clearTimeout(state.toolCallTimer);
    state.autoplayTimer = null;
    state.toolCallTimer = null;
  }
}

function setProgress(fraction) {
  const fill = $('#status-bar-fill');
  if (!fill) return;
  const clamped = Math.max(0, Math.min(1, fraction));
  fill.style.width = `${(clamped * 100).toFixed(1)}%`;
}

function computeProgress() {
  // Only displayed, committed narrative carries a plot-position estimate.
  // Missing estimates retain the last known position, including after reload.
  const history = state.canonicalHistory || [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const event = history[i];
    if (!['story_opening', 'narrative_beat'].includes(event?.event_type)) continue;
    const value = event.payload?.story_progress;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) return value;
  }
  return 0;
}

function showToast(message, ms = 2400) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.hidden = true; }, ms);
}

// -------- API client --------

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 524]);
const API_MAX_RETRIES = 2;
const API_RETRY_BASE_DELAY_MS = 250;
const API_RETRY_MAX_DELAY_MS = 2000;

function hasStableRequestId(options) {
  if (!options || typeof options.body !== 'string') return false;
  try {
    const body = JSON.parse(options.body);
    return (typeof body?.client_request_id === 'string' && body.client_request_id.length > 0)
      || (typeof body?.request_id === 'string' && body.request_id.length > 0);
  } catch {
    return false;
  }
}

function retryAfterMs(response, attempt) {
  const backoff = Math.min(API_RETRY_MAX_DELAY_MS, API_RETRY_BASE_DELAY_MS * (2 ** attempt));
  const value = response?.headers?.get?.('retry-after');
  if (!value) return backoff;
  const seconds = Number(value);
  const retryAfter = Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1000
    : Math.max(0, Date.parse(value) - Date.now());
  return Math.min(API_RETRY_MAX_DELAY_MS, Math.max(backoff, Number.isFinite(retryAfter) ? retryAfter : 0));
}

function waitForRetry(response, attempt) {
  return new Promise((resolve) => setTimeout(resolve, retryAfterMs(response, attempt)));
}

async function api(path, options = {}) {
  const savesProgress = options.method === 'POST' && /\/(opening-events|narrative-events|interrupt)$/.test(path);
  const sessionUuid = state.sessionUuid;
  if (savesProgress) setText('#autosave-status', '正在保存…');
  try {
    const result = await requestApi(path, options);
    if (savesProgress && state.sessionUuid === sessionUuid) rememberReading();
    return result;
  } catch (error) {
    if (savesProgress && state.sessionUuid === sessionUuid) setText('#autosave-status', '保存未完成，请重试');
    throw error;
  }
}

async function requestApi(path, options = {}) {
  const requestSession = path.match(/^\/api\/sessions\/([^/]+)\//)?.[1];
  const { allowStaleSession = false, ...fetchOptions } = options;
  const method = String(options.method || 'GET').toUpperCase();
  // POST is retry-safe only when the server can deduplicate the same
  // logical operation after a lost response.
  const retryableRequest = method === 'GET' || (method === 'POST' && hasStableRequestId(options));
  for (let attempt = 0; attempt <= API_MAX_RETRIES; attempt += 1) {
    let res;
    try {
      res = await fetch(path, {
        headers: { 'content-type': 'application/json' },
        ...fetchOptions,
      });
    } catch (error) {
      if (!retryableRequest || attempt === API_MAX_RETRIES) throw error;
      await waitForRetry(null, attempt);
      continue;
    }
    let data = null;
    let validJson = true;
    try { data = await res.json(); }
    catch { validJson = false; data = { error: 'bad_json' }; }
    if (!allowStaleSession && requestSession && requestSession !== state.sessionUuid) {
      const err = new Error('stale_session'); err.code = 'stale_session'; throw err;
    }
    if (!validJson) {
      const timedOut = [408, 504, 524].includes(res.status);
      const err = new Error(timedOut ? '请求超时，请重试。' : (!res.ok ? `http_${res.status}` : 'invalid_json_response'));
      err.code = timedOut ? 'request_timeout' : (!res.ok ? `http_${res.status}` : 'bad_json');
      err.status = res.status;
      err.data = data;
      if (retryableRequest && RETRYABLE_HTTP_STATUSES.has(res.status) && attempt < API_MAX_RETRIES) {
        await waitForRetry(res, attempt);
        continue;
      }
      throw err;
    }
    if (!res.ok) {
      if (res.status === 401 && data.error === 'login_required') {
        clearAutoplayTimer();
        showToast('请点击知乎登录后继续。');
        const link = $('#login-link'); if (link) link.hidden = false;
      }
      const timedOut = [408, 504, 524].includes(res.status);
      const err = new Error(timedOut ? '请求超时，请重试。' : (data.message || data.error || `http_${res.status}`));
      err.code = timedOut ? 'request_timeout' : (data.error || `http_${res.status}`);
      err.status = res.status;
      err.data = data;
      if (retryableRequest && RETRYABLE_HTTP_STATUSES.has(res.status) && attempt < API_MAX_RETRIES) {
        await waitForRetry(res, attempt);
        continue;
      }
      throw err;
    }
    if (state.authConfigured && path !== '/api/auth/status' && data?.owner && oauthOwnerId(data.owner) !== state.ownerUuid) {
      clearAutoplayTimer();
      window.location.replace('/');
      const error = new Error('account_changed'); error.code = 'stale_session'; throw error;
    }
    return data;
  }
  throw new Error('request_retry_exhausted');
}

// -------- Picker (story + role) --------

async function loadStories() {
  const list = $('#story-list');
  const status = $('#picker-status');
  list.setAttribute('aria-busy', 'true');
  list.innerHTML = '<li class="chip-placeholder">加载中&hellip;</li>';
  try {
    const data = await api('/api/stories');
    const stories = data.stories || [];
    state.stories = stories;
    renderStories();
    status.textContent = '';
  } catch (err) {
    if (err?.code === 'stale_session') return null;
    list.innerHTML = '<li class="chip-placeholder">加载失败，可以稍后重试。</li>';
    status.textContent = `加载失败：${err.message}`;
  } finally {
    list.setAttribute('aria-busy', 'false');
  }
}

function storyCategories(story) {
  const cats = story.categories || story.source?.labels || [];
  return Array.isArray(cats) ? cats.map(c => typeof c === 'string' ? c : c.name || c.title || '').filter(Boolean) : [story.category].filter(Boolean);
}
function storyCover(story, cls = '') {
  const url = story.cover_url || story.source?.artwork || story.source?.tab_artwork;
  return `<div class="book-cover ${cls}">${url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(story.title)}封面" loading="lazy" referrerpolicy="no-referrer">` : `<div class="cover-fallback">${escapeHtml(story.title)}</div>`}</div>`;
}
function icons() { window.lucide?.createIcons(); }
function renderStories() {
  const list = $('#story-list');
  list.innerHTML = '';
  const search = ($('#story-search')?.value || '').trim().toLowerCase();
  const stories = (state.stories || []).filter(story => (!state.category || storyCategories(story).includes(state.category)) && (!search || [story.title, story.author, story.description, story.hook, ...storyCategories(story)].join(' ').toLowerCase().includes(search)));
  for (const story of stories) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'book-card'; btn.type = 'button'; btn.dataset.storyId = story.id;
    btn.innerHTML = `${storyCover(story)}<span class="book-category">${escapeHtml(storyCategories(story).join(' · ') || '互动故事')}</span><h3 class="book-title">${escapeHtml(story.title)}</h3>${story.author ? `<p class="book-author">${escapeHtml(story.author)}</p>` : ''}<p class="book-description">${escapeHtml(story.description || story.hook || '')}</p>`;
    btn.addEventListener('click', () => { void selectStory(story.id); });
    li.appendChild(btn); list.appendChild(li);
  }
  if (!stories.length) list.innerHTML = '<li class="chip-placeholder">没有找到这本故事，换个关键词试试。</li>';
  if (!state.filtersBuilt) {
    state.filtersBuilt = true;
    const cats = [...new Set((state.stories || []).map(story => story.category || storyCategories(story)[0]).filter(Boolean))];
    const filters = $('#category-filters');
    for (const cat of ['', ...cats]) {
      const btn = document.createElement('button'); btn.textContent = cat || '全部故事'; btn.className = cat === (state.category || '') ? 'active' : '';
      btn.addEventListener('click', () => {state.category = cat; Array.from(filters.children).forEach(el => el.classList.toggle('active', el === btn)); renderStories();});
      filters.appendChild(btn);
    }
  }
}
async function selectStory(storyId) {
  let story = state.stories.find(s => s.id === storyId); if (!story) return;
  state.story = story; state.role = null;
  setText('#story-name', story.title); setText('#role-name', '故事详情');
  showScreen('detail'); renderStoryDetail(story);
  $('#start-story-btn').disabled = true; setText('#detail-status', '正在寻找故事中的角色…'); $('#role-list').innerHTML = '';
  const request = ++state.detailRequest || (state.detailRequest = 1);
  try {
    const detail = await api(`/api/stories/${encodeURIComponent(storyId)}`);
    if (request !== state.detailRequest || state.story?.id !== storyId) return;
    const enriched = detail.story || detail;
    story = { ...story, ...enriched, cover_url: enriched.cover_url || story.cover_url, source: { ...story.source, ...enriched.source } }; state.story = story;
    state.role = (story.roles || []).find(r => r.id === story.default_role_id) || null;
    renderStoryDetail(story); renderRoles(story.roles || []);
    $('#start-story-btn').disabled = !state.role; setText('#detail-status', state.role ? '' : '选一个角色，开始你的故事。');
  } catch (err) {
    if (err?.code === 'stale_session') return null; setText('#detail-status', `角色暂时未能加载：${err.message}`); }
}
function renderStoryDetail(story) {
  $('#story-detail').innerHTML = `<div class="detail-hero">${storyCover(story, 'detail-cover')}<div class="detail-meta"><p class="eyebrow">${escapeHtml(storyCategories(story).join(' / ') || 'BEYOND THE STORY')}</p><h1>${escapeHtml(story.title)}</h1><div class="detail-byline">${story.author_avatar ? `<img class="author-avatar" src="${escapeHtml(story.author_avatar)}" alt="" referrerpolicy="no-referrer">` : ''}${story.author ? `<span>${escapeHtml(story.author)}</span>` : ''}${story.word_count ? `<span>${Number(story.word_count).toLocaleString()} 字</span>` : ''}</div><p class="detail-description">${escapeHtml(story.description || story.summary || story.hook || '')}</p></div></div>`;
}
const READING_HISTORY_PREFIX = 'story-outside:reading-session:';
const READING_PAGE_SIZE = 9;

function rememberReading() {
  if (!state.story || !state.sessionUuid) return;
  const saved = { ownerUuid: state.ownerUuid || null, story: state.story, role: state.role, sessionUuid: state.sessionUuid, storyUuid: state.storyUuid, storyVersionUuid: state.storyVersionUuid, cacheUuid: state.cacheUuid, generationProfile: state.generationProfile, openingEvents: state.openingEvents, communityProfileVersion: state.communityProfileVersion, communityProfileUuid: state.communityProfileUuid, communityProfileQueries: state.communityProfileQueries, knowledgeQueries: state.knowledgeQueries, finished: state.finished || state.status === 'finished', updatedAt: Date.now() };
  try {
    migrateReading();
    localStorage.setItem(READING_HISTORY_PREFIX + saved.sessionUuid, JSON.stringify(saved));
    localStorage.setItem('story-outside:reading', JSON.stringify(saved));
    setText('#autosave-status', '已自动保存');
  } catch { setText('#autosave-status', '进度已提交，本机续读记录未保存'); }
}
function ownsReading(saved) { return !state.authConfigured || Boolean(state.ownerUuid && saved?.ownerUuid === state.ownerUuid); }
function readReading() { try { const saved = JSON.parse(localStorage.getItem('story-outside:reading') || 'null'); return ownsReading(saved) ? saved : null; } catch { return null; } }
// Keep one storage entry per session so independent tabs do not overwrite a shared list.
function migrateReading() {
  const legacy = readReading();
  if (legacy?.story && legacy.sessionUuid && !localStorage.getItem(READING_HISTORY_PREFIX + legacy.sessionUuid)) {
    localStorage.setItem(READING_HISTORY_PREFIX + legacy.sessionUuid, JSON.stringify(legacy));
  }
}
function readReadingHistory() {
  const records = new Map();
  const legacy = readReading();
  if (legacy?.story && legacy.sessionUuid) records.set(legacy.sessionUuid, legacy);
  try {
    migrateReading();
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key?.startsWith(READING_HISTORY_PREFIX)) continue;
      try {
        const saved = JSON.parse(localStorage.getItem(key));
        if (ownsReading(saved) && saved?.story && saved.sessionUuid && key === READING_HISTORY_PREFIX + saved.sessionUuid) records.set(saved.sessionUuid, saved);
      } catch { /* A damaged entry must not hide the rest of the bookshelf. */ }
    }
  } catch { /* Storage may be unavailable; retain the legacy record if readable. */ }
  return [...records.values()].sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0) || a.sessionUuid.localeCompare(b.sessionUuid));
}
function readingHistoryPage(records, requestedPage = 1) {
  const pages = Math.max(1, Math.ceil(records.length / READING_PAGE_SIZE));
  const page = Math.max(1, Math.min(pages, Math.trunc(Number(requestedPage)) || 1));
  return { page, pages, records: records.slice((page - 1) * READING_PAGE_SIZE, page * READING_PAGE_SIZE) };
}
function isEndingNotCommittedError(error) {
  return error?.code === 'ending_not_committed'
    || (error?.status === 404 && error?.data?.error === 'ending_not_committed');
}
async function hasCommittedEnding(sessionUuid) {
  try {
    await api(`/api/sessions/${sessionUuid}/ending`);
    return true;
  } catch (error) {
    if (isEndingNotCommittedError(error)) return false;
    throw error;
  }
}
async function resumeSavedReading(saved) {
  if (!saved?.story || !saved.sessionUuid) return;
  const navigationToken = state.navigationToken = (state.navigationToken || 0) + 1;
  state.generationEpoch = (state.generationEpoch || 0) + 1;
  state.startNextBatchInFlight = null;
  clearAutoplayTimer();
  if (state.toolCallTimer) clearTimeout(state.toolCallTimer);
  state.toolCallTimer = null;
  showScreen('player');
  Object.assign(state, saved, { finished: Boolean(saved.finished), pending:null, pendingIdx:0, queuedToolCall:null, inputInFlight:false });
  setText('#story-name', state.story.title); setText('#role-name', state.role?.label || '故事之外'); persistSessionContext(); setStatus('loading');
  try {
    const endingCommitted = await hasCommittedEnding(saved.sessionUuid);
    if (navigationToken !== state.navigationToken || state.sessionUuid !== saved.sessionUuid) return;
    if (endingCommitted) {
      state.finished = true;
      rememberReading();
      setStatus('finished');
      await mountEndingPage();
      return;
    }
    state.finished = false;
    rememberReading();
    showScreen('player');
    await recoverAndStart();
  } catch (err) {
    if (navigationToken !== state.navigationToken || state.sessionUuid !== saved.sessionUuid) return;
    showToast(`读取会话失败：${err.message}`);
    setStatus('error');
  }
}
// 「故事里的相遇」区块模块：进入「我的」页面时重新拉取，避免登录或会话变化后
// 仍显示旧内容。模块加载失败时保持 null，该区块静默缺席。
let communitySectionModule = null;
async function refreshCommunitySection() {
  if (!communitySectionModule) return;
  try {
    if (typeof communitySectionModule.refreshAuthStatus === 'function') await communitySectionModule.refreshAuthStatus();
    if (typeof communitySectionModule.refreshShareAction === 'function') await communitySectionModule.refreshShareAction();
    if (typeof communitySectionModule.refreshFeed === 'function') await communitySectionModule.refreshFeed();
  } catch { /* 区块是增强项，失败不影响「我的」页面其余内容 */ }
}

function renderMine(requestedPage = 1) {
  const all = readReadingHistory();
  const { page, pages, records } = readingHistoryPage(all, requestedPage);
  const host = $('#recent-session');
  host.innerHTML = all.length ? `<p class="history-count">共 ${all.length} 段故事</p><div class="reading-grid">${records.map((saved, index) => {
    const date = new Date(Number(saved.updatedAt));
    const dateLabel = saved.updatedAt && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    return `<article class="reading-card">${storyCover(saved.story)}<h3>${escapeHtml(saved.story.title)}</h3><p>以 ${escapeHtml(saved.role?.label || '你')} 的视角</p><p class="reading-status">${saved.finished ? '已完结' : '阅读中'}${dateLabel ? ` · ${escapeHtml(dateLabel)}` : ''}</p><button class="btn btn-primary" data-reading-index="${index}">${saved.finished ? '查看结局' : '继续故事'} <i data-lucide="arrow-right"></i></button></article>`;
  }).join('')}</div>${pages > 1 ? `<nav class="reading-pagination" aria-label="故事历史分页"><button class="btn" id="reading-prev" ${page === 1 ? 'disabled' : ''}>上一页</button><span aria-live="polite">第 ${page} / ${pages} 页</span><button class="btn" id="reading-next" ${page === pages ? 'disabled' : ''}>下一页</button></nav>` : ''}` : '<p class="empty-state">你的书架还很安静。去选一个喜欢的故事吧。</p>';
  $$('[data-reading-index]', host).forEach(button => button.addEventListener('click', () => { void resumeSavedReading(records[Number(button.dataset.readingIndex)]); }));
  $('#reading-prev')?.addEventListener('click', () => renderMine(page - 1));
  $('#reading-next')?.addEventListener('click', () => renderMine(page + 1));
  icons();
}
// -------- Story bootstrap (session creation) --------

async function bootstrapSession({ story, role }) {
  // Issue #9: the browser no longer depends on any demo / admin route
  // to discover UUIDs, rebuild the opening cache, or assemble a
  // generation_profile. The public /api/sessions façade returns
  // everything we need in a single atomic call:
  //   session_uuid, cache_uuid, opening_events, story_uuid,
  //   story_version_uuid, generation_profile, pinned.
  // The server chooses the model / prompt / generation_profile defaults
  // — the browser does not know about them, by design.
  const requestToken = (state.bootstrapRequestToken || 0) + 1;
  state.bootstrapRequestToken = requestToken;
  state.bootstrapInFlight = true;
  state.generationEpoch = (state.generationEpoch || 0) + 1;
  state.startNextBatchInFlight = null;
  clearAutoplayTimer();
  if (state.toolCallTimer) clearTimeout(state.toolCallTimer);
  state.finished = false; state.pending = null; state.pendingIdx = 0; state.queuedToolCall = null; state.lastPlayerRequestId = 1; state.nextBatchInput = undefined;
  setStatus('loading');
  $('#start-story-btn').disabled = true;
  setText('#detail-status', '正在为你写下开场…');
  setText('#picker-status', '准备开场…');
  const bootstrapToken = state.navigationToken || 0;
  let cacheUuid, generationProfile;
  try {
    const created = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        work_id: story.id,
        role_id: role.id,
      }),
    });
    if (requestToken !== state.bootstrapRequestToken || bootstrapToken !== (state.navigationToken || 0)) return;
    if (!created || !created.session_uuid || !created.cache_uuid) {
      throw new Error('bad_session_bootstrap');
    }
    if (created.pinned?.role_id && created.pinned.role_id !== role.id) {
      throw new Error('session_role_mismatch');
    }
    // The requested role becomes canonical only together with the matching
    // server session. This keeps the header, persisted recovery data and the
    // model's pinned role on the same selection.
    state.role = role;
    state.sessionUuid = created.session_uuid;
    state.cacheUuid = created.cache_uuid;
    state.storyUuid = created.story_uuid || null;
    state.storyVersionUuid = created.story_version_uuid || null;
    // Story 16.2 P1.v2 (2026-09-07): forward the canonical
    // community-profile pointer into state so mountEndingPage can
    // hand it to /v1/ecosystem/discussions verbatim.
    // Story 16.4 P1.v1-2 fix (2026-09-07): capture the canonical
    // community_profile_version the server returns on the bootstrap
    // response. The value comes from the same source the
    // /v1/ecosystem/hot orchestrator reads, so a mismatch is
    // impossible unless the row was regenerated between calls.
    // Empty-string rejection preserved so a 400
    // community_profile_version_mismatch downstream is not
    // preempted by a phantom "" match.
    state.communityProfileVersion = typeof created.community_profile_version === 'string'
      && created.community_profile_version
      ? created.community_profile_version
      : null;
    // Story 16.5 P1.1 (2026-09-07, PR #25): also forward the
    // canonical community_profile_uuid so deep-link recovery and the
    // ending page can pin it without a fresh round-trip.
    state.communityProfileUuid = created.community_profile_uuid || null;
    // Story 16.2 P1.v2 (2026-09-07): forward the canonical
    // community-profile queries list (server-authoritative) so
    // mountEndingPage can hand it to /v1/ecosystem/discussions
    // verbatim without a fresh /recover round-trip.
    state.communityProfileQueries = Array.isArray(created.community_profile_queries)
      ? created.community_profile_queries
      : null;
    // Story 16.5 P1.1 (2026-09-07, PR #25): the public
    // /api/sessions bootstrap also echoes the canonical
    // knowledge_queries[]. The player is contractually just a
    // courier — it never picks a topic of its own; it hands the
    // canonical list straight to the ending page (and onward to
    // /v1/ecosystem/knowledge) so the public surface always has the
    // three identifiers it needs.
    state.knowledgeQueries = Array.isArray(created.knowledge_queries)
      ? created.knowledge_queries.map((q) => ({
        id: q && q.id ? q.id : null,
        query: q && q.query ? String(q.query) : '',
        kind: q && q.kind ? String(q.kind) : 'knowledge',
      }))
      : [];
    state.openingEvents = Array.isArray(created.opening_events) ? created.opening_events : [];
    state.generationProfile = (created.session && created.session.generation_profile)
      || (created.pinned && created.pinned.generation_profile)
      || { cache_uuid: created.cache_uuid };
    // Story 16.4 P1.v1-7 fix (2026-09-07): publish the canonical
    // triple (story_uuid + story_version_uuid + community_profile_version)
    // to the producer module the moment the bootstrap response is in
    // hand. v1-2 wired this path only on `endingPage.mount()`, so a
    // fresh tab that picks a story and starts the game never published
    // the triple — the home-page hot module had nothing to bind to and
    // silently fell back to a plain (no-relevance) list. Now the
    // bootstrap response is the SOLE source of truth for the triple and
    // `bootstrapSession` is the SOLE producer for the pick-story →
    // start-story path; endingPage keeps its own republish so reloads /
    // deep links also reach the producer.
    //
    // The producer module exposes `setActiveIdentity` on
    // `window.STORY_OUTSIDE_IDENTITY_API` (frozen object loaded
    // synchronously BEFORE player.js per public/index.html). It
    // validates the required triple itself and is idempotent:
    // last-write-wins on `window.STORY_OUTSIDE_IDENTITY` plus
    // sessionStorage + one canonical-pointer-changed event per call.
    // A missing field short-circuits without firing the event, so
    // a partial triple cannot downgrade the relevance path.
    publishBootstrapIdentity();
    // Story 16.3 P1 v1-2: capture the canonical owner the server
    // echoed back so the ending page can render the OAuth-pending
    // display name without an extra round-trip.
    if (created.owner) {
      state.ownerDisplayName = created.owner.display_name || state.ownerDisplayName || '';
      state.ownerAuthSource = created.owner.auth_source || state.ownerAuthSource || '';
      if (state.ownerDisplayName) setText('#owner-display-name', state.ownerDisplayName);
    }
    setText('#story-name', story.title);
    setText('#role-name', role.label);
    persistSessionContext();
    // Story 16.3 P1 v1-4: tell every listener (communitySection etc.)
    // that a fresh session exists so share/unshare can point at it.
    // `persistSessionContext` already dispatches through the helper
    // when it loaded; this dispatch covers the helper-not-yet-loaded
    // path AND the "no-helper-loaded" harness path.
    dispatchLocalSessionChanged(state.sessionUuid || null, 'player.bootstrapSession');
    rememberReading();
    showScreen('player');
    await recoverAndStart();
  } catch (err) {
    if (requestToken !== state.bootstrapRequestToken || bootstrapToken !== (state.navigationToken || 0)) return null;
    if (err?.code === 'stale_session') return null;
    setText('#picker-status', `准备失败：${err.message}`);
    setText('#detail-status', `准备失败：${err.message}`);
    setStatus('picker');
    showScreen('detail');
    setText('#role-name', '故事详情');
  } finally {
    if (requestToken === state.bootstrapRequestToken) {
      state.bootstrapInFlight = false;
      $('#start-story-btn').disabled = !state.role;
    }
  }
}

/**
 * Story 16.4 P1.v1-7 fix (2026-09-07): push the canonical
 * triple to the producer the moment bootstrapSession holds a
 * server-confirmed (story_uuid + story_version_uuid + community_profile_version).
 * The producer is a separate module loaded synchronously BEFORE
 * player.js per public/index.html; this helper just adapts the
 * player state shape to the producer's input shape. Called once per
 * successful bootstrap — never on the error path.
 *
 * Idempotency: `STORY_OUTSIDE_IDENTITY_API.setActiveIdentity` is
 * pure write-through. Multiple callers (this helper +
 * endingPage.publishEndingIdentity) compose as last-write-wins
 * on the same global + storage row + event stream.
 */
function publishBootstrapIdentity() {
  const apiRef = /** @type {any} */ (window).STORY_OUTSIDE_IDENTITY_API;
  if (!apiRef || typeof apiRef.setActiveIdentity !== 'function') return;
  const story_uuid = typeof state.storyUuid === 'string' ? state.storyUuid : '';
  const story_version_uuid = typeof state.storyVersionUuid === 'string' ? state.storyVersionUuid : '';
  const community_profile_version = typeof state.communityProfileVersion === 'string'
    && state.communityProfileVersion
    ? state.communityProfileVersion
    : '';
  if (!story_uuid || !story_version_uuid || !community_profile_version) return;
  // Story 16.4 P1.v1-7 fix (2026-09-07): publish the canonical
  // triple via the producer's frozen API surface. The literal
  // qualified call below is the wire contract for the
  // `STORY_OUTSIDE_IDENTITY_API.setActiveIdentity` grep guard —
  // any future refactor that moves the call behind an indirection
  // must keep this qualified form so the verification grep keeps
  // matching. The producer is idempotent (last-write-wins) so
  // endingPage.publishEndingIdentity + this helper compose cleanly.
  /** @type {any} */ (window).STORY_OUTSIDE_IDENTITY_API.setActiveIdentity({
    story_uuid,
    story_version_uuid,
    community_profile_version,
    story_slug: state.story && state.story.id ? state.story.id : '',
    story_title: state.story && state.story.title ? state.story.title : '',
    source: 'start',
  });
}

// -------- Last-session context (for the ?s=ending deep link) --------
//
// Story 16.3 P1 v1-4 (2026-09-07 review):
// the page now uses ONE storage key (`story-outside:last-session`)
// and ONE helper module (`/scripts/sessionContext.js`). The previous
// secondary session-context slot is GONE, and the bogus global
// session-context object on `window` is GONE. Every reader and
// writer goes through the helper, which also dispatches a
// `session:changed` CustomEvent on `window` after every write so the
// social panel (and any other listener) can refresh without re-mount.

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

function persistSessionContext() {
  // The helper is async-loaded, but the player uses a fire-and-forget
  // pattern: write through the helper when it is available, otherwise
  // fall back to the direct storage write so the deep-link recovery
  // still works. Both paths write the SAME single key.
  //
  // Story 16.3 P1 v1-7 (2026-09-07 review):
  // the meta passed to the helper MUST include the FULL canonical
  // triple (`storyUuid` / `storyVersionUuid` /
  // `communityProfileVersion` / `communityProfileQueries`). v1-6
  // forwarded only `storyTitle` / `roleLabel` / `source`, which
  // caused the helper to silently strip the canonical triple on
  // `location.reload()` and the `?s=ending` deep link lost its
  // canonical triple. The direct-write fallback below was correct,
  // but the helper is pre-loaded by the player bootstrap, so the
  // fallback essentially never ran — every reload ate the
  // canonical triple.
  //
  // v1-7 sends the full meta on BOTH paths so the storage payload
  // is identical regardless of whether the helper or the fallback
  // wins the race.
  //
  // Story 16.5 P1.1 (2026-09-07, PR #25): add knowledge_queries /
  // communityProfileUuid to the meta so a ?s=ending reload preserves
  // them for the public /v1/ecosystem/knowledge surface. The values
  // come from the bootstrap response, NEVER from the player's own
  // inputs — the player is a courier, not the topic chooser.
  const meta = {
    storyTitle: state.story ? state.story.title : '',
    roleLabel: state.role ? state.role.label : '',
    storyUuid: state.storyUuid || null,
    storyVersionUuid: state.storyVersionUuid || null,
    communityProfileVersion: state.communityProfileVersion || null,
    communityProfileUuid: state.communityProfileUuid || null,
    communityProfileQueries: Array.isArray(state.communityProfileQueries)
      ? state.communityProfileQueries.slice() : null,
    knowledgeQueries: Array.isArray(state.knowledgeQueries) ? state.knowledgeQueries : [],
    source: 'player.bootstrapSession',
  };
  const helper = _sessionContextModule;
  if (helper && typeof helper.setCurrentShareTargetUuid === 'function') {
    try {
      helper.setCurrentShareTargetUuid(state.sessionUuid || null, meta);
      return;
    } catch { /* fall through to direct write */ }
  }
  // Direct write — same key as the helper. No secondary key exists.
  // Keep the payload shape aligned with the helper's v1-7
  // `normalizeMeta()` so a future fallback-path test or a pre-v1-7
  // helper still round-trips the same triple.
  try {
    sessionStorage.setItem('story-outside:last-session', JSON.stringify({
      sessionUuid: state.sessionUuid || null,
      storyTitle: meta.storyTitle || (state.story ? state.story.title : ''),
      roleLabel: meta.roleLabel || (state.role ? state.role.label : ''),
      storyUuid: meta.storyUuid,
      storyVersionUuid: meta.storyVersionUuid,
      communityProfileVersion: meta.communityProfileVersion,
      communityProfileUuid: meta.communityProfileUuid,
      communityProfileQueries: meta.communityProfileQueries,
      knowledgeQueries: meta.knowledgeQueries,
      source: meta.source,
    }));
  } catch { /* storage unavailable — deep link degrades to empty state */ }
  // We still want listeners to observe the change even when the
  // helper has not finished loading. Dispatch the event here so a
  // panel mounted before the helper arrived will refresh when it
  // resolves.
  dispatchLocalSessionChanged(state.sessionUuid || null, meta.source);
}

function dispatchLocalSessionChanged(uuid, source) {
  try {
    const target = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : null);
    if (!target || typeof target.dispatchEvent !== 'function') return;
    const Ctor = target.CustomEvent || (typeof CustomEvent !== 'undefined' ? CustomEvent : null);
    if (typeof Ctor !== 'function') return;
    target.dispatchEvent(new Ctor('session:changed', { detail: { sessionUuid: uuid || null, source: source || 'player' } }));
  } catch { /* event dispatch is best-effort */ }
}

function readSessionContext() {
  // Synchronous read of the SINGLE storage key — the helper module
  // resolves the same key, so a write through the helper is visible
  // here and vice-versa. The previous secondary slot is gone.
  try {
    const raw = sessionStorage.getItem('story-outside:last-session');
    const ctx = raw ? JSON.parse(raw) : null;
    return ctx && typeof ctx.sessionUuid === 'string' ? ctx : null;
  } catch { return null; }
}

// -------- Recovery + autoplay driver --------

async function recoverAndStart() {
  const sessionUuid = state.sessionUuid;
  const recoveryEpoch = state.generationEpoch || 0;
  // Read canonical history + active pending. We do NOT call /generate
  // here — recovery is read-only. The autoplay driver only kicks in if
  // there is something pending to display.
  setStatus('loading');
  clearAllPendingNodes();
  try {
    const recovered = await api(`/api/sessions/${sessionUuid}/recover`);
    if (sessionUuid !== state.sessionUuid || recoveryEpoch !== (state.generationEpoch || 0)) return;
    state.lastRevision = recovered.revision || 0;
    state.openingCursor = recovered.opening_cursor || 0;
    // Story 16.2 P1.v2 (2026-09-07): refresh the canonical
    // community-profile pointer on /recover so a page reload still
    // has it. If the server response does not carry one (older
    // versions), leave the previous value as-is.
    if (typeof recovered.community_profile_version === 'string') {
      state.communityProfileVersion = recovered.community_profile_version;
    }
    if (Array.isArray(recovered.community_profile_queries)) {
      state.communityProfileQueries = recovered.community_profile_queries;
    }
    state.canonicalHistory = recovered.history || [];
    state.canonicalEventsById = new Map(state.canonicalHistory.map((e) => [e.event_id, e]));
    state.canonicalNarrativeCount = state.canonicalHistory.filter((e) => e.event_type === 'narrative_beat').length;
    const log = $('#story-log');
    const choices = $('#player-choices');
    if (choices?.parentNode === log) $('#screen-player').appendChild(choices);
    log.innerHTML = '';
    for (const ev of state.canonicalHistory) {
      appendCanonical(ev);
    }
    setProgress(computeProgress());
    // If we still have opening events left to commit, resume opening
    // playback. Otherwise, if there is a pending narrative batch, resume
    // it. Otherwise, generate the next batch.
    if (inOpeningPhase()) {
      setStatus('playing');
      scheduleOpeningStep();
      return;
    }
    if (recovered.pending) {
      state.pending = {
        pending_id: recovered.pending.pending_id,
        events: recovered.pending.events || [],
        tool_call: recovered.pending.tool_call || null,
        committed_count: recovered.pending.committed_count || 0,
      };
      state.pendingIdx = state.pending.committed_count;
      for (let i = state.pendingIdx; i < state.pending.events.length; i += 1) {
        const el = renderPendingPlaceholder(state.pending.events[i], state.canonicalHistory.length + i);
        registerPendingNode(`pending:${state.pending.pending_id}:${i}`, el);
      }
      scrollLogToEnd();
      setStatus('playing');
      scheduleNextStep();
      return;
    }
    // No pending and no opening tail left. The session may already be
    // finished (e.g. a reload after finish_story committed). Probe the
    // read-only ending projection: 200 means the finish envelope is
    // committed and playback must NOT continue — mount the ending page
    // instead. An explicit ending_not_committed response means the story
    // is still live and may generate. Any other probe failure is surfaced
    // as an error; it is not evidence that another generation is safe.
    let endingCommitted = false;
    try {
      endingCommitted = await hasCommittedEnding(state.sessionUuid);
    } catch (error) {
      // A failed ending probe is not evidence that the story is unfinished.
      // Stop here so a transient 502/timeout cannot start another generation.
      throw error;
    }
    if (endingCommitted) {
      state.finished = true;
      rememberReading();
      setStatus('finished');
      await mountEndingPage();
      return;
    }
    await startNextBatch();
  } catch (err) {
    if (err?.code === 'stale_session') return null;
    showToast(`恢复失败：${err.message}`);
    setStatus('error');
  }
}

function scheduleOpeningStep() {
  if (state.status !== 'playing' || state.finished) return;
  if (state.autoplayTimer) clearTimeout(state.autoplayTimer);
  state.autoplayTimer = setTimeout(() => { void runOpeningStep(); }, STEP_DELAY_MS);
}

// Single entry point that dispatches to the right step based on the
// current phase. The opening phase takes priority over the narrative
// phase; while opening events remain uncommitted, no /generate can
// run and no skip can advance to a narrative batch.
function inOpeningPhase() {
  return (state.openingEvents && state.openingCursor < state.openingEvents.length) || false;
}

function clearAutoplayTimer() {
  if (state.autoplayTimer) clearTimeout(state.autoplayTimer);
  state.autoplayTimer = null;
}

function scheduleNext() {
  if (state.status !== 'playing' || state.finished) return;
  clearAutoplayTimer();
  if (inOpeningPhase()) {
    scheduleOpeningStep();
  } else {
    scheduleNextStep();
  }
}

function runOpeningStep() {
  if (state.runOpeningStepInFlight) return state.runOpeningStepInFlight;
  const operation = performrunOpeningStep();
  state.runOpeningStepInFlight = operation;
  operation.finally(() => { if (state.runOpeningStepInFlight === operation) state.runOpeningStepInFlight = null; });
  return operation;
}
async function performrunOpeningStep() {
  state.autoplayTimer = null;
  if (state.status !== 'playing' || state.finished) return;
  // Defensive: if we landed here but opening is already done, hand off
  // to the narrative scheduler instead of looping.
  if (!inOpeningPhase()) {
    if (state.status === 'playing' && !state.finished) {
      if (state.pending) {
        scheduleNextStep();
      } else {
        await startNextBatch();
      }
    }
    return;
  }
  const sequence = state.openingCursor;
  const event = state.openingEvents[sequence];
  if (!event) {
    state.openingCursor = state.openingEvents.length;
    if (state.status === 'playing' && !state.finished) {
      await startNextBatch();
    }
    return;
  }
  // Append a pending-style line so the player sees it instantly.
  // Track the DOM node by sequence so the commit can clear the
  // correct placeholder regardless of how many narrative lines have
  // landed in between.
  const placeholderEl = renderPendingPlaceholder({
    type: event.type,
    // The server projects the opening onto the track this role should read
    // (original first person for "我", neutral third person otherwise).
    // `text` stays the canonical neutral value for the commit comparison.
    text: typeof event.display_text === 'string' ? event.display_text : event.text,
    speaker: event.speaker,
    sequence,
  }, state.canonicalHistory.length + sequence);
  registerPendingNode(`opening:${sequence}`, placeholderEl);
  try {
    const result = await api(`/api/sessions/${state.sessionUuid}/opening-events`, {
      method: 'POST',
      body: JSON.stringify({
        cache_uuid: state.cacheUuid,
        event: { ...event, displayed: true },
        client_request_id: `opening-${state.sessionUuid}-${sequence}`,
        expected_revision: state.lastRevision || 0,
      }),
    });
    state.lastRevision = result.revision;
    state.canonicalHistory = [...state.canonicalHistory, result.event];
    state.openingCursor = sequence + 1;
    clearPendingNode(`opening:${sequence}`);
    commitPendingLineInDomNode(placeholderEl);
    setProgress(computeProgress());
    if (state.status === 'playing' && !state.finished) {
      // Stay on the opening path until the opening is fully committed.
      scheduleOpeningStep();
    }
  } catch (err) {
    if (err?.code === 'stale_session') return null;
    showToast(`开场提交失败：${err.message}`);
    setStatus('paused');
    $('#skip-btn').hidden = false;
  }
}

function appendCanonical(ev) {
  if (!ev || ev.event_type === 'opening_unused') return;
  if (ev.event_type === 'narrative_beat') {
    appendLine(ev.payload, { pending: false });
  } else if (ev.event_type === 'story_opening') {
    appendLine(ev.payload, { pending: false, kind: 'opening' });
  } else if (ev.event_type === 'player_input') {
    appendLine({ type: 'player_input', text: ev.payload.text }, { pending: false });
  }
}

function roleDisplayName(value, story = state.story) {
  const raw = String(value ?? '');
  const roles = Array.isArray(story?.roles) ? story.roles : [];
  const role = roles.find((item) => item && (String(item.id) === raw || String(item.label) === raw));
  return role && typeof role.label === 'string' && role.label ? role.label : raw;
}

function renderPendingPlaceholder(item, position) {
  const log = $('#story-log');
  // If we already have a placeholder at this position from prior recovery
  // (committed_count>=position), skip.
  if (log.children.length > position) {
    const existing = log.children[position];
    if (existing) existing.classList.add('line-pending');
    return existing;
  }
  const li = document.createElement('li');
  li.className = 'line line-pending';
  li.dataset.type = item.type;
  li.dataset.pending = 'true';
  li.dataset.sequence = String(item.sequence);
  if (item.speaker) li.dataset.speaker = item.speaker;
  if (item.speaker) {
    const sp = document.createElement('span');
    sp.className = 'line-speaker';
    sp.textContent = roleDisplayName(item.speaker);
    li.appendChild(sp);
  }
  const txt = document.createElement('span');
  txt.className = 'line-text';
  txt.textContent = item.text;
  li.appendChild(txt);
  log.appendChild(li);
  return li;
}

function appendLine(item, { pending, kind } = {}) {
  const log = $('#story-log');
  const li = document.createElement('li');
  li.className = 'line';
  li.dataset.type = item.type;
  if (pending) li.classList.add('line-pending');
  if (kind === 'opening') li.dataset.opening = 'true';
  if (item.speaker) {
    li.dataset.speaker = item.speaker;
    const sp = document.createElement('span');
    sp.className = 'line-speaker';
    sp.textContent = roleDisplayName(item.speaker);
    li.appendChild(sp);
  }
  const txt = document.createElement('span');
  txt.className = 'line-text';
  txt.textContent = item.text || '';
  li.appendChild(txt);
  log.appendChild(li);
  scrollLogToEnd();
  return li;
}

function scrollLogToEnd() {
  const log = $('#story-log');
  if (!log) return;
  if (state.autoplayTimer === null && $('#pause-btn').hidden) return;
  // Defer to next frame so layout settles.
  requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
}

function commitPendingLineInDom(position) {
  const log = $('#story-log');
  const el = log.children[position];
  if (!el) return;
  el.classList.remove('line-pending');
  // Clear the data-pending attribute so the line is fully indistinguishable
  // from a canonical-history line; otherwise the attribute lingers across
  // commits and confuses any consumer that selects by [data-pending].
  if (el.dataset && 'pending' in el.dataset) delete el.dataset.pending;
}

// Direct-node variant: callers that already hold a reference to the
// placeholder element can clear the pending state without going through
// log.children[position] (which is fragile when canonical history has
// shifted the indexing).
function commitPendingLineInDomNode(el) {
  if (!el) return;
  el.classList.remove('line-pending');
  if (el.dataset && 'pending' in el.dataset) delete el.dataset.pending;
}

// Map of pending placeholder keys (e.g. "opening:2" or "pending:0")
// to the actual DOM node. Lets the commit path clear the right
// element without relying on log.children[position] which drifts as
// canonical events land.
const pendingNodes = new Map();
function registerPendingNode(key, el) {
  if (key != null && el) pendingNodes.set(String(key), el);
}
function clearPendingNode(key) {
  if (key != null) pendingNodes.delete(String(key));
}
function clearAllPendingNodes() {
  pendingNodes.clear();
}

// -------- Autoplay scheduler --------

const STEP_DELAY_MS = 1100;

function scheduleNextStep() {
  if (state.status !== 'playing' || state.finished) return;
  if (state.autoplayTimer) clearTimeout(state.autoplayTimer);
  state.autoplayTimer = setTimeout(() => { void runStep(); }, STEP_DELAY_MS);
}

async function runStep() {
  state.autoplayTimer = null;
  if (state.status !== 'playing' || state.finished) return;
  // Guard: a tool call envelope whose deferred render was interrupted
  // (pause inside the ~STEP_DELAY/2 window, explicit skip) must surface
  // BEFORE any new batch is generated — the world line cannot skip its
  // key nodes.
  if (state.queuedToolCall) {
    const queued = state.queuedToolCall;
    state.queuedToolCall = null;
    await surfaceToolCall(queued);
    return;
  }
  // Guard: while opening events are uncommitted, the narrative path
  // is blocked. Hand off to the opening scheduler instead of
  // generating a new narrative batch (which would discard the
  // opening cache tail and skip remaining opening lines).
  if (inOpeningPhase()) {
    if (state.status === 'playing' && !state.finished) scheduleOpeningStep();
    return;
  }
  // Path 1: still have pending items to commit
  if (state.pending && state.pendingIdx < state.pending.events.length) {
    const hadItems = state.pending.events.length;
    await commitNextPendingItem();
    // commitNextPendingItem may have surfaced a tool_call and queued a
    // deferred render via setTimeout. If it did, the scheduler is now
    // tied up waiting on that render — do NOT chain a fresh /generate
    // or we would race the choice card with another batch of dialogue.
    if (state.toolCallTimer || state.status !== 'playing' || state.finished) return;
    if (hadItems === 0) return;
    if (inOpeningPhase()) {
      scheduleOpeningStep();
    } else {
      scheduleNextStep();
    }
    return;
  }
  // Path 2: pending is empty AND the final tool_call was already shown
  if (state.pending && state.pendingIdx >= state.pending.events.length && state.pending.tool_call) {
    const toolCall = state.pending.tool_call;
    state.pending = null;
    await surfaceToolCall(toolCall);
    return;
  }
  // Path 3: no pending → generate the next batch
  await startNextBatch();
}

function commitNextPendingItem() {
  if (state.commitNextPendingItemInFlight) return state.commitNextPendingItemInFlight;
  const operation = performcommitNextPendingItem();
  state.commitNextPendingItemInFlight = operation;
  operation.finally(() => { if (state.commitNextPendingItemInFlight === operation) state.commitNextPendingItemInFlight = null; });
  return operation;
}
async function performcommitNextPendingItem() {
  const item = state.pending.events[state.pendingIdx];
  if (!item) {
    state.pendingIdx = state.pending.events.length;
    return;
  }
  const expectedRevision = (state.lastRevision || 0);
  const sequence = state.pendingIdx;
  const clientRequestId = `commit-${state.pending.pending_id}-${sequence}`;
  // Use the registered DOM node (if any) so we clear the right
  // placeholder even when canonical history has shifted the indexing.
  const pendingKey = `pending:${state.pending.pending_id}:${sequence}`;
  const placeholderEl = pendingNodes.get(pendingKey) || null;
  try {
    const result = await api(`/api/sessions/${state.sessionUuid}/narrative-events`, {
      method: 'POST',
      body: JSON.stringify({
        pending_id: state.pending.pending_id,
        sequence,
        expected_revision: expectedRevision,
        client_request_id: clientRequestId,
      }),
    });
    state.lastRevision = result.revision;
    state.canonicalHistory = [...state.canonicalHistory, result.event];
    state.canonicalEventsById.set(result.event.event_id, result.event);
    if (result.event.event_type === 'narrative_beat') {
      state.canonicalNarrativeCount = (state.canonicalNarrativeCount || 0) + 1;
    }
    state.pending.committed_count = sequence + 1;
    state.pendingIdx = sequence + 1;
    clearPendingNode(pendingKey);
    if (placeholderEl) {
      commitPendingLineInDomNode(placeholderEl);
    } else {
      // Fall back to the old position-based clearing if the node was
      // never registered (e.g. recovered from a session where we lost
      // the DOM references).
      commitPendingLineInDom(state.canonicalHistory.length - 1);
    }
    setProgress(computeProgress());
    // Final commit → surface the tool_call AFTER the last line is
    // displayed. We flip to 'awaiting-choice' / 'finished' immediately
    // so the outer scheduleNextStep() in runStep becomes a no-op; the
    // deferred setTimeout below is the only thing that advances.
    if (result.pending_tool_call && state.pendingIdx >= state.pending.events.length) {
      const finalToolCall = result.pending_tool_call;
      state.pending = null;
      // Cancel any further scheduler ticks that runStep might have
      // queued, then defer the UI render so the player can read the
      // final line before the choice card or ending appears. The
      // deferred timer is short enough that surfaceToolCall wins the
      // race against the next scheduleNextStep tick. The envelope is
      // ALSO stored in state.queuedToolCall so that a pause inside the
      // deferred window (which clears the timer) cannot lose it —
      // resume and the runStep/startNextBatch guards surface it first.
      if (state.autoplayTimer) clearTimeout(state.autoplayTimer);
      state.autoplayTimer = null;
      if (state.toolCallTimer) clearTimeout(state.toolCallTimer);
      state.queuedToolCall = finalToolCall;
      state.toolCallTimer = setTimeout(() => {
        state.toolCallTimer = null;
        void surfaceToolCall(finalToolCall);
      }, STEP_DELAY_MS / 2);
      return;
    }
  } catch (err) {
    if (err?.code === 'stale_session') return null;
    // Commit failed: surface retryable error, leave the pending line in
    // place, and pause. The user can hit "下一句" to retry.
    showToast(`提交失败：${err.message}`);
    setStatus('paused');
    $('#skip-btn').hidden = false;
  }
}

// Release a pending batch that was staged by a turn the client has
// already abandoned. Without this the server keeps an unconsumed
// pending batch and every subsequent /generate on that session fails
// with `pending_conflict` until the page is reloaded.
//
// Strictly best-effort and deliberately silent:
//   * the player has already moved on, so there is nothing to render
//     and nothing actionable to report;
//   * an interrupt that lands first already dropped the batch, so a
//     404 / state error here is an expected benign race;
//   * this must never throw into performstartNextBatch's catch, or a
//     cleanup failure would surface as a bogus "请求失败" toast for a
//     turn the player abandoned on purpose.
async function discardSupersededPending(sessionUuid, pendingId) {
  if (!sessionUuid || !pendingId) return;
  try {
    await api(`/api/sessions/${sessionUuid}/discard-pending`, {
      method: 'POST',
      body: JSON.stringify({ pending_id: pendingId }),
    });
  } catch { /* superseded cleanup is best-effort by design */ }
}

function startNextBatch() {
  if (state.startNextBatchInFlight) return state.startNextBatchInFlight;
  const operation = performstartNextBatch();
  state.startNextBatchInFlight = operation;
  operation.finally(() => { if (state.startNextBatchInFlight === operation) state.startNextBatchInFlight = null; });
  return operation;
}
async function performstartNextBatch() {
  const generationEpoch = state.generationEpoch || 0;
  if (state.finished) return;
  // Same guard as runStep: never /generate over an undelivered tool
  // call envelope.
  if (state.queuedToolCall) {
    const queued = state.queuedToolCall;
    state.queuedToolCall = null;
    await surfaceToolCall(queued);
    return;
  }
  // Guard: opening must be complete before a narrative batch can be
  // requested. The opening path runs through scheduleOpeningStep, which
  // calls /opening-events, never /generate.
  if (inOpeningPhase()) {
    if (state.status === 'playing' && !state.finished) scheduleOpeningStep();
    return;
  }
  setText('#player-help', '故事正在继续…');
  const expectedRevision = state.lastRevision || 0;
  // Keep the identity AND input after a lost response. A manual retry must
  // replay the first turn, not buy another completion over its pending slot.
  let request = state.generationRequest;
  if (!request || request.sessionUuid !== state.sessionUuid || request.revision !== expectedRevision || request.epoch !== generationEpoch) {
    request = { sessionUuid: state.sessionUuid, revision: expectedRevision, epoch: generationEpoch,
      id: `turn-${expectedRevision}-${state.lastPlayerRequestId}`, input: state.nextBatchInput || 'hello' };
    state.lastPlayerRequestId += 1;
    state.nextBatchInput = null;
    state.generationRequest = request;
  }
  // Remember which session this turn was issued for: the superseded
  // cleanup below must target THAT session, never whatever session the
  // player has navigated to in the meantime.
  const supersededSession = state.sessionUuid;
  try {
    const path = `/api/sessions/${state.sessionUuid}/generate`;
    const options = {
      method: 'POST',
      body: JSON.stringify({
        input: { text: request.input },
        expected_revision: expectedRevision,
        request_id: request.id,
      }),
      headers: { 'content-type': 'application/json', prefer: 'respond-async' },
      allowStaleSession: true,
    };
    let turn;
    const deadline = Date.now() + 10 * 60 * 1000;
    while (true) {
      turn = await api(path, options);
      if (turn.status !== 'pending') break;
      if (Date.now() >= deadline) {
        const error = new Error('生成仍在处理中，请稍后重试。'); error.code = 'request_timeout'; throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (generationEpoch !== (state.generationEpoch || 0) || supersededSession !== state.sessionUuid) {
      // The turn was superseded (player interrupt / navigation / reload)
      // WHILE the request was in flight. The response still landed a real
      // pending batch on the server. Dropping it here without telling the
      // server would leave an unconsumed pending batch that no client
      // tracks: every later /generate then fails closed with
      // `pending_conflict` (stageNarrativeBatch refuses to overwrite an
      // active pending) and the session is stuck until a reload.
      // Release it explicitly. Best-effort: a failure here must never
      // replace the newer turn's outcome.
      await discardSupersededPending(supersededSession, turn.pending_id);
      return;
    }
    if (state.generationRequest === request) state.generationRequest = null;
    state.lastRevision = turn.revision;
    state.pending = {
      pending_id: turn.pending_id,
      events: turn.events || [],
      tool_call: turn.tool_call || null,
      committed_count: turn.pending_committed_count || 0,
    };
    state.pendingIdx = state.pending.committed_count;
    setText('#player-help', '');
    // Render the new pending lines as placeholders; track each node
    // by (pending_id, sequence) so commitNextPendingItem can clear
    // them deterministically.
    for (let i = state.pendingIdx; i < state.pending.events.length; i += 1) {
      const el = renderPendingPlaceholder(state.pending.events[i], state.canonicalHistory.length + i);
      registerPendingNode(`pending:${state.pending.pending_id}:${i}`, el);
    }
    if (state.inputInFlight) return;
    if (state.pending.events.length === 0 && state.pending.tool_call) {
      await surfaceToolCall(state.pending.tool_call);
      state.pending = null;
      return;
    }
    if (state.status === 'playing' && !state.finished) {
      if (inOpeningPhase()) scheduleOpeningStep();
      else scheduleNextStep();
    }
  } catch (err) {
    if (err?.code === 'stale_session') return null;
    if (generationEpoch !== (state.generationEpoch || 0) || supersededSession !== state.sessionUuid) return;
    setText('#player-help', '');
    if (state.inputInFlight) return;
    if (err?.code === 'pending_conflict') {
      state.generationRequest = null;
      await recoverAndStart();
      return;
    }
    showToast(`请求失败：${err.message}`);
    setStatus('paused');
  }
}

async function surfaceToolCall(toolCall) {
  if (!toolCall) return;
  // Whatever is being surfaced now is no longer queued.
  state.queuedToolCall = null;
  if (toolCall.name === 'ask_player_choice') {
    setStatus('awaiting-choice');
    renderChoices(toolCall);
    setText('#player-help', '选一个，或在下方输入框里自己说一句。');
    return;
  }
  if (toolCall.name === 'finish_story') {
    state.finished = true;
    setStatus('finished');
    renderEnding(toolCall);
    setText('#player-help', '');
    rememberReading();
    await mountEndingPage();
    return;
  }
  // Unknown tool: render the literal envelope so the player can see the
  // raw data and we don't silently drop it.
  showToast(`未识别的工具：${toolCall.name}`);
  setStatus('finished');
  state.finished = true;
}

async function mountEndingPage(sessionMetaOverride) {
  // Story 11 hook: hand off to the dedicated ending page module,
  // which fetches /ending + /original-timeline + /replay and renders
  // the comparison + replay UI. We lazy-load so the player.js state
  // machine does not depend on endingPage being available.
  //
  // Story 16.5 P1.1 (2026-09-07, PR #25): the sessionMeta we pass
  // MUST carry the three canonical pointers (storyUuid /
  // storyVersionUuid / communityProfileVersion) + the canonical
  // knowledge_queries[] emitted by /api/sessions. The values come
  // from the bootstrap response — the player is just a courier, it
  // NEVER picks its own topic. The previous default of
  // `{storyTitle, roleLabel}` was the source of the
  // `missing_identifiers` degraded fallback on the public surface.
  const fallback = sessionMetaOverride || {
    storyTitle: state.story ? state.story.title : '',
    roleLabel: state.role ? state.role.label : '',
  };
  const sessionMeta = {
    ...fallback,
    story_uuid: state.storyUuid || fallback.story_uuid || null,
    story_version_uuid: state.storyVersionUuid || fallback.story_version_uuid || null,
    community_profile_version:
      state.communityProfileVersion
      || fallback.community_profile_version
      || (typeof window !== 'undefined'
        && typeof window.STORY_OUTSIDE_COMMUNITY_PROFILE_VERSION === 'string'
        && window.STORY_OUTSIDE_COMMUNITY_PROFILE_VERSION)
      || null,
    knowledge_queries: Array.isArray(state.knowledgeQueries) && state.knowledgeQueries.length > 0
      ? state.knowledgeQueries
      : (Array.isArray(fallback.knowledge_queries) ? fallback.knowledge_queries : []),
  };
  try {
    const mod = await import('/scripts/endingPage.js');
    if (mod && typeof mod.mount === 'function') {
      // Story 16.4 P1.v1-2 fix (2026-09-07): carry the canonical
      // triple into the ending-page sessionMeta so the producer
      // module can republish on mount.
      // Story 16.2 P1.v2 (2026-09-07): also forward the canonical
      // community-profile queries list (server-authoritative) so
      // the ending page can submit /v1/ecosystem/discussions
      // without an extra /recover round-trip. sessionMetaOverride
      // wins for any field it supplies.
      const canonicalMeta = {
        story_uuid: state.storyUuid || '',
        story_version_uuid: state.storyVersionUuid || '',
        community_profile_version: state.communityProfileVersion || '',
        community_profile_queries: state.communityProfileQueries || null,
        story_slug: state.story && state.story.id ? state.story.id : '',
        story_title: state.story ? state.story.title : '',
        storyTitle: state.story ? state.story.title : '',
        roleLabel: state.role ? state.role.label : '',
        roles: Array.isArray(state.story?.roles) ? state.story.roles : [],
        communityProfileVersion: state.communityProfileVersion || '',
        communityProfileQueries: state.communityProfileQueries || null,
        storyUuid: state.storyUuid || '',
        storyVersionUuid: state.storyVersionUuid || '',
      };
      // Story 16.2 P1.v2 (2026-09-07): forward the canonical
      // community-profile pointer into sessionMeta so the ending
      // page can submit /v1/ecosystem/discussions without an extra
      // /recover round-trip. The handler is server-authoritative,
      // so endingPage just echoes these strings back to the API.
      await mod.mount({
        sessionUuid: state.sessionUuid,
        sessionMeta: sessionMetaOverride
          ? { ...canonicalMeta, ...sessionMetaOverride }
          : canonicalMeta,
      });
      return true;
    }
  } catch (err) {
    if (err?.code === 'stale_session') return null;
    // Non-fatal: keep the inline ending visible if the module is
    // unreachable (e.g. dev environment without the new files).
    showToast(`结局页加载失败：${err.message}`);
  }
  return false;
}


function renderChoices(toolCall) {
  const wrap = $('#player-choices');
  wrap.setAttribute('role', 'listitem');
  wrap.innerHTML = '';
  const h = document.createElement('h3');
  h.textContent = toolCall.payload.question || '请选择';
  wrap.appendChild(h);
  const ul = document.createElement('ul');
  ul.className = 'choice-list';
  for (const [optionIndex, opt] of (toolCall.payload.options || []).entries()) {
    const displayLabel = String.fromCharCode(65 + optionIndex);
    const optionText = normalizeOptionLabel(opt.label || opt.text || opt.id);
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    btn.type = 'button';
    btn.dataset.optionId = opt.id;
    btn.innerHTML = `
      <span class="choice-id">${displayLabel}</span>
      <span class="choice-label">${escapeHtml(optionText)}</span>
    `;
    btn.addEventListener('click', () => chooseOption({ ...opt, displayLabel }));
    li.appendChild(btn);
    ul.appendChild(li);
  }
  wrap.appendChild(ul);
  const log = $('#story-log');
  if (wrap.parentNode !== log) log.appendChild(wrap);
  requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
  // Allow free-text input.
  $('#player-input-form').hidden = false;
}

const OPTION_PREFIX_RE = /^\s*[A-Za-zＡ-Ｚａ-ｚ]\s*[.．:：、)）]\s*/u;

function normalizeOptionLabel(value) {
  let label = String(value ?? '').trim();
  let previous = null;
  while (label && label !== previous) {
    previous = label;
    label = label.replace(OPTION_PREFIX_RE, '').trim();
  }
  return label;
}

function formatOptionText(option) {
  const prefix = String(option?.displayLabel || option?.id || '').trim().replace(/[.．:：、)）]$/, '');
  const label = normalizeOptionLabel(option?.label || option?.text || option?.id);
  return prefix ? `${prefix}. ${label}` : label;
}

function renderEnding(toolCall) {
  const wrap = $('#player-ending');
  wrap.innerHTML = '';
  const h3 = document.createElement('h3');
  h3.textContent = toolCall.payload.summary || '结局';
  wrap.appendChild(h3);
  const sections = [
    ['ending', '结尾'],
    ['original_difference', '差一点点'],
    ['key_choices', '关键选择'],
    ['character_outcomes', '角色命运'],
  ];
  for (const [key, label] of sections) {
    const value = toolCall.payload[key];
    if (!value) continue;
    const sec = document.createElement('div');
    sec.className = 'ending-section';
    const h4 = document.createElement('h4');
    h4.textContent = label;
    sec.appendChild(h4);
    if (Array.isArray(value)) {
      const ul = document.createElement('ul');
      for (const item of value) {
        const li = document.createElement('li');
        if (typeof item === 'string') li.textContent = item;
        else if (item && typeof item === 'object') {
          const character = item.character ? `${roleDisplayName(item.character)}: ` : '';
          const change = item.change ? ` (${item.change})` : '';
          li.textContent = `${character}${item.fate || ''}${change}`;
        }
        ul.appendChild(li);
      }
      sec.appendChild(ul);
    } else {
      const p = document.createElement('p');
      p.textContent = String(value);
      sec.appendChild(p);
    }
    wrap.appendChild(sec);
  }
}

// -------- Player interactions --------

function setInputsDisabled(disabled) {
  const input = $('#player-input');
  const btn = $('#player-input-btn');
  if (input) input.disabled = disabled;
  if (btn) btn.disabled = disabled;
}

// Single implementation behind sendPlayerInput (free-text submit) and
// sendPlayerInputChoice (choice buttons): converts the player text into
// a player_input → interrupt, drops the pending tail, and queues the
// text as the next /generate input. `input` names the text field whose
// value is cleared on success / restored on failure; `failLabel` only
// shapes the error toast. Returns a truthy value on success and a falsy
// value on failure so the choice-button caller can stay in
// awaiting-choice without re-engaging the autoplay scheduler.
async function interruptWithPlayerText(text, { input = null, failLabel = '打断' } = {}) {
  if (!state.sessionUuid) return null;
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  // Double-submit guard: a second submit while the interrupt request is
  // in flight would replay the same client_request_id. Swallow it and
  // disable the form so the UI matches.
  if (state.inputInFlight) return null;
  state.inputInFlight = true;
  state.generationEpoch = (state.generationEpoch || 0) + 1;
  state.startNextBatchInFlight = null;
  setInputsDisabled(true);
  // Clear any in-flight schedulers so the failed send cannot race the
  // user's retry; the caller restores the input on failure and the
  // finally-block re-enables the field.
  clearAutoplayTimer();
  if (state.toolCallTimer) { clearTimeout(state.toolCallTimer); state.toolCallTimer = null; }
  // An explicit player interrupt supersedes any tool call envelope
  // whose deferred render has not happened yet.
  state.queuedToolCall = null;
  const inputEl = input ? $(input) : null;
  const previousStatus = state.status;
  setStatus('loading');
  try {
    const interruptedSession = state.sessionUuid;
    await Promise.all([state.runOpeningStepInFlight, state.commitNextPendingItemInFlight].filter(Boolean));
    if (state.sessionUuid !== interruptedSession) return null;
    clearAutoplayTimer();
    if (state.toolCallTimer) clearTimeout(state.toolCallTimer);
    state.toolCallTimer = null; state.queuedToolCall = null;
    setText('#player-help', '');
    const result = await api(`/api/sessions/${state.sessionUuid}/interrupt`, {
      method: 'POST',
      body: JSON.stringify({
        text: trimmed,
        client_request_id: `interrupt-${state.lastPlayerRequestId}`,
        expected_revision: state.lastRevision || 0,
      }),
    });
    state.lastPlayerRequestId += 1;
    state.lastRevision = result.revision;
    state.canonicalHistory = [...state.canonicalHistory, result.event];
    appendLine({ type: 'player_input', text: trimmed }, { pending: false });
    state.pending = null;
    state.pendingIdx = 0;
    clearAllPendingNodes();
    // Drop any pending placeholders in the DOM that did not survive.
    const log = $('#story-log');
    for (let i = log.children.length - 1; i >= 0; i -= 1) {
      const child = log.children[i];
      if (child.dataset && child.dataset.pending === 'true') child.remove();
      else break;
    }
    // Save the typed text so the next /generate can use it as input
    // (drives the deterministic demo provider).
    state.nextBatchInput = trimmed;
    if (inputEl) inputEl.value = '';
    return result;
  } catch (err) {
    if (err?.code === 'stale_session') return null;
    // Failure: the user must be able to retry. Restore the typed text
    // and the previous status (do NOT pretend we are still playing).
    if (inputEl) {
      inputEl.value = trimmed;
      // Best-effort re-focus so the next keystroke is captured.
      try { inputEl.focus({ preventScroll: true }); } catch { inputEl.focus(); }
    }
    showToast(`${failLabel}失败：${err.message}（已保留输入，可重试）`);
    // Drop back to the previous non-loading status so the player is
    // not stuck in a fake "playing" state. The submit handler will
    // resume the correct scheduler on retry.
    setStatus(previousStatus === 'loading' ? 'playing' : previousStatus);
    return null;
  } finally {
    state.inputInFlight = false;
    setInputsDisabled(false);
  }
}

async function sendPlayerInput(text) {
  return interruptWithPlayerText(text, { input: '#player-input', failLabel: '打断' });
}

async function sendPlayerInputChoice(text) {
  return interruptWithPlayerText(text, { failLabel: '选择' });
}

async function chooseOption(option) {
  // Convert the option pick into a player_input → interrupt, then resume.
  const text = formatOptionText(option);
  // The sendPlayerInput call already handles the status transitions on
  // success and failure. We only need to nudge the scheduler when the
  // call actually landed in the canonical history.
  const result = await sendPlayerInputChoice(text);
  if (!result) return; // failure path: sendPlayerInput already restored status
  // Use the choice id as a hint for the deterministic demo provider so
  // the next batch reflects the player's decision (a/b → default
  // 3-item batch, "finish" would be unusual here but allowed).
  state.nextBatchInput = option.id === 'b' ? 'short' : 'hello';
  setStatus('playing');
  clearAutoplayTimer();
  scheduleNext();
}

// -------- Pause / resume / skip --------

function togglePause() {
  if (state.status === 'playing') {
    setStatus('paused');
    $('#skip-btn').hidden = false;
    return;
  }
  if (state.status === 'paused') {
    setStatus('playing');
    // A tool call envelope whose deferred render was interrupted by the
    // pause must surface first; only then does the scheduler resume.
    if (state.queuedToolCall) {
      const queued = state.queuedToolCall;
      state.queuedToolCall = null;
      void surfaceToolCall(queued);
      return;
    }
    // Resume the right scheduler for the current phase so opening
    // playback keeps advancing through its remaining events instead
    // of jumping straight to a narrative /generate.
    scheduleNext();
    return;
  }
  if (state.status === 'awaiting-choice') {
    // The user can use the skip button to force a generate anyway.
    setStatus('playing');
    scheduleNext();
  }
}

async function advanceStory() {
  if (state.status === 'playing') { skipCurrent(); return; }
  if (state.status !== 'paused' || state.inputInFlight) return;
  setStatus('playing');
  if (state.queuedToolCall) { const queued = state.queuedToolCall; state.queuedToolCall = null; await surfaceToolCall(queued); }
  else if (inOpeningPhase()) await runOpeningStep();
  else await runStep();
  if (state.status === 'playing') setStatus('paused');
}

function skipCurrent() {
  // Skip is intentionally a no-op while paused: the user must resume
  // playback first. A paused skip that stages a new batch would
  // discard the still-uncommitted opening cache tail, which violates
  // the 09 acceptance criteria (no skip-ahead during pause).
  if (state.status === 'paused') {
    showToast('先点继续，再点下一句');
    return;
  }
  if (state.status !== 'playing') return;
  // Opening phase: skip = advance one opening event without waiting
  // the autoplay delay. We do NOT call /generate here.
  if (inOpeningPhase()) {
    if (state.autoplayTimer) clearTimeout(state.autoplayTimer);
    state.autoplayTimer = setTimeout(() => { void runOpeningStep(); }, 0);
    return;
  }
  // Narrative phase: skip = advance one pending event OR start the
  // next batch.
  if (state.pending && state.pendingIdx < state.pending.events.length) {
    if (state.autoplayTimer) clearTimeout(state.autoplayTimer);
    void runStep();
  } else if (!state.pending) {
    void startNextBatch();
  }
}

// -------- Share --------

async function share() {
  const url = window.location.href;
  const title = document.title;
  const text = state.story ? `${state.story.title} · ${state.role ? state.role.label : ''}` : title;
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ title, text, url });
      showToast('已发送分享');
      return;
    } catch (err) {
    if (err?.code === 'stale_session') return null;
      if (err && err.name === 'AbortError') return;
      // Fall through to clipboard fallback.
    }
  }
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(url);
      showToast('链接已复制');
      return;
    } catch (err) {
    if (err?.code === 'stale_session') return null;
      // Fall through to legacy copy. Note: in headless / permission-
      // denied contexts navigator.clipboard.writeText rejects with a
      // NotAllowedError; legacy execCommand is the last resort.
    }
  }
  // Last-resort fallback: legacy execCommand copy.
  if (legacyCopy(url)) {
    showToast('链接已复制');
    return;
  }
  // Surface a precise, actionable message instead of a generic
  // failure. The user can still copy the URL manually.
  showToast('复制未授权，请长按地址栏或使用系统复制');
}

function legacyCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

// -------- Navigation --------

function backToPicker() {
  state.generationEpoch = (state.generationEpoch || 0) + 1;
  state.startNextBatchInFlight = null;
  state.navigationToken = (state.navigationToken || 0) + 1;
  state.detailRequest = (state.detailRequest || 0) + 1;
  if (state.toolCallTimer) clearTimeout(state.toolCallTimer);
  state.toolCallTimer = null;
  state.autoplayTimer && clearTimeout(state.autoplayTimer);
  state.autoplayTimer = null;
  state.sessionUuid = null;
  state.pending = null;
  state.pendingIdx = 0;
  state.finished = false;
  state.queuedToolCall = null;
  const choices = $('#player-choices');
  if (choices?.parentNode === $('#story-log')) $('#screen-player').appendChild(choices);
  setText('#story-log', '');
  setText('#player-choices', '');
  setText('#player-ending', '');
  setText('#role-name', '故事之外');
  setText('#story-name', '发现故事');
  setStatus('picker');
  showScreen('picker');
}

// -------- Escape helpers --------

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// -------- Bootstrap --------

let eventsBound = false;
function bindEvents() {
  // Guard against double bootstrap (e.g. harness re-runs): stacking a
  // second submit/click handler would double-fire interrupts.
  if (eventsBound) return;
  eventsBound = true;
  $('#back-btn').addEventListener('click', backToPicker);
  window.addEventListener?.('story:restart', () => {
    const storyId = state.story?.id || readReading()?.story?.id;
    backToPicker();
    if (storyId) void selectStory(storyId);
  });
  window.addEventListener?.('story:home', backToPicker);
  $('#nav-stories')?.addEventListener('click', backToPicker);
  $('#nav-mine')?.addEventListener('click', () => { state.navigationToken = (state.navigationToken || 0) + 1; if (state.status === 'playing') togglePause(); showScreen('mine'); setText('#story-name', '我的'); setText('#role-name', '故事之外'); renderMine(); void refreshCommunitySection(); });
  $('#story-search')?.addEventListener('input', renderStories);
  window.addEventListener?.('story:open', e => {
    if (e.detail?.storyId) void selectStory(e.detail.storyId);
  });
  $('#start-story-btn')?.addEventListener('click', () => { if (state.story && state.role) void bootstrapSession({story:state.story, role:state.role}); });
  $('#player-input').addEventListener('focus', () => { if (state.status === 'playing') togglePause(); });
  $('#story-log').addEventListener('click', e => { if (e.target?.closest('button, a')) return; void advanceStory(); });
  $('#share-btn').addEventListener('click', () => { void share(); });
  $('#pause-btn').addEventListener('click', togglePause);
  $('#skip-btn').addEventListener('click', skipCurrent);
  $('#player-input-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#player-input');
    const text = (input && input.value || '').trim();
    if (!text) return;
    // The sendPlayerInput path owns the input value (it restores on
    // failure, clears on success). Do NOT pre-clear here.
    void sendPlayerInput(text).then((result) => {
      if (!result) return; // failure branch already restored status + input
      if (!state.sessionUuid) return;
      // If we are already finished, leave the finished state alone.
      if (state.finished) {
        setStatus('finished');
        return;
      }
      setStatus('playing');
      clearAutoplayTimer();
      scheduleNext();
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.target && e.target instanceof HTMLInputElement) return;
    if (e.code === 'Space') {
      e.preventDefault();
      togglePause();
    } else if (e.code === 'KeyN' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      skipCurrent();
    }
  });
}

function oauthOwnerId(owner) { return owner?.user_uuid || null; }

async function initializeAccount() {
  const params = new URLSearchParams(window.location.search);
  const error = params.get('oauth_error');
  if (error) {
    const messages = {
      oauth_state_invalid: '登录验证未通过，请重新使用知乎登录。',
      oauth_denied: '你已取消知乎授权。',
      oauth_identity_unavailable: '暂时无法读取知乎账号，请稍后重试。',
    };
    showToast(messages[error] || '知乎登录暂时未成功，请稍后重试。');
    params.delete('oauth_error');
    history.replaceState(null, '', window.location.pathname + (params.size ? '?' + params : ''));
  }
  try {
    const authStatus = await api('/api/auth/status');
    state.authConfigured = authStatus.configured === true;
    state.ownerUuid = oauthOwnerId(authStatus.owner);
    state.ownerDisplayName = authStatus.owner?.display_name || '';
    state.ownerAuthSource = authStatus.owner?.auth_source || '';
    setText('#owner-display-name', state.ownerDisplayName);
    if (!state.authConfigured) return;
    // Never reuse a previous account's last-session pointer on a shared browser.
    try {
      const accountKey = 'story-outside:session-account';
      if (sessionStorage.getItem(accountKey) !== state.ownerUuid) sessionStorage.removeItem('story-outside:last-session');
      sessionStorage.setItem(accountKey, state.ownerUuid || '');
      const activeKey = 'story-outside:active-account';
      localStorage.setItem(activeKey, state.ownerUuid || '');
      window.addEventListener('storage', event => {
        if (event.key === activeKey && event.newValue !== (state.ownerUuid || '')) {
          clearAutoplayTimer(); window.location.replace('/');
        }
      });
    } catch { /* unavailable storage */ }
    const controls = $('#account-controls'); if (controls) controls.hidden = false;
    setText('#account-name', state.ownerDisplayName);
    const login = $('#login-link');
    if (login) { login.hidden = authStatus.authenticated; login.href = '/auth/login?return_to=' + encodeURIComponent(window.location.pathname + window.location.search); }
    const logout = $('#logout-btn');
    if (logout) {
      logout.hidden = !authStatus.authenticated;
      logout.addEventListener('click', async () => {
        logout.disabled = true; clearAutoplayTimer();
        try {
          await api('/auth/logout', { method: 'POST' });
          try { localStorage.setItem('story-outside:active-account', ''); } catch { /* unavailable storage */ }
          window.location.assign('/');
        } catch { logout.disabled = false; showToast('退出未成功，请重试。'); }
      });
    }
  } catch {
    // Until identity can be resolved, do not display a previous account's shelf.
    state.authConfigured = true; state.ownerUuid = null;
    try { sessionStorage.removeItem('story-outside:last-session'); } catch { /* unavailable storage */ }
    showToast('暂时无法确认登录状态，请刷新后重试。');
  }
}

async function bootstrap() {
  const linkedStoryId = new URLSearchParams(window.location.search).get('story');
  await initializeAccount();
  bindEvents();
  // 「故事里的相遇」区块（2026-09-13 转正）：以前它是 socialPanel.js 挂在
  // document.body 上的悬浮 demo 卡片，再被搬进 #community-section。现在它就是
  // 「我的」页面里的一个正常区块，直接渲染进 #community-section，不再有悬浮
  // 宿主、关闭按钮和内联样式。它同样不携带调用者身份 —— 见
  // public/scripts/communitySection.js 顶部的边界说明。
  try {
    await loadSessionContext();
    const communityMod = await import('/scripts/communitySection.js');
    if (communityMod && typeof communityMod.mount === 'function') {
      communitySectionModule = communityMod;
      await communityMod.mount();
    }
  } catch { /* 区块是增强项 —— 核心故事流程必须照常运行 */ }
  setStatus('loading');
  // Deep link: showScreen writes ?s=<screen> into the URL, and a reload
  // on the ending screen must land back on the ending page instead of
  // silently dropping the player into the picker. Attempt the mount
  // first; when no committed ending exists for the remembered session
  // (or no session is remembered at all), the ending page module renders
  // its own empty state.
  let deepLinkedToEnding = false;
  try {
    if (new URLSearchParams(window.location.search).get('s') === 'ending') {
      const ctx = readSessionContext();
      if (ctx) {
        state.sessionUuid = ctx.sessionUuid;
        // Story 16.3 P1 v1-7 (2026-09-07 review + code review
        // 复核): forward the FULL canonical meta from the last-session
        // payload so the ending page can submit
        // /v1/ecosystem/discussions with the same triple the player
        // bootstrap received from /api/sessions. v1-6 only forwarded
        // `storyTitle` / `roleLabel`, so the deep link lost the
        // canonical triple on every reload.
        state.storyUuid = ctx.storyUuid || state.storyUuid;
        state.storyVersionUuid = ctx.storyVersionUuid || state.storyVersionUuid;
        state.communityProfileVersion = ctx.communityProfileVersion || state.communityProfileVersion;
        state.communityProfileUuid = ctx.communityProfileUuid || state.communityProfileUuid;
        state.communityProfileQueries = Array.isArray(ctx.communityProfileQueries) ? ctx.communityProfileQueries : state.communityProfileQueries;
        // Story 16.5 P1.1: also replay knowledge_queries[] onto
        // `state` so the deep link path matches the live-mount path
        // (no missing_identifiers when /v1/ecosystem/knowledge fires).
        state.knowledgeQueries = Array.isArray(ctx.knowledgeQueries) ? ctx.knowledgeQueries : state.knowledgeQueries;
      }
      deepLinkedToEnding = await mountEndingPage(ctx ? {
        storyTitle: ctx.storyTitle || '',
        roleLabel: ctx.roleLabel || '',
        storyUuid: typeof ctx.storyUuid === 'string' ? ctx.storyUuid : null,
        storyVersionUuid: typeof ctx.storyVersionUuid === 'string' ? ctx.storyVersionUuid : null,
        communityProfileVersion: typeof ctx.communityProfileVersion === 'string' ? ctx.communityProfileVersion : null,
        communityProfileUuid: typeof ctx.communityProfileUuid === 'string' ? ctx.communityProfileUuid : null,
        communityProfileQueries: Array.isArray(ctx.communityProfileQueries) ? ctx.communityProfileQueries : null,
        knowledgeQueries: Array.isArray(ctx.knowledgeQueries) ? ctx.knowledgeQueries : [],
      } : undefined);
      if (deepLinkedToEnding) {
        state.finished = true;
        setStatus('finished');
      }
    }
  } catch { /* fall through to the picker */ }
  await loadStories();
  if (deepLinkedToEnding) {
    // Stay on the ending screen. Stories are loaded so the 返回 button
    // still lands on a populated picker.
  } else {
    setStatus('picker');
    showScreen('picker');
    if (linkedStoryId) {
      if (state.stories.some(story => story.id === linkedStoryId)) await selectStory(linkedStoryId);
      else showToast('这本小说暂时不可用，请选择其他故事。');
    }
  }
  // Wire role chips once stories are loaded. Guarded so re-running
  // bootstrap (e.g. harness re-entry) never stacks a second handler —
  // duplicate handlers would race duplicate session creations.
  if (!bootstrap.roleChipsWired) {
    bootstrap.roleChipsWired = true;
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const roleChip = t.closest('#role-list .chip');
      if (!roleChip) return;
      const roleId = roleChip.dataset.roleId;
      const role = (state.story && state.story.roles || []).find((r) => r.id === roleId);
      if (!role) return;
      $$('#role-list .chip').forEach((c) => c.setAttribute('aria-selected', String(c === roleChip)));
      state.role = role;
      $('#start-story-btn').disabled = false;
      setText('#detail-status', '');
    });
  }
}

function renderRoles(roles) {
  const list = $('#role-list');
  list.innerHTML = '';
  for (const role of roles) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.type = 'button';
    btn.dataset.roleId = role.id;
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', String(role.id === state.role?.id));
    btn.innerHTML = `
      <span class="chip-title">${escapeHtml(role.label)}${role.id === state.story?.first_person_role_id && role.label !== '我' ? ' · 我' : ''}</span>
      <span class="chip-hook">${escapeHtml(role.mood || '')}</span>
    `;
    li.appendChild(btn);
    list.appendChild(li);
  }
}

bootstrap();
