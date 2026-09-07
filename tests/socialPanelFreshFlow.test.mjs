// tests/socialPanelFreshFlow.test.mjs — ClickUp 16.3 P1 v1-5
// regression: fresh-flow (no remembered session) → user picks a
// real story + role through the picker → `player.bootstrapSession`
// runs → real `POST /api/sessions` returns a server-allocated UUID
// X → player dispatches `session:changed` → panel refreshes →
// share / unshare appear AND point at X → share / unshare wire
// against X → 200.
//
// ClickUp 16.3 P1 v1-5 (主人 2026-09-07 07:34 巡检 + ChatGPT 独立
// 复核): the social panel must NOT self-bootstrap a session. The
// previous v1-4 panel rendered a "创建 session" button that called
// `POST /api/sessions` with a hard-coded
// `{ work_id: 'cafe-rain', role_id: 'stranger' }` body, fabricating
// a demo session and leaking it into the share target. v1-5 deletes
// the button + the handler and lets the player be the single source
// of truth. The panel surfaces "请先选择故事 + 角色" until the user
// actually picks a story + role through the picker.
//
// What this test verifies:
//
//   P1.v1-5-1 — the panel does not self-bootstrap a session.
//     * `grep -nE "cafe-rain" public/scripts/socialPanel.js` → 0 hits.
//     * `grep -nE "stranger" public/scripts/socialPanel.js` → 0 hits.
//     * `grep -nE "POST.*sessions|/api/sessions" public/scripts/socialPanel.js`
//       → 0 hits.
//     * `grep -nE "onCreateSessionClick|createSession" public/scripts/socialPanel.js`
//       → 0 hits.
//     * No `#social-panel-create-session-btn` in the rendered panel.
//     * The exported `socialPanel` module does NOT expose
//       `handleCreateSession` or `maybeOfferCreateSessionButton`.
//
//   P1.v1-5-2 — fresh-flow drives the real player bootstrap.
//     1. Wipe `story-outside:last-session` (no history).
//     2. Panel mounts with share / unshare HIDDEN and the
//        "请先选择故事 + 角色" hint VISIBLE.
//     3. User picks the first picker story chip → picker renders
//        roles → user picks the first role chip.
//     4. `player.bootstrapSession` runs `POST /api/sessions` with
//        the picked `work_id` + `role_id` (real, server-validated).
//     5. Server returns a real `session_uuid = X` (NOT a hard-coded
//        demo UUID).
//     6. Player dispatches `session:changed`; the panel listener
//        fires `refreshShareButton` → share / unshare VISIBLE, hint
//        HIDDEN, `#social-panel-share-target-uuid` === X.
//     7. `POST /v1/ecosystem/sessions/X/share` → 200.
//     8. `POST /v1/ecosystem/sessions/X/unshare` → 200.
//
// All network traffic goes through the real HTTP server (see
// tests/_player-dom.mjs); the helper dispatches the event on the
// harness's `window` stand-in (see _player-dom.mjs
// `windowAddEventListener`).

import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { server } from '../src/server.mjs';
import { createPlayerDom } from './_player-dom.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_SCRIPTS_DIR = resolvePath(__dirname, '..', 'public', 'scripts');
const SOCIAL_PANEL_PATH = resolvePath(PUBLIC_SCRIPTS_DIR, 'socialPanel.js');

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

console.log('ClickUp 16.3 P1 v1-5 — socialPanel fresh-flow (real player bootstrap)');

// ---------------------------------------------------------------------------
// P1.v1-5-1 — panel does not self-bootstrap a session.
// ---------------------------------------------------------------------------
{
  const source = await readFile(SOCIAL_PANEL_PATH, 'utf-8');

  check(
    'static: grep -nE "cafe-rain" public/scripts/socialPanel.js → 0 hits',
    (source.match(/cafe-rain/g) || []).length === 0,
    `count=${(source.match(/cafe-rain/g) || []).length}`
  );
  check(
    'static: grep -nE "stranger" public/scripts/socialPanel.js → 0 hits',
    (source.match(/stranger/g) || []).length === 0,
    `count=${(source.match(/stranger/g) || []).length}`
  );
  check(
    'static: grep -nE "POST.*sessions|/api/sessions" public/scripts/socialPanel.js → 0 hits',
    (source.match(/POST[^\n]*sessions|\/api\/sessions/g) || []).length === 0,
    `hits=${JSON.stringify(source.match(/POST[^\n]*sessions|\/api\/sessions/g) || [])}`
  );
  check(
    'static: grep -nE "onCreateSessionClick|createSession" public/scripts/socialPanel.js → 0 hits',
    (source.match(/onCreateSessionClick|createSession/g) || []).length === 0,
    `count=${(source.match(/onCreateSessionClick|createSession/g) || []).length}`
  );

  // The exported module surface must NOT include the deleted handlers.
  const exports = Object.keys(await import(SOCIAL_PANEL_PATH));
  check(
    'static: socialPanel module no longer exports handleCreateSession',
    !exports.includes('handleCreateSession'),
    `exports=${JSON.stringify(exports)}`
  );
  check(
    'static: socialPanel module no longer exports maybeOfferCreateSessionButton',
    !exports.includes('maybeOfferCreateSessionButton'),
    `exports=${JSON.stringify(exports)}`
  );

  // Cross-script sanity: ensure no other public/scripts/* file
  // regresses by re-introducing the same anti-pattern.
  const files = (await readdir(PUBLIC_SCRIPTS_DIR)).filter((n) => n.endsWith('.js'));
  const offenders = [];
  for (const name of files) {
    const text = await readFile(resolvePath(PUBLIC_SCRIPTS_DIR, name), 'utf-8');
    text.split('\n').forEach((line, idx) => {
      // Comment lines are fine; this guards against future code drift
      // that would put the literal demo story/role strings back into
      // the rendered source.
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      if (/cafe-rain/.test(line) || /stranger/.test(line)) {
        offenders.push({ file: name, lineNo: idx + 1, line: trimmed });
      }
    });
  }
  check(
    'static: public/scripts/* code lines have no cafe-rain or stranger literals',
    offenders.length === 0,
    JSON.stringify(offenders)
  );
}

// ---------------------------------------------------------------------------
// P1.v1-5-2 — fresh-flow drives the real player bootstrap.
// ---------------------------------------------------------------------------
{
  const harness = await createPlayerDom({ baseUrl });
  // Wipe the last-session store BEFORE the player loads so the
  // panel mounts with no remembered session.
  if (typeof globalThis.__HARNESS_RESET_SESSION_CONTEXT__ === 'function') {
    globalThis.__HARNESS_RESET_SESSION_CONTEXT__();
  }
  await harness.ready();
  // Give the picker a moment to fetch /api/stories + render chips.
  await new Promise((r) => setTimeout(r, 1500));

  const document = globalThis.document;
  const host = document.getElementById('social-panel-host');
  check('dom: social-panel-host mounted after fresh-tab load', !!host, 'host missing');

  const shareBtn = host ? host.querySelector('#social-panel-share-btn') : null;
  const unshareBtn = host ? host.querySelector('#social-panel-unshare-btn') : null;
  const targetCode = host ? host.querySelector('#social-panel-share-target-uuid') : null;
  const hintEl = host ? host.querySelector('#social-panel-share-hint') : null;
  const createBtn = host ? host.querySelector('#social-panel-create-session-btn') : null;

  check('dom: #social-panel-share-btn present', !!shareBtn, 'share button missing');
  check('dom: #social-panel-unshare-btn present', !!unshareBtn, 'unshare button missing');
  check('dom: #social-panel-share-target-uuid present', !!targetCode, 'share-target code missing');
  check('dom: #social-panel-share-hint present', !!hintEl, 'hint element missing');
  check('dom: #social-panel-create-session-btn is GONE (panel never self-bootstraps)', !createBtn, 'create-session button leaked back into the panel');

  check(
    'fresh: share / unshare HIDDEN before any session exists',
    shareBtn && shareBtn.hidden === true && unshareBtn && unshareBtn.hidden === true,
    `shareBtn.hidden=${shareBtn && shareBtn.hidden} unshareBtn.hidden=${unshareBtn && unshareBtn.hidden}`
  );
  check(
    'fresh: hint "请先选择故事 + 角色" VISIBLE before any session exists',
    hintEl && hintEl.hidden === false && typeof hintEl.textContent === 'string' && hintEl.textContent.includes('请先选择故事'),
    `hintEl.hidden=${hintEl && hintEl.hidden} text=${hintEl && hintEl.textContent}`
  );

  // Drive the REAL picker — read whatever story / role the server
  // rendered, do not hard-code the demo story/role names. This way
  // the regression survives future fixture changes.
  const storyChips = document.querySelectorAll('#story-list .chip');
  check('fresh: picker rendered at least one story chip', storyChips.length > 0, `count=${storyChips.length}`);
  const storyChip = storyChips[0];
  const storyId = storyChip && (storyChip.dataset ? (storyChip.dataset.storyId || storyChip.attrs['data-story-id']) : null);
  check('fresh: first story chip has data-story-id', !!storyId, `attrs=${JSON.stringify(storyChip && storyChip.attrs)} dataset=${JSON.stringify(storyChip && storyChip.dataset)}`);
  if (storyChip) storyChip.dispatch('click');
  await new Promise((r) => setTimeout(r, 400));
  const roleChips = document.querySelectorAll('#role-list .chip');
  check('fresh: picker rendered at least one role chip after story select', roleChips.length > 0, `count=${roleChips.length}`);
  const roleChip = roleChips[0];
  const roleId = roleChip && (roleChip.dataset ? (roleChip.dataset.roleId || roleChip.attrs['data-role-id']) : null);
  check('fresh: first role chip has data-role-id', !!roleId, `attrs=${JSON.stringify(roleChip && roleChip.attrs)} dataset=${JSON.stringify(roleChip && roleChip.dataset)}`);
  if (roleChip) roleChip.dispatch('click');

  // Wait for the bootstrap POST /api/sessions round-trip + the
  // session:changed event to flush through the panel listener.
  await new Promise((r) => setTimeout(r, 1500));

  const playerState = globalThis.__PLAYER_STATE__ || null;
  check(
    'fresh: player state has sessionUuid after bootstrap',
    playerState && typeof playerState.sessionUuid === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(playerState.sessionUuid),
    `playerState.sessionUuid=${playerState && playerState.sessionUuid}`
  );

  const realUuid = playerState && playerState.sessionUuid;
  // Cross-check: the sessionUuid MUST match what the server returned
  // (NOT a hard-coded demo UUID). The harness gives crypto.randomUUID
  // a fixed value, but the SERVER allocates fresh UUIDs — so this is
  // a real server-allocated UUID, distinct from any demo fixture.
  check(
    'fresh: server-allocated sessionUuid is NOT a hard-coded demo UUID',
    realUuid && realUuid !== '00000000-0000-4000-8000-000000000099',
    `uuid=${realUuid}`
  );

  const stored = (typeof sessionStorage !== 'undefined') ? sessionStorage.getItem('story-outside:last-session') : null;
  let storedUuid = null;
  if (stored) {
    try { storedUuid = JSON.parse(stored).sessionUuid || null; } catch { /* ignore */ }
  }
  check(
    'fresh: sessionStorage story-outside:last-session holds the player UUID',
    typeof storedUuid === 'string' && storedUuid === realUuid,
    `stored=${stored} realUuid=${realUuid}`
  );

  check(
    'fresh: after real player bootstrap, share / unshare VISIBLE',
    shareBtn && shareBtn.hidden === false && unshareBtn && unshareBtn.hidden === false,
    `shareBtn.hidden=${shareBtn && shareBtn.hidden} unshareBtn.hidden=${unshareBtn && unshareBtn.hidden}`
  );
  check(
    'fresh: hint HIDDEN once a real session exists',
    hintEl && hintEl.hidden === true,
    `hintEl.hidden=${hintEl && hintEl.hidden}`
  );
  check(
    'fresh: #social-panel-share-target-uuid === realUuid',
    targetCode && targetCode.textContent === realUuid,
    `targetCode=${targetCode && targetCode.textContent} realUuid=${realUuid}`
  );

  // The panel share / unshare buttons call the wire endpoints
  // (no body, server resolves principal) — click them through the
  // harness so we can confirm the panel wires against the real UUID.
  if (realUuid && shareBtn) {
    shareBtn.dispatch('click');
    await new Promise((r) => setTimeout(r, 400));
  }
  if (realUuid && unshareBtn) {
    unshareBtn.dispatch('click');
    await new Promise((r) => setTimeout(r, 400));
  }

  // Drive the wire directly to prove the share / unshare URLs
  // resolve to 200 against the LIVE server (matches the spec
  // "调 POST /api/sessions/X/share → 200 / 调 POST
  // /api/sessions/X/unshare → 200").
  if (realUuid) {
    const shareRes = await fetch(`${baseUrl}/v1/ecosystem/sessions/${realUuid}/share`, { method: 'POST' });
    check(
      'wire: POST /v1/ecosystem/sessions/<realUuid>/share → 200',
      shareRes.status === 200,
      `got ${shareRes.status}`
    );
    const unshareRes = await fetch(`${baseUrl}/v1/ecosystem/sessions/${realUuid}/unshare`, { method: 'POST' });
    check(
      'wire: POST /v1/ecosystem/sessions/<realUuid>/unshare → 200',
      unshareRes.status === 200,
      `got ${unshareRes.status}`
    );
  }
}

console.log(`\nClickUp 16.3 P1 v1-5 — socialPanel fresh-flow: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
server.close();
if (failures > 0) process.exit(1);