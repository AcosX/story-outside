// tests/_player-dom.mjs — minimal DOM polyfill + player harness.
//
// Runs public/scripts/player.js in a jsdom-free Node environment so the
// state machine can be exercised end-to-end against the live HTTP
// server. The polyfill only implements the DOM surface the player uses
// (querySelector, click/addEventListener, dataset, fetch, setTimeout).
// Anything else throws clearly so we know we hit an unsupported path.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAYER_PATH = resolve(__dirname, '..', 'public', 'scripts', 'player.js');
const ENDING_PAGE_PATH = resolve(__dirname, '..', 'public', 'scripts', 'endingPage.js');
const SOCIAL_PANEL_PATH = resolve(__dirname, '..', 'public', 'scripts', 'socialPanel.js');
const SESSION_CONTEXT_PATH = resolve(__dirname, '..', 'public', 'scripts', 'sessionContext.js');

export async function loadFixtureScript() {
  return readFile(PLAYER_PATH, 'utf-8');
}

let endingPageSourceCache = null;
async function readEndingPageSource() {
  if (!endingPageSourceCache) endingPageSourceCache = readFile(ENDING_PAGE_PATH, 'utf-8');
  return endingPageSourceCache;
}

let socialPanelSourceCache = null;
async function readSocialPanelSource() {
  if (!socialPanelSourceCache) socialPanelSourceCache = readFile(SOCIAL_PANEL_PATH, 'utf-8');
  return socialPanelSourceCache;
}

let sessionContextSourceCache = null;
async function readSessionContextSource() {
  if (!sessionContextSourceCache) sessionContextSourceCache = readFile(SESSION_CONTEXT_PATH, 'utf-8');
  return sessionContextSourceCache;
}

// The player lazy-loads the ending page via `import('/scripts/endingPage.js')`.
// Inside the harness (player source evaluated via `new Function`) a real
// dynamic import cannot resolve that URL, so the source is rewritten to
// call this hook instead, which evaluates the REAL endingPage.js source
// (exports stripped) and returns its module namespace. This keeps the
// lazy-import wiring — and everything downstream of it (mount on finish,
// the reload recovery mount, the ?s=ending deep link) — under real test
// coverage.
const PLAYER_ENDING_IMPORT = "import('/scripts/endingPage.js')";
const PLAYER_ENDING_HOOK = 'globalThis.__HARNESS_IMPORT_ENDING_PAGE__()';

async function importEndingPageForHarness() {
  const source = await readEndingPageSource();
  // Strip both `export {...}` and `export default {...}` so the
  // source can be evaluated inside `new Function`.
  const stripped = source
    .replace(/export\s*\{[^}]*\}\s*;?\s*$/m, '')
    .replace(/export\s+default\s+\{[^}]*\}\s*;?\s*$/m, '');
  const fn = new Function(`${stripped}\nreturn { mount, teardown, STATE };`);
  return fn();
}

// The player lazy-loads the social panel via `import('/scripts/socialPanel.js')`
// (ClickUp 16.3 P1 v1-3). The harness rewrites that dynamic import to a
// hook that evaluates the REAL socialPanel.js source — the panel mounts
// its own DOM and the player's lazy-import wiring stays under test.
const PLAYER_SOCIAL_PANEL_IMPORT = "import('/scripts/socialPanel.js')";
const PLAYER_SOCIAL_PANEL_HOOK = 'globalThis.__HARNESS_IMPORT_SOCIAL_PANEL__()';

async function importSocialPanelForHarness() {
  const source = await readSocialPanelSource();
  const patched = applyHarnessPatches(source);
  // Strip both `export {...}` and `export default {...}` so the
  // source can be evaluated inside `new Function` (which has no
  // module-level export support). The named exports we want are
  // captured in the return statement below.
  const stripped = patched
    .replace(/export\s*\{[^}]*\}\s*;?\s*$/m, '')
    .replace(/export\s+default\s+\{[^}]*\}\s*;?\s*$/m, '');
  const fn = new Function(`${stripped}\nreturn { mount, refreshFeed, refreshShareButton, refreshAuthStatus, currentShareTargetUuid, handleCreateSession, maybeOfferCreateSessionButton };`);
  return fn();
}

async function importSessionContextForHarness() {
  const source = await readSessionContextSource();
  const patched = applyHarnessPatches(source);
  const stripped = patched
    .replace(/export\s*\{[^}]*\}\s*;?\s*$/m, '')
    .replace(/export\s+default\s+\{[^}]*\}\s*;?\s*$/m, '');
  const fn = new Function(`${stripped}\nreturn { getCurrentShareTargetUuid, setCurrentShareTargetUuid, clearCurrentShareTargetUuid, getLastSessionStorageKey };`);
  return fn();
}

function applyHarnessPatches(source) {
  let patched = source;
  // ClickUp 16.3 P1 v1-4: the player AND the social panel both
  // lazy-import the session-context helper. Rewrite that import to
  // a harness hook that evaluates the REAL sessionContext.js source
  // — same pattern as the panel and ending-page hooks above.
  const PLAYER_SESSION_CONTEXT_IMPORT = "import('/scripts/sessionContext.js')";
  const PLAYER_SESSION_CONTEXT_HOOK = 'globalThis.__HARNESS_IMPORT_SESSION_CONTEXT__()';
  if (patched.includes(PLAYER_SESSION_CONTEXT_IMPORT)) {
    patched = patched.replaceAll(PLAYER_SESSION_CONTEXT_IMPORT, PLAYER_SESSION_CONTEXT_HOOK);
  }
  // The player dynamic import of /scripts/endingPage.js only appears
  // in player.js; tolerate its absence for the panel / sessionContext
  // sources.
  if (patched.includes(PLAYER_ENDING_IMPORT)) {
    patched = patched.replaceAll(PLAYER_ENDING_IMPORT, PLAYER_ENDING_HOOK);
  }
  // The social panel import is OPTIONAL: it was added by ClickUp 16.3
  // P1 v1-3. Older player.js source (before the panel wiring) does
  // not include the import, so we tolerate that.
  if (patched.includes(PLAYER_SOCIAL_PANEL_IMPORT)) {
    patched = patched.replaceAll(PLAYER_SOCIAL_PANEL_IMPORT, PLAYER_SOCIAL_PANEL_HOOK);
  }
  return patched;
}

// --- Minimal DOM polyfill ---

class Element {
  closest(sel) {
    // Walk up from this element and return the first ancestor (or self)
    // that matches the LAST selector segment while also having an
    // ancestor (possibly itself) that matches every preceding segment.
    const parts = sel.split(' ');
    const last = parts[parts.length - 1];
    const prev = parts.slice(0, -1).join(' ');
    let cur = this;
    while (cur) {
      if (matchTag(cur, last)) {
        if (!prev) return cur;
        // Check whether some ancestor of `cur` matches `prev`. If yes,
        // this element is a valid descendant match for the whole selector.
        let probe = cur.parent;
        while (probe) {
          if (matchTag(probe, prev)) return cur;
          probe = probe.parent;
        }
      }
      cur = cur.parent;
    }
    return null;
  }
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    // dataset is a Proxy that mirrors kebab-case ↔ camelCase so that
    // `el.dataset.storyId = 'x'` and `[data-story-id="x"]` selectors
    // agree (in real browsers the DOM does this conversion for us).
    this.dataset = makeDatasetProxy({}, this);
    this.style = {};
    this.attrs = {};
    Object.defineProperty(this, 'className', {
      get() { return Array.from(this.classList._set).join(' '); },
      set(value) {
        this.classList._set.clear();
        for (const token of String(value || '').split(/\s+/).filter(Boolean)) {
          this.classList._set.add(token);
        }
      },
      configurable: true,
    });
    this.classList = {
      _set: new Set(),
      add(...names) { for (const n of names) this._set.add(n); },
      remove(...names) { for (const n of names) this._set.delete(n); },
      toggle(name, on) {
        if (on === true) this._set.add(name);
        else if (on === false) this._set.delete(name);
        else if (this._set.has(name)) this._set.delete(name);
        else this._set.add(name);
      },
      contains(name) { return this._set.has(name); },
    };
    this.eventListeners = new Map();
    this.hidden = false;
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.title = '';
    this.id = '';
    this.type = '';
  }
  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (!this.parent) return;
    const idx = this.parent.children.indexOf(this);
    if (idx >= 0) this.parent.children.splice(idx, 1);
    this.parent = null;
  }
  setAttribute(name, value) { this.attrs[name] = value; }
  getAttribute(name) { return this.attrs[name]; }
  removeAttribute(name) { delete this.attrs[name]; }
  addEventListener(type, fn) {
    if (!this.eventListeners.has(type)) this.eventListeners.set(type, []);
    this.eventListeners.get(type).push(fn);
  }
  dispatch(type, event = {}) {
    // Bubble the event through ancestors so document-level delegated
    // listeners (used by the player for role chips) see the original
    // target via `e.target`.
    let node = this;
    const target = this;
    let stopped = false;
    while (node) {
      const list = node.eventListeners ? (node.eventListeners.get(type) || []) : [];
      const enriched = { type, ...event, target, currentTarget: node };
      for (const fn of list) fn(enriched);
      if (enriched._stopped) { stopped = true; break; }
      node = node.parent;
    }
    // Also notify document-level listeners at the very end so the
    // delegated role-chip handler picks up the click.
    if (!stopped && document.eventListeners && document.eventListeners.get(type)) {
      const list = document.eventListeners.get(type) || [];
      const enriched = { type, ...event, target, currentTarget: document };
      for (const fn of list) fn(enriched);
    }
  }
  click() { this.dispatch('click', { type: 'click' }); }
  focus() { document.activeElement = this; }
  querySelector(sel) { return querySelector(this, sel); }
  querySelectorAll(sel) { return querySelectorAll(this, sel); }
}

function matchTag(el, sel) {
  // Compound selectors like `.chip[data-story-id="cafe-rain"]` need to
  // be split into per-constraint checks. We split the selector into
  // pieces whenever depth (square-bracket nesting) is zero and we hit
  // `.`, `#`, or `[`.
  const parts = [];
  let buf = '';
  let depth = 0;
  for (const ch of sel) {
    if (depth === 0 && (ch === '.' || ch === '#' || ch === '[')) {
      if (buf) { parts.push(buf); buf = ''; }
    }
    buf += ch;
    if (ch === '[') depth += 1;
    else if (ch === ']') depth -= 1;
    // When a bracket pair closes, push the accumulated buf as a part
    // so we don't leak it into the next selector segment.
    if (depth === 0 && ch === ']') { parts.push(buf); buf = ''; }
  }
  if (buf) parts.push(buf);
  for (const part of parts) {
    if (!matchConstraint(el, part)) return false;
  }
  return true;
}

function matchConstraint(el, sel) {
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
  if (sel.startsWith('[') && sel.endsWith(']')) {
    const inner = sel.slice(1, -1);
    const eq = inner.indexOf('=');
    const strip = (k) => (k.startsWith('data-') ? k.slice(5) : k);
    if (eq < 0) {
      const k = strip(inner);
      return el.dataset[k] !== undefined
        || el.dataset[camelCase(k)] !== undefined
        || el.attrs[inner] !== undefined
        || el.attrs[k] !== undefined;
    }
    const k = strip(inner.slice(0, eq));
    const v = inner.slice(eq + 1).replace(/^["']|["']$/g, '');
    return el.dataset[k] === v
      || el.dataset[camelCase(k)] === v
      || el.attrs[inner.slice(0, eq)] === v
      || el.attrs[k] === v;
  }
  return el.tagName === sel.toUpperCase();
}

function camelCase(kebab) {
  return kebab.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function kebabCase(camel) {
  return camel.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function makeDatasetProxy(target, element) {
  return new Proxy(target, {
    set(obj, prop, value) {
      obj[prop] = value;
      // Mirror to the kebab-case form (and back) so attribute selectors
      // and DOM API both see the same dataset.
      if (typeof prop === 'string') {
        const kebab = kebabCase(prop);
        if (kebab !== prop) obj[kebab] = value;
        const camel = camelCase(prop);
        if (camel !== prop) obj[camel] = value;
      }
      return true;
    },
    get(obj, prop) {
      if (typeof prop === 'string') {
        if (prop in obj) return obj[prop];
        // Try kebab <-> camel for browsers' name conversion.
        const alt = prop.includes('-') ? camelCase(prop) : kebabCase(prop);
        if (alt !== prop && alt in obj) return obj[alt];
      }
      return obj[prop];
    },
  });
}

function querySelector(root, sel) {
  const parts = sel.split(' ');
  const first = parts[0];
  const rest = parts.slice(1).join(' ');
  for (const child of root.children) {
    if (matchTag(child, first)) {
      if (!rest) return child;
      // Search the entire subtree of `child` for the rest.
      const sub = querySelector(child, rest);
      if (sub) return sub;
    }
    const sub = querySelector(child, sel);
    if (sub) return sub;
  }
  return null;
}

function querySelectorAll(root, sel) {
  const out = [];
  const parts = sel.split(' ');
  const first = parts[0];
  const rest = parts.slice(1).join(' ');
  function walk(node) {
    for (const child of node.children) {
      if (matchTag(child, first)) {
        if (!rest) { out.push(child); }
        else {
          // Find every descendant of `child` that matches the rest.
          const inner = [];
          (function deep(n) {
            for (const c of n.children) {
              if (matchTag(c, rest)) inner.push(c);
              deep(c);
            }
          })(child);
          for (const m of inner) out.push(m);
        }
      }
      walk(child);
    }
  }
  walk(root);
  return out;
}

const document = {
  activeElement: null,
  body: new Element('body'),
  head: new Element('head'),
  createElement(tag) { return new Element(tag); },
  // getElementById: ClickUp 16.3 P1 v1-3 — the socialPanel module
  // looks up its own host / status / feed elements by id. We map an
  // id selector onto the existing querySelector path so the panel
  // can mount under the harness without an extra polyfill surface.
  getElementById(id) {
    if (id === 'body') return document.body;
    if (id === 'head') return document.head;
    return querySelector(document.body, `#${id}`);
  },
  querySelector(sel) {
    if (sel === 'body') return document.body;
    if (sel === 'head') return document.head;
    return querySelector(document.body, sel);
  },
  querySelectorAll(sel) { return querySelectorAll(document.body, sel); },
  addEventListener(type, fn) {
    if (!document.eventListeners) document.eventListeners = new Map();
    if (!document.eventListeners.has(type)) document.eventListeners.set(type, []);
    document.eventListeners.get(type).push(fn);
  },
  dispatch(type, event = {}) {
    const list = (document.eventListeners || new Map()).get(type) || [];
    // The harness handles dispatching on elements via Element.dispatch;
    // this path is only used for explicit document.dispatch calls.
    const enriched = { type, ...event, target: this, currentTarget: this };
    for (const fn of list) fn(enriched);
  },
};

// Make the harness Element class behave like a browser HTMLElement for
// `instanceof` checks inside player.js. The script guards on
// `t instanceof HTMLElement` to skip non-element event targets; without
// this class the instanceof check would throw ReferenceError under
// Node, blocking every delegated click handler.
class HTMLElement {}
Object.setPrototypeOf(Element.prototype, HTMLElement.prototype);
// Also expose HTMLElement on the global object so the player.js source
// (loaded via `new Function(wrapped)` which evaluates in a fresh scope)
// can resolve `t instanceof HTMLElement` without a ReferenceError.
if (!globalThis.HTMLElement) globalThis.HTMLElement = HTMLElement;

// --- Player DOM harness ---

// Save the real Node fetch before overriding globalThis.fetch so the
// stub can call back into the real implementation without recursing.
const nativeFetch = globalThis.fetch;
if (typeof nativeFetch !== 'function') {
  throw new Error('player harness requires Node global fetch (Node 18+)');
}

export function createPlayerDom({ baseUrl, viewport = null, stepDelayMs = null, startScreen = null } = {}) {
  // Build the DOM tree the player.js expects. Mirrors public/index.html.
  function buildDom() {
    // The document/body/head elements are shared by every harness
    // instance in the process. Assigning innerHTML only stores a string
    // in the polyfill — it does NOT clear the children array — so stale
    // subtrees from earlier harnesses would shadow every
    // querySelector(All) first-match. Detach them explicitly.
    document.body.children.length = 0;
    document.head.children.length = 0;
    document.body.innerHTML = '';
    document.body.appendChild(new Element('a')); // skip-link
    const topbar = new Element('header'); document.body.appendChild(topbar);
    topbar.classList.add('topbar'); topbar.attrs['aria-label'] = '页头';
    const backBtn = new Element('button'); topbar.appendChild(backBtn); backBtn.id = 'back-btn'; backBtn.classList.add('icon-btn'); backBtn.attrs.type = 'button'; backBtn.attrs['aria-label'] = '返回'; backBtn.attrs.title = '返回';
    const meta = new Element('div'); topbar.appendChild(meta); meta.classList.add('topbar-meta');
    const storyName = new Element('div'); meta.appendChild(storyName); storyName.id = 'story-name'; storyName.classList.add('story-name');
    const roleName = new Element('div'); meta.appendChild(roleName); roleName.id = 'role-name'; roleName.classList.add('role-name');
    const shareBtn = new Element('button'); topbar.appendChild(shareBtn); shareBtn.id = 'share-btn'; shareBtn.classList.add('icon-btn'); shareBtn.attrs.type = 'button'; shareBtn.attrs['aria-label'] = '分享'; shareBtn.attrs.title = '分享';
    const main = new Element('main'); document.body.appendChild(main); main.id = 'player-main'; main.classList.add('player-main');
    const pickerScreen = new Element('section'); main.appendChild(pickerScreen); pickerScreen.id = 'screen-picker'; pickerScreen.classList.add('screen', 'screen-picker', 'active'); pickerScreen.dataset.screen = 'picker';
    const pickerShell = new Element('div'); pickerScreen.appendChild(pickerShell); pickerShell.classList.add('picker-shell');
    const pickerHead = new Element('header'); pickerShell.appendChild(pickerHead); pickerHead.classList.add('picker-head');
    const pickerTitle = new Element('h1'); pickerHead.appendChild(pickerTitle); pickerTitle.id = 'picker-title'; pickerTitle.classList.add('picker-title'); pickerTitle.textContent = '如果当时，由你来选';
    const pickerSub = new Element('p'); pickerHead.appendChild(pickerSub); pickerSub.id = 'picker-sub'; pickerSub.classList.add('picker-sub');
    const storiesBlock = new Element('section'); pickerShell.appendChild(storiesBlock); storiesBlock.classList.add('picker-block');
    const storiesLabel = new Element('h2'); storiesBlock.appendChild(storiesLabel); storiesLabel.id = 'picker-stories-label'; storiesLabel.classList.add('picker-label');
    const storyList = new Element('ul'); storiesBlock.appendChild(storyList); storyList.id = 'story-list'; storyList.attrs['aria-busy'] = 'true';
    const roleBlock = new Element('section'); pickerShell.appendChild(roleBlock); roleBlock.id = 'role-block'; roleBlock.classList.add('picker-block'); roleBlock.hidden = true;
    const rolesLabel = new Element('h2'); roleBlock.appendChild(rolesLabel); rolesLabel.id = 'picker-roles-label'; rolesLabel.classList.add('picker-label');
    const roleList = new Element('ul'); roleBlock.appendChild(roleList); roleList.id = 'role-list';
    const pickerStatus = new Element('p'); pickerShell.appendChild(pickerStatus); pickerStatus.id = 'picker-status'; pickerStatus.classList.add('picker-status');

    const playerScreen = new Element('section'); main.appendChild(playerScreen); playerScreen.id = 'screen-player'; playerScreen.classList.add('screen', 'screen-player'); playerScreen.dataset.screen = 'player'; playerScreen.hidden = true;
    const playerShell = new Element('div'); playerScreen.appendChild(playerShell); playerShell.classList.add('player-shell');
    const playerHead = new Element('header'); playerShell.appendChild(playerHead); playerHead.classList.add('player-head');
    const playerStatus = new Element('div'); playerHead.appendChild(playerStatus); playerStatus.classList.add('player-status');
    const statusLabel = new Element('span'); playerStatus.appendChild(statusLabel); statusLabel.id = 'status-label'; statusLabel.classList.add('status-label');
    const statusBar = new Element('span'); playerStatus.appendChild(statusBar); statusBar.classList.add('status-bar');
    const statusBarFill = new Element('span'); statusBar.appendChild(statusBarFill); statusBarFill.id = 'status-bar-fill'; statusBarFill.classList.add('status-bar-fill');
    const storyLog = new Element('ol'); playerShell.appendChild(storyLog); storyLog.id = 'story-log'; storyLog.classList.add('story-log'); storyLog.attrs['aria-label'] = '故事正文';
    const controls = new Element('div'); playerShell.appendChild(controls); controls.classList.add('player-controls');
    const pauseBtn = new Element('button'); controls.appendChild(pauseBtn); pauseBtn.id = 'pause-btn'; pauseBtn.classList.add('btn'); pauseBtn.attrs.type = 'button'; pauseBtn.attrs['aria-label'] = '暂停自动播放';
    const pauseBtnLabel = new Element('span'); pauseBtn.appendChild(pauseBtnLabel); pauseBtnLabel.id = 'pause-btn-label'; pauseBtnLabel.textContent = '暂停';
    const skipBtn = new Element('button'); controls.appendChild(skipBtn); skipBtn.id = 'skip-btn'; skipBtn.classList.add('btn'); skipBtn.attrs.type = 'button'; skipBtn.attrs['aria-label'] = '下一句'; skipBtn.hidden = true;
    const playerHelp = new Element('span'); controls.appendChild(playerHelp); playerHelp.id = 'player-help'; playerHelp.classList.add('player-help');
    const inputForm = new Element('form'); playerShell.appendChild(inputForm); inputForm.id = 'player-input-form'; inputForm.classList.add('player-input'); inputForm.hidden = true;
    const inputField = new Element('input'); inputForm.appendChild(inputField); inputField.id = 'player-input'; inputField.attrs.type = 'text'; inputField.attrs.name = 'text'; inputField.attrs.placeholder = '说一句...';
    const inputBtn = new Element('button'); inputForm.appendChild(inputBtn); inputBtn.id = 'player-input-btn'; inputBtn.classList.add('btn', 'btn-primary'); inputBtn.attrs.type = 'submit';
    const choices = new Element('section'); playerShell.appendChild(choices); choices.id = 'player-choices'; choices.classList.add('player-choices'); choices.hidden = true;
    const ending = new Element('section'); playerShell.appendChild(ending); ending.id = 'player-ending'; ending.classList.add('player-ending'); ending.hidden = true;
    const toast = new Element('aside'); document.body.appendChild(toast); toast.id = 'toast'; toast.classList.add('toast'); toast.hidden = true;
    const footer = new Element('footer'); document.body.appendChild(footer); footer.classList.add('bottombar');
  }

  function bindTestApi() {
    const api = {
      bootstrap: async () => {
        // Re-run the player's bootstrap() so the harness can observe the
        // initial state machine values. The wrapped player.js already
        // invoked bootstrap() at load time, so this second call resets
        // status to 'loading' before re-entering 'picker' once stories
        // finish loading. We expose this so test assertions can rely on
        // a deterministic post-bootstrap snapshot.
        if (typeof globalThis.__PLAYER_BOOTSTRAP__ === 'function') {
          await globalThis.__PLAYER_BOOTSTRAP__();
        }
      },
      snapshot: () => {
        const playerState = globalThis.__PLAYER_STATE__ || null;
        return {
          status: playerState ? playerState.status : 'idle',
          activeScreen: (() => {
            const sp = document.querySelector('#screen-picker');
            const pp = document.querySelector('#screen-player');
            const se = document.querySelector('#screen-ending');
            if (se && !se.hidden) return 'ending';
            if (sp && !sp.hidden) return 'picker';
            if (pp && !pp.hidden) return 'player';
            return null;
          })(),
          openingCursor: playerState ? playerState.openingCursor : 0,
          canonicalNarrativeCount: playerState ? playerState.canonicalNarrativeCount : 0,
          historyLines: playerState ? (playerState.canonicalHistory || []).length : 0,
          finished: playerState ? !!playerState.finished : false,
          hasQueuedToolCall: playerState ? !!playerState.queuedToolCall : false,
          inputInFlight: playerState ? !!playerState.inputInFlight : false,
        };
      },
      simulatePickerSelect: async ({ storyId, roleId }) => {
        const storyChip = document.querySelector(`#story-list .chip[data-story-id="${storyId}"]`);
        if (storyChip) storyChip.dispatch('click');
        await new Promise((r) => setTimeout(r, 100));
        const roleChip = document.querySelector(`#role-list .chip[data-role-id="${roleId}"]`);
        if (roleChip) roleChip.dispatch('click');
      },
      simulateChoiceClick: async ({ optionIndex }) => {
        const btn = document.querySelectorAll('#player-choices .choice-btn')[optionIndex || 0];
        if (btn) btn.dispatch('click');
      },
      simulatePause: async () => {
        const btn = document.querySelector('#pause-btn');
        if (btn) btn.dispatch('click');
      },
      simulateResume: async () => {
        const btn = document.querySelector('#pause-btn');
        if (btn) btn.dispatch('click');
      },
      simulateShare: async () => {
        const btn = document.querySelector('#share-btn');
        if (!btn) return { ok: false };
        try {
          btn.dispatch('click');
          await new Promise((r) => setTimeout(r, 100));
          return { ok: true, path: 'fired' };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      },
      progressAudit: async () => {
        const fill = document.querySelector('#status-bar-fill');
        const pendingAttrLines = document.querySelectorAll('#story-log .line[data-pending="true"]').length;
        const pendingClassLines = document.querySelectorAll('#story-log .line.line-pending').length;
        const totalLines = document.querySelectorAll('#story-log .line').length;
        const width = fill ? fill.style.width : null;
        // Parse "12.3%" into 0.123.
        const fraction = (width && width.endsWith('%')) ? Number(width.slice(0, -1)) / 100 : null;
        return { width, fraction, totalLines, pendingAttrLines, pendingClassLines };
      },
      accessibilityAudit: async () => {
        const back = document.querySelector('#back-btn');
        const share = document.querySelector('#share-btn');
        const pause = document.querySelector('#pause-btn');
        const input = document.querySelector('#player-input');
        const status = document.querySelector('#status-label');
        return {
          backAriaLabel: back && back.getAttribute('aria-label'),
          shareAriaLabel: share && share.getAttribute('aria-label'),
          pauseAriaLabel: pause && pause.getAttribute('aria-label'),
          inputAria: input && (input.getAttribute('aria-label') || input.getAttribute('placeholder')),
          statusLive: !!status,
        };
      },
      firstFrameSurface: async () => {
        const title = document.querySelector('#picker-title');
        const chips = document.querySelectorAll('#story-list .chip');
        return { pickerTitle: title?.textContent || '', storyChipCount: chips.length };
      },
      layoutOverflow: async () => {
        // The harness has no layout engine, so "no horizontal overflow"
        // is asserted against a REAL proxy metric derived from the
        // actual rendered content: the widest unbreakable text run on
        // any visible element (CJK glyphs act as break points; runs of
        // latin/digits/punctuation cannot wrap in a browser either).
        // If any such run is wider than the viewport, a real browser
        // would overflow too, so scrollWidth exceeds clientWidth and
        // the assertion can genuinely fail.
        const vp = globalThis.window?.innerWidth || 1280;
        const CJK_PX = 16;    // full-width glyph ≈ 1em at the 16px base font
        const LATIN_PX = 8;   // average half-width advance
        const CHROME_PX = 32; // padding/borders allowance around content
        const CJK = /[\u1100-\u11FF\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFF60\u3000-\u303F]/;
        function widestRunPx(text) {
          let best = 0;
          let run = 0;
          for (const ch of String(text || '')) {
            if (CJK.test(ch)) {
              best = Math.max(best, run, CJK_PX);
              run = 0; // a CJK glyph is a break point (its own 16px run fits)
            } else if (/\s/.test(ch)) {
              best = Math.max(best, run);
              run = 0;
            } else {
              run += LATIN_PX;
            }
          }
          return Math.max(best, run);
        }
        function walk(node) {
          let widest = 0;
          if (node.hidden !== true) {
            // Leaf content is set via textContent; chips/cards via
            // innerHTML — measure both (tags stripped).
            const content = `${node.textContent || ''} ${String(node.innerHTML || '').replace(/<[^>]*>/g, ' ')}`;
            widest = Math.max(widest, widestRunPx(content));
            for (const child of node.children || []) {
              widest = Math.max(widest, walk(child));
            }
          }
          return widest;
        }
        const widestRun = Math.ceil(walk(document.body));
        const scrollWidth = Math.max(vp, widestRun + CHROME_PX);
        return { scrollWidth, clientWidth: vp, widestRunPx: widestRun, viewportWidth: vp };
      },
    };
    globalThis.__PLAYER_TEST_API__ = api;
  }

  async function fetchStub(url, options = {}) {
    // Capture the real Node fetch before overriding globalThis.fetch so
    // the stub does not recurse into itself.
    const realFetch = nativeFetch;
    // Resolve relative URLs against the harness baseUrl. Player code
    // passes paths like '/api/stories' that browsers would resolve
    // against window.location; Node's built-in fetch rejects relative
    // URLs outright.
    const absoluteUrl = /^https?:/i.test(url) ? url : new URL(url, baseUrl).href;
    const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
    const res = await realFetch(absoluteUrl, { ...options, headers });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return {
      ok: res.ok,
      status: res.status,
      async json() { return data; },
    };
  }

  // Install globals the player.js expects. Node 20+ defines `crypto`
  // as a non-writable global, so we only set the keys we need.
  const setupGlobals = () => {
    globalThis.document = document;
    // Fresh sessionStorage per harness instance — each createPlayerDom()
    // stands for a fresh tab, so the player's persisted last-session
    // context never leaks across harnesses.
    const sessionStore = new Map();
    globalThis.sessionStorage = {
      getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
      setItem: (k, v) => { sessionStore.set(String(k), String(v)); },
      removeItem: (k) => { sessionStore.delete(k); },
      clear: () => { sessionStore.clear(); },
    };
    // localStorage mirrors sessionStorage so the helper's fallback
    // path sees a consistent surface. Tests can clear both via the
    // `__HARNESS_RESET_SESSION_CONTEXT__` hook.
    const localStore = new Map();
    globalThis.localStorage = {
      getItem: (k) => (localStore.has(k) ? localStore.get(k) : null),
      setItem: (k, v) => { localStore.set(String(k), String(v)); },
      removeItem: (k) => { localStore.delete(k); },
      clear: () => { localStore.clear(); },
    };
    // Test-only escape hatch: wipe both stores and the helper's
    // in-memory cache so the harness can model a fresh tab with no
    // remembered session.
    globalThis.__HARNESS_RESET_SESSION_CONTEXT__ = () => {
      sessionStore.clear();
      localStore.clear();
    };
    // The viewport option lets a test simulate mobile widths by
    // overriding the inner clientWidth used by `layoutOverflow`.
    const search = startScreen ? `?s=${startScreen}` : '';
    // ClickUp 16.3 P1 v1-4: give the harness window addEventListener /
    // dispatchEvent / CustomEvent support so the social panel can
    // subscribe to the session-context helper's `session:changed`
    // CustomEvent. Without this surface the harness would silently
    // drop every event and the listener never fires.
    const windowListeners = new Map();
    function windowAddEventListener(type, fn) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(fn);
    }
    function windowRemoveEventListener(type, fn) {
      const list = windowListeners.get(type);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    }
    function windowDispatchEvent(evt) {
      const list = windowListeners.get(evt && evt.type) || [];
      for (const fn of list) {
        try { fn(evt); } catch { /* ignore handler failures */ }
      }
      return true;
    }
    function WindowCustomEvent(type, init) {
      this.type = type;
      this.detail = init && init.detail;
    }
    globalThis.window = {
      location: { href: `${baseUrl}/${search}`, search },
      scrollTo: () => {},
      innerWidth: viewport?.width || 1280,
      innerHeight: viewport?.height || 800,
      addEventListener: windowAddEventListener,
      removeEventListener: windowRemoveEventListener,
      dispatchEvent: windowDispatchEvent,
      CustomEvent: WindowCustomEvent,
    };
    globalThis.fetch = fetchStub;
    // Lazy ending-page import hook (see importEndingPageForHarness).
    globalThis.__HARNESS_IMPORT_ENDING_PAGE__ = importEndingPageForHarness;
    // ClickUp 16.3 P1 v1-3: same hook pattern for the social panel.
    globalThis.__HARNESS_IMPORT_SOCIAL_PANEL__ = importSocialPanelForHarness;
    // ClickUp 16.3 P1 v1-4: same hook pattern for the session-context
    // helper (loaded by player.js AND by socialPanel.js).
    globalThis.__HARNESS_IMPORT_SESSION_CONTEXT__ = importSessionContextForHarness;
    if (!globalThis.crypto) globalThis.crypto = {};
    if (typeof globalThis.crypto.randomUUID !== 'function') {
      globalThis.crypto.randomUUID = () => '00000000-0000-4000-8000-000000000099';
    }
    if (!globalThis.navigator) globalThis.navigator = {};
    if (!globalThis.history) globalThis.history = { replaceState: () => {} };
    if (typeof globalThis.requestAnimationFrame !== 'function') {
      globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
    }
  };

  async function ready() {
    setupGlobals();
    buildDom();
    // Each harness instance models a fresh page load: drop any
    // document-level listeners registered by earlier harnesses in this
    // process (otherwise the delegated role-chip handler fires once per
    // harness and races duplicate session creations against each other).
    if (document.eventListeners) document.eventListeners.clear();
    bindTestApi();
    let source = await loadFixtureScript();
    if (stepDelayMs != null) {
      // Optionally slow the autoplay cadence so tests can reliably
      // land inside the deferred tool-call window (STEP_DELAY_MS / 2).
      const pattern = 'const STEP_DELAY_MS = 1100;';
      if (!source.includes(pattern)) {
        throw new Error('player harness: STEP_DELAY_MS declaration not found in player.js source');
      }
      source = source.replace(pattern, `const STEP_DELAY_MS = ${Number(stepDelayMs)};`);
    }
    source = applyHarnessPatches(source);
    // Wrap the player.js source so its top-level `bootstrap()` call is
    // captured on globalThis alongside the state singleton and the
    // internal functions the suites need to drive directly. We use
    // Function() with an explicit body to keep the script in the
    // module's lexical scope.
    const wrapped = `${source}\n`
      + 'globalThis.__PLAYER_STATE__ = state; globalThis.__PLAYER_BOOTSTRAP__ = bootstrap; '
      + 'globalThis.__PLAYER_INTERNALS__ = { recoverAndStart, scheduleNextStep, runStep, startNextBatch, surfaceToolCall, sendPlayerInput, sendPlayerInputChoice };';
    const fn = new Function(wrapped);
    // Do NOT swallow execution errors: if player.js does not even run,
    // every downstream assertion would pass vacuously. Surface the
    // error (recorded + ready() rejects) so the calling suite fails
    // loudly and only a genuinely executing player passes ready().
    try {
      fn();
    } catch (err) {
      const loadError = new Error(`player.js failed to execute in the harness: ${err && err.message}`);
      loadError.cause = err;
      globalThis.__PLAYER_LOAD_ERROR__ = loadError;
      throw loadError;
    }
    globalThis.__PLAYER_LOAD_ERROR__ = null;
    // Wait for the picker to populate.
    await new Promise((r) => setTimeout(r, 200));
  }

  async function call(method, ...args) {
    const api = globalThis.__PLAYER_TEST_API__;
    if (!api) throw new Error('player test api not bound');
    const fn = api[method];
    if (!fn) throw new Error(`unknown test method ${method}`);
    return fn(...args);
  }

  async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 200 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await predicate()) return true;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error('waitFor timed out');
  }

  function snapshot() {
    const api = globalThis.__PLAYER_TEST_API__;
    return api ? api.snapshot() : {};
  }

  return { ready, call, waitFor, snapshot };
}
