// tests/adminRoutes.test.mjs — HTTP-level coverage of the Phase 4 admin and
// dev routes. Confirms:
//   * Existing /api/* routes are unaffected (compatibility guard).
//   * Admin / dev routes exist, return the DEV_FLAG banner, and map errors.
//   * The rebuild route is idempotent: same story_version + same profile
//     twice returns the same cache row.
//   * The rebuild route with a new rules_version creates a fresh row.
//   * Import + rebuild → session → first-choice end-to-end.

import http from 'node:http';

import { server } from '../src/server.mjs';
import { storyFixtures } from '../src/server.mjs';

const PICK = await new Promise((resolve, reject) => {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
  probe.on('error', reject);
});

const baseUrl = `http://127.0.0.1:${PICK}`;
let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`);
  }
}

await new Promise((resolve) => server.listen(PICK, '127.0.0.1', resolve));
try {
  // ------------------------------------------------------------------
  // Backward compatibility guard: the existing demo endpoints still work.
  // ------------------------------------------------------------------
  {
    const res = await fetch(`${baseUrl}/api/health`);
    const data = await res.json();
    check('GET /api/health still 200', res.status === 200);
    check('phase bumped to 4', data.phase === 4, `phase=${data.phase}`);
    check('demo flag still demo', data.demo?.official_zhihu_api === false);
  }
  {
    const res = await fetch(`${baseUrl}/api/stories`);
    const data = await res.json();
    check('GET /api/stories still 200', res.status === 200);
    check('stories still a non-empty array', Array.isArray(data.stories) && data.stories.length >= 2);
  }
  {
    const res = await fetch(`${baseUrl}/api/stories/cafe-rain`);
    check('GET /api/stories/cafe-rain still 200', res.status === 200);
  }

  // ------------------------------------------------------------------
  // /api/admin/stories — catalogue with story_uuid + version list.
  // ------------------------------------------------------------------
  let cafeFixture;
  {
    const res = await fetch(`${baseUrl}/api/admin/stories`);
    const data = await res.json();
    check('GET /api/admin/stories 200', res.status === 200);
    check('response carries DEV_FLAG', data.dev?.dev_only === true);
    check('admin response carries DEMO_FLAG', data.demo?.official_zhihu_api === false);
    check('admin lists at least 2 stories', Array.isArray(data.stories) && data.stories.length >= 2);
    cafeFixture = data.stories.find((s) => s.slug === 'cafe-rain');
    check('cafe-rain fixture present', !!cafeFixture);
    check('cafe-rain has at least one version', cafeFixture && cafeFixture.versions.length >= 1);
  }

  // ------------------------------------------------------------------
  // /api/admin/opening-cache/rebuild — idempotent + new-generation.
  // ------------------------------------------------------------------
  let firstCacheUuid;
  {
    const res = await fetch(`${baseUrl}/api/admin/opening-cache/rebuild`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ story_version_uuid: cafeFixture.versions[0].story_version_uuid }),
    });
    const data = await res.json();
    check('POST rebuild (default profile) 200', res.status === 200, `status=${res.status}`);
    check('rebuild response carries dev flag', data.dev?.dev_only === true);
    check('rebuild result.cache present', !!data.result?.cache);
    firstCacheUuid = data.result?.cache?.cache_uuid;
  }
  {
    const res = await fetch(`${baseUrl}/api/admin/opening-cache/rebuild`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ story_version_uuid: cafeFixture.versions[0].story_version_uuid }),
    });
    const data = await res.json();
    check('rebuild twice with same profile is idempotent', data.result?.cache?.cache_uuid === firstCacheUuid);
  }
  {
    const res = await fetch(`${baseUrl}/api/admin/opening-cache/rebuild`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        story_version_uuid: cafeFixture.versions[0].story_version_uuid,
        profile: {
          identifier: 'opening-default',
          rules_version: 'opening-rules/2',
          locale: 'zh-CN',
        },
      }),
    });
    const data = await res.json();
    check('rebuild with new rules_version creates new row', data.result?.cache?.cache_uuid !== firstCacheUuid);
  }

  // ------------------------------------------------------------------
  // /api/dev/sessions — startSessionSnapshot.
  // ------------------------------------------------------------------
  let snapshot;
  {
    const res = await fetch(`${baseUrl}/api/dev/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_uuid: '00000000-0000-4000-8000-aaaaaaaaaaaa',
        story_uuid: cafeFixture.story_uuid,
        story_version_uuid: cafeFixture.versions[0].story_version_uuid,
        user_ref: 'alice',
        role_id: 'stranger',
      }),
    });
    const data = await res.json();
    check('POST /api/dev/sessions 200', res.status === 200);
    check('snapshot pins story_version_uuid', data.snapshot?.story_version_uuid === cafeFixture.versions[0].story_version_uuid);
    check('snapshot has opening_cache_uuid', !!data.snapshot?.opening_cache_uuid);
    snapshot = data.snapshot;
  }

  // Missing field returns 400.
  {
    const res = await fetch(`${baseUrl}/api/dev/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_uuid: '00000000-0000-4000-8000-aaaaaaaaaaab',
        story_uuid: cafeFixture.story_uuid,
        story_version_uuid: cafeFixture.versions[0].story_version_uuid,
        user_ref: 'bob',
        // role_id intentionally missing
      }),
    });
    check('POST /api/dev/sessions missing field 400', res.status === 400, `status=${res.status}`);
  }

  // ------------------------------------------------------------------
  // /api/dev/sessions/:uuid/first-choice — invalidate opening cache.
  // ------------------------------------------------------------------
  {
    const res = await fetch(
      `${baseUrl}/api/dev/sessions/00000000-0000-4000-8000-aaaaaaaaaaaa/first-choice`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ snapshot }),
      },
    );
    const data = await res.json();
    check('POST first-choice 200', res.status === 200);
    check('first-choice result is invalidated', data.result?.status === 'invalidated');
    check('first-choice reason is first_ask_player_choice', data.result?.invalidated_reason === 'first_ask_player_choice');
  }

  // ------------------------------------------------------------------
  // /api/admin/stories/:slug/import — reuse vs new version.
  // ------------------------------------------------------------------
  {
    const res = await fetch(`${baseUrl}/api/admin/stories/cafe-rain/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ story_uuid: cafeFixture.story_uuid }),
    });
    const data = await res.json();
    check('POST import (same content) 200', res.status === 200);
    check('import same content reuses version', data.result?.version_reused === true);
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}

if (failures > 0) {
  console.error(`\n${failures} admin-route check(s) failed`);
  process.exit(1);
}
console.log(`\nall admin-route checks passed`);