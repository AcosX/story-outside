// public/scripts/homeHotModule.js — ClickUp 16.4 home-page "知乎此刻热议"
// module (rebuilt on current main 44343b2).
//
// This script is INTENTIONALLY isolated from player.js / endingPage.js:
//   * It only touches DOM nodes under #ecosystem-hot-module.
//   * It never blocks the picker / player / ending flow.
//   * It fetches GET /v1/ecosystem/hot?category=total (PUBLIC endpoint;
//     the path lives under /v1/, not the admin/dev toolspace).
//   * On any upstream failure (5xx, 4xx, network error, malformed
//     payload, empty list) it shows the fallback "暂时无法获取知乎
//     热议" placeholder inside the module rather than crashing the
//     rest of the page. The fallback DOM is always present in
//     index.html (#ecosystem-hot-empty) so a JS-disabled browser also
//     sees something other than nothing.
//
// The module is deliberately tiny — no framework, no build step —
// so the existing home page stays dependency-free.

const HOT_ENDPOINT = '/v1/ecosystem/hot';
const DEFAULT_CATEGORY = 'total';
const DEFAULT_LIMIT = 10;
const FETCH_TIMEOUT_MS = 4000;

function pickElement(id) {
  if (typeof document === 'undefined') return null;
  return document.getElementById(id);
}

function clampLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), 50);
}

/**
 * Render the fallback "暂时无法获取知乎热议" placeholder. The DOM
 * element is always present in index.html so this is purely a state
 * flip (hidden / visible).
 *
 * @param {{ list: HTMLElement | null, empty: HTMLElement | null, sub: HTMLElement | null }} els
 */
function renderFallback(els) {
  if (!els.list || !els.empty || !els.sub) return;
  els.list.setAttribute('aria-busy', 'false');
  els.list.replaceChildren();
  els.sub.textContent = '知乎热议暂不可用';
  els.empty.hidden = false;
}

/**
 * Render the hot list. Defensive: drops malformed rows so a single
 * bad payload entry cannot blank the whole module.
 *
 * @param {{ list: HTMLElement | null, empty: HTMLElement | null, sub: HTMLElement | null }} els
 * @param {Array<{ rank: number, question_uuid: string, title: string, heat: number, url: string, category: string }>} rows
 */
function renderRows(els, rows) {
  if (!els.list || !els.empty || !els.sub) return;
  const safe = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
  if (safe.length === 0) {
    renderFallback(els);
    return;
  }
  els.empty.hidden = true;
  els.list.setAttribute('aria-busy', 'false');
  els.sub.textContent = `知乎热议 · ${safe.length} 条`;
  const frag = document.createDocumentFragment();
  for (const row of safe) {
    const li = document.createElement('li');
    li.className = 'ecosystem-hot-module__item';
    const link = document.createElement('a');
    link.className = 'ecosystem-hot-module__link';
    link.href = typeof row.url === 'string' && row.url ? row.url : '#';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const rank = document.createElement('span');
    rank.className = 'ecosystem-hot-module__rank';
    rank.textContent = `#${Number.isFinite(row.rank) ? row.rank : '?'}`;
    const title = document.createElement('span');
    title.className = 'ecosystem-hot-module__item-title';
    title.textContent = typeof row.title === 'string' ? row.title : '';
    link.appendChild(rank);
    link.appendChild(title);
    li.appendChild(link);
    frag.appendChild(li);
  }
  els.list.replaceChildren(frag);
}

async function fetchHot(category, limit, signal) {
  // Build the URL defensively. Public endpoint lives under /v1/ —
  // not the admin / dev toolspace.
  const url = `${HOT_ENDPOINT}?category=${encodeURIComponent(category)}&limit=${encodeURIComponent(String(limit))}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal,
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`hot endpoint returned HTTP ${res.status}`);
  }
  const json = await res.json();
  if (!json || typeof json !== 'object' || !Array.isArray(json.hot)) {
    throw new Error('hot payload missing hot[] array');
  }
  return json;
}

async function refresh(els) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const payload = await fetchHot(DEFAULT_CATEGORY, DEFAULT_LIMIT, ctrl.signal);
      renderRows(els, payload.hot);
    } catch (err) {
      // Graceful degradation — any upstream failure paints the
      // fallback DOM. The picker / player / ending flow is untouched.
      renderFallback(els);
    } finally {
      clearTimeout(timeoutId);
    }
    return;
  }
  try {
    const payload = await fetchHot(DEFAULT_CATEGORY, DEFAULT_LIMIT, undefined);
    renderRows(els, payload.hot);
  } catch (err) {
    renderFallback(els);
  }
}

function init() {
  const els = {
    list: pickElement('ecosystem-hot-list'),
    empty: pickElement('ecosystem-hot-empty'),
    sub: pickElement('ecosystem-hot-sub'),
  };
  if (!els.list || !els.empty || !els.sub) return;
  // Mark the list busy until the first response (success OR failure)
  // lands. The aria-busy flips to false inside renderRows /
  // renderFallback so a screen reader never gets stuck on busy.
  els.list.setAttribute('aria-busy', 'true');
  refresh(els);
}

// Boot once the DOM is ready. Module scripts are deferred by default
// but we still guard against the document being unavailable at script
// evaluation time (defensive — the script tag is at the bottom of the
// body in index.html so DOMContentLoaded has already fired by the
// time this module runs).
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}
