// Story Outside — public session-context helper
// (ClickUp 16.3 P1 v1-4 rebuild, 主人 2026-09-07 06:24 巡检 + ChatGPT 复核).
//
// Single source of truth for "what session is the panel / share /
// unshare buttons targeting". Every reader and writer in the page goes
// through this module — there is exactly ONE storage key,
// `story-outside:last-session`, and exactly ONE event,
// `session:changed`.
//
// Hard rules (ClickUp 16.3 P1 v1-4):
//
//   * The single storage key is `story-outside:last-session`. The
//     previous bogus session-context global on `window` and the
//     stray secondary session-context slot (deleted by v1-4) are
//     GONE — only one key exists so a write from the player and a
//     read from the panel always agree.
//   * Reads (`getCurrentShareTargetUuid()`) and writes
//     (`setCurrentShareTargetUuid(uuid)`) are both in this module.
//     Nothing else touches the storage key directly.
//   * Every write dispatches a `session:changed` CustomEvent on
//     `window` (or `globalThis` under the test harness) carrying
//     `{ sessionUuid, source }` in `detail`. Listeners re-render
//     without re-mounting — they call `panel.refresh()` etc.
//   * Storage is best-effort. When `sessionStorage` / `localStorage`
//     is unavailable (private browsing) the helper still returns the
//     in-memory cached value so the panel survives a reload in the
//     same tab session.
//
// The helper has no dependency on the player or the panel; both
// import it via dynamic import so the home-page DOM stays untouched.

const LAST_SESSION_KEY = 'story-outside:last-session';

// In-memory cache that survives when storage is unavailable. Populated
// on every successful read and write so that a subsequent read in the
// same tab returns the same value even if storage was wiped.
let inMemoryCache = null;

function readStorageValue() {
  try {
    if (typeof sessionStorage !== 'undefined') {
      const raw = sessionStorage.getItem(LAST_SESSION_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.sessionUuid === 'string' && parsed.sessionUuid) {
          return parsed.sessionUuid;
        }
      }
    }
  } catch { /* sessionStorage disabled — fall through */ }
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(LAST_SESSION_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.sessionUuid === 'string' && parsed.sessionUuid) {
          return parsed.sessionUuid;
        }
      }
    }
  } catch { /* localStorage disabled — fall through */ }
  return null;
}

function writeStorageValue(uuid, meta) {
  // Always update the in-memory cache first so subsequent reads in
  // the same tab reflect the new value even if storage rejects the
  // write.
  inMemoryCache = uuid || null;
  const payload = JSON.stringify({
    sessionUuid: uuid || null,
    storyTitle: meta && typeof meta.storyTitle === 'string' ? meta.storyTitle : '',
    roleLabel: meta && typeof meta.roleLabel === 'string' ? meta.roleLabel : '',
  });
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(LAST_SESSION_KEY, payload);
      return;
    }
  } catch { /* sessionStorage disabled — try localStorage */ }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LAST_SESSION_KEY, payload);
    }
  } catch { /* storage disabled — in-memory cache is the only fallback */ }
}

function dispatchSessionChanged(uuid, source) {
  // The harness installs `globalThis` as the document's event root;
  // real browsers attach listeners to `window`. Dispatch through the
  // same getter that listeners use so the test harness and a real
  // browser both observe the event.
  const target = (typeof window !== 'undefined') ? window
    : (typeof globalThis !== 'undefined' ? globalThis : null);
  if (!target || typeof target.dispatchEvent !== 'function') return;
  let CustomEventCtor = null;
  try {
    CustomEventCtor = target.CustomEvent || (typeof CustomEvent !== 'undefined' ? CustomEvent : null);
  } catch { /* no CustomEvent */ }
  if (typeof CustomEventCtor !== 'function') return;
  try {
    const evt = new CustomEventCtor('session:changed', {
      detail: { sessionUuid: uuid || null, source: source || 'sessionContext' },
    });
    target.dispatchEvent(evt);
  } catch { /* event dispatch failed — listener cannot fire */ }
}

function getCurrentShareTargetUuid() {
  if (inMemoryCache) return inMemoryCache;
  const fromStorage = readStorageValue();
  if (fromStorage) {
    inMemoryCache = fromStorage;
    return fromStorage;
  }
  return null;
}

function setCurrentShareTargetUuid(uuid, meta) {
  // Normalize the value so a fresh tab always reports "no session"
  // (null) until the player explicitly bootstraps one.
  const normalized = (typeof uuid === 'string' && uuid.length > 0) ? uuid : null;
  writeStorageValue(normalized, meta);
  dispatchSessionChanged(normalized, meta && meta.source ? meta.source : 'sessionContext');
  return normalized;
}

function clearCurrentShareTargetUuid() {
  // Used by the test harness / fresh-flow reset paths.
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(LAST_SESSION_KEY);
  } catch { /* ignore */ }
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(LAST_SESSION_KEY);
  } catch { /* ignore */ }
  inMemoryCache = null;
  dispatchSessionChanged(null, 'sessionContext.clear');
}

// Expose the storage key so tests can verify there is exactly ONE key
// (the secondary slot was deleted by v1-4).
function getLastSessionStorageKey() {
  return LAST_SESSION_KEY;
}

export {
  getCurrentShareTargetUuid,
  setCurrentShareTargetUuid,
  clearCurrentShareTargetUuid,
  getLastSessionStorageKey,
};

export default {
  getCurrentShareTargetUuid,
  setCurrentShareTargetUuid,
  clearCurrentShareTargetUuid,
  getLastSessionStorageKey,
};