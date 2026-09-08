// tests/clickup16-4-p1-v1-7-playerIdentity.test.mjs — ClickUp 16.4 P1.v1-7
// player-bootstrap → identity → hot regression (2026-09-07).
//
// What this test guards (owner-supervised inspection + ChatGPT
// independent review at 2026-09-07 10:18):
//
//   P1.v1-7-1. `public/scripts/player.js`'s `bootstrapSession` calls
//              `STORY_OUTSIDE_IDENTITY_API.setActiveIdentity({ story_uuid,
//              story_version_uuid, community_profile_version })` exactly
//              once on the success path with the canonical triple
//              returned by POST /api/sessions (no fabricated fields,
//              no fallback strings). The literal qualified call
//              `STORY_OUTSIDE_IDENTITY_API.setActiveIdentity` MUST
//              appear in the player source (grep guard).
//
//   P1.v1-7-2. End-to-end regression: a fresh tab picks a story and
//              starts a session. The bootstrap response publishes
//              the canonical triple via the producer (identity.js),
//              which writes `window.STORY_OUTSIDE_IDENTITY` and
//              fires `story:identity-changed` on `document`. The
//              hot module (homeHotModule.js) listener catches the
//              event and re-fetches /v1/ecosystem/hot WITH the three
//              identity query fields attached — never the plain
//              fallback.
//
//   P1.v1-7-3. `endingPage.publishEndingIdentity` STILL calls
//              `STORY_OUTSIDE_IDENTITY_API.setActiveIdentity` after a
//              player bootstrap; the producer is idempotent
//              (last-write-wins), so the bootstrap-publish + ending
//              republish sequence resolves to the ending identity
//              (the last write). The producer never throws and
//              always fires exactly one event per accepted call.
//
// We deliberately load the REAL identity.js + player.js +
// homeHotModule.js source files (no shim re-implementations) so any
// regression in the wire shape — a renamed API key, a renamed event,
// a dropped query field — fails loudly. The DOM polyfill below is
// intentionally minimal: just enough for the three browser scripts
// to evaluate and run the bootstrap → event → fetch chain.

import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { server, storyFixtures } from '../src/server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const IDENTITY_PATH = resolve(repoRoot, 'public/scripts/identity.js');
const PLAYER_PATH = resolve(repoRoot, 'public/scripts/player.js');
const HOME_HOT_PATH = resolve(repoRoot, 'public/scripts/homeHotModule.js');

let testIdx = 0;

async function check(label, fn) {
  testIdx += 1;
  try {
    await fn();
    // eslint-disable-next-line no-console
    console.log(`  ok  #${testIdx.toString().padStart(2, ' ')} ${label}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`FAIL  #${testIdx.toString().padStart(2, ' ')} ${label}`);
    // eslint-disable-next-line no-console
    console.error(`        ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
}

// ----------------------------------------------------------------------
// Minimal DOM polyfill — enough for identity.js + player.js +
// homeHotModule.js to evaluate and exercise the identity pipeline.
// ----------------------------------------------------------------------

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.eventListeners = new Map();
    this.style = {};
    this.classList = {
      _set: new Set(),
      add(...n) { for (const x of n) this._set.add(x); },
      remove(...n) { for (const x of n) this._set.delete(x); },
      contains(n) { return this._set.has(n); },
      toggle(name, on) {
        if (on === true) { this._set.add(name); return true; }
        if (on === false) { this._set.delete(name); return false; }
        if (this._set.has(name)) { this._set.delete(name); return false; }
        this._set.add(name); return true;
      },
    };
    Object.defineProperty(this, 'className', {
      get() { return Array.from(this.classList._set).join(' '); },
      set(v) {
        this.classList._set.clear();
        for (const t of String(v || '').split(/\s+/).filter(Boolean)) this.classList._set.add(t);
      },
      configurable: true,
    });
    this.hidden = false;
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.id = '';
    this.type = '';
    this.dataset = {};
  }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  replaceChildren(...kids) { for (const c of this.children.slice()) c.remove(); for (const k of kids) this.appendChild(k); }
  remove() { if (this.parent) { const i = this.parent.children.indexOf(this); if (i >= 0) this.parent.children.splice(i, 1); this.parent = null; } }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { if (!this.eventListeners.has(t)) this.eventListeners.set(t, []); this.eventListeners.get(t).push(fn); }
  closest(sel) {
    // Walk up the parent chain. For each candidate, check whether it
    // matches the LAST segment AND has a chain of ancestors (possibly
    // empty) matching the prefix segments in order. This mirrors
    // `Element.closest()` semantics for descendant combinators.
    const parts = sel.split(/\s+/).filter(Boolean);
    const last = parts[parts.length - 1];
    let cur = this;
    while (cur) {
      if (matchTag(cur, last) && ancestorsMatchPrefix(cur, parts.slice(0, -1))) {
        return cur;
      }
      cur = cur.parent;
    }
    return null;
  }
  dispatchEvent(ev) {
    let node = this;
    let stopped = false;
    const visited = [];
    while (node) {
      visited.push(node);
      node = node.parent;
    }
    for (const n of visited) {
      const list = n.eventListeners ? (n.eventListeners.get(ev.type) || []) : [];
      if (n === this) { try { ev.currentTarget = n; } catch { /* CustomEvent may forbid setter — fine */ } }
      for (const fn of list) {
        fn(ev);
        if (ev._stopped) { stopped = true; break; }
      }
      if (stopped) break;
    }
    // Notify document-level listeners at the end so delegated handlers
    // (used by the player for role chips) see the click.
    if (!stopped && document.eventListeners && document.eventListeners.get(ev.type)) {
      try { ev.currentTarget = document; } catch { /* fine */ }
      const list = document.eventListeners.get(ev.type) || [];
      for (const fn of list) {
        fn(ev);
        if (ev._stopped) break;
      }
    }
    return !ev.defaultPrevented;
  }
  click() {
    const ev = { type: 'click', target: this, currentTarget: this, _stopped: false, defaultPrevented: false };
    this.dispatchEvent(ev);
  }
  querySelector(sel) { return querySelector(this, sel); }
  querySelectorAll(sel) { return querySelectorAll(this, sel); }
}

function matchTag(el, sel) {
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
  if (sel.startsWith('[') && sel.endsWith(']')) {
    const inner = sel.slice(1, -1);
    const eq = inner.indexOf('=');
    // data-* attribute names map to camelCase dataset keys; allow
    // either form so the polyfill mirrors real browser behaviour.
    const camelize = (k) => k.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const lookup = (k) => {
      if (el.dataset && (k in el.dataset)) return el.dataset[k];
      const ck = camelize(k);
      if (el.dataset && (ck in el.dataset)) return el.dataset[ck];
      if (el.attrs && el.attrs[k] !== undefined) return el.attrs[k];
      return undefined;
    };
    if (eq < 0) return lookup(inner) !== undefined;
    const k = inner.slice(0, eq);
    const v = inner.slice(eq + 1).replace(/^["']|["']$/g, '');
    return lookup(k) === v;
  }
  return el.tagName === sel.toUpperCase();
}

// Used by `Element.closest()`: from the candidate element, walk up
// its parent chain verifying the prefix segments (in order). The
// rightmost prefix segment must match the closest ancestor, the
// leftmost must match an ancestor higher up. Returns true iff the
// chain matches the prefix left-to-right (outermost first).
function ancestorsMatchPrefix(candidate, prefixParts) {
  if (prefixParts.length === 0) return true;
  const chain = [];
  let cur = candidate.parent;
  while (cur) { chain.push(cur); cur = cur.parent; }
  let partIdx = prefixParts.length - 1;
  for (let i = 0; i < chain.length && partIdx >= 0; i += 1) {
    if (matchTag(chain[i], prefixParts[partIdx])) {
      partIdx -= 1;
    }
  }
  return partIdx < 0;
}

function querySelector(root, sel) {
  // Multi-segment selector (e.g. '#story-list .book-card'): match the first
  // segment against children, then recurse into matches with the
  // remaining segments.
  const parts = sel.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    for (const child of root.children) {
      if (matchTag(child, sel)) return child;
      const sub = querySelector(child, sel);
      if (sub) return sub;
    }
    return null;
  }
  const [head, ...rest] = parts;
  const tail = rest.join(' ');
  for (const child of root.children) {
    if (matchTag(child, head)) {
      const sub = querySelector(child, tail);
      if (sub) return sub;
    }
    const sub = querySelector(child, sel);
    if (sub) return sub;
  }
  return null;
}

function querySelectorAll(root, sel) {
  const out = [];
  const parts = sel.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    (function walk(node) {
      for (const child of node.children) {
        if (matchTag(child, sel)) out.push(child);
        walk(child);
      }
    })(root);
    return out;
  }
  const [head, ...rest] = parts;
  const tail = rest.join(' ');
  (function walk(node) {
    for (const child of node.children) {
      if (matchTag(child, head)) {
        for (const m of querySelectorAll(child, tail)) out.push(m);
      }
      walk(child);
    }
  })(root);
  return out;
}

function findById(root, id) {
  if (root.id === id) return root;
  for (const child of root.children) {
    const f = findById(child, id);
    if (f) return f;
  }
  return null;
}

const document = {
  activeElement: null,
  body: new Element('body'),
  head: new Element('head'),
  eventListeners: new Map(),
  createElement(tag) { return new Element(tag); },
  getElementById(id) { return findById(document.body, id); },
  querySelector(sel) { if (sel === 'body') return document.body; if (sel === 'head') return document.head; return querySelector(document.body, sel); }
  ,
  querySelectorAll(sel) { return querySelectorAll(document.body, sel); },
  addEventListener(t, fn) { if (!this.eventListeners.has(t)) this.eventListeners.set(t, []); this.eventListeners.get(t).push(fn); },
  dispatchEvent(ev) {
    const list = this.eventListeners.get(ev.type) || [];
    try { ev.currentTarget = this; } catch { /* CustomEvent may forbid setter — fine */ }
    for (const fn of list) {
      fn(ev);
      if (ev._stopped) break;
    }
    return !ev.defaultPrevented;
  },
  // identity.js falls back to document.createEvent for browsers without
  // CustomEvent; polyfill both so the producer code path never throws.
  createEvent(type) {
    const ev = {
      type,
      _detail: null,
      initCustomEvent(name, _b, _c, detail) {
        this.type = name;
        this._detail = detail;
      },
    };
    return ev;
  },
};

class CustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init && 'detail' in init ? init.detail : null;
    this.cancelable = !!(init && init.cancelable);
    this._stopped = false;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
  }
}

class HTMLElement {}
Object.setPrototypeOf(Element.prototype, HTMLElement.prototype);
if (!globalThis.HTMLElement) globalThis.HTMLElement = HTMLElement;

// ----------------------------------------------------------------------
// Per-test browser harness. We do NOT use tests/_player-dom.mjs because
// the homeHotModule + identity pipeline does not need the player's
// state machine — only its bootstrap path. A focused harness keeps
// the assertions tight and avoids fighting the player's lazy ending-
// page import during a fresh-tab smoke test.
// ----------------------------------------------------------------------

function buildPlayerDom() {
  document.body.children.length = 0;
  document.body.innerHTML = '';
  // Topbar: back / share buttons + story/role name spans.
  const topbar = new Element('header'); document.body.appendChild(topbar); topbar.id = 'topbar';
  const backBtn = new Element('button'); topbar.appendChild(backBtn); backBtn.id = 'back-btn'; backBtn.type = 'button';
  const shareBtn = new Element('button'); topbar.appendChild(shareBtn); shareBtn.id = 'share-btn'; shareBtn.type = 'button';
  const storyName = new Element('div'); topbar.appendChild(storyName); storyName.id = 'story-name';
  const roleName = new Element('div'); topbar.appendChild(roleName); roleName.id = 'role-name';
  // Main + picker + player screens.
  const main = new Element('main'); document.body.appendChild(main);
  const pickerScreen = new Element('section'); main.appendChild(pickerScreen); pickerScreen.id = 'screen-picker'; pickerScreen.dataset.screen = 'picker'; pickerScreen.classList.add('screen', 'active');
  const pickerTitle = new Element('h1'); pickerScreen.appendChild(pickerTitle); pickerTitle.id = 'picker-title';
  const storiesList = new Element('ul'); pickerScreen.appendChild(storiesList); storiesList.id = 'story-list';
  for (const [tag, id] of [['input','story-search'],['div','category-filters'],['div','story-detail'],['button','start-story-btn'],['p','detail-status'],['select','header-role-select']]) { const el = new Element(tag); pickerScreen.appendChild(el); el.id = id; }
  const detailScreen = new Element('section'); main.appendChild(detailScreen); detailScreen.id = 'screen-detail'; detailScreen.dataset.screen = 'detail'; detailScreen.classList.add('screen');
  const rolesList = new Element('ul'); pickerScreen.appendChild(rolesList); rolesList.id = 'role-list';
  const pickerStatus = new Element('p'); pickerScreen.appendChild(pickerStatus); pickerStatus.id = 'picker-status';
  const roleBlock = new Element('section'); pickerScreen.appendChild(roleBlock); roleBlock.id = 'role-block'; roleBlock.hidden = true;
  const playerScreen = new Element('section'); main.appendChild(playerScreen); playerScreen.id = 'screen-player'; playerScreen.dataset.screen = 'player'; playerScreen.hidden = true;
  const statusLabel = new Element('span'); playerScreen.appendChild(statusLabel); statusLabel.id = 'status-label';
  const statusBarFill = new Element('span'); playerScreen.appendChild(statusBarFill); statusBarFill.id = 'status-bar-fill';
  const storyLog = new Element('ol'); playerScreen.appendChild(storyLog); storyLog.id = 'story-log';
  // Player controls: pause, skip, input form, choices, ending.
  const pauseBtn = new Element('button'); playerScreen.appendChild(pauseBtn); pauseBtn.id = 'pause-btn'; pauseBtn.type = 'button';
  const pauseBtnLabel = new Element('span'); pauseBtn.appendChild(pauseBtnLabel); pauseBtnLabel.id = 'pause-btn-label';
  const skipBtn = new Element('button'); playerScreen.appendChild(skipBtn); skipBtn.id = 'skip-btn'; skipBtn.type = 'button'; skipBtn.hidden = true;
  const inputForm = new Element('form'); playerScreen.appendChild(inputForm); inputForm.id = 'player-input-form';
  const inputField = new Element('input'); inputForm.appendChild(inputField); inputField.id = 'player-input'; inputField.type = 'text';
  const inputBtn = new Element('button'); inputForm.appendChild(inputBtn); inputBtn.id = 'player-input-btn'; inputBtn.type = 'submit';
  const choices = new Element('section'); playerScreen.appendChild(choices); choices.id = 'player-choices';
  const playerEnding = new Element('section'); playerScreen.appendChild(playerEnding); playerEnding.id = 'player-ending';
  // Toast.
  const toast = new Element('aside'); document.body.appendChild(toast); toast.id = 'toast';
  // Hot-module DOM nodes. The hot module queries #ecosystem-hot-module,
  // #ecosystem-hot-list, #ecosystem-hot-status by id; build them so the
  // module actually mounts and calls fetch().
  const hotRoot = new Element('section'); document.body.appendChild(hotRoot); hotRoot.id = 'ecosystem-hot-module';
  const hotList = new Element('ul'); hotRoot.appendChild(hotList); hotList.id = 'ecosystem-hot-list';
  const hotStatus = new Element('p'); hotRoot.appendChild(hotStatus); hotStatus.id = 'ecosystem-hot-status';
}

async function loadAndEval(path, { wrap = null } = {}) {
  let src = await readFile(path, 'utf-8');
  if (wrap) {
    src = `${src}\n${wrap}`;
  }
  // eslint-disable-next-line no-new-func
  new Function(src)();
}

async function setupFreshTab({ baseUrl }) {
  // Each setupFreshTab() stands for a fresh tab. Wipe document event
  // listeners, sessionStorage, and the window globals so no state
  // from a previous test leaks.
  document.eventListeners.clear();
  document.body.children.length = 0;
  document.body.innerHTML = '';
  buildPlayerDom();
  const sessionStore = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
    setItem: (k, v) => { sessionStore.set(String(k), String(v)); },
    removeItem: (k) => { sessionStore.delete(k); },
    clear: () => { sessionStore.clear(); },
  };
  globalThis.document = document;
  // Make `window` a Proxy so reads/writes to the script-visible
  // `window` object ALSO land on `globalThis`. The browser scripts
  // (identity.js, player.js) set `window.STORY_OUTSIDE_IDENTITY_API`
  // and read `window.STORY_OUTSIDE_IDENTITY`; with the proxy the
  // tests can read them off `globalThis` directly.
  const windowObj = {
    location: { href: `${baseUrl}/`, search: '' },
    scrollTo: () => {},
    innerWidth: 1280,
    innerHeight: 800,
  };
  globalThis.window = new Proxy(windowObj, {
    set(target, prop, value) {
      target[prop] = value;
      globalThis[prop] = value;
      return true;
    },
    get(target, prop) {
      if (prop in target) return target[prop];
      return globalThis[prop];
    },
  });
  // Capture every fetch the player + hot module issue. Tests inspect
  // this list to assert the hot module actually queried with the
  // canonical triple.
  const fetchCalls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const absolute = /^https?:/i.test(url) ? url : new URL(url, baseUrl).href;
    fetchCalls.push({ url: absolute, options });
    const res = await realFetch(absolute, options);
    return res;
  };
  if (!globalThis.crypto) globalThis.crypto = {};
  if (typeof globalThis.crypto.randomUUID !== 'function') {
    globalThis.crypto.randomUUID = () => '00000000-0000-4000-8000-000000000099';
  }
  if (!globalThis.history) globalThis.history = { replaceState: () => {} };
  if (!globalThis.location) globalThis.location = globalThis.window.location;
  return { fetchCalls, sessionStore };
}

// ----------------------------------------------------------------------
// Run.
// ----------------------------------------------------------------------

async function run() {
  const port = await new Promise((resolvePort, reject) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
    probe.on('error', reject);
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${port}`;
  const cafeRain = storyFixtures.find((row) => row.slug === 'cafe-rain');

  try {
    // ==================================================================
    // P1.v1-7-1 — grep guard: player.js contains the literal qualified
    // call. The test MUST be the first one to fail if a future refactor
    // moves the call behind an indirection that breaks the grep.
    // ==================================================================
    const playerSrc = await readFile(PLAYER_PATH, 'utf-8');

    await check('A1: player.js source contains STORY_OUTSIDE_IDENTITY_API.setActiveIdentity (grep guard)', () => {
      assert.match(
        playerSrc,
        /STORY_OUTSIDE_IDENTITY_API\.setActiveIdentity\s*\(/,
        'player.js must call STORY_OUTSIDE_IDENTITY_API.setActiveIdentity directly (no indirection)',
      );
    });

    await check('A2: player.js source contains STORY_OUTSIDE_IDENTITY_API.setActiveIdentity (regex grep)', () => {
      const re = /STORY_OUTSIDE_IDENTITY_API\.setActiveIdentity/;
      const hits = playerSrc.split('\n').filter((line) => re.test(line));
      assert.ok(hits.length > 0, `expected at least one match; got ${hits.length}`);
    });

    await check('A3: player.js bootstrapSession publishes identity BEFORE recoverAndStart', () => {
      const bootstrapMatch = playerSrc.match(/async function bootstrapSession[\s\S]*?\n\}\n/);
      assert.ok(bootstrapMatch, 'bootstrapSession not found in player.js');
      const body = bootstrapMatch[0];
      const publishIdx = body.search(/publishBootstrapIdentity\s*\(\s*\)/);
      const recoverIdx = body.search(/recoverAndStart\s*\(\s*\)/);
      assert.ok(publishIdx >= 0, 'bootstrapSession must call publishBootstrapIdentity()');
      assert.ok(recoverIdx >= 0, 'bootstrapSession must call recoverAndStart()');
      assert.ok(
        publishIdx < recoverIdx,
        'publishBootstrapIdentity() must run BEFORE recoverAndStart() so the producer fires before the hot module re-fetch',
      );
    });

    // ==================================================================
    // P1.v1-7-2 — end-to-end: fresh tab → pick → bootstrap → identity
    // event → hot module /v1/ecosystem/hot?story_uuid=...&story_version_uuid=...
    // &community_profile_version=...
    // ==================================================================
    const harness = await setupFreshTab({ baseUrl });
    await loadAndEval(IDENTITY_PATH);   // MUST run first per public/index.html ordering

    // Capture the pre-bootstrap identity state: on a fresh tab with
    // empty sessionStorage, the global must be null. This MUST be
    // checked before the player loads — once bootstrap() runs, it
    // publishes the canonical triple and the global is no longer null.
    await check('B0: identity.js pre-populates the global (initial state is null on fresh tab)', () => {
      // Fresh tab → sessionStorage empty → window.STORY_OUTSIDE_IDENTITY is null.
      assert.equal(globalThis.STORY_OUTSIDE_IDENTITY, null);
    });

    await loadAndEval(PLAYER_PATH, {
      // Capture the player's state singleton and bootstrap entry so
      // the test can wait for the async bootstrap to complete and
      // assert on state values. This is the same trick tests/_player-dom.mjs
      // uses for the same purpose.
      wrap: 'globalThis.__PLAYER_STATE__ = state; globalThis.__PLAYER_BOOTSTRAP__ = bootstrap;',
    });
    await loadAndEval(HOME_HOT_PATH);

    await check('B1: identity.js exposes STORY_OUTSIDE_IDENTITY_API on window', () => {
      const api = globalThis.STORY_OUTSIDE_IDENTITY_API;
      assert.ok(api, 'STORY_OUTSIDE_IDENTITY_API must exist after identity.js loads');
      assert.equal(typeof api.setActiveIdentity, 'function');
      assert.equal(typeof api.clearActiveIdentity, 'function');
      assert.equal(typeof api.getActiveIdentity, 'function');
      assert.equal(api.EVENT_NAME, 'story:identity-changed');
    });

    // Find the story chip and the role chip the harness inserted, then
    // dispatch the click chain the real UI would. The player's bootstrap
    // chain calls bootstrapSession, which awaits the API response and
    // THEN runs publishBootstrapIdentity() — this is what we want to
    // observe end-to-end.
    let identityEventsSeen = 0;
    let lastIdentityDetail = null;
    const eventListener = (ev) => {
      identityEventsSeen += 1;
      lastIdentityDetail = ev && 'detail' in ev ? ev.detail : null;
    };
    document.addEventListener('story:identity-changed', eventListener);

    // Wait for the player to load stories (its bootstrap calls
    // /api/stories and then renders #story-list chips).
    const storyLoadStart = Date.now();
    while (Date.now() - storyLoadStart < 10000) {
      const chips = document.querySelectorAll('#story-list .book-card');
      if (chips.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    let storyChip = document.querySelector('#story-list .book-card[data-story-id="cafe-rain"]');
    if (!storyChip) {
      // Fallback: pick the first chip (server fixture only seeds one story).
      storyChip = document.querySelector('#story-list .book-card');
    }
    assert.ok(storyChip, 'story chip must exist after player.js loads /api/stories');
    storyChip.click();
    await new Promise((r) => setTimeout(r, 50));
    const roleChip = document.querySelector('#role-list .chip[data-role-id="stranger"]')
      || document.querySelector('#role-list .chip');
    assert.ok(roleChip, 'role chip must exist after selectStory');
    roleChip.click();
    document.querySelector('#start-story-btn')?.click();

    // Wait for bootstrap to complete: state.storyUuid must be set
    // and at least one identity-changed event must have fired.
    const bootstrapStart = Date.now();
    while (Date.now() - bootstrapStart < 10000) {
      const playerState = globalThis.__PLAYER_STATE__ || {};
      if (playerState.storyUuid && identityEventsSeen > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const playerState = globalThis.__PLAYER_STATE__ || {};

    await check('B3: bootstrapSession populated state.storyUuid', () => {
      assert.ok(playerState.storyUuid, 'state.storyUuid must be set after bootstrap');
    });

    await check('B4: bootstrapSession populated state.storyVersionUuid', () => {
      assert.ok(playerState.storyVersionUuid, 'state.storyVersionUuid must be set after bootstrap');
    });

    await check('B5: bootstrapSession populated state.communityProfileVersion', () => {
      assert.ok(playerState.communityProfileVersion, 'state.communityProfileVersion must be set after bootstrap');
    });

    await check('B6: STORY_OUTSIDE_IDENTITY_API.setActiveIdentity fired exactly one event (bootstrap success path)', () => {
      assert.equal(identityEventsSeen, 1, `expected exactly 1 event, got ${identityEventsSeen}`);
    });

    await check('B7: identity event detail carries the canonical triple returned by /api/sessions', () => {
      assert.ok(lastIdentityDetail, 'event detail must not be null');
      assert.equal(lastIdentityDetail.story_uuid, playerState.storyUuid);
      assert.equal(lastIdentityDetail.story_version_uuid, playerState.storyVersionUuid);
      assert.equal(lastIdentityDetail.community_profile_version, playerState.communityProfileVersion);
    });

    await check('B8: window.STORY_OUTSIDE_IDENTITY mirrors the canonical triple after the event', () => {
      const stored = globalThis.STORY_OUTSIDE_IDENTITY;
      assert.ok(stored && typeof stored === 'object');
      assert.equal(stored.story_uuid, playerState.storyUuid);
      assert.equal(stored.story_version_uuid, playerState.storyVersionUuid);
      assert.equal(stored.community_profile_version, playerState.communityProfileVersion);
    });

    // The hot module calls fetch('/v1/ecosystem/hot?...') once on initial
    // load (no identity yet → plain fallback) and once on the
    // identity-changed event (with identity). Wait for the second
    // fetch to land.
    const hotStart = Date.now();
    let hotCalls = [];
    while (Date.now() - hotStart < 5000) {
      hotCalls = harness.fetchCalls.filter((c) => c.url.includes('/v1/ecosystem/hot'));
      if (hotCalls.length >= 1 && hotCalls[hotCalls.length - 1].url.includes('story_uuid=')) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    await check('B9: hot module issued at least one /v1/ecosystem/hot fetch', () => {
      assert.ok(hotCalls.length >= 1, `expected ≥1 hot fetch, got ${hotCalls.length}`);
    });

    const lastHotCall = hotCalls[hotCalls.length - 1] || { url: '' };
    const hotUrl = new URL(lastHotCall.url);

    await check('B10: hot module fetch carries story_uuid query field', () => {
      const v = hotUrl.searchParams.get('story_uuid');
      assert.ok(v, 'story_uuid must be set on the hot fetch URL');
      assert.equal(v, playerState.storyUuid);
    });

    await check('B11: hot module fetch carries story_version_uuid query field', () => {
      const v = hotUrl.searchParams.get('story_version_uuid');
      assert.ok(v, 'story_version_uuid must be set on the hot fetch URL');
      assert.equal(v, playerState.storyVersionUuid);
    });

    await check('B12: hot module fetch carries community_profile_version query field', () => {
      const v = hotUrl.searchParams.get('community_profile_version');
      assert.ok(v, 'community_profile_version must be set on the hot fetch URL');
      assert.equal(v, playerState.communityProfileVersion);
    });

    await check('B13: hot module fetch is NOT the fallback (all 3 identity fields present)', () => {
      const hasAll3 = hotUrl.searchParams.get('story_uuid')
        && hotUrl.searchParams.get('story_version_uuid')
        && hotUrl.searchParams.get('community_profile_version');
      assert.ok(hasAll3, 'hot fetch must carry all 3 identity fields (not the plain fallback)');
    });

    await check('B14: server returned 200 for the identity-bearing hot fetch', async () => {
      const res = await fetch(lastHotCall.url, { headers: { accept: 'application/json' } });
      assert.equal(res.status, 200, `server hot endpoint must accept the identity triple (status=${res.status})`);
    });

    await check('B15: server response includes relevant_to_story projection when the full triple is supplied', async () => {
      const res = await fetch(lastHotCall.url, { headers: { accept: 'application/json' } });
      const payload = await res.json();
      assert.ok(payload, 'response body must parse as JSON');
      assert.ok('relevant_to_story' in payload, 'response must carry relevant_to_story when the triple is supplied');
    });

    // ==================================================================
    // P1.v1-7-3 — idempotency / last-write-wins. After the bootstrap
    // publish, endingPage.publishEndingIdentity MUST still be able to
    // republish the same (or different) triple. The producer's contract
    // is "last write wins"; this verifies the contract holds without
    // regressing endingPage.mount().
    // ==================================================================
    await check('C1: bootstrap publish is idempotent under a second bootstrap call (same triple)', () => {
      const baselineCount = identityEventsSeen;
      // Use the real API directly: replay the bootstrap publish path
      // with the same triple. A second call with identical values
      // MUST fire exactly one more event (last write wins).
      globalThis.STORY_OUTSIDE_IDENTITY_API.setActiveIdentity({
        story_uuid: playerState.storyUuid,
        story_version_uuid: playerState.storyVersionUuid,
        community_profile_version: playerState.communityProfileVersion,
        story_slug: 'cafe-rain',
        story_title: '雨夜咖啡馆',
        source: 'start',
      });
      assert.equal(identityEventsSeen, baselineCount + 1, 'second publish must fire one event');
    });

    await check('C2: bootstrap + endingPage order — last write wins (ending identity overrides bootstrap)', () => {
      const baselineCount = identityEventsSeen;
      const endingIdentity = {
        story_uuid: playerState.storyUuid,
        story_version_uuid: playerState.storyVersionUuid,
        community_profile_version: playerState.communityProfileVersion + '|ending',
        story_slug: 'cafe-rain',
        story_title: '雨夜咖啡馆',
        source: 'ending',
      };
      globalThis.STORY_OUTSIDE_IDENTITY_API.setActiveIdentity(endingIdentity);
      assert.equal(identityEventsSeen, baselineCount + 1, 'ending publish must fire one event');
      const stored = globalThis.STORY_OUTSIDE_IDENTITY;
      assert.equal(stored.community_profile_version, endingIdentity.community_profile_version,
        'ending write must be the active identity (last-write-wins)');
      assert.equal(stored.source, 'ending');
    });

    await check('C3: bootstrap + endingPage order — global + storage agree (last write wins)', () => {
      const stored = globalThis.STORY_OUTSIDE_IDENTITY;
      const storedFromStorage = globalThis.sessionStorage.getItem('story-outside:active-identity');
      assert.ok(storedFromStorage, 'sessionStorage row must exist');
      const parsed = JSON.parse(storedFromStorage);
      assert.equal(parsed.community_profile_version, stored.community_profile_version);
      assert.equal(parsed.source, 'ending');
    });

    await check('C4: producer rejects partial triple (no event fires on bad input)', () => {
      const baselineCount = identityEventsSeen;
      const result = globalThis.STORY_OUTSIDE_IDENTITY_API.setActiveIdentity({
        story_uuid: playerState.storyUuid,
        // story_version_uuid + community_profile_version missing
      });
      assert.equal(result, null, 'partial triple MUST be rejected (producer returns null)');
      assert.equal(identityEventsSeen, baselineCount, 'partial triple MUST NOT fire an event');
    });

    await check('C5: producer clears identity when clearActiveIdentity is called', () => {
      const baselineCount = identityEventsSeen;
      globalThis.STORY_OUTSIDE_IDENTITY_API.clearActiveIdentity();
      assert.equal(identityEventsSeen, baselineCount + 1, 'clearActiveIdentity must fire exactly one event');
      const stored = globalThis.STORY_OUTSIDE_IDENTITY;
      assert.equal(stored, null, 'global must be null after clearActiveIdentity');
    });

    // ==================================================================
    // P1.v1-7-2 (continued) — after a clear, the hot module listener
    // will fire again with detail=null and re-fetch the plain fallback.
    // Re-establish the identity to prove the chain still re-binds.
    // ==================================================================
    await check('D1: identity re-established after a clear still reaches the hot module with all 3 fields', async () => {
      const beforeHotCalls = harness.fetchCalls.filter((c) => c.url.includes('/v1/ecosystem/hot')).length;
      globalThis.STORY_OUTSIDE_IDENTITY_API.setActiveIdentity({
        story_uuid: playerState.storyUuid,
        story_version_uuid: playerState.storyVersionUuid,
        community_profile_version: playerState.communityProfileVersion,
        story_slug: 'cafe-rain',
        story_title: '雨夜咖啡馆',
        source: 'start',
      });
      // Wait for the hot module listener to fire its fetch.
      const deadline = Date.now() + 3000;
      let latestHotUrl = '';
      while (Date.now() < deadline) {
        const recent = harness.fetchCalls.filter((c) => c.url.includes('/v1/ecosystem/hot'));
        if (recent.length > beforeHotCalls) {
          latestHotUrl = recent[recent.length - 1].url;
          if (latestHotUrl.includes('story_uuid=')) break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      const u = new URL(latestHotUrl);
      assert.ok(u.searchParams.get('story_uuid'), 'story_uuid must be set');
      assert.ok(u.searchParams.get('story_version_uuid'), 'story_version_uuid must be set');
      assert.ok(u.searchParams.get('community_profile_version'), 'community_profile_version must be set');
    });

    // ==================================================================
    // Run.
    // ==================================================================
    // eslint-disable-next-line no-console
    console.log(`\n[clickup16-4-p1-v1-7-playerIdentity] ${testIdx}/${testIdx} passed`);
  } finally {
    server.close();
  }

  // Avoid unused-import lint warning while keeping the fixture lookup
  // around for debugging when the test fails.
  void cafeRain;
}

await run();
