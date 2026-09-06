// Story Outside — player frontend (ClickUp 09).
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
  pending: null,        // { pending_id, events[], tool_call, committed_count }
  pendingIdx: 0,        // index of the NEXT pending event to display
  progressTotal: 0,     // largest known event total for progress bar
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
  $$('.screen').forEach((s) => {
    const isActive = s.dataset.screen === name;
    s.classList.toggle('active', isActive);
    s.hidden = !isActive;
  });
  const url = new URL(window.location.href);
  if (name === 'picker') url.searchParams.delete('s');
  else url.searchParams.set('s', name);
  history.replaceState(null, '', url);
}

function setStatus(next) {
  state.status = next;
  setText('#status-label', STATUS_LABEL[next] || next);
  // When the session reaches a terminal state (finished), the progress
  // bar should snap to 100% regardless of the in-flight denominator
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
  $('#player-ending').hidden = !finished;
  $('#pause-btn-label').textContent = next === 'paused' ? '继续' : '暂停';
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
  // Numerator: canonical-history events (committed) — this is the
  // "completed" portion that genuinely advances. Includes opening
  // events, narrative beats, AND player_input interrupts because the
  // player also "completed" those.
  // Denominator: opening_lines + sum of staged (and already-seen)
  // batch sizes + a budget for player_input interrupts. We never
  // let the denominator equal the committed count, so mid-playback
  // the bar is always < 1.0 unless every staged event has been
  // committed. The denominator only grows monotonically as new
  // batches come in or new interrupts are made.
  const openingLines = state.openingEvents ? state.openingEvents.length : 0;
  const history = state.canonicalHistory || [];
  const committed = history.length;
  const playerInputsSeen = history.filter((e) => e && e.event_type === 'player_input').length;
  // A batch is "known" once we have either staged it (state.pending
  // exists) or it is reflected in canonical history.
  // state.progressTotal is bumped each time we stage a batch; it
  // persists across commits so the bar can keep moving forward.
  const knownTotal = Math.max(state.progressTotal || 0, openingLines);
  // The first batch the player can see might still be only partially
  // staged, so add the in-flight batch's total to the denominator.
  const inFlight = (state.pending && state.pending.events) ? state.pending.events.length : 0;
  // The base denominator is opening + cumulative batch sizes. We
  // never let it go below (committed - playerInputsSeen) so that an
  // interrupt-heavy session still has the bar at or near 1.0 at
  // finished. But mid-playback the gap between committed and
  // total comes from the unseen portion of in-flight batches.
  let total = Math.max(knownTotal, openingLines + inFlight, 1);
  // If interrupts pushed committed past total, treat total as at
  // least committed (but never more than the implied work). The
  // player_input events are "free" additions from the player's
  // perspective — they don't add to the staged work, so we don't
  // count them in the denominator.
  const narrativeCommitted = committed - playerInputsSeen;
  if (narrativeCommitted > total) total = narrativeCommitted;
  // Defensive: if for any reason total still tracks committed, force a
  // minimum gap so the bar cannot be pinned to 1.0 mid-play.
  const safeTotal = total > committed ? total : committed + 1;
  return committed / safeTotal;
}

function growProgressTotal(stagedSize) {
  // Called whenever a new batch is staged. The denominator grows so
  // the bar can keep moving forward as commits land.
  const openingLines = state.openingEvents ? state.openingEvents.length : 0;
  const candidate = openingLines + stagedSize;
  if (!state.progressTotal || candidate > state.progressTotal) {
    state.progressTotal = candidate;
  }
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

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  let data = null;
  try { data = await res.json(); }
  catch { data = { error: 'bad_json' }; }
  if (!res.ok) {
    const err = new Error(data.message || data.error || `http_${res.status}`);
    err.code = data.error || `http_${res.status}`;
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
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
    list.innerHTML = '<li class="chip-placeholder">加载失败，可以稍后重试。</li>';
    status.textContent = `加载失败：${err.message}`;
  } finally {
    list.setAttribute('aria-busy', 'false');
  }
}

function renderStories() {
  const list = $('#story-list');
  list.innerHTML = '';
  if (!state.stories || !state.stories.length) {
    list.innerHTML = '<li class="chip-placeholder">暂无可用的故事。</li>';
    return;
  }
  for (const story of state.stories) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.type = 'button';
    btn.dataset.storyId = story.id;
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', 'false');
    btn.innerHTML = `
      <span class="chip-title">${escapeHtml(story.title)}</span>
      <span class="chip-hook">${escapeHtml(story.hook || '')}</span>
    `;
    btn.addEventListener('click', () => selectStory(story.id));
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function selectStory(storyId) {
  const story = state.stories.find((s) => s.id === storyId);
  if (!story) return;
  $$('#story-list .chip').forEach((c) => {
    c.setAttribute('aria-selected', String(c.dataset.storyId === storyId));
  });
  state.story = story;
  state.role = null;
  setText('#story-name', story.title);
  setText('#role-name', '选一个视角');
  renderRoles(story.roles || []);
  $('#role-block').hidden = false;
  // ClickUp 16.4 P1.v2 fix (2026-09-07): when the user picks a
  // story, publish a provisional identity with the slug/title metadata
  // so the hot module can refresh. We DO NOT have story_uuid /
  // story_version_uuid / community_profile_version here yet (those
  // arrive on bootstrapSession), so the producer rejects this partial
  // triple and the hot module stays on its "no identity" path.
  // bootstrapSession() then publishes the complete triple.
  publishIdentityIfAvailable();
}

/**
 * ClickUp 16.4 P1.v2 fix (2026-09-07): publish the active identity
 * via the producer exposed by /scripts/identity.js. Reads from the
 * in-memory state (story_slug, story_title) plus the latest
 * session-bootstrap response (story_uuid, story_version_uuid,
 * community_profile_version). Refuses to publish a partial triple.
 */
function publishIdentityIfAvailable() {
  const api = /** @type {any} */ (window).STORY_OUTSIDE_IDENTITY_API;
  if (!api || typeof api.setActiveIdentity !== 'function') return;
  const story_uuid = state.storyUuid || '';
  const story_version_uuid = state.storyVersionUuid || '';
  // The community_profile_version is read from the session bootstrap
  // payload (server surfaces the canonical value on the response)
  // OR falls back to the canonical default. The mock catalog pins
  // the default at COMMUNITY_PROFILE_GENERATOR_VERSION.rules_version
  // ('1.0.0'); the v2 contract requires strict MAJOR.MINOR.PATCH
  // semver, so we surface '1.0.0'.
  let community_profile_version = '';
  if (typeof state.communityProfileVersion === 'string' && state.communityProfileVersion) {
    community_profile_version = state.communityProfileVersion;
  } else {
    community_profile_version = '1.0.0';
  }
  if (!story_uuid || !story_version_uuid) return;
  api.setActiveIdentity({
    story_uuid,
    story_version_uuid,
    community_profile_version,
    story_slug: state.story && state.story.id ? state.story.id : '',
    story_title: state.story && state.story.title ? state.story.title : '',
    source: 'pick',
  });
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
  setStatus('loading');
  setText('#picker-status', '准备开场&hellip;');
  let cacheUuid, generationProfile;
  try {
    const created = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        work_id: story.id,
        role_id: role.id,
      }),
    });
    if (!created || !created.session_uuid || !created.cache_uuid) {
      throw new Error('bad_session_bootstrap');
    }
    state.sessionUuid = created.session_uuid;
    state.cacheUuid = created.cache_uuid;
    state.storyUuid = created.story_uuid || null;
    state.storyVersionUuid = created.story_version_uuid || null;
    state.communityProfileVersion = typeof created.community_profile_version === 'string'
      ? created.community_profile_version
      : null;
    state.openingEvents = Array.isArray(created.opening_events) ? created.opening_events : [];
    state.generationProfile = (created.session && created.session.generation_profile)
      || (created.pinned && created.pinned.generation_profile)
      || { cache_uuid: created.cache_uuid };
    // ClickUp 16.4 P1.v2 fix (2026-09-07): publish the complete
    // identity triple (story_uuid / story_version_uuid /
    // community_profile_version) so homeHotModule.js can switch
    // from the plain hot list to "相关才关联". The producer is in
    // /scripts/identity.js and is loaded BEFORE player.js.
    publishIdentityIfAvailable();
    setText('#story-name', story.title);
    setText('#role-name', role.label);
    persistSessionContext();
    showScreen('player');
    await recoverAndStart();
  } catch (err) {
    setText('#picker-status', `准备失败：${err.message}`);
    setStatus('picker');
  }
}

// -------- Last-session context (for the ?s=ending deep link) --------

const LAST_SESSION_KEY = 'story-outside:last-session';

function persistSessionContext() {
  // Remember the active session so a reload that lands on ?s=ending can
  // re-mount the ending page for the SAME session instead of silently
  // falling back to the picker. Best-effort: private browsing modes may
  // block storage, in which case the deep link just shows the empty
  // ending state.
  try {
    sessionStorage.setItem(LAST_SESSION_KEY, JSON.stringify({
      sessionUuid: state.sessionUuid || null,
      storyTitle: state.story ? state.story.title : '',
      roleLabel: state.role ? state.role.label : '',
    }));
  } catch { /* storage unavailable — deep link degrades to empty state */ }
}

function readSessionContext() {
  try {
    const raw = sessionStorage.getItem(LAST_SESSION_KEY);
    const ctx = raw ? JSON.parse(raw) : null;
    return ctx && typeof ctx.sessionUuid === 'string' ? ctx : null;
  } catch { return null; }
}

// -------- Recovery + autoplay driver --------

async function recoverAndStart() {
  // Read canonical history + active pending. We do NOT call /generate
  // here — recovery is read-only. The autoplay driver only kicks in if
  // there is something pending to display.
  setStatus('loading');
  clearAllPendingNodes();
  try {
    const recovered = await api(`/api/sessions/${state.sessionUuid}/recover`);
    state.lastRevision = recovered.revision || 0;
    state.openingCursor = recovered.opening_cursor || 0;
    state.canonicalHistory = recovered.history || [];
    state.canonicalEventsById = new Map(state.canonicalHistory.map((e) => [e.event_id, e]));
    state.canonicalNarrativeCount = state.canonicalHistory.filter((e) => e.event_type === 'narrative_beat').length;
    const log = $('#story-log');
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
      growProgressTotal(state.pending.events.length);
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
    // instead. 404 (error=ending_not_committed) or any transient failure
    // keeps the original behavior: generate the next batch.
    let endingCommitted = false;
    try {
      await api(`/api/sessions/${state.sessionUuid}/ending`);
      endingCommitted = true;
    } catch { /* ending_not_committed (404) or transient failure */ }
    if (endingCommitted) {
      state.finished = true;
      setStatus('finished');
      await mountEndingPage();
      return;
    }
    await startNextBatch();
  } catch (err) {
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

async function runOpeningStep() {
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
    text: event.text,
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
    sp.textContent = item.speaker;
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
    sp.textContent = item.speaker;
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

async function commitNextPendingItem() {
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
    // Commit failed: surface retryable error, leave the pending line in
    // place, and pause. The user can hit "下一句" to retry.
    showToast(`提交失败：${err.message}`);
    setStatus('paused');
    $('#skip-btn').hidden = false;
  }
}

async function startNextBatch() {
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
  setText('#player-help', '正在请求下一段&hellip;');
  const expectedRevision = state.lastRevision || 0;
  const requestId = `turn-${state.lastPlayerRequestId}`;
  state.lastPlayerRequestId += 1;
  // The deterministic demo provider reads input.text to decide what to
  // emit: default → 3-item batch, "choice" → choice tool call, "finish"
  // → finish_story tool call, "long" → 4-item batch, "short" → 1-item
  // batch. The first call defaults to a 3-item batch so the player can
  // see narration/dialogue mix.
  const inputText = state.nextBatchInput || 'hello';
  state.nextBatchInput = null;
  try {
    const turn = await api(`/api/sessions/${state.sessionUuid}/generate`, {
      method: 'POST',
      body: JSON.stringify({
        input: { text: inputText },
        expected_revision: expectedRevision,
        request_id: requestId,
      }),
    });
    state.lastRevision = turn.revision;
    state.pending = {
      pending_id: turn.pending_id,
      events: turn.events || [],
      tool_call: turn.tool_call || null,
      committed_count: turn.pending_committed_count || 0,
    };
    state.pendingIdx = state.pending.committed_count;
    // Grow the progress denominator to include this new batch so the
    // bar can advance as commits land.
    growProgressTotal(state.pending.events.length);
    setText('#player-help', '');
    // Render the new pending lines as placeholders; track each node
    // by (pending_id, sequence) so commitNextPendingItem can clear
    // them deterministically.
    for (let i = state.pendingIdx; i < state.pending.events.length; i += 1) {
      const el = renderPendingPlaceholder(state.pending.events[i], state.canonicalHistory.length + i);
      registerPendingNode(`pending:${state.pending.pending_id}:${i}`, el);
    }
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
    setStatus('finished');
    renderEnding(toolCall);
    setText('#player-help', '');
    state.finished = true;
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
  // ClickUp 11 hook: hand off to the dedicated ending page module,
  // which fetches /ending + /original-timeline + /replay and renders
  // the comparison + replay UI. We lazy-load so the player.js state
  // machine does not depend on endingPage being available.
  try {
    const mod = await import('/scripts/endingPage.js');
    if (mod && typeof mod.mount === 'function') {
      // ClickUp 16.4 P1.v2 fix (2026-09-07): carry the canonical
      // identity triple into the ending-page sessionMeta so the
      // producer in /scripts/identity.js can republish on mount.
      const identityMeta = {
        story_uuid: state.storyUuid || '',
        story_version_uuid: state.storyVersionUuid || '',
        community_profile_version: state.communityProfileVersion || '1.0.0',
        story_slug: state.story && state.story.id ? state.story.id : '',
        story_title: state.story ? state.story.title : '',
        storyTitle: state.story ? state.story.title : '',
        roleLabel: state.role ? state.role.label : '',
      };
      await mod.mount({
        sessionUuid: state.sessionUuid,
        sessionMeta: sessionMetaOverride
          ? { ...identityMeta, ...sessionMetaOverride }
          : identityMeta,
      });
      return true;
    }
  } catch (err) {
    // Non-fatal: keep the inline ending visible if the module is
    // unreachable (e.g. dev environment without the new files).
    showToast(`结局页加载失败：${err.message}`);
  }
  return false;
}


function renderChoices(toolCall) {
  const wrap = $('#player-choices');
  wrap.innerHTML = '';
  const h = document.createElement('h3');
  h.textContent = toolCall.payload.question || '请选择';
  wrap.appendChild(h);
  const ul = document.createElement('ul');
  ul.className = 'choice-list';
  for (const opt of toolCall.payload.options || []) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    btn.type = 'button';
    btn.dataset.optionId = opt.id;
    btn.innerHTML = `
      <span class="choice-id">${escapeHtml(opt.id)}</span>
      <span class="choice-label">${escapeHtml(opt.label || opt.text || opt.id)}</span>
    `;
    btn.addEventListener('click', () => chooseOption(opt));
    li.appendChild(btn);
    ul.appendChild(li);
  }
  wrap.appendChild(ul);
  // Allow free-text input.
  $('#player-input-form').hidden = false;
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
          const character = item.character ? `${item.character}: ` : '';
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
  const text = `${option.id}: ${option.label || option.text || option.id}`;
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
  state.autoplayTimer && clearTimeout(state.autoplayTimer);
  state.autoplayTimer = null;
  state.sessionUuid = null;
  state.pending = null;
  state.pendingIdx = 0;
  state.finished = false;
  state.queuedToolCall = null;
  setText('#story-log', '');
  setText('#player-choices', '');
  setText('#player-ending', '');
  setText('#role-name', '未选择角色');
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

async function bootstrap() {
  bindEvents();
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
      if (ctx) state.sessionUuid = ctx.sessionUuid;
      deepLinkedToEnding = await mountEndingPage(ctx ? {
        storyTitle: ctx.storyTitle || '',
        roleLabel: ctx.roleLabel || '',
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
      setText('#role-name', role.label);
      void bootstrapSession({ story: state.story, role });
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
    btn.setAttribute('aria-selected', 'false');
    btn.innerHTML = `
      <span class="chip-title">${escapeHtml(role.label)}</span>
      <span class="chip-hook">${escapeHtml(role.mood || '')}</span>
    `;
    li.appendChild(btn);
    list.appendChild(li);
  }
}

bootstrap();
