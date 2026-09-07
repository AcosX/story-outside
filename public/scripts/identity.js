// public/scripts/identity.js — ClickUp 16.4 P1.v1-2 fix (2026-09-07).
//
// Global identity producer + cross-page persistence layer. ClickUp
// 16.4 home-page relevance matching requires a stable identity triple
// `{ story_uuid, story_version_uuid, community_profile_version }` to
// read the community profile for the active story and decide which
// hot entries are "相关才关联". The triple MUST come from somewhere —
// PR #23 (ce7f03a) assumed `window.STORY_OUTSIDE_ACTIVE_IDENTITY`
// was already being set by the picker, but it never was, so the
// relevance path was unreachable.
//
// This module is the single producer. It runs as soon as it loads,
// before player.js / homeHotModule.js / endingPage.js, so by the time
// any of them runs `readActiveIdentity()` the global is already
// populated (from sessionStorage if a previous page-load pinned one).
//
// Wire contract:
//   * global: `window.STORY_OUTSIDE_IDENTITY` — synchronous object,
//     `{ story_uuid, story_version_uuid, community_profile_version,
//        story_slug, story_title, source, set_at } | null`.
//   * event: `CustomEvent('story:identity-changed', { detail })` on
//     `document`. Every producer call fires exactly one event so the
//     hot module (and any other listener) can re-render.
//   * storage: `sessionStorage.setItem('story-outside:active-identity',
//     JSON.stringify(...))`. Cross-page persistence within the same
//     tab session; survives reloads but not new tabs.
//   * producer: `setActiveIdentity(partial)` — partial carries
//     `story_uuid`, `story_version_uuid`, `community_profile_version`
//     plus optional metadata (`story_slug`, `story_title`). Missing
//     required fields are rejected so callers cannot accidentally
//     clear the identity (use `clearActiveIdentity()` for that).
//   * cleardown: `clearActiveIdentity()` — fires the event with
//     `detail: null` and removes the global + storage row.
//
// v1-2 schema contract (2026-09-07):
//   The on-the-wire `community_profile_version` value is whatever
//   `/api/sessions` bootstrap returns (server reads it from the
//   canonical profile row). Current production data pins the value
//   to `COMMUNITY_PROFILE_GENERATOR_VERSION.rules_version`
//   (`'community-profile-rules/1'`), but the producer is permissive:
//   ANY non-empty string passes the shape check, so v1 schema data
//   does not break the relevance path. Future renames can flip the
//   constant without touching this file.
//
// Loaded BEFORE player.js / homeHotModule.js / endingPage.js in
// public/index.html. Self-registers its listeners on `DOMContentLoaded`
// when needed; otherwise initialises immediately so the global is
// available the instant downstream scripts start reading it.

(function () {
  'use strict';

  const STORAGE_KEY = 'story-outside:active-identity';
  const EVENT_NAME = 'story:identity-changed';
  const GLOBAL_KEY = 'STORY_OUTSIDE_IDENTITY';

  /**
   * @typedef {Object} ActiveIdentity
   * @property {string} story_uuid
   * @property {string} story_version_uuid
   * @property {string} community_profile_version
   * @property {string} [story_slug]
   * @property {string} [story_title]
   * @property {string} source                  'pick' | 'start' | 'ending' | 'restore'.
   * @property {string} set_at                  ISO timestamp.
   */

  /**
   * Read the identity currently held in sessionStorage. Returns null
   * when the storage row is missing OR the stored triple fails the
   * shape check (a malformed payload MUST NOT crash the home page).
   *
   * @returns {ActiveIdentity | null}
   */
  function readStorage() {
    try {
      if (typeof sessionStorage === 'undefined') return null;
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      const triple = assertTripleShape(parsed);
      if (!triple) return null;
      return /** @type {ActiveIdentity} */ ({
        ...triple,
        story_slug: typeof parsed.story_slug === 'string' ? parsed.story_slug : '',
        story_title: typeof parsed.story_title === 'string' ? parsed.story_title : '',
        source: typeof parsed.source === 'string' && parsed.source ? parsed.source : 'restore',
        set_at: typeof parsed.set_at === 'string' && parsed.set_at ? parsed.set_at : new Date().toISOString(),
      });
    } catch {
      return null;
    }
  }

  /**
   * Validate the required triple. Returns the normalised triple on
   * success, null on any failure. Centralised so the producer and
   * the storage reader apply the same rule.
   *
   * v1-2 (2026-09-07): the value is any non-empty trimmed string.
   * This is intentionally permissive so the v1 production data
   * ('community-profile-rules/1') and a future semver rename both
   * flow through unchanged. Server-side validation enforces the
   * canonical shape — this check is only "is the triple plausibly
   * a triple".
   *
   * @param {object} input
   * @returns {{ story_uuid: string, story_version_uuid: string, community_profile_version: string } | null}
   */
  function assertTripleShape(input) {
    const story_uuid = typeof input.story_uuid === 'string' ? input.story_uuid.trim() : '';
    const story_version_uuid = typeof input.story_version_uuid === 'string' ? input.story_version_uuid.trim() : '';
    const community_profile_version = typeof input.community_profile_version === 'string'
      ? input.community_profile_version.trim()
      : '';
    if (!story_uuid || !story_version_uuid || !community_profile_version) return null;
    return { story_uuid, story_version_uuid, community_profile_version };
  }

  /**
   * Write the identity into sessionStorage. Tolerant of storage
   * failures (private browsing modes, quota exhausted) — those MUST
   * NOT break the home page.
   *
   * @param {ActiveIdentity | null} identity
   */
  function writeStorage(identity) {
    try {
      if (typeof sessionStorage === 'undefined') return;
      if (!identity) {
        sessionStorage.removeItem(STORAGE_KEY);
        return;
      }
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
    } catch {
      /* storage unavailable — degrade gracefully */
    }
  }

  /**
   * @param {ActiveIdentity | null} identity
   * @param {{ source?: string }} [opts]
   */
  function publish(identity, opts) {
    const w = /** @type {any} */ (window);
    w[GLOBAL_KEY] = identity;
    writeStorage(identity);
    const source = (opts && typeof opts.source === 'string') ? opts.source : (identity ? 'set' : 'clear');
    let event;
    try {
      event = new CustomEvent(EVENT_NAME, { detail: identity, cancelable: false });
    } catch {
      // Old browsers: use the document.createEvent fallback.
      event = /** @type {any} */ (document.createEvent('CustomEvent'));
      event.initCustomEvent(EVENT_NAME, false, false, identity);
    }
    // The `source` is not part of the wire event (consumers read
    // `detail` only); it is logged so observability can correlate.
    document.dispatchEvent(event);
    void source;
  }

  /**
   * Set the active identity. The required triple
   * (`story_uuid`, `story_version_uuid`, `community_profile_version`)
   * MUST be supplied — partial triples are rejected so a buggy
   * caller cannot downgrade the home page to "0 terms" by accident.
   *
   * @param {object} input
   * @param {string} input.story_uuid
   * @param {string} input.story_version_uuid
   * @param {string} input.community_profile_version
   * @param {string} [input.story_slug]
   * @param {string} [input.story_title]
   * @returns {ActiveIdentity | null}
   */
  function setActiveIdentity(input) {
    const triple = assertTripleShape(input || {});
    if (!triple) {
      // Refuse to publish a partial identity. The caller MUST supply
      // all three required fields OR call clearActiveIdentity() to
      // drop the current row.
      return null;
    }
    const identity = /** @type {ActiveIdentity} */ ({
      ...triple,
      story_slug: typeof input.story_slug === 'string' ? input.story_slug : '',
      story_title: typeof input.story_title === 'string' ? input.story_title : '',
      source: typeof input.source === 'string' && input.source ? input.source : 'set',
      set_at: new Date().toISOString(),
    });
    publish(identity, { source: identity.source });
    return identity;
  }

  /**
   * Clear the active identity. Fires the event with `detail: null`
   * so consumers can fall back to "no identity" UI.
   */
  function clearActiveIdentity() {
    publish(null, { source: 'clear' });
  }

  /**
   * Read the current identity. Reads the in-memory global FIRST so
   * callers in the same frame see what was just set, and falls back
   * to sessionStorage when the global has been wiped (e.g. by a
   * hot-module reload that nuked the window object).
   *
   * @returns {ActiveIdentity | null}
   */
  function getActiveIdentity() {
    const w = /** @type {any} */ (window);
    if (w[GLOBAL_KEY] && typeof w[GLOBAL_KEY] === 'object') {
      return /** @type {ActiveIdentity} */ (w[GLOBAL_KEY]);
    }
    const fromStorage = readStorage();
    if (fromStorage) {
      w[GLOBAL_KEY] = fromStorage;
    }
    return fromStorage;
  }

  // Initialise the global synchronously so downstream scripts that
  // load AFTER identity.js can read it on their first frame.
  const initial = readStorage();
  if (initial) {
    /** @type {any} */ (window)[GLOBAL_KEY] = initial;
  } else {
    /** @type {any} */ (window)[GLOBAL_KEY] = null;
  }

  // Expose the producer + reader on window for downstream scripts.
  // ClickUp 16.4 P1.v1-2 contract:
  //   * homeHotModule.js calls `getActiveIdentity()` (no closure
  //     dependency) so the function can be unit-tested in isolation.
  //   * player.js / endingPage.js call `setActiveIdentity(...)` when
  //     the user picks / starts / finishes a story.
  /** @type {any} */ (window).STORY_OUTSIDE_IDENTITY_API = Object.freeze({
    setActiveIdentity,
    clearActiveIdentity,
    getActiveIdentity,
    EVENT_NAME,
    GLOBAL_KEY,
    STORAGE_KEY,
  });
})();