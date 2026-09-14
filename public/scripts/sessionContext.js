// Story Outside — public session-context helper
// (Story 16.3 P1 v1-4 rebuild, 2026-09-07 review;
//  v1-7 扩 meta 字段 2026-09-07 review).
//
// Single source of truth for "what session is the panel / share /
// unshare buttons targeting". Every reader and writer in the page goes
// through this module — there is exactly ONE storage key,
// `story-outside:last-session`, and exactly ONE event,
// `session:changed`.
//
// Hard rules (Story 16.3 P1 v1-4 + v1-7):
//
//   * The single storage key is `story-outside:last-session`. The
//     previous bogus session-context global on `window` and the
//     stray secondary session-context slot (deleted by v1-4) are
//     GONE — only one key exists so a write from the player and a
//     read from the panel always agree.
//   * Reads (`getCurrentShareTargetUuid()`) and writes
//     (`setCurrentShareTargetUuid(uuid, meta)`) are both in this
//     module. Nothing else touches the storage key directly.
//   * Every write dispatches a `session:changed` CustomEvent on
//     `window` (or `globalThis` under the test harness) carrying
//     `{ sessionUuid, source }` in `detail`. Listeners re-render
//     without re-mounting — they call `panel.refresh()` etc.
//   * Storage is best-effort. When `sessionStorage` / `localStorage`
//     is unavailable (private browsing) the helper still returns the
//     in-memory cached value so the panel survives a reload in the
//     same tab session.
//   * v1-7 (Story 16.3 P1 review):
//     `setCurrentShareTargetUuid(uuid, meta)` accepts a full meta
//     object and persists EVERY canonical field —
//     `storyUuid`, `storyVersionUuid`, `communityProfileVersion`,
//     `communityProfileQueries` — alongside the previous
//     `storyTitle` / `roleLabel`. Without these the `?s=ending`
//     deep link loses its canonical triple (story_uuid /
//     story_version_uuid / community_profile_version /
//     community_profile_queries), the `/v1/ecosystem/knowledge`
//     call from the ending page cannot submit a valid payload, and
//     the panel / share / unshare buttons point at the wrong
//     session after a `location.reload()`.
//   * `getCurrentShareTargetUuid()` returns the uuid string; readers
//     that need the canonical meta (e.g. `endingPage` when it
//     builds the deep-link payload) MUST call
//     `getCurrentShareTargetMeta()` so they see the same persisted
//     triple / pointer that the helper wrote.
//
// The helper has no dependency on the player or the panel; both
// import it via dynamic import so the home-page DOM stays untouched.

const LAST_SESSION_KEY = 'story-outside:last-session';

// In-memory cache that survives when storage is unavailable. Populated
// on every successful read and write so that a subsequent read in the
// same tab returns the same value even if storage was wiped.
let inMemoryCache = null;

function readStorageValue() {
  // Story 16.3 P1 v1-7: the in-memory cache and the storage
  // payload now hold the full canonical triple (storyUuid /
  // storyVersionUuid / communityProfileVersion /
  // communityProfileQueries). The cache is a tuple:
  //   { sessionUuid, meta } where meta is the full canonical object.
  // Readers that want only the uuid continue to read
  // `cache.sessionUuid`; readers that need the full payload (the
  // ending page, the social panel after a reload, etc.) MUST read
  // `cache.meta` so they see the canonical triple.
  if (inMemoryCache && typeof inMemoryCache === 'object' && 'sessionUuid' in inMemoryCache) {
    return inMemoryCache;
  }
  // Legacy shape from before v1-7 — fall through and re-read storage.
  inMemoryCache = null;
  let raw = null;
  try {
    if (typeof sessionStorage !== 'undefined') {
      raw = sessionStorage.getItem(LAST_SESSION_KEY);
    }
  } catch { /* sessionStorage disabled — try localStorage */ }
  if (!raw) {
    try {
      if (typeof localStorage !== 'undefined') {
        raw = localStorage.getItem(LAST_SESSION_KEY);
      }
    } catch { /* localStorage disabled — no payload */ }
  }
  if (!raw) return null;
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (!parsed || typeof parsed.sessionUuid !== 'string' || !parsed.sessionUuid) return null;
  // Normalize the parsed payload so every reader sees the v1-7
  // shape regardless of whether the writer was an older player.
  // Missing canonical fields default to null / empty array so a
  // reload from a pre-v1-7 tab degrades to "no canonical triple"
  // rather than `undefined`.
  const meta = normalizeMeta({
    storyTitle: typeof parsed.storyTitle === 'string' ? parsed.storyTitle : '',
    roleLabel: typeof parsed.roleLabel === 'string' ? parsed.roleLabel : '',
    storyUuid: typeof parsed.storyUuid === 'string' ? parsed.storyUuid : null,
    storyVersionUuid: typeof parsed.storyVersionUuid === 'string' ? parsed.storyVersionUuid : null,
    communityProfileVersion: typeof parsed.communityProfileVersion === 'string' ? parsed.communityProfileVersion : null,
    communityProfileQueries: Array.isArray(parsed.communityProfileQueries) ? parsed.communityProfileQueries : null,
    source: typeof parsed.source === 'string' ? parsed.source : 'sessionContext',
  });
  inMemoryCache = { sessionUuid: parsed.sessionUuid, meta };
  return inMemoryCache;
}

// Story 16.3 P1 v1-7: every canonical meta field is preserved on
// the way out. The helper writes the FULL meta — not just storyTitle
// / roleLabel — so the `?s=ending` deep link can rebuild its
// `/v1/ecosystem/knowledge` payload after `location.reload()`.
function normalizeMeta(meta) {
  const safe = (meta && typeof meta === 'object') ? meta : {};
  return {
    storyTitle: typeof safe.storyTitle === 'string' ? safe.storyTitle : '',
    roleLabel: typeof safe.roleLabel === 'string' ? safe.roleLabel : '',
    storyUuid: typeof safe.storyUuid === 'string' && safe.storyUuid ? safe.storyUuid : null,
    storyVersionUuid: typeof safe.storyVersionUuid === 'string' && safe.storyVersionUuid
      ? safe.storyVersionUuid : null,
    communityProfileVersion: typeof safe.communityProfileVersion === 'string' && safe.communityProfileVersion
      ? safe.communityProfileVersion : null,
    communityProfileQueries: Array.isArray(safe.communityProfileQueries)
      ? safe.communityProfileQueries.slice() : null,
    source: typeof safe.source === 'string' ? safe.source : 'sessionContext',
  };
}

function writeStorageValue(uuid, meta) {
  // Always update the in-memory cache first so subsequent reads in
  // the same tab reflect the new value even if storage rejects the
  // write. The cache stores BOTH the uuid and the full meta so
  // `getCurrentShareTargetMeta()` returns the canonical triple
  // without a second storage read.
  const normalizedMeta = normalizeMeta(meta);
  inMemoryCache = { sessionUuid: uuid || null, meta: normalizedMeta };
  const payload = JSON.stringify({
    sessionUuid: uuid || null,
    storyTitle: normalizedMeta.storyTitle,
    roleLabel: normalizedMeta.roleLabel,
    storyUuid: normalizedMeta.storyUuid,
    storyVersionUuid: normalizedMeta.storyVersionUuid,
    communityProfileVersion: normalizedMeta.communityProfileVersion,
    communityProfileQueries: normalizedMeta.communityProfileQueries,
    source: normalizedMeta.source,
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
  // Story 16.3 P1 v1-7: cache is now `{ sessionUuid, meta }` so
  // the legacy `inMemoryCache = uuid` short-circuit becomes a
  // uuid-only short-circuit. New code that needs the full canonical
  // triple uses `getCurrentShareTargetMeta()`.
  if (inMemoryCache && typeof inMemoryCache === 'object' && 'sessionUuid' in inMemoryCache) {
    return inMemoryCache.sessionUuid || null;
  }
  // Legacy cache shape (string uuid) — clear it so subsequent calls
  // re-read the v1-7 tuple.
  if (typeof inMemoryCache === 'string') inMemoryCache = null;
  const fromStorage = readStorageValue();
  if (fromStorage && typeof fromStorage === 'object') {
    return fromStorage.sessionUuid || null;
  }
  return null;
}

// Story 16.3 P1 v1-7: returns the FULL canonical meta written by
// the last `setCurrentShareTargetUuid` call (storyUuid /
// storyVersionUuid / communityProfileVersion /
// communityProfileQueries + storyTitle / roleLabel / source). The
// ending page uses this so its deep-link `/v1/ecosystem/knowledge`
// call submits the same triple the player bootstrap received from
// `/api/sessions`. Without this getter the deep link would have to
// re-derive the meta from `getCurrentShareTargetUuid()` alone and
// would lose the canonical triple after `location.reload()`.
function getCurrentShareTargetMeta() {
  // Fast path: cache already holds the v1-7 tuple.
  if (inMemoryCache && typeof inMemoryCache === 'object' && 'sessionUuid' in inMemoryCache) {
    return Object.assign({}, inMemoryCache.meta || {});
  }
  // Legacy string cache — clear and re-read so we expose the full
  // tuple from storage.
  if (typeof inMemoryCache === 'string') inMemoryCache = null;
  const fromStorage = readStorageValue();
  if (fromStorage && typeof fromStorage === 'object') {
    return Object.assign({}, fromStorage.meta || {});
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
  getCurrentShareTargetMeta,
  setCurrentShareTargetUuid,
  clearCurrentShareTargetUuid,
  getLastSessionStorageKey,
};

export default {
  getCurrentShareTargetUuid,
  getCurrentShareTargetMeta,
  setCurrentShareTargetUuid,
  clearCurrentShareTargetUuid,
  getLastSessionStorageKey,
};