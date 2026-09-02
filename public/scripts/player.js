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
//     and renders the ending card; further commits are blocked;
//   * /recover on reload rebuilds the displayed lines from canonical
//     history + active pending without re-running the provider;
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
  storyVersionUuid: null,
  cacheUuid: null,
  generationProfile: null,
  pending: null,        // { pending_id, events[], tool_call, committed_count }
  pendingIdx: 0,        // index of the NEXT pending event to display
  progressTotal: 0,     // largest known event total for progress bar
  finished: false,      // terminal tool_call has been rendered
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
}

// -------- Story bootstrap (session creation) --------

async function bootstrapSession({ story, role }) {
  setStatus('loading');
  setText('#picker-status', '准备开场&hellip;');
  let cacheUuid, storyUuid, storyVersionUuid, generationProfile;
  try {
    const adminList = await api('/api/admin/stories');
    const entry = (adminList.stories || []).find((row) => row.slug === story.id);
    if (!entry || !entry.versions || !entry.versions.length) {
      throw new Error('no_version_for_story');
    }
    const version = entry.versions.find((v) => v.status === 'published') || entry.versions[0];
    storyUuid = entry.story_uuid;
    storyVersionUuid = version.story_version_uuid;
    const rebuilt = await api('/api/admin/opening-cache/rebuild', {
      method: 'POST',
      body: JSON.stringify({ story_version_uuid: storyVersionUuid }),
    });
    const cache = rebuilt.result.cache;
    cacheUuid = cache.cache_uuid;
    generationProfile = { ...cache.generation_profile, cache_uuid: cacheUuid };
    state.openingEvents = (cache.content_payload && cache.content_payload.events) || [];
  } catch (err) {
    setText('#picker-status', `准备失败：${err.message}`);
    setStatus('picker');
    return;
  }
  const sessionUuid = newSessionUuid();
  try {
    const created = await api('/api/dev/sessions', {
      method: 'POST',
      body: JSON.stringify({
        session_uuid: sessionUuid,
        story_uuid: storyUuid,
        story_version_uuid: storyVersionUuid,
        user_ref: 'demo-user-09',
        role_id: role.id,
        model: 'mock-09',
        prompt: 'demo 09 prompt',
        generation_profile: generationProfile,
      }),
    });
    state.sessionUuid = created.session_uuid || sessionUuid;
    state.cacheUuid = cacheUuid;
    state.storyVersionUuid = storyVersionUuid;
    state.generationProfile = generationProfile;
    setText('#story-name', story.title);
    setText('#role-name', role.label);
    setText('#role-hook', '');
    showScreen('player');
    await recoverAndStart();
  } catch (err) {
    setText('#picker-status', `创建会话失败：${err.message}`);
    setStatus('picker');
  }
}

function newSessionUuid() {
  // A stable client-side UUID keeps the demo session addressable across
  // reloads (within the same process). crypto.randomUUID is available in
  // modern browsers and the Node 20+ server we run against.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: a non-cryptographic v4-shaped identifier.
  const rnd = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${rnd(8)}-${rnd(4)}-4${rnd(3)}-a${rnd(3)}-${rnd(12)}`;
}

// -------- Recovery + autoplay driver --------

async function recoverAndStart() {
  // Read canonical history + active pending. We do NOT call /generate
  // here — recovery is read-only. The autoplay driver only kicks in if
  // there is something pending to display.
  setStatus('loading');
  clearAllPendingNodes();
  try {
    const recovered = await api(`/api/dev/sessions/${state.sessionUuid}/recover`);
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
    const result = await api(`/api/dev/sessions/${state.sessionUuid}/opening-events`, {
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
    const result = await api(`/api/dev/sessions/${state.sessionUuid}/narrative-events`, {
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
      // race against the next scheduleNextStep tick.
      if (state.autoplayTimer) clearTimeout(state.autoplayTimer);
      state.autoplayTimer = null;
      if (state.toolCallTimer) clearTimeout(state.toolCallTimer);
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
    const turn = await api(`/api/dev/sessions/${state.sessionUuid}/generate`, {
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
    // ClickUp 11 hook: hand off to the dedicated ending page module,
    // which fetches /ending + /original-timeline + /replay and renders
    // the comparison + replay UI. We lazy-load so the player.js state
    // machine does not depend on endingPage being available.
    try {
      const mod = await import('/scripts/endingPage.js');
      if (mod && typeof mod.mount === 'function') {
        await mod.mount({
          sessionUuid: state.sessionUuid,
          sessionMeta: {
            storyTitle: state.story ? state.story.title : '',
            roleLabel: state.role ? state.role.label : '',
          },
        });
      }
    } catch (err) {
      // Non-fatal: keep the inline ending visible if the module is
      // unreachable (e.g. dev environment without the new files).
      showToast(`结局页加载失败：${err.message}`);
    }
    return;
  }
  // Unknown tool: render the literal envelope so the player can see the
  // raw data and we don't silently drop it.
  showToast(`未识别的工具：${toolCall.name}`);
  setStatus('finished');
  state.finished = true;
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

// Variant of sendPlayerInput used by the choice buttons: returns a
// truthy value on success and a falsy value on failure (instead of
// just throwing). Lets the caller stay in awaiting-choice on failure
// without re-engaging the autoplay scheduler.
async function sendPlayerInputChoice(text) {
  if (!state.sessionUuid) return null;
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  clearAutoplayTimer();
  if (state.toolCallTimer) { clearTimeout(state.toolCallTimer); state.toolCallTimer = null; }
  setStatus('loading');
  try {
    const result = await api(`/api/dev/sessions/${state.sessionUuid}/interrupt`, {
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
    const log = $('#story-log');
    for (let i = log.children.length - 1; i >= 0; i -= 1) {
      const child = log.children[i];
      if (child.dataset && child.dataset.pending === 'true') child.remove();
      else break;
    }
    state.nextBatchInput = trimmed;
    return result;
  } catch (err) {
    showToast(`选择失败：${err.message}（可重试或输入自己的句子）`);
    setStatus('awaiting-choice');
    return null;
  }
}

async function sendPlayerInput(text) {
  if (!state.sessionUuid) return null;
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  // Clear any in-flight schedulers so the failed send cannot race the
  // user's retry; the form submit handler will restore the input on
  // failure and re-enable the field.
  clearAutoplayTimer();
  if (state.toolCallTimer) { clearTimeout(state.toolCallTimer); state.toolCallTimer = null; }
  const input = $('#player-input');
  const previousStatus = state.status;
  setStatus('loading');
  try {
    const result = await api(`/api/dev/sessions/${state.sessionUuid}/interrupt`, {
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
    if (input) input.value = '';
    return result;
  } catch (err) {
    // Failure: the user must be able to retry. Restore the typed text
    // and the previous status (do NOT pretend we are still playing).
    // If the input is still in the DOM (it should be), restore its
    // value so the user can resubmit.
    if (input) {
      input.value = trimmed;
      // Best-effort re-focus so the next keystroke is captured.
      try { input.focus({ preventScroll: true }); } catch { input.focus(); }
    }
    showToast(`打断失败：${err.message}（已保留输入，可重试）`);
    // Drop back to the previous non-loading status so the player is
    // not stuck in a fake "playing" state. The submit handler will
    // resume the correct scheduler on retry.
    setStatus(previousStatus === 'loading' ? 'playing' : previousStatus);
    return null;
  }
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

function bindEvents() {
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
  await loadStories();
  setStatus('picker');
  showScreen('picker');
  // Wire role chips once stories are loaded.
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