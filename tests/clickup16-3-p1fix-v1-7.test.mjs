// tests/clickup16-3-p1fix-v1-7.test.mjs — ClickUp 16.3 P1 v1-7
// regression (主人 2026-09-07 10:18 巡检 + ChatGPT 独立复核).
//
// What this test verifies (canonical-identity preservation across
// the player bootstrap → helper write → reload / ?s=ending deep
// link path):
//
//   P1.v1-7-1 — `sessionContext` helper preserves the full
//     canonical meta. v1-6 silently stripped
//     `storyUuid / storyVersionUuid / communityProfileVersion /
//     communityProfileQueries` when persisting the
//     `story-outside:last-session` payload — only
//     `sessionUuid / storyTitle / roleLabel` survived. The `?s=ending`
//     deep link therefore lost its canonical identity after every
//     `location.reload()` and the ending page's
//     `/v1/ecosystem/knowledge` call could not submit a valid
//     payload. v1-7:
//       * exposes the v1-7 helper getter
//         `getCurrentShareTargetMeta()`;
//       * extends `writeStorageValue()` to persist every canonical
//         field;
//       * keeps the v1-7 in-memory cache as
//         `{ sessionUuid, meta }` so the getter can return the same
//         triple without a second storage read.
//
//   P1.v1-7-2 — `player.bootstrapSession` writes the full meta.
//     The player pre-loads the helper, so v1-6's direct-write
//     fallback essentially never ran — every reload ate the
//     canonical triple. v1-7 makes the helper path AND the
//     direct-write path emit the same canonical payload.
//
//   P1.v1-7-3 — fresh bootstrap → reload / `?s=ending` deep-link
//     preserves canonical identity.
//       1. fresh tab → `player.bootstrapSession` → server returns
//          a real canonical triple;
//       2. helper writes the full meta;
//       3. simulate `location.reload()` (new harness instance +
//          reset helper in-memory state, storage untouched);
//       4. `getCurrentShareTargetUuid()` and
//          `getCurrentShareTargetMeta()` round-trip the same
//          canonical triple;
//       5. simulate `?s=ending` deep link — the deep-link code
//          forwards the canonical triple into `mountEndingPage`
//          so the ending page can submit
//          `/v1/ecosystem/discussions` without losing identity.
//
// All checks go through the real `sessionContext.js` source via the
// harness import hook (`tests/_player-dom.mjs`); the player
// bootstrap, the helper, and the deep-link branch are exercised
// end-to-end against the live HTTP server.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { server } from '../src/server.mjs';
import { createPlayerDom } from './_player-dom.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_CONTEXT_PATH = resolvePath(__dirname, '..', 'public', 'scripts', 'sessionContext.js');
const PLAYER_PATH = resolvePath(__dirname, '..', 'public', 'scripts', 'player.js');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`);
  }
}

const baseUrl = await new Promise((resolve, reject) => {
  const tmp = http.createServer();
  tmp.listen(0, '127.0.0.1', () => {
    const { port } = tmp.address();
    tmp.close(() => resolve(`http://127.0.0.1:${port}`));
  });
  tmp.on('error', reject);
});

await new Promise((resolve) => server.listen(Number(new URL(baseUrl).port), '127.0.0.1', resolve));

console.log('ClickUp 16.3 P1 v1-7 — sessionContext canonical-meta preservation');

// ---------------------------------------------------------------------------
// P1.v1-7-1 — helper source / static contracts.
// ---------------------------------------------------------------------------
{
  const source = await readFile(SESSION_CONTEXT_PATH, 'utf-8');

  // The helper MUST export `getCurrentShareTargetMeta` so the ending
  // page can rebuild its `/v1/ecosystem/knowledge` payload from the
  // persisted canonical meta on a reload.
  check(
    'static: sessionContext.js exports getCurrentShareTargetMeta',
    /export\s*\{[^}]*getCurrentShareTargetMeta[^}]*\}/.test(source),
    'export block missing getCurrentShareTargetMeta'
  );
  check(
    'static: sessionContext.js default export exposes getCurrentShareTargetMeta',
    /export\s+default\s+\{[^}]*getCurrentShareTargetMeta[^}]*\}/.test(source),
    'default export block missing getCurrentShareTargetMeta'
  );
  // The helper MUST persist the four canonical fields on every write.
  check(
    'static: sessionContext.js writeStorageValue persists storyUuid',
    /storyUuid/.test(source) && /JSON\.stringify\(\s*\{[^}]*storyUuid/.test(source),
    'writeStorageValue payload missing storyUuid'
  );
  check(
    'static: sessionContext.js writeStorageValue persists storyVersionUuid',
    /storyVersionUuid/.test(source) && /JSON\.stringify\(\s*\{[^}]*storyVersionUuid/.test(source),
    'writeStorageValue payload missing storyVersionUuid'
  );
  check(
    'static: sessionContext.js writeStorageValue persists communityProfileVersion',
    /communityProfileVersion/.test(source) && /JSON\.stringify\(\s*\{[^}]*communityProfileVersion/.test(source),
    'writeStorageValue payload missing communityProfileVersion'
  );
  check(
    'static: sessionContext.js writeStorageValue persists communityProfileQueries',
    /communityProfileQueries/.test(source) && /JSON\.stringify\(\s*\{[^}]*communityProfileQueries/.test(source),
    'writeStorageValue payload missing communityProfileQueries'
  );

  // The player MUST forward the canonical triple into the helper.
  const playerSource = await readFile(PLAYER_PATH, 'utf-8');
  check(
    'static: player.js persistSessionContext passes storyUuid in meta',
    /persistSessionContext[\s\S]*storyUuid: state\.storyUuid/.test(playerSource),
    'player.js meta missing storyUuid'
  );
  check(
    'static: player.js persistSessionContext passes storyVersionUuid in meta',
    /persistSessionContext[\s\S]*storyVersionUuid: state\.storyVersionUuid/.test(playerSource),
    'player.js meta missing storyVersionUuid'
  );
  check(
    'static: player.js persistSessionContext passes communityProfileVersion in meta',
    /persistSessionContext[\s\S]*communityProfileVersion: state\.communityProfileVersion/.test(playerSource),
    'player.js meta missing communityProfileVersion'
  );
  check(
    'static: player.js persistSessionContext passes communityProfileQueries in meta',
    /persistSessionContext[\s\S]*communityProfileQueries:[\s\S]*state\.communityProfileQueries/.test(playerSource),
    'player.js meta missing communityProfileQueries'
  );
}

// ---------------------------------------------------------------------------
// P1.v1-7-2 — fresh bootstrap writes the full canonical meta via the
// helper. The harness pre-resolves the helper, so this exercises the
// helper path (NOT the direct-write fallback).
// ---------------------------------------------------------------------------
let realCanonical = null; // captured from the live /api/sessions response
let persistedRawAfterBootstrap = null;
{
  const harness = await createPlayerDom({ baseUrl });
  // Reset sessionStorage so this harness is a fresh tab.
  if (typeof globalThis.__HARNESS_RESET_SESSION_CONTEXT__ === 'function') {
    globalThis.__HARNESS_RESET_SESSION_CONTEXT__();
  }
  await harness.ready();
  // Allow the picker to fetch /api/stories and render chips.
  await new Promise((r) => setTimeout(r, 1500));

  const document = globalThis.document;
  const storyChips = document.querySelectorAll('#story-list .chip');
  check('fresh: picker rendered at least one story chip', storyChips.length > 0, `count=${storyChips.length}`);
  const storyChip = storyChips[0];
  const storyId = storyChip && (storyChip.dataset ? (storyChip.dataset.storyId || storyChip.attrs['data-story-id']) : null);
  check('fresh: first story chip has data-story-id', !!storyId, `attrs=${JSON.stringify(storyChip && storyChip.attrs)}`);
  if (storyChip) storyChip.dispatch('click');
  await new Promise((r) => setTimeout(r, 400));
  const roleChips = document.querySelectorAll('#role-list .chip');
  check('fresh: picker rendered at least one role chip after story select', roleChips.length > 0, `count=${roleChips.length}`);
  const roleChip = roleChips[0];
  const roleId = roleChip && (roleChip.dataset ? (roleChip.dataset.roleId || roleChip.attrs['data-role-id']) : null);
  check('fresh: first role chip has data-role-id', !!roleId, `attrs=${JSON.stringify(roleChip && roleChip.attrs)}`);
  if (roleChip) roleChip.dispatch('click');

  // Wait for the bootstrap POST /api/sessions round-trip + helper
  // write + session:changed event to flush.
  await new Promise((r) => setTimeout(r, 1500));

  const playerState = globalThis.__PLAYER_STATE__ || null;
  check(
    'fresh: player state has sessionUuid after bootstrap',
    playerState && typeof playerState.sessionUuid === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(playerState.sessionUuid),
    `playerState.sessionUuid=${playerState && playerState.sessionUuid}`
  );

  // v1-7-2 — the player's state MUST carry the canonical triple so the
  // helper write below actually has the canonical meta to persist.
  check(
    'fresh: state.storyUuid is a non-empty string (server-allocated)',
    playerState && typeof playerState.storyUuid === 'string' && playerState.storyUuid.length > 0,
    `state.storyUuid=${playerState && playerState.storyUuid}`
  );
  check(
    'fresh: state.storyVersionUuid is a non-empty string (server-allocated)',
    playerState && typeof playerState.storyVersionUuid === 'string' && playerState.storyVersionUuid.length > 0,
    `state.storyVersionUuid=${playerState && playerState.storyVersionUuid}`
  );
  check(
    'fresh: state.communityProfileVersion is a non-empty string (server-allocated)',
    playerState && typeof playerState.communityProfileVersion === 'string' && playerState.communityProfileVersion.length > 0,
    `state.communityProfileVersion=${playerState && playerState.communityProfileVersion}`
  );
  check(
    'fresh: state.communityProfileQueries is a non-empty array',
    playerState && Array.isArray(playerState.communityProfileQueries) && playerState.communityProfileQueries.length > 0,
    `state.communityProfileQueries=${JSON.stringify(playerState && playerState.communityProfileQueries)}`
  );

  realCanonical = {
    sessionUuid: playerState && playerState.sessionUuid,
    storyUuid: playerState && playerState.storyUuid,
    storyVersionUuid: playerState && playerState.storyVersionUuid,
    communityProfileVersion: playerState && playerState.communityProfileVersion,
    communityProfileQueries: playerState && playerState.communityProfileQueries,
  };

  // Inspect the storage payload the helper actually wrote.
  persistedRawAfterBootstrap = sessionStorage.getItem('story-outside:last-session');
  check(
    'fresh: helper wrote story-outside:last-session payload',
    typeof persistedRawAfterBootstrap === 'string' && persistedRawAfterBootstrap.length > 0,
    `raw=${persistedRawAfterBootstrap}`
  );

  let parsed = null;
  try { parsed = JSON.parse(persistedRawAfterBootstrap); } catch { parsed = null; }
  check(
    'fresh: helper payload is JSON',
    !!parsed,
    `raw=${persistedRawAfterBootstrap}`
  );
  check(
    'fresh: helper payload.sessionUuid === realCanonical.sessionUuid',
    parsed && parsed.sessionUuid === realCanonical.sessionUuid,
    `parsed.sessionUuid=${parsed && parsed.sessionUuid} expected=${realCanonical.sessionUuid}`
  );
  // v1-7-1 — these four canonical fields MUST be in the payload.
  check(
    'fresh: helper payload.storyUuid === realCanonical.storyUuid (NO DROP)',
    parsed && parsed.storyUuid === realCanonical.storyUuid,
    `parsed.storyUuid=${parsed && parsed.storyUuid} expected=${realCanonical.storyUuid}`
  );
  check(
    'fresh: helper payload.storyVersionUuid === realCanonical.storyVersionUuid (NO DROP)',
    parsed && parsed.storyVersionUuid === realCanonical.storyVersionUuid,
    `parsed.storyVersionUuid=${parsed && parsed.storyVersionUuid} expected=${realCanonical.storyVersionUuid}`
  );
  check(
    'fresh: helper payload.communityProfileVersion === realCanonical.communityProfileVersion (NO DROP)',
    parsed && parsed.communityProfileVersion === realCanonical.communityProfileVersion,
    `parsed.communityProfileVersion=${parsed && parsed.communityProfileVersion} expected=${realCanonical.communityProfileVersion}`
  );
  check(
    'fresh: helper payload.communityProfileQueries is an Array equal to the canonical queries',
    parsed && Array.isArray(parsed.communityProfileQueries)
      && JSON.stringify(parsed.communityProfileQueries) === JSON.stringify(realCanonical.communityProfileQueries),
    `parsed.communityProfileQueries=${JSON.stringify(parsed && parsed.communityProfileQueries)} expected=${JSON.stringify(realCanonical.communityProfileQueries)}`
  );

  // The helper getter MUST round-trip the same canonical triple.
  const helperFresh = await globalThis.__HARNESS_IMPORT_SESSION_CONTEXT__();
  const helperMetaFresh = helperFresh.getCurrentShareTargetMeta();
  check(
    'fresh: helper.getCurrentShareTargetMeta() returns storyUuid',
    helperMetaFresh && helperMetaFresh.storyUuid === realCanonical.storyUuid,
    `helperMetaFresh.storyUuid=${helperMetaFresh && helperMetaFresh.storyUuid} expected=${realCanonical.storyUuid}`
  );
  check(
    'fresh: helper.getCurrentShareTargetMeta() returns storyVersionUuid',
    helperMetaFresh && helperMetaFresh.storyVersionUuid === realCanonical.storyVersionUuid,
    `helperMetaFresh.storyVersionUuid=${helperMetaFresh && helperMetaFresh.storyVersionUuid} expected=${realCanonical.storyVersionUuid}`
  );
  check(
    'fresh: helper.getCurrentShareTargetMeta() returns communityProfileVersion',
    helperMetaFresh && helperMetaFresh.communityProfileVersion === realCanonical.communityProfileVersion,
    `helperMetaFresh.communityProfileVersion=${helperMetaFresh && helperMetaFresh.communityProfileVersion} expected=${realCanonical.communityProfileVersion}`
  );
  check(
    'fresh: helper.getCurrentShareTargetMeta() returns communityProfileQueries',
    helperMetaFresh && Array.isArray(helperMetaFresh.communityProfileQueries)
      && JSON.stringify(helperMetaFresh.communityProfileQueries) === JSON.stringify(realCanonical.communityProfileQueries),
    `helperMetaFresh.communityProfileQueries=${JSON.stringify(helperMetaFresh && helperMetaFresh.communityProfileQueries)} expected=${JSON.stringify(realCanonical.communityProfileQueries)}`
  );
}

// ---------------------------------------------------------------------------
// P1.v1-7-3 — simulate `location.reload()`. The harness builds a NEW
// instance so the in-memory cache is reset; the storage payload from
// the previous tab must still round-trip the canonical triple.
// ---------------------------------------------------------------------------
let reloadCanonical = null;
{
  // Capture the raw payload the previous harness wrote — the new
  // harness is a fresh in-process Map, so we seed its sessionStorage
  // with this exact payload to model `location.reload()` against the
  // same browser tab (same storage backing store, fresh JS state).
  const persistedFromFresh = persistedRawAfterBootstrap;
  const preserved = (typeof persistedFromFresh === 'string' && persistedFromFresh.length > 0)
    ? { 'story-outside:last-session': persistedFromFresh }
    : null;

  // The ending-page mount-spy buffer is fresh for this harness.
  globalThis.__HARNESS_ENDING_PAGE_MOUNT_CALLS__ = [];

  const harness = await createPlayerDom({ baseUrl, startScreen: 'ending', preservedSessionStorage: preserved });
  // DO NOT reset the helper / sessionStorage here — that simulates a
  // reload that preserves the same sessionStorage backing store.
  // The harness is a fresh player harness with a fresh
  // `_sessionContextModule` instance, so the helper's in-memory
  // cache MUST be re-populated from storage.
  await harness.ready();
  await new Promise((r) => setTimeout(r, 800));

  // The helper module is reachable via the player.js pre-load.
  // Verify the storage payload (from the previous harness) is still
  // present after the second harness builds a new helper instance.
  const persistedAfterReload = sessionStorage.getItem('story-outside:last-session');
  check(
    'reload: storage payload from previous harness is still present',
    typeof persistedAfterReload === 'string' && persistedAfterReload.length > 0,
    `raw=${persistedAfterReload}`
  );
  let parsedReload = null;
  try { parsedReload = JSON.parse(persistedAfterReload); } catch { parsedReload = null; }
  check(
    'reload: payload still carries storyUuid (NO DROP across reload)',
    parsedReload && parsedReload.storyUuid === realCanonical.storyUuid,
    `parsedReload.storyUuid=${parsedReload && parsedReload.storyUuid} expected=${realCanonical.storyUuid}`
  );
  check(
    'reload: payload still carries storyVersionUuid (NO DROP across reload)',
    parsedReload && parsedReload.storyVersionUuid === realCanonical.storyVersionUuid,
    `parsedReload.storyVersionUuid=${parsedReload && parsedReload.storyVersionUuid} expected=${realCanonical.storyVersionUuid}`
  );
  check(
    'reload: payload still carries communityProfileVersion (NO DROP across reload)',
    parsedReload && parsedReload.communityProfileVersion === realCanonical.communityProfileVersion,
    `parsedReload.communityProfileVersion=${parsedReload && parsedReload.communityProfileVersion} expected=${realCanonical.communityProfileVersion}`
  );
  check(
    'reload: payload still carries communityProfileQueries (NO DROP across reload)',
    parsedReload && Array.isArray(parsedReload.communityProfileQueries)
      && JSON.stringify(parsedReload.communityProfileQueries) === JSON.stringify(realCanonical.communityProfileQueries),
    `parsedReload.communityProfileQueries=${JSON.stringify(parsedReload && parsedReload.communityProfileQueries)} expected=${JSON.stringify(realCanonical.communityProfileQueries)}`
  );

  reloadCanonical = {
    sessionUuid: parsedReload && parsedReload.sessionUuid,
    storyUuid: parsedReload && parsedReload.storyUuid,
    storyVersionUuid: parsedReload && parsedReload.storyVersionUuid,
    communityProfileVersion: parsedReload && parsedReload.communityProfileVersion,
    communityProfileQueries: parsedReload && parsedReload.communityProfileQueries,
  };

  // The player bootstrap on the second harness MUST populate
  // `state.sessionUuid` from the persisted context (the deep-link
  // branch at public/scripts/player.js reads `ctx.sessionUuid` from
  // `readSessionContext()` and assigns it). The other canonical
  // fields flow through `mountEndingPage(sessionMetaOverride)` →
  // `mod.mount({ sessionUuid, sessionMeta })` — so the assertion is
  // that the mount-spy captured the full canonical triple.
  const playerState = globalThis.__PLAYER_STATE__ || null;
  check(
    'reload: player state.sessionUuid matches the persisted UUID',
    playerState && playerState.sessionUuid === realCanonical.sessionUuid,
    `state.sessionUuid=${playerState && playerState.sessionUuid} expected=${realCanonical.sessionUuid}`
  );

  // The ending page must have been mounted with the canonical meta
  // — the spy records every mount() call from the player's
  // mountEndingPage() wrapper. The last call carries the deep-link
  // sessionMeta.
  const calls = globalThis.__HARNESS_ENDING_PAGE_MOUNT_CALLS__ || [];
  check(
    'reload: endingPage.mount was invoked at least once (deep link)',
    calls.length >= 1,
    `count=${calls.length}`
  );
  const lastCall = calls.length > 0 ? calls[calls.length - 1] : null;
  check(
    'reload: endingPage.mount received sessionUuid === realCanonical.sessionUuid',
    lastCall && lastCall.sessionUuid === realCanonical.sessionUuid,
    `lastCall.sessionUuid=${lastCall && lastCall.sessionUuid} expected=${realCanonical.sessionUuid}`
  );
  check(
    'reload: endingPage.mount sessionMeta carries storyUuid (NO DROP)',
    lastCall && lastCall.sessionMeta && lastCall.sessionMeta.storyUuid === realCanonical.storyUuid,
    `lastCall.sessionMeta.storyUuid=${lastCall && lastCall.sessionMeta && lastCall.sessionMeta.storyUuid} expected=${realCanonical.storyUuid}`
  );
  check(
    'reload: endingPage.mount sessionMeta carries storyVersionUuid (NO DROP)',
    lastCall && lastCall.sessionMeta && lastCall.sessionMeta.storyVersionUuid === realCanonical.storyVersionUuid,
    `lastCall.sessionMeta.storyVersionUuid=${lastCall && lastCall.sessionMeta && lastCall.sessionMeta.storyVersionUuid} expected=${realCanonical.storyVersionUuid}`
  );
  check(
    'reload: endingPage.mount sessionMeta carries communityProfileVersion (NO DROP)',
    lastCall && lastCall.sessionMeta && lastCall.sessionMeta.communityProfileVersion === realCanonical.communityProfileVersion,
    `lastCall.sessionMeta.communityProfileVersion=${lastCall && lastCall.sessionMeta && lastCall.sessionMeta.communityProfileVersion} expected=${realCanonical.communityProfileVersion}`
  );
  check(
    'reload: endingPage.mount sessionMeta carries communityProfileQueries (NO DROP)',
    lastCall && lastCall.sessionMeta && Array.isArray(lastCall.sessionMeta.communityProfileQueries)
      && JSON.stringify(lastCall.sessionMeta.communityProfileQueries) === JSON.stringify(realCanonical.communityProfileQueries),
    `lastCall.sessionMeta.communityProfileQueries=${JSON.stringify(lastCall && lastCall.sessionMeta && lastCall.sessionMeta.communityProfileQueries)} expected=${JSON.stringify(realCanonical.communityProfileQueries)}`
  );

  // Also exercise the helper getter `getCurrentShareTargetMeta` so
  // a future reader sees the same canonical triple without going
  // through the storage layer.
  const helper = await globalThis.__HARNESS_IMPORT_SESSION_CONTEXT__();
  const helperUuid = helper.getCurrentShareTargetUuid();
  const helperMeta = helper.getCurrentShareTargetMeta();
  check(
    'reload: helper.getCurrentShareTargetUuid() === realCanonical.sessionUuid',
    helperUuid === realCanonical.sessionUuid,
    `helperUuid=${helperUuid} expected=${realCanonical.sessionUuid}`
  );
  check(
    'reload: helper.getCurrentShareTargetMeta().storyUuid === realCanonical.storyUuid',
    helperMeta && helperMeta.storyUuid === realCanonical.storyUuid,
    `helperMeta.storyUuid=${helperMeta && helperMeta.storyUuid} expected=${realCanonical.storyUuid}`
  );
  check(
    'reload: helper.getCurrentShareTargetMeta().storyVersionUuid === realCanonical.storyVersionUuid',
    helperMeta && helperMeta.storyVersionUuid === realCanonical.storyVersionUuid,
    `helperMeta.storyVersionUuid=${helperMeta && helperMeta.storyVersionUuid} expected=${realCanonical.storyVersionUuid}`
  );
  check(
    'reload: helper.getCurrentShareTargetMeta().communityProfileVersion === realCanonical.communityProfileVersion',
    helperMeta && helperMeta.communityProfileVersion === realCanonical.communityProfileVersion,
    `helperMeta.communityProfileVersion=${helperMeta && helperMeta.communityProfileVersion} expected=${realCanonical.communityProfileVersion}`
  );
  check(
    'reload: helper.getCurrentShareTargetMeta().communityProfileQueries matches canonical',
    helperMeta && Array.isArray(helperMeta.communityProfileQueries)
      && JSON.stringify(helperMeta.communityProfileQueries) === JSON.stringify(realCanonical.communityProfileQueries),
    `helperMeta.communityProfileQueries=${JSON.stringify(helperMeta && helperMeta.communityProfileQueries)} expected=${JSON.stringify(realCanonical.communityProfileQueries)}`
  );
}

console.log(`\nClickUp 16.3 P1 v1-7 — sessionContext canonical-meta preservation: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
server.close();
if (failures > 0) process.exit(1);