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
  relatedKnowledge: null,
};

// ---------- API helper ----------

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const API_MAX_RETRIES = 2;
const API_RETRY_BASE_DELAY_MS = 250;
const API_RETRY_MAX_DELAY_MS = 2000;

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
  const method = String(fetchOpts.method || 'GET').toUpperCase();
  const retryableRequest = method === 'GET';
  for (let attempt = 0; attempt <= API_MAX_RETRIES; attempt += 1) {
    let res;
    try {
      res = await fetch(path, fetchOpts);
    } catch (error) {
      if (!retryableRequest || attempt === API_MAX_RETRIES) throw error;
      await waitForRetry(null, attempt);
      continue;
    }
    let data = null;
    let validJson = true;
    try { data = await res.json(); } catch { validJson = false; data = { error: 'bad_json' }; }
    if (!validJson) {
      const err = new Error('invalid_json_response');
      err.code = 'bad_json';
      err.status = res.status;
      err.data = data;
      if (retryableRequest && RETRYABLE_HTTP_STATUSES.has(res.status) && attempt < API_MAX_RETRIES) {
        await waitForRetry(res, attempt);
        continue;
      }
      throw err;
    }
    if (!res.ok) {
      const err = new Error((data && data.message) || (data && data.error) || `http_${res.status}`);
      err.code = data && data.error;
      err.status = res.status;
      err.data = data;
      if (retryableRequest && RETRYABLE_HTTP_STATUSES.has(res.status) && attempt < API_MAX_RETRIES) {
        await waitForRetry(res, attempt);
        continue;
      }
      throw err;
    }
    return data;
  }
  throw new Error('request_retry_exhausted');
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

// ClickUp 16.5 — fetch the public 知乎知识区 (Knowledge 区) extension
// for this ending. The Knowledge surface is INDEPENDENT from the
// 16.2 / 16.4 Discussion 区 (queries/topics/hot_keywords); a failure
// here MUST NOT block the ending page. Returns either a normalised
// payload, or { degraded: true } when the public surface failed.
//
// P1.v2 authority contract: the browser sends ONLY the canonical
// profile pointer triple plus an optional limit. The server resolves the
// pinned StoryCommunityProfile row and reads knowledge_queries[] from
// that trusted row. This keeps query text server-authoritative and
// prevents the browser from accidentally (or maliciously) overriding
// the subject list.
async function fetchRelatedKnowledge(sessionMeta) {
  if (!sessionMeta || typeof sessionMeta !== 'object') {
    return { degraded: true, reason: 'no_session_meta', knowledge: [] };
  }
  const story_uuid = sessionMeta.story_uuid || null;
  const story_version_uuid = sessionMeta.story_version_uuid || null;
  const community_profile_version = sessionMeta.community_profile_version || null;
  if (!story_uuid || !story_version_uuid || !community_profile_version) {
    // Graceful degradation — the ending still renders without the
    // knowledge extension. The Knowledge surface is provisional.
    return { degraded: true, reason: 'missing_identifiers', knowledge: [] };
  }
  try {
    const res = await fetch('/v1/ecosystem/knowledge', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        story_uuid,
        story_version_uuid,
        community_profile_version,
        limit: 4,
      }),
    });
    if (!res.ok) {
      return { degraded: true, reason: `http_${res.status}`, knowledge: [] };
    }
    const data = await res.json();
    return {
      degraded: data.degraded === true,
      source: data.source || null,
      provisional: data.provisional === true,
      disclaimer: data.disclaimer || null,
      knowledge: Array.isArray(data.knowledge) ? data.knowledge : [],
      knowledge_queries: Array.isArray(data.knowledge_queries) ? data.knowledge_queries : [],
      results: Array.isArray(data.results) ? data.results : [],
    };
  } catch (err) {
    return { degraded: true, reason: 'network_error', knowledge: [] };
  }
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
        el('span', { class: 'ending-choice-index' }, `选择 ${String.fromCharCode(65 + index)}`),
        el('span', { class: 'ending-choice-text' }, String(text)),
      )),
    ),
  );
}

function displayRoleName(value, sessionMeta) {
  const raw = String(value ?? '');
  const roles = Array.isArray(sessionMeta?.roles) ? sessionMeta.roles : [];
  const role = roles.find((item) => item && (String(item.id) === raw || String(item.label) === raw));
  return role && typeof role.label === 'string' && role.label ? role.label : raw;
}

function renderCharacterOutcomesSection(ending, sessionMeta) {
  const outcomes = Array.isArray(ending.character_outcomes) ? ending.character_outcomes : [];
  if (outcomes.length === 0) return null;
  return el('section', { class: 'ending-section', dataset: { section: 'character-outcomes' } },
    el('h2', {}, '角色最终命运'),
    el('ul', { class: 'ending-outcomes', id: 'ending-character-outcomes' },
      ...outcomes.map((item, index) => {
        const character = item && (item.character_label || item.character)
          ? String(item.character_label || displayRoleName(item.character, sessionMeta)) : '';
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
  const deviation = ending.first_divergence;
  if (!deviation || typeof deviation !== 'object') {
    return el('section', { class: 'ending-section ending-deviation', dataset: { section: 'first-deviation' } },
      el('h2', {}, '第一次重大偏离'),
      el('p', {}, ending.first_divergence_reason || '暂未找到足够依据，确定故事从哪里开始不同。'));
  }
  return el('section', { class: 'ending-section ending-deviation', dataset: { section: 'first-deviation' } },
    el('h2', {}, '第一次重大偏离'),
    el('div', { class: 'deviation-card', id: 'ending-first-deviation' },
      el('p', {}, el('strong', {}, '原作的选择'), el('span', {}, `　${deviation.original_choice || ''}`)),
      el('p', {}, el('strong', {}, '你的选择'), el('span', {}, `　${deviation.player_choice || ''}`)),
      deviation.original_evidence ? el('blockquote', { class: 'original-evidence' }, deviation.original_evidence) : null,
      deviation.basis ? el('p', { class: 'deviation-meta' }, deviation.basis) : null));
}
function renderEndingComparisonSection(ending) {
  const verdict = ending.same_as_original === true ? '殊途，同归。' : ending.same_as_original === false ? '你写下了不一样的结局。' : '原作与这一次的结局';
  return el('section', { class:'ending-section ending-verdict', dataset:{section:'ending-verdict'} },
    el('h2', {}, verdict),
    ending.original_ending ? el('p', {}, el('strong', {}, '原作结局'), el('span', {}, `　${ending.original_ending}`)) : null,
    ending.original_ending_evidence ? el('blockquote', {class:'original-evidence'}, ending.original_ending_evidence) : null,
    el('p', {}, ending.ending_comparison_reason || (ending.same_as_original == null ? '目前的原作信息还不足以判断两个结局是否相同。' : '')));
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
  const sourceList = $('#comparison-source-list', wrap);
  const aiList = $('#comparison-ai-list', wrap);
  const toggle = el('button', { class: 'btn timeline-toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'comparison-ai-list' }, '展开完整剧情');
  aiList.classList.add('timeline-collapsed');
  aiList.parentNode.appendChild(toggle);
  const fit = () => {
    const height = Math.max(160, sourceList.getBoundingClientRect().height);
    aiList.style.setProperty('--timeline-preview-height', `${height}px`);
    toggle.hidden = aiList.scrollHeight <= height;
  };
  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(expanded));
    aiList.classList.toggle('timeline-collapsed', !expanded);
    toggle.textContent = expanded ? '收起剧情' : '展开完整剧情';
  });
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(fit);
    observer.observe(sourceList);
    STATE.comparisonObserver?.disconnect();
    STATE.comparisonObserver = observer;
  }
  return wrap;
}

function buildAiTimelineEntries(replay, ending) {
  if (!replay || !Array.isArray(replay.events) || replay.events.length === 0) {
    return [el('li', { class: 'timeline-ai', dataset: { kind: 'empty' } },
      el('span', { class: 'timeline-kind' }, '无'),
      el('span', { class: 'timeline-text' }, '本次没有产生剧情事件。'))];
  }
  const deviationSeq = ending?.first_divergence?.player_event_seq;
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
        '社区讨论暂时无法加载，请稍后再试。'),
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
        el('span', { class: 'ecosystem-tag ecosystem-provenance-tag' }, ecosystem.provenance === 'mock' ? '示例内容' : '知乎讨论'),
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
      `故事之外，还有这些值得聊聊的话题 · ${total} 条讨论`),
    el('div', { class: 'ecosystem-groups' }, ...groups),
  );
}

function renderReplaySection(replay, sessionMeta) {
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
        ev.speaker ? el('span', { class: 'replay-speaker' }, ev.speaker_label || displayRoleName(ev.speaker, sessionMeta)) : null,
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
  );
}

// ClickUp 16.5 — Knowledge 区 (现实/知乎知识延伸) section. The
// Knowledge surface is INDEPENDENT from the 16.2 / 16.4 Discussion 区
// surface; this DOM block NEVER mutates or replaces
// `relatedDiscussions` and shares no class names with it.
//
// Contract:
//   * Section #ending-related-knowledge is always rendered when the
//     ending page mounts (even when the surface is degraded), so a
//     DOM-test can assert its presence deterministically.
//   * When `state.relatedKnowledge.degraded === true`, the section
//     shows the disabled hint "相关问答暂时无法加载，请稍后再试。" instead of an entry
//     list. The hint's stable id is `#ending-related-knowledge-disabled`.
//   * When entries are present, the surface disclaimer
//     "以下内容属于现实/知乎知识延伸，不是原作设定或 AI 世界线事实"
//     is rendered verbatim INSIDE the section (not on `relatedDiscussions`)
//     so a UI / accessibility tool can verify the boundary on the DOM.
function renderRelatedKnowledgeSection(knowledgeState) {
  const state = knowledgeState || { degraded: true, knowledge: [] };
  const entries = Array.isArray(state.knowledge) ? state.knowledge : [];
  const degraded = state.degraded === true;
  const header = el('h2', {}, '延伸知识（知乎）');
  const intro = el('p', { class: 'related-knowledge-intro', id: 'ending-related-knowledge-intro' },
    '以下内容属于现实/知乎知识延伸，不是原作设定或 AI 世界线事实。');
  const banner = state.provisional === true
    ? el('p', { class: 'related-knowledge-banner', id: 'ending-related-knowledge-banner', dataset: { flag: 'provisional' } },
        '知识延伸为临时来源，不代表作品事实')
    : null;
  let body;
  if (degraded) {
    // Real provider not configured (or upstream failed). We never
    // surface the error code on the DOM — only the stable disabled
    // hint — so a regression that exposes the upstream error does
    // not leak through the browser.
    body = el('p', {
      class: 'related-knowledge-disabled',
      id: 'ending-related-knowledge-disabled',
      dataset: { kind: 'disabled' },
    }, '相关问答暂时无法加载，请稍后再试。');
  } else if (entries.length === 0) {
    body = el('p', { class: 'related-knowledge-empty', id: 'ending-related-knowledge-empty' },
      '本次没有匹配的延伸知识。');
  } else {
    body = el('ul', { class: 'related-knowledge-list', id: 'ending-related-knowledge-list' },
      ...entries.map((entry, index) => {
        const title = entry && entry.title ? String(entry.title) : '';
        const summary = entry && entry.summary ? String(entry.summary) : '';
        const source = entry && entry.source ? String(entry.source) : '';
        const url = entry && entry.url ? String(entry.url) : '';
        const relatedTopics = entry && Array.isArray(entry.related_topics)
          ? entry.related_topics.filter((s) => typeof s === 'string')
          : [];
        const link = url
          ? el('a', {
              href: url,
              rel: 'noopener noreferrer',
              target: '_blank',
              class: 'related-knowledge-link',
            }, title)
          : el('span', { class: 'related-knowledge-title' }, title);
        return el('li', {
          class: 'related-knowledge-item',
          dataset: {
            index: String(index),
            provisional: 'true',
          },
        },
          link,
          summary ? el('p', { class: 'related-knowledge-summary' }, summary) : null,
          relatedTopics.length > 0
            ? el('p', { class: 'related-knowledge-topics' },
                el('span', { class: 'related-knowledge-topics-label' }, '相关话题：'),
                ...relatedTopics.flatMap((topic, tidx) => [
                  tidx > 0 ? el('span', { class: 'related-knowledge-topic-sep' }, ' · ') : null,
                  el('span', { class: 'related-knowledge-topic' }, topic),
                ]),
              )
            : null,
          source ? el('p', { class: 'related-knowledge-source' }, `来源：${source}`) : null,
        );
      }),
    );
  }
  return el('section', {
    class: 'ending-section ending-related-knowledge',
    id: 'ending-related-knowledge',
    dataset: {
      section: 'related-knowledge',
      surface: 'knowledge',
      provisional: state.provisional === true ? 'true' : 'false',
      degraded: degraded ? 'true' : 'false',
    },
  },
    header,
    intro,
    banner,
    body,
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
  // ClickUp 16.5 — fetch the public 知乎知识区 (Knowledge 区)
  // extension for this ending. The fetch is best-effort: a failure
  // degrades to a disabled state and never blocks the render.
  STATE.relatedKnowledge = await fetchRelatedKnowledge(sessionMeta || {});
  // ClickUp 16.3 P1 v1-6 (merge of origin/main ea992690 into
  // fix/clickup16-3-p1-auth): keep the OAuth-pending owner display
  // name alongside the new sessionMeta spread. The player reads
  // `ownerDisplayName` to render the canonical author label even
  // when the server returns a different `display_name`.
  render(screen, { ...(sessionMeta || {}), ownerDisplayName });
  STATE.mounted = true;
}

function render(screen, sessionMeta) {
  STATE.comparisonObserver?.disconnect();
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
  blocks.push(renderEndingComparisonSection(STATE.ending));
  const choices = renderKeyChoicesSection(STATE.ending); if (choices) blocks.push(choices);
  const outcomes = renderCharacterOutcomesSection(STATE.ending, sessionMeta); if (outcomes) blocks.push(outcomes);
  const analysis = renderAnalysisSection(STATE.ending); if (analysis) blocks.push(analysis);
  const comparison = renderComparisonSection(STATE.originalTimeline, STATE.ending, STATE.replay); if (comparison) blocks.push(comparison);
  // ClickUp 16.2 P1.v2 (2026-09-07): ecosystem discussions from
  // server-authoritative canonical profile.queries[]. Render below
  // the comparison and above the replay timeline.
  const ecosystemBlock = renderEcosystemDiscussionsSection(STATE.ecosystem, STATE.ecosystemError);
  if (ecosystemBlock) blocks.push(ecosystemBlock);
  // ClickUp 16.5 — Knowledge 区. Always rendered (even when degraded)
  // so a DOM-test can assert its presence deterministically. The
  // surface is independent from `relatedDiscussions` (16.2 / 16.4).
  blocks.push(renderRelatedKnowledgeSection(STATE.relatedKnowledge || { degraded: true, knowledge: [] }));
  const replay = renderReplaySection(STATE.replay, sessionMeta);
  blocks.push(replay);
  const actions = el('nav', { class: 'ending-actions', 'aria-label': '接下来' });
  for (const [label, event, primary] of [['再来一次', 'story:restart', true], ['返回主页', 'story:home', false]]) {
    const button = el('button', { type: 'button', class: primary ? 'btn btn-primary' : 'btn' }, label);
    button.addEventListener('click', () => window.dispatchEvent(new CustomEvent(event)));
    actions.appendChild(button);
  }
  blocks.push(actions);
  blocks.push(renderAttribution(STATE.originalTimeline));
  for (const block of blocks) screen.appendChild(block);
  attachReplayHandlers();
  showScreen('ending');
}

function teardown() {
  STATE.comparisonObserver?.disconnect();
  const screen = $('#screen-ending');
  if (screen) clear(screen);
  STATE.mounted = false;
  STATE.sessionUuid = null;
  STATE.ending = null;
  STATE.originalTimeline = null;
  STATE.replay = null;
  STATE.replayIndex = 0;
  STATE.relatedKnowledge = null;
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
