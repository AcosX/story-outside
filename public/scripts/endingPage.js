// public/scripts/endingPage.js — ClickUp 11 ending page (browser).
//
// Loaded lazily from public/scripts/player.js after the player state
// machine reaches `finished`. The module fetches three read-only
// projections from /api/dev/sessions/:uuid/* and renders a dedicated
// ending screen with:
//   * ending title + summary + key choices + character outcomes
//   * first deviation highlight (red anchor in the comparison view)
//   * "原著时间线 vs 我的时间线" side-by-side comparison with
//     visually distinct classes (`timeline-source` for original facts,
//     `timeline-ai` for AI-parallel facts)
//   * world-line replay (button → step through committed events one at
//     a time)
//   * story / author source attribution + a clear "AI 生成平行时间线"
//     label so the page never misrepresents AI content as the original
//
// DOM contract:
//   * mount({ sessionUuid, sessionMeta }) — entry point. Always
//     succeeds (the inline ending card is left in place on any failure
//     so the user still sees *something*); switches the player screen
//     from `player` to a dedicated `screen-ending` section.
//   * teardown() — restores the inline ending card and switches back
//     to `screen-player`. The player hooks do not currently call this
//     (the ending screen is terminal), but it is exported for tests.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const STATE = {
  sessionUuid: null,
  ending: null,
  originalTimeline: null,
  replay: null,
  replayIndex: 0,
  mounted: false,
};

// ---------- API helper ----------

async function api(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const err = new Error((data && data.message) || data && data.error || `http_${res.status}`);
    err.code = data && data.error;
    err.status = res.status;
    throw err;
  }
  return data;
}

async function fetchProjections(sessionUuid) {
  // Parallel-fetch the three projections. /ending returns 404 when
  // finish_story has not yet committed, so the caller surfaces that
  // distinctly from a network failure.
  const [endingResult, originalResult, replayResult] = await Promise.allSettled([
    api(`/api/dev/sessions/${sessionUuid}/ending`),
    api(`/api/dev/sessions/${sessionUuid}/original-timeline`),
    api(`/api/dev/sessions/${sessionUuid}/replay`),
  ]);
  return {
    ending: endingResult.status === 'fulfilled' ? endingResult.value : { error: endingResult.reason },
    originalTimeline: originalResult.status === 'fulfilled' ? originalResult.value : { error: originalResult.reason },
    replay: replayResult.status === 'fulfilled' ? replayResult.value : { error: replayResult.reason },
  };
}

// ---------- DOM helpers ----------

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'dataset') {
      for (const [k, v] of Object.entries(value)) node.dataset[k] = v;
    } else if (key === 'html') {
      node.innerHTML = value;
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    if (typeof child === 'string' || typeof child === 'number') {
      node.appendChild(document.createTextNode(String(child)));
    } else {
      node.appendChild(child);
    }
  }
  return node;
}

// ---------- Section builders ----------

function renderHeader(ending, sessionMeta) {
  return el('header', { class: 'ending-header' },
    el('h1', { class: 'ending-title', id: 'ending-title' },
      ending.ending_title || ending.ending_summary || '结局'),
    el('p', { class: 'ending-subtitle' },
      sessionMeta && sessionMeta.storyTitle ? `${sessionMeta.storyTitle} · ${sessionMeta.roleLabel || ''}` : ''),
    el('span', { class: 'ending-tag ending-tag-ai', id: 'ending-ai-tag', title: '本页 AI 生成的时间线仅供平行体验，不视为原作' },
      'AI 生成平行时间线'),
  );
}

function renderSummarySection(ending) {
  const summary = ending.ending_summary || '';
  if (!summary) return null;
  return el('section', { class: 'ending-section ending-summary', dataset: { section: 'summary' } },
    el('h2', {}, '结局摘要'),
    el('p', { id: 'ending-summary-text' }, summary),
  );
}

function renderKeyChoicesSection(ending) {
  const choices = Array.isArray(ending.key_choices) ? ending.key_choices : [];
  if (choices.length === 0) return null;
  return el('section', { class: 'ending-section', dataset: { section: 'key-choices' } },
    el('h2', {}, '关键选择'),
    el('ul', { class: 'ending-choices', id: 'ending-key-choices' },
      ...choices.map((text, index) => el('li', { class: 'ending-choice', dataset: { index: String(index) } },
        el('span', { class: 'ending-choice-index' }, `Choice ${index + 1}`),
        el('span', { class: 'ending-choice-text' }, String(text)),
      )),
    ),
  );
}

function renderCharacterOutcomesSection(ending) {
  const outcomes = Array.isArray(ending.character_outcomes) ? ending.character_outcomes : [];
  if (outcomes.length === 0) return null;
  return el('section', { class: 'ending-section', dataset: { section: 'character-outcomes' } },
    el('h2', {}, '角色最终命运'),
    el('ul', { class: 'ending-outcomes', id: 'ending-character-outcomes' },
      ...outcomes.map((item, index) => {
        const character = item && item.character ? String(item.character) : '';
        const fate = item && item.fate ? String(item.fate) : '';
        const change = item && item.change ? String(item.change) : '';
        return el('li', { class: 'ending-outcome', dataset: { character, index: String(index) } },
          el('span', { class: 'ending-outcome-character' }, character),
          el('span', { class: 'ending-outcome-fate' }, fate),
          change ? el('span', { class: 'ending-outcome-change' }, `（${change}）`) : null,
        );
      }),
    ),
  );
}

function renderFirstDeviationSection(ending) {
  const deviation = ending.first_deviation;
  if (!deviation || typeof deviation !== 'object') return null;
  return el('section', { class: 'ending-section ending-deviation', dataset: { section: 'first-deviation' } },
    el('h2', {}, '第一次重大偏离'),
    el('div', { class: 'deviation-card', id: 'ending-first-deviation' },
      el('div', { class: 'deviation-meta' },
        el('span', { class: 'deviation-event-seq' }, `第 ${deviation.event_seq || 0} 句`),
        el('span', { class: 'deviation-type' }, deviation.type || 'narrative_beat'),
      ),
      deviation.speaker ? el('div', { class: 'deviation-speaker' }, deviation.speaker) : null,
      el('div', { class: 'deviation-text' }, deviation.text || ''),
    ),
  );
}

function renderAnalysisSection(ending) {
  if (!ending.total_analysis) return null;
  return el('section', { class: 'ending-section ending-analysis', dataset: { section: 'total-analysis' } },
    el('h2', {}, '总体分析'),
    el('p', { id: 'ending-total-analysis' }, ending.total_analysis),
  );
}

// Build the side-by-side comparison: "原著时间线" on the left, "我的
// 时间线" on the right. Both are visually distinct via classes so a
// user / accessibility tool can tell them apart at a glance.
function renderComparisonSection(originalTimeline, ending, replay) {
  if (!originalTimeline || !Array.isArray(originalTimeline.key_facts)) return null;
  const wrap = el('section', { class: 'ending-section ending-comparison', dataset: { section: 'comparison' } },
    el('h2', {}, '原著时间线 vs 我的时间线'),
    el('p', { class: 'ending-comparison-hint' },
      '左边是原作的客观事实，右边是你实际走过的剧情节点。'),
    el('div', { class: 'comparison-grid', id: 'ending-comparison-grid' },
      // Left: source timeline
      el('div', { class: 'comparison-col comparison-source' },
        el('h3', { class: 'comparison-col-title' },
          el('span', { class: 'comparison-label-tag timeline-source-tag' }, '来自原作'),
          el('span', { class: 'comparison-source-title' }, originalTimeline.source_attribution || '原作时间线'),
        ),
        el('ol', { class: 'comparison-list timeline-source', id: 'comparison-source-list' },
          ...originalTimeline.key_facts.map((fact, index) => el('li', { class: 'timeline-source', dataset: { kind: fact.kind || 'fact', index: String(index) } },
            el('span', { class: 'timeline-kind' }, fact.label || (fact.kind || 'fact')),
            el('span', { class: 'timeline-text' }, fact.text || ''),
          )),
        ),
      ),
      // Right: AI-parallel timeline
      el('div', { class: 'comparison-col comparison-ai' },
        el('h3', { class: 'comparison-col-title' },
          el('span', { class: 'comparison-label-tag timeline-ai-tag' }, 'AI 生成平行时间线'),
          el('span', { class: 'comparison-ai-title' }, '你走过的剧情'),
        ),
        el('ol', { class: 'comparison-list timeline-ai', id: 'comparison-ai-list' },
          ...buildAiTimelineEntries(replay, ending)),
      ),
    ),
  );
  return wrap;
}

function buildAiTimelineEntries(replay, ending) {
  if (!replay || !Array.isArray(replay.events) || replay.events.length === 0) {
    return [el('li', { class: 'timeline-ai', dataset: { kind: 'empty' } },
      el('span', { class: 'timeline-kind' }, '无'),
      el('span', { class: 'timeline-text' }, '本次没有产生剧情事件。'))];
  }
  const deviationSeq = ending && ending.first_deviation && ending.first_deviation.event_seq;
  return replay.events.map((ev, index) => {
    const isDeviation = Number.isInteger(deviationSeq) && Number(ev.sequence) === deviationSeq;
    const li = el('li',
      {
        class: isDeviation ? 'timeline-ai timeline-deviation' : 'timeline-ai',
        dataset: {
          kind: ev.type || 'narration',
          sequence: String(ev.sequence || index + 1),
          ...(isDeviation ? { deviation: 'true' } : {}),
        },
      },
      el('span', { class: 'timeline-kind' }, `${ev.sequence || index + 1}`),
      el('span', { class: 'timeline-text' }, ev.text || ''),
    );
    return li;
  });
}

function renderReplaySection(replay) {
  const events = replay && Array.isArray(replay.events) ? replay.events : [];
  return el('section', { class: 'ending-section ending-replay', dataset: { section: 'replay' } },
    el('h2', {}, '世界线回放'),
    el('p', { class: 'ending-replay-hint' },
      '按时间顺序，一句一句重放你实际走过的剧情（不含未提交的推测内容）。'),
    el('div', { class: 'replay-controls' },
      el('button', { class: 'btn', id: 'replay-prev-btn', type: 'button', 'aria-label': '上一句' }, '上一句'),
      el('button', { class: 'btn', id: 'replay-next-btn', type: 'button', 'aria-label': '下一句' }, '下一句'),
      el('button', { class: 'btn', id: 'replay-reset-btn', type: 'button', 'aria-label': '回到开头' }, '回到开头'),
      el('span', { class: 'replay-progress', id: 'replay-progress' }, replayProgressText(0, events.length)),
    ),
    el('ol', { class: 'replay-list', id: 'replay-list' },
      ...events.map((ev, index) => el('li',
        {
          class: 'replay-event',
          dataset: { sequence: String(ev.sequence || index + 1) },
        },
        el('span', { class: 'replay-sequence' }, `${ev.sequence || index + 1}`),
        ev.speaker ? el('span', { class: 'replay-speaker' }, ev.speaker) : null,
        el('span', { class: 'replay-text' }, ev.text || ''),
      )),
    ),
  );
}

function renderAttribution(originalTimeline) {
  const sourceAttribution = originalTimeline && originalTimeline.source_attribution;
  return el('section', { class: 'ending-section ending-attribution', dataset: { section: 'attribution' } },
    el('p', { class: 'attribution-row' },
      el('span', { class: 'attribution-source' }, sourceAttribution || '原作信息不可用')),
    el('p', { class: 'attribution-row attribution-ai' },
      el('strong', {}, '本页右栏、结局摘要、关键选择、角色命运均为 '),
      el('strong', { id: 'ending-attribution-ai' }, 'AI 生成平行时间线'),
      el('span', {}, '；不视为原作。')),
    el('p', { class: 'attribution-row' },
      el('small', {},
        '为未来社区统计预留 ending_key / category 字段（数据契约已定义，MVP 不展示排行榜）。')),
  );
}

function replayProgressText(current, total) {
  return `${Math.min(current, total)} / ${total}`;
}

// ---------- Mount / teardown ----------

function showScreen(name) {
  $$('.screen').forEach((s) => {
    const isActive = s.dataset && s.dataset.screen === name;
    if (isActive) {
      s.classList.add('active');
      s.hidden = false;
    } else {
      s.classList.remove('active');
      s.hidden = true;
    }
  });
  const url = new URL(window.location.href);
  url.searchParams.set('s', name);
  if (window.history && typeof window.history.replaceState === 'function') {
    window.history.replaceState(null, '', url);
  }
}

function attachReplayHandlers() {
  const prev = $('#replay-prev-btn');
  const next = $('#replay-next-btn');
  const reset = $('#replay-reset-btn');
  if (prev) prev.addEventListener('click', () => stepReplay(-1));
  if (next) next.addEventListener('click', () => stepReplay(+1));
  if (reset) reset.addEventListener('click', () => setReplayIndex(0));
  updateReplayView();
}

function setReplayIndex(nextIndex) {
  const total = STATE.replay && Array.isArray(STATE.replay.events) ? STATE.replay.events.length : 0;
  STATE.replayIndex = Math.max(0, Math.min(total, nextIndex));
  updateReplayView();
}

function stepReplay(delta) {
  const total = STATE.replay && Array.isArray(STATE.replay.events) ? STATE.replay.events.length : 0;
  setReplayIndex(STATE.replayIndex + delta);
  // The total guard above already caps the index to `total` (inclusive)
  // so the final position shows all events plus the closing "完成" hint.
  return STATE.replayIndex >= total;
}

function updateReplayView() {
  const list = $('#replay-list');
  if (!list) return;
  const events = STATE.replay && Array.isArray(STATE.replay.events) ? STATE.replay.events : [];
  const children = list.children;
  for (let i = 0; i < children.length; i += 1) {
    const isShown = i < STATE.replayIndex;
    children[i].classList.toggle('replay-event-shown', isShown);
  }
  const progress = $('#replay-progress');
  if (progress) progress.textContent = replayProgressText(STATE.replayIndex, events.length);
}

async function mount({ sessionUuid, sessionMeta } = {}) {
  if (!sessionUuid) {
    throw new Error('endingPage.mount: sessionUuid required');
  }
  STATE.sessionUuid = sessionUuid;
  // Locate the dedicated screen section. It must exist by the time the
  // player reaches `finished` (added to public/index.html).
  const screen = $('#screen-ending');
  if (!screen) {
    throw new Error('endingPage.mount: #screen-ending not found in DOM');
  }
  // Fetch the three projections in parallel; render whatever we get.
  const projections = await fetchProjections(sessionUuid);
  STATE.ending = projections.ending && !projections.ending.error ? projections.ending : null;
  STATE.originalTimeline = projections.originalTimeline && !projections.originalTimeline.error ? projections.originalTimeline : null;
  STATE.replay = projections.replay && !projections.replay.error ? projections.replay : null;
  STATE.replayIndex = 0;
  render(screen, sessionMeta || {});
  STATE.mounted = true;
}

function render(screen, sessionMeta) {
  clear(screen);
  if (!STATE.ending) {
    // Surface a friendly "未提交" hint when finish_story has not
    // committed. The data still has the in-card inline ending on
    // #player-ending so the user is never stranded.
    const wrap = el('div', { class: 'ending-empty' },
      el('h1', { class: 'ending-title' }, '结局尚未提交'),
      el('p', {}, '本次会话还没有 finish_story 提交记录。如果你刚刚进入结局页，请稍后刷新。'),
    );
    screen.appendChild(wrap);
    showScreen('ending');
    return;
  }
  const blocks = [];
  blocks.push(renderHeader(STATE.ending, sessionMeta));
  const summary = renderSummarySection(STATE.ending); if (summary) blocks.push(summary);
  const deviation = renderFirstDeviationSection(STATE.ending); if (deviation) blocks.push(deviation);
  const choices = renderKeyChoicesSection(STATE.ending); if (choices) blocks.push(choices);
  const outcomes = renderCharacterOutcomesSection(STATE.ending); if (outcomes) blocks.push(outcomes);
  const analysis = renderAnalysisSection(STATE.ending); if (analysis) blocks.push(analysis);
  const comparison = renderComparisonSection(STATE.originalTimeline, STATE.ending, STATE.replay); if (comparison) blocks.push(comparison);
  const replay = renderReplaySection(STATE.replay);
  blocks.push(replay);
  blocks.push(renderAttribution(STATE.originalTimeline));
  for (const block of blocks) screen.appendChild(block);
  attachReplayHandlers();
  showScreen('ending');
}

function teardown() {
  const screen = $('#screen-ending');
  if (screen) clear(screen);
  STATE.mounted = false;
  STATE.sessionUuid = null;
  STATE.ending = null;
  STATE.originalTimeline = null;
  STATE.replay = null;
  STATE.replayIndex = 0;
  showScreen('player');
}

// Exposed for tests + future hot-reload. The module is loaded via
// dynamic `import('/scripts/endingPage.js')` from player.js, so this
// globalThis handle lets the harness replay a scenario deterministically.
if (typeof globalThis !== 'undefined') {
  globalThis.__ENDING_PAGE_STATE__ = STATE;
}

export { mount, teardown, STATE as __state__ };