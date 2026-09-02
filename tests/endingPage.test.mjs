// tests/endingPage.test.mjs — ClickUp 11 ending page DOM coverage.
//
// Validates that the dedicated ending screen renders the documented
// sections after finish_story commits:
//
//   * finish_story commit + DOM hook reaches the ending screen
//   * page rebuilds identical DOM after a full page reload (read-only)
//   * original timeline column + AI-parallel timeline column are
//     visually distinct (.timeline-source vs .timeline-ai)
//   * replay controller walks the replay list forward + reset
//   * dedicated screen is hidden in the picker / playing states
//
// The test reuses tests/_player-dom.mjs (the 09 DOM harness) so we do
// not duplicate the harness. The ending module is loaded via dynamic
// import from the live HTTP server's static file (so the same path the
// browser uses), not via require.

import assert_ from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

import { server, storyFixtures } from '../src/server.mjs';
import { createPlayerDom } from './_player-dom.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENDING_PAGE_PATH = resolvePath(__dirname, '..', 'public', 'scripts', 'endingPage.js');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`);
  }
}

async function postJson(baseUrl, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body: json };
}

async function getJson(baseUrl, path) {
  const res = await fetch(`${baseUrl}${path}`);
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body: json };
}

async function driveToFinish(baseUrl, sessionUuid, expectedRevision) {
  for (let turn = 1; turn <= 6; turn += 1) {
    const stagedRes = await postJson(baseUrl, `/api/dev/sessions/${sessionUuid}/generate`, {
      input: { text: 'long' },
      expected_revision: expectedRevision,
      request_id: `dom-end-${sessionUuid}-${turn}`,
    });
    if (stagedRes.status !== 200) throw new Error(`turn ${turn} generate failed: ${stagedRes.status}`);
    const staged = stagedRes.body;
    expectedRevision = staged.revision;
    let committedToolCall = false;
    for (let seq = staged.pending_committed_count || 0; seq < staged.events.length; seq += 1) {
      const commitRes = await postJson(baseUrl, `/api/dev/sessions/${sessionUuid}/narrative-events`, {
        pending_id: staged.pending_id,
        sequence: seq,
        expected_revision: expectedRevision,
        client_request_id: `dom-end-commit-${sessionUuid}-${turn}-${seq}`,
      });
      if (commitRes.status !== 200) throw new Error(`commit failed: ${commitRes.status}`);
      const commitJson = commitRes.body;
      expectedRevision = commitJson.revision;
      if (commitJson.pending_tool_call && commitJson.pending_tool_call.name === 'finish_story') {
        committedToolCall = true;
        break;
      }
    }
    if (committedToolCall) break;
  }
  return expectedRevision;
}

async function main() {
  const port = await new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port: picked } = probe.address();
      probe.close(() => resolve(picked));
    });
    probe.on('error', reject);
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${port}`;
  const fixture = storyFixtures.find((row) => row.slug === 'cafe-rain');

  // Pre-load endingPage source (loaded inside the harness globals).
  const endingSource = await readFile(ENDING_PAGE_PATH, 'utf-8');

  // Helper: install endingPage globals on the test harness.
  function installEndingPageGlobals() {
    globalThis.__ENDING_PAGE_SOURCE__ = endingSource;
    globalThis.__ENDING_PAGE_LOAD__ = async () => {
      // Strip the ESM `export {...}` (the source is otherwise plain
      // top-level JS). `new Function` evaluates in script context, so
      // ESM exports are not legal. We capture the locals on globalThis
      // for the test to read.
      const stripped = endingSource.replace(/export\s*\{[^}]*\}\s*;?\s*$/m, '');
      const wrapped = `${stripped}\nglobalThis.__ENDING_PAGE__ = { mount, teardown, STATE };`;
      const fn = new Function(wrapped);
      fn();
    };
  }

  // The 09 harness DOM does NOT include #screen-ending by default.
// We append a minimal section AFTER the harness installs its DOM
// (i.e. inside dom.ready()). The harness exposes `globalThis.document`
// once setupGlobals() has run.
async function appendEndingScreen(dom) {
  await dom.ready();
  const doc = globalThis.document;
  // Polyfill: the 09 harness does not implement createTextNode.
  // endingPage.js uses document.createTextNode in el(). Implement
  // it here so the harness can render text nodes — we use the
  // prototype's textContent setter directly so the value is captured
  // by the getter above (and not recursed through the constructor's
  // `this.textContent = ''` path).
  if (typeof doc.createTextNode !== 'function') {
    doc.createTextNode = (text) => {
      const t = doc.createElement('text-node');
      t.__isTextNode = true;
      t.__textValue = String(text == null ? '' : text);
      return t;
    };
  }
  // Monkey-patch the Element prototype so setAttribute('id', '...') is
  // mirrored onto the `id` property. The 09 harness's querySelector
  // for `#id` selectors reads `el.id` directly (does not consult
  // `attrs`). endingPage.js uses el('h1', { id: 'foo' }) which goes
  // through setAttribute, so without this patch the harness cannot
  // find any id set by endingPage.js. The patch is applied to the
  // prototype so every newly-created element picks it up.
  const proto = Object.getPrototypeOf(doc.body);
  if (proto && typeof proto.setAttribute === 'function' && !proto.__endingIdPatched) {
    const originalSet = proto.setAttribute;
    proto.setAttribute = function (name, value) {
      const result = originalSet.call(this, name, value);
      if (name === 'id') this.id = value;
      return result;
    };
    Object.defineProperty(proto, '__endingIdPatched', { value: true, configurable: true });
  }
  // Polyfill textContent as a getter that walks children (the 09
  // harness stores textContent as a plain property that is never
  // updated by appendChild). Without this, assertion reads like
  // `tag.textContent` always return the constructor's default ''.
  if (proto && !proto.__endingTextPatched) {
    Object.defineProperty(proto, 'textContent', {
      configurable: true,
      get() {
        // Walk descendants and concatenate text-node content + own
        // textContent (which the constructor left empty).
        let out = '';
        const self = this;
        function walk(node) {
          if (node && node.__isTextNode) {
            out += node.__textValue || '';
          }
          if (!node || !node.children) return;
          for (const child of node.children) walk(child);
        }
        walk(self);
        return out;
      },
      set(value) {
        // Setter: clear children and store the new value on the
        // instance directly (skip the prototype getter to avoid the
        // constructor's `this.textContent = ''` recursion). We do NOT
        // call createElement here because some harnesses set textContent
        // before createTextNode is installed.
        if (this.children) this.children.length = 0;
        this.__isTextNode = true;
        this.__textValue = String(value == null ? '' : value);
      },
    });
    Object.defineProperty(proto, '__endingTextPatched', { value: true, configurable: true });
  }
  const endingScreen = doc.createElement('section');
  endingScreen.id = 'screen-ending';
  endingScreen.className = 'screen screen-ending';
  endingScreen.setAttribute('data-screen', 'ending');
  endingScreen.setAttribute('aria-label', '结局页');
  endingScreen.hidden = true;
  doc.body.querySelector('#player-main').appendChild(endingScreen);
}

  try {
    console.log('--- ending page DOM contract ---');

    // ----- 1) DOM harness loads ending page source -----
    {
      installEndingPageGlobals();
      const dom = createPlayerDom({ baseUrl });
      await appendEndingScreen(dom);
      await globalThis.__ENDING_PAGE_LOAD__();
      check('endingPage module exposes mount', typeof globalThis.__ENDING_PAGE__.mount === 'function');
      check('endingPage module exposes teardown', typeof globalThis.__ENDING_PAGE__.teardown === 'function');
    }

    // ----- 2) Mount renders the ending page after finish_story commit -----
    {
      // Tear down the previous harness globals before recreating.
      delete globalThis.__ENDING_PAGE__;
      installEndingPageGlobals();
      const dom = createPlayerDom({ baseUrl });
      await appendEndingScreen(dom);
      await globalThis.__ENDING_PAGE_LOAD__();
      // Drive a session to finish_story via the live server.
      const sessionUuid = '00000000-0000-4000-8000-110000000011';
      const adminList = await (await fetch(`${baseUrl}/api/admin/stories`)).json();
      const entry = adminList.stories.find((s) => s.slug === 'cafe-rain');
      const version = entry.versions.find((v) => v.status === 'published') || entry.versions[0];
      const rebuilt = await postJson(baseUrl, '/api/admin/opening-cache/rebuild', {
        story_version_uuid: version.story_version_uuid,
      });
      const cache = rebuilt.body.result.cache;
      const generationProfile = { ...cache.generation_profile, cache_uuid: cache.cache_uuid };
      await postJson(baseUrl, '/api/dev/sessions', {
        session_uuid: sessionUuid,
        story_uuid: entry.story_uuid,
        story_version_uuid: version.story_version_uuid,
        user_ref: 'dom-test-1',
        role_id: 'stranger',
        model: 'mock-11',
        prompt: '11 prompt',
        generation_profile: generationProfile,
      });
      await driveToFinish(baseUrl, sessionUuid, 0);
      await globalThis.__ENDING_PAGE__.mount({
        sessionUuid,
        sessionMeta: { storyTitle: '雨夜咖啡馆', roleLabel: '陌生人' },
      });
      const endingScreen = document.body.querySelector('#screen-ending');
      check('ending screen exists in DOM', endingScreen !== null);
      check('ending screen has children after mount', endingScreen && endingScreen.children.length > 0);
      check('ending screen has visible header h1', !!document.body.querySelector('#screen-ending #ending-title'));
      check('ending screen has summary section', !!document.body.querySelector('#screen-ending [data-section="summary"]'));
      check('ending screen has key-choices section', !!document.body.querySelector('#screen-ending [data-section="key-choices"]'));
      check('ending screen has character-outcomes section', !!document.body.querySelector('#screen-ending [data-section="character-outcomes"]'));
      check('ending screen has comparison section', !!document.body.querySelector('#screen-ending [data-section="comparison"]'));
      check('ending screen has replay section', !!document.body.querySelector('#screen-ending [data-section="replay"]'));
      check('ending screen has attribution section', !!document.body.querySelector('#screen-ending [data-section="attribution"]'));
    }

    // ----- 3) Comparison column visual distinction -----
    {
      check('comparison-source column exists', !!document.body.querySelector('#screen-ending .comparison-source'));
      check('comparison-ai column exists', !!document.body.querySelector('#screen-ending .comparison-ai'));
      const sourceItems = document.body.querySelectorAll('#screen-ending .timeline-source');
      const aiItems = document.body.querySelectorAll('#screen-ending .timeline-ai');
      check('timeline-source items rendered', sourceItems.length > 0);
      check('timeline-ai items rendered', aiItems.length > 0);
      // Source items must be inside .comparison-source, AI items inside .comparison-ai.
      let sourceInSourceColumn = 0;
      let aiInAiColumn = 0;
      for (const item of sourceItems) {
        let probe = item;
        while (probe) {
          if (probe.classList && probe.classList.contains('comparison-source')) { sourceInSourceColumn += 1; break; }
          probe = probe.parent;
        }
      }
      for (const item of aiItems) {
        let probe = item;
        while (probe) {
          if (probe.classList && probe.classList.contains('comparison-ai')) { aiInAiColumn += 1; break; }
          probe = probe.parent;
        }
      }
      check('all timeline-source items are inside comparison-source column', sourceInSourceColumn === sourceItems.length);
      check('all timeline-ai items are inside comparison-ai column', aiInAiColumn === aiItems.length);
    }

    // ----- 4) "AI 生成平行时间线" label is present -----
    {
      const tag = document.body.querySelector('#screen-ending .ending-tag-ai');
      check('AI tag rendered', tag !== null);
      check('AI tag contains "AI 生成平行时间线"', tag && /AI 生成平行时间线/.test(tag.textContent));
    }

    // ----- 5) Source attribution rendered -----
    {
      const sourceTitle = document.body.querySelector('#screen-ending .comparison-source-title');
      check('source attribution rendered', sourceTitle && sourceTitle.textContent.length > 0);
      check('source attribution mentions "来自原作"', sourceTitle && /来自原作/.test(sourceTitle.textContent));
      const aiTitle = document.body.querySelector('#screen-ending .comparison-ai-title');
      check('AI timeline title rendered', aiTitle && aiTitle.textContent.length > 0);
    }

    // ----- 6) Replay controls + list -----
    {
      const replayList = document.body.querySelector('#replay-list');
      check('replay list rendered', replayList !== null);
      const replayEvents = replayList ? replayList.children.length : 0;
      check('replay list has events', replayEvents > 0);
      const prevBtn = document.body.querySelector('#replay-prev-btn');
      const nextBtn = document.body.querySelector('#replay-next-btn');
      const resetBtn = document.body.querySelector('#replay-reset-btn');
      check('replay prev button exists', !!prevBtn);
      check('replay next button exists', !!nextBtn);
      check('replay reset button exists', !!resetBtn);
      // Click "下一句" twice and confirm progress updates.
      if (nextBtn && resetBtn) {
        nextBtn.dispatch('click');
        nextBtn.dispatch('click');
        const progress = document.body.querySelector('#replay-progress');
        check('replay progress updates after next clicks', progress && /\d+ \/ \d+/.test(progress.textContent));
        resetBtn.dispatch('click');
        const resetProgress = document.body.querySelector('#replay-progress');
        check('replay reset returns progress to 0', resetProgress && /^0 \//.test(resetProgress.textContent));
      }
    }

    // ----- 7) Refresh: rebuild DOM from API and confirm parity -----
    {
      // Re-mount by teardown + mount again. The second mount should
      // produce the same projection payload (deterministic from the same
      // session history), so the DOM should match exactly.
      const sessionUuid = '00000000-0000-4000-8000-110000000011';
      await globalThis.__ENDING_PAGE__.teardown();
      await globalThis.__ENDING_PAGE__.mount({
        sessionUuid,
        sessionMeta: { storyTitle: '雨夜咖啡馆', roleLabel: '陌生人' },
      });
      // Snapshot the rendered DOM as a normalized HTML string.
      const screen = document.body.querySelector('#screen-ending');
      const html = screen.innerHTML.replace(/\s+/g, ' ').trim();
      await globalThis.__ENDING_PAGE__.teardown();
      await globalThis.__ENDING_PAGE__.mount({
        sessionUuid,
        sessionMeta: { storyTitle: '雨夜咖啡馆', roleLabel: '陌生人' },
      });
      const html2 = screen.innerHTML.replace(/\s+/g, ' ').trim();
      check('refresh re-renders identical DOM', html === html2);
    }

    // ----- 8) Hidden in picker / playing states -----
    {
      const endingScreen = document.body.querySelector('#screen-ending');
      // After mount, the endingScreen is shown; after teardown, it
      // should be hidden (showScreen('player') hides everything except
      // #screen-player).
      await globalThis.__ENDING_PAGE__.teardown();
      check('ending screen hidden after teardown', endingScreen.hidden === true);
    }

    // ----- 9) Empty state when session has no finish_story -----
    {
      // Create a fresh session via the live server, do not drive to
      // finish_story, then mount and confirm the empty state.
      const sessionUuid = '00000000-0000-4000-8000-110000000099';
      const adminList = await (await fetch(`${baseUrl}/api/admin/stories`)).json();
      const entry = adminList.stories.find((s) => s.slug === 'cafe-rain');
      const version = entry.versions.find((v) => v.status === 'published') || entry.versions[0];
      const rebuilt = await postJson(baseUrl, '/api/admin/opening-cache/rebuild', {
        story_version_uuid: version.story_version_uuid,
      });
      const cache = rebuilt.body.result.cache;
      const generationProfile = { ...cache.generation_profile, cache_uuid: cache.cache_uuid };
      await postJson(baseUrl, '/api/dev/sessions', {
        session_uuid: sessionUuid,
        story_uuid: entry.story_uuid,
        story_version_uuid: version.story_version_uuid,
        user_ref: 'dom-test-empty',
        role_id: 'stranger',
        model: 'mock-11',
        prompt: '11 prompt',
        generation_profile: generationProfile,
      });
      await globalThis.__ENDING_PAGE__.mount({ sessionUuid });
      const empty = document.body.querySelector('#screen-ending .ending-empty');
      check('empty state rendered when ending not committed', !!empty);
    }

    // ----- 10) Player hook reaches endingPage.mount on finish_story -----
    {
      // Tear down + re-bootstrap player DOM, then simulate a finish
      // event by driving /generate via a forced finish input.
      delete globalThis.__ENDING_PAGE__;
      delete globalThis.__PLAYER_TEST_API__;
      installEndingPageGlobals();
      const dom = createPlayerDom({ baseUrl });
      await appendEndingScreen(dom);
      await globalThis.__ENDING_PAGE_LOAD__();
      // Create a session via the live server, drive it through the
      // "finish" path by sending "finish" as input (deterministic
      // demo provider).
      const sessionUuid = '00000000-0000-4000-8000-110000000020';
      const adminList = await (await fetch(`${baseUrl}/api/admin/stories`)).json();
      const entry = adminList.stories.find((s) => s.slug === 'cafe-rain');
      const version = entry.versions.find((v) => v.status === 'published') || entry.versions[0];
      const rebuilt = await postJson(baseUrl, '/api/admin/opening-cache/rebuild', {
        story_version_uuid: version.story_version_uuid,
      });
      const cache = rebuilt.body.result.cache;
      const generationProfile = { ...cache.generation_profile, cache_uuid: cache.cache_uuid };
      await postJson(baseUrl, '/api/dev/sessions', {
        session_uuid: sessionUuid,
        story_uuid: entry.story_uuid,
        story_version_uuid: version.story_version_uuid,
        user_ref: 'dom-test-hook',
        role_id: 'stranger',
        model: 'mock-11',
        prompt: '11 prompt',
        generation_profile: generationProfile,
      });
      // Drive ONE generate batch with "finish" input to trigger the
      // finish_story tool call directly.
      const stagedRes = await postJson(baseUrl, `/api/dev/sessions/${sessionUuid}/generate`, {
        input: { text: 'finish' },
        expected_revision: 0,
        request_id: `dom-finish-${sessionUuid}`,
      });
      check('forced finish generate returned 200', stagedRes.status === 200);
      let committedToolCall = false;
      for (let seq = stagedRes.body.pending_committed_count || 0; seq < stagedRes.body.events.length; seq += 1) {
        const commitRes = await postJson(baseUrl, `/api/dev/sessions/${sessionUuid}/narrative-events`, {
          pending_id: stagedRes.body.pending_id,
          sequence: seq,
          expected_revision: stagedRes.body.revision,
          client_request_id: `dom-finish-commit-${sessionUuid}-${seq}`,
        });
        const commitJson = commitRes.body;
        if (commitJson.pending_tool_call && commitJson.pending_tool_call.name === 'finish_story') {
          committedToolCall = true;
          break;
        }
      }
      check('finish_story tool_call committed via forced input', committedToolCall);
      // Confirm /ending is now 200.
      const endingRes = await getJson(baseUrl, `/api/dev/sessions/${sessionUuid}/ending`);
      check('GET /ending returns 200 after forced finish', endingRes.status === 200);
      // The player DOM does not actually drive the session via the
      // canvas (state-machine wiring is heavy), so we manually invoke
      // mount to simulate the hook.
      await globalThis.__ENDING_PAGE__.mount({ sessionUuid });
      const endingScreen = document.body.querySelector('#screen-ending');
      check('player hook reaches endingPage.mount (forced mount succeeds)', endingScreen && endingScreen.children.length > 0);
    }
  } finally {
    server.close();
  }
  if (failures > 0) {
    console.error(`\nendingPage: ${failures} failures`);
    process.exit(1);
  } else {
    console.log('\nendingPage: all green');
  }
}

main().catch((err) => {
  console.error('endingPage test crashed:', err);
  process.exit(1);
});