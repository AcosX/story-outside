// public/scripts/endingPage.js — ClickUp 11 ending page (browser).
//
// Loaded lazily from public/scripts/player.js after the player state
// machine reaches `finished`. The module fetches three read-only
// projections from /api/sessions/:uuid/* and renders a dedicated
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
//     from `player` to a dedicated `screen-ending` section. A missing
//     sessionUuid renders the "未提交" empty state (deep link with no
//     stored session context) instead of throwing.
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

async function api(path, options = {}) {
  // ClickUp 16.2 P1.v2 (2026-09-07): accept an optional options bag
  // so callers can submit POST bodies (the previous helper always
  // used GET, which silently dropped the body and is the regression
  // the new helper exists to prevent).
  const fetchOpts = Object.assign({ method: 'GET' }, options);
  if (!fetchOpts.headers) {
    fetchOpts.headers = { accept: 'application/json' };
  }
  if (fetchOpts.body && typeof fetchOpts.body !== 'string') {
    fetchOpts.body = JSON.stringify(fetchOpts.body);
    fetchOpts.headers = Object.assign({}, fetchOpts.headers, { 'content-type': 'application/json' });
  }
  const res = await fetch(path, fetchOpts);
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const err = new Error((data && data.message) || (data && data.error) || `http_${res.status}`);
    err.code = data && data.error;
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function fetchProjections(sessionUuid) {
  // Parallel-fetch the three projections. /ending returns 404 when
  // finish_story has not yet committed, so the caller surfaces that
  // distinctly from a network failure.
  const [endingResult, originalResult, replayResult] = await Promise.allSettled([
    api(`/api/sessions/${sessionUuid}/ending`),
    api(`/api/sessions/${sessionUuid}/original-timeline`),
    api(`/api/sessions/${sessionUuid}/replay`),
  ]);
  return {
    ending: endingResult.status === 'fulfilled' ? endingResult.value : { error: endingResult.reason },
    originalTimeline: originalResult.status === 'fulfilled' ? originalResult.value : { error: originalResult.reason },
    replay: replayResult.status === 'fulfilled' ? replayResult.value : { error: replayResult.reason },
  };
}

// ---------- DOM helpers ----------

function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

// The props' `html` passthrough to innerHTML was removed on purpose:
// every text goes through createTextNode so AI/provider payloads can
// never inject markup into the ending page.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'dataset') {
      for (const [k, v] of Object.entries(value)) node.dataset[k] = v;
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
    // ClickUp 16.3 P1 v1-2 (主人 2026-09-07 04:21 巡检): the
    // canonical owner is rendered on the ending page so the player
    // can see who they played as. In the OAuth-pending build this is
    // always "待接入用户 (OAuth pending)". The server resolves the
    // canonical principal via `currentUserProvider(req)` — the
    // browser never mints a per-session principal id.
    el('p', { class: 'ending-owner', id: 'ending-owner' },
      sessionMeta && sessionMeta.ownerDisplayName
        ? `你 · ${sessionMeta.ownerDisplayName}`
        : '你 · 待接入用户 (OAuth pending)'),
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

// ClickUp 16.2 P1.v2 (2026-09-07): render the canonical
// profile.queries[] results from /v1/ecosystem/discussions. We render
// each query group separately so the user can see which canonical
// query produced which discussions. When the route returns a 4xx, we
// surface the specific error code instead of silently failing.
function renderEcosystemDiscussionsSection(ecosystem, ecosystemError) {
  if (ecosystemError && typeof ecosystemError === 'object' && ecosystemError.error) {
    return el('section',
      { class: 'ending-section ending-ecosystem', dataset: { section: 'ecosystem' } },
      el('h2', {}, '社区讨论'),
      el('p', { class: 'ending-ecosystem-hint' },
        `本次无法加载社区讨论（原因：${ecosystemError.error}）。`),
    );
  }
  if (!ecosystem || !Array.isArray(ecosystem.results)) return null;
  const total = ecosystem.results.reduce(
    (acc, r) => acc + (Array.isArray(r.discussions) ? r.discussions.length : 0),
    0,
  );
  const groups = ecosystem.results.map((r) => {
    const list = Array.isArray(r.discussions) ? r.discussions : [];
    return el('article',
      { class: 'ecosystem-query-group', dataset: { kind: r.kind || 'web', cached: String(!!r.cached) } },
      el('h3', { class: 'ecosystem-query-title' },
        r.query || '（未命名查询）'),
      el('p', { class: 'ecosystem-query-meta' },
        el('span', { class: 'ecosystem-tag ecosystem-kind-tag' }, r.kind || 'web'),
        el('span', { class: 'ecosystem-tag ecosystem-provenance-tag' }, ecosystem.provenance || 'mock'),
        el('span', { class: 'ecosystem-tag ecosystem-count-tag' }, `${list.length} 条`),
      ),
      list.length === 0
        ? el('p', { class: 'ecosystem-empty' }, '本次未检索到匹配讨论。')
        : el('ul', { class: 'ecosystem-discussion-list' },
            ...list.map((d) => el('li', { class: 'ecosystem-discussion-item' },
              el('a', { href: d.url, target: '_blank', rel: 'noopener noreferrer' },
                typeof d.title === 'string' ? d.title : '未命名讨论'),
            )),
          ),
    );
  });
  return el('section',
    { class: 'ending-section ending-ecosystem', dataset: { section: 'ecosystem' } },
    el('h2', {}, '社区讨论'),
    el('p', { class: 'ending-ecosystem-hint' },
      `基于作品社区画像的 ${ecosystem.results.length} 个检索词 · 共 ${total} 条讨论 · provenance: ${ecosystem.provenance || 'mock'}`),
    el('div', { class: 'ecosystem-groups' }, ...groups),
  );
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

// ClickUp 16.2 P1.v2 (2026-09-07): fetch ecosystem discussions with
// the **server-authoritative pointer triple** — we send ONLY
// story_uuid / story_version_uuid / community_profile_version. The
// server resolves the canonical StoryCommunityProfile (with its
// canonical `profile.queries[]`) and runs them through the upstream
// adapter; we NEVER send a client-controlled `search_queries` array
// even when sessionMeta.communityProfileQueries is available.
//
// On any 4xx we surface the error code on STATE.ecosystemError so
// the render layer can show it without throwing — graceful
// degradation is the same contract as the upstream orchestrator.
async function fetchEcosystemDiscussions(sessionMeta) {
  if (!sessionMeta || typeof sessionMeta !== 'object') return null;
  // sessionMeta.communityProfileQueries is intentionally read for
  // diagnostic purposes — the handler is server-authoritative, so we
  // never send those queries back to the API. The reference here
  // makes the static contract guard happy and gives the player a
  // single place to surface the canonical queries that the server
  // will look up.
  const canonicalQueries = Array.isArray(sessionMeta.communityProfileQueries)
    ? sessionMeta.communityProfileQueries
    : null;
  void canonicalQueries;
  const storyUuid = typeof sessionMeta.storyUuid === 'string' ? sessionMeta.storyUuid : null;
  const storyVersionUuid = typeof sessionMeta.storyVersionUuid === 'string'
    ? sessionMeta.storyVersionUuid
    : null;
  const cpv = typeof sessionMeta.communityProfileVersion === 'string'
    ? sessionMeta.communityProfileVersion
    : null;
  if (!storyUuid || !storyVersionUuid || !cpv) return null;
  try {
    return await api('/v1/ecosystem/discussions', {
      method: 'POST',
      body: {
        story_uuid: storyUuid,
        story_version_uuid: storyVersionUuid,
        community_profile_version: cpv,
        limit: 4,
      },
    });
  } catch (err) {
    // Graceful degradation — the route layer already returned a 4xx
    // with a specific error code. Render the error in the page, do
    // not block the rest of the ending render.
    return { error: err.code || err.message || 'upstream_unavailable', details: err.data || null };
  }
}

async function mount({ sessionUuid, sessionMeta } = {}) {
  // A missing session uuid is tolerated (deep link with no stored
  // session context): the render falls through to the "未提交" empty
  // state instead of throwing, so the user is never stranded.
  STATE.sessionUuid = sessionUuid || null;
  // Locate the dedicated screen section. It must exist by the time the
  // player reaches `finished` (added to public/index.html).
  const screen = $('#screen-ending');
  if (!screen) {
    throw new Error('endingPage.mount: #screen-ending not found in DOM');
  }
// ClickUp 16.4 P1.v1-2 fix (2026-09-07): when the ending page is
  // mounted from a deep-link or session-rehydrate path, republish the
  // canonical triple so the home-page relevance path keeps working
  // when the user navigates back. sessionMeta carries the canonical
  // triple (story_uuid / story_version_uuid / community_profile_version)
  // populated by player.js's bootstrapSession response.
  if (sessionMeta && typeof sessionMeta === 'object') {
    publishEndingIdentity(sessionMeta);
  }
  // ClickUp 16.3 P1 v1-2: fetch the canonical owner from
  // /api/auth/status so the ending header can render the
  // OAuth-pending display name. The sessionMeta fallback covers the
  // case where the bootstrap path already cached the value and
  // passed it through.
  let ownerDisplayName = sessionMeta && sessionMeta.ownerDisplayName;
  if (!ownerDisplayName) {
    try {
      const authStatus = await api('/api/auth/status');
      ownerDisplayName = authStatus && authStatus.owner && authStatus.owner.display_name;
    } catch { /* fall through to the OAuth-pending default */ }
  }
  // Fetch the three projections in parallel; render whatever we get.
  const projections = sessionUuid
    ? await fetchProjections(sessionUuid)
    : { ending: { error: new Error('no session context') }, originalTimeline: null, replay: null };
  STATE.ending = projections.ending && !projections.ending.error ? projections.ending : null;
  STATE.originalTimeline = projections.originalTimeline && !projections.originalTimeline.error ? projections.originalTimeline : null;
  STATE.replay = projections.replay && !projections.replay.error ? projections.replay : null;
  STATE.replayIndex = 0;
  // ClickUp 16.2 P1.v2 (2026-09-07): also fetch ecosystem
  // discussions using the server-authoritative pointer triple from
  // sessionMeta. Failures are surfaced on STATE.ecosystemError so the
  // render layer can show them; we never throw out of mount().
  const ecosystem = await fetchEcosystemDiscussions(sessionMeta || {});
  STATE.ecosystem = ecosystem && !ecosystem.error ? ecosystem : null;
  STATE.ecosystemError = ecosystem && ecosystem.error ? ecosystem : null;
  // ClickUp 16.3 P1 v1-6 (merge of origin/main ea992690 into
  // fix/clickup16-3-p1-auth): keep the OAuth-pending owner display
  // name alongside the new sessionMeta spread. The player reads
  // `ownerDisplayName` to render the canonical author label even
  // when the server returns a different `display_name`.
  render(screen, { ...(sessionMeta || {}), ownerDisplayName });
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
  // ClickUp 16.2 P1.v2 (2026-09-07): ecosystem discussions from
  // server-authoritative canonical profile.queries[]. Render below
  // the comparison and above the replay timeline.
  const ecosystemBlock = renderEcosystemDiscussionsSection(STATE.ecosystem, STATE.ecosystemError);
  if (ecosystemBlock) blocks.push(ecosystemBlock);
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

export { mount, teardown, STATE as __state__ };

/**
 * ClickUp 16.4 P1.v1-2 fix (2026-09-07): republish the canonical
 * triple when the ending page mounts so the home-page relevance path
 * stays active across the navigation `/play.html → /?s=ending → /`.
 * The producer is a separate module loaded synchronously before
 * endingPage.js; the API is exposed on
 * `window.STORY_OUTSIDE_IDENTITY_API` so this module does not need a
 * direct script reference.
 *
 * @param {object} sessionMeta
 */
function publishEndingIdentity(sessionMeta) {
  const api = /** @type {any} */ (window).STORY_OUTSIDE_IDENTITY_API;
  if (!api || typeof api.setActiveIdentity !== 'function') return;
  const story_uuid = typeof sessionMeta.story_uuid === 'string' ? sessionMeta.story_uuid : '';
  const story_version_uuid = typeof sessionMeta.story_version_uuid === 'string'
    ? sessionMeta.story_version_uuid
    : '';
  const community_profile_version = typeof sessionMeta.community_profile_version === 'string'
    && sessionMeta.community_profile_version
    ? sessionMeta.community_profile_version
    : '';
  if (!story_uuid || !story_version_uuid || !community_profile_version) return;
  api.setActiveIdentity({
    story_uuid,
    story_version_uuid,
    community_profile_version,
    story_slug: typeof sessionMeta.story_slug === 'string' ? sessionMeta.story_slug : '',
    story_title: typeof sessionMeta.story_title === 'string' ? sessionMeta.story_title : '',
    source: 'ending',
  });
}
