// tests/http.test.mjs — HTTP integration test for the new provider seam.
// Spins the server on an ephemeral port, hits routes that now delegate to
// the provider, and asserts the demo flag, error mapping (404 unknown, 400
// validation), and shape compatibility with Phase 1.

import http from 'node:http';

import { server } from '../src/server.mjs';
import { setSink } from '../src/observability/logger.mjs';

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
  // /api/stories still 200 with demo flag and array
  {
    const res = await fetch(`${baseUrl}/api/stories`);
    const data = await res.json();
    check('GET /api/stories 200', res.status === 200);
    check('demo flag still demo.official_zhihu_api=false', data?.demo?.official_zhihu_api === false);
    check('stories is non-empty array', Array.isArray(data?.stories) && data.stories.length >= 1);
    check('stories do NOT leak beats', data.stories.every((s) => Array.isArray(s.roles) && s.beats === undefined));
  }

  // /api/stories/:id happy path
  {
    const res = await fetch(`${baseUrl}/api/stories/cafe-rain`);
    const data = await res.json();
    check('GET /api/stories/cafe-rain 200', res.status === 200);
    check('detail has beats', Array.isArray(data?.story?.beats) && data.story.beats.length >= 1);
    check('detail carries demo flag', data?.demo?.official_zhihu_api === false);
  }

  // /api/stories/:id 404 for unknown story — provider raises StoryNotFoundError
  {
    const res = await fetch(`${baseUrl}/api/stories/does-not-exist`);
    const data = await res.json();
    check('GET unknown story 404', res.status === 404, `status=${res.status}`);
    check('404 body has story_not_found code', data?.error === 'story_not_found');
    check('404 body still has demo flag', data?.demo?.official_zhihu_api === false);
  }

  // /api/stories/:id 400 for malformed id (route regex already guards this)
  {
    const res = await fetch(`${baseUrl}/api/stories/has%20space`);
    check('GET malformed story id 404 (route mismatch)', res.status === 404);
  }

  // /api/stories/advance happy path
  {
    const res = await fetch(`${baseUrl}/api/stories/advance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ storyId: 'cafe-rain', roleId: 'stranger', index: 0 }),
    });
    const data = await res.json();
    check('POST advance 200', res.status === 200);
    check('advance increments index', data?.index === 1 && typeof data?.beat === 'string');
    check('advance demo flag', data?.demo?.official_zhihu_api === false);
  }

  // /api/stories/advance 404 for unknown story
  {
    const res = await fetch(`${baseUrl}/api/stories/advance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ storyId: 'nope', index: 0 }),
    });
    const data = await res.json();
    check('POST advance unknown 404', res.status === 404, `status=${res.status}`);
    check('POST advance 404 has story_not_found code', data?.error === 'story_not_found');
  }

  // /api/stories/advance 400 for bad json
  {
    const res = await fetch(`${baseUrl}/api/stories/advance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    check('POST advance bad json 400', res.status === 400, `status=${res.status}`);
  }

  // /api/stories/advance 400 for negative index — provider validation
  {
    const res = await fetch(`${baseUrl}/api/stories/advance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ storyId: 'cafe-rain', index: -1 }),
    });
    const data = await res.json();
    check('POST advance negative index 400', res.status === 400, `status=${res.status}`);
    check('negative index error code is invalid_input', data?.error === 'invalid_input');
  }

  // /api/chat — unchanged path, still echoes with demo flag
  {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '你好' }),
    });
    const data = await res.json();
    check('POST /api/chat 200', res.status === 200);
    check('/api/chat demo flag', data?.demo?.official_zhihu_api === false);
  }

  // Catalog failures must leave a warn trace in the structured log.
  // Regression for the 2026-09-14 incident: /api/stories returned
  // upstream_4xx for ~22 minutes with zero journald evidence because the
  // route never logged provider errors. The mock provider's unknown-id
  // 404 exercises the same catch block.
  {
    const logLines = [];
    const previousSink = setSink((line) => logLines.push(line));
    let detailRes;
    try {
      detailRes = await fetch(`${baseUrl}/api/stories/does-not-exist`);
    } finally {
      setSink(previousSink);
    }
    check('GET unknown story still 404 (log test)', detailRes.status === 404, `status=${detailRes.status}`);
    const warnLine = logLines
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .find((record) => record && record.event === 'stories.request.failed');
    check('stories.request.failed warn emitted on provider error', Boolean(warnLine));
    check('warn carries error_code', warnLine && warnLine.error_code === 'story_not_found');
    check('warn carries route + upstream status in extra', warnLine
      && warnLine.extra && warnLine.extra.route === 'story_detail'
      && warnLine.extra.http_status === 404
      && warnLine.extra.upstream_status === null);
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}

if (failures > 0) {
  console.error(`\n${failures} http check(s) failed`);
  process.exit(1);
}
console.log(`\nall http checks passed`);