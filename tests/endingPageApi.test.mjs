// tests/endingPageApi.test.mjs — ClickUp 16.2 review fix (ChatGPT P1):
//
//   * `endingPage.js` `api(path, options = {})` MUST actually pass
//     options to fetch. The previous signature dropped options
//     silently — POST bodies were ignored, so fetchEcosystemDiscussions
//     fell back to GET and the server returned 405.
//
//   * `endingPage.js` MUST NOT contain any reference to `/api/admin/`
//     or `/api/dev/` (static contract guard inherited from PR #17).
//
//   * The relatedDiscussions block is wired only when an ending has
//     enough text to derive a query, and never breaks the page when
//     the ecosystem search endpoint is unavailable.
//
// We use a child-process harness to load endingPage.js with a fake
// `document` and `fetch` (the module touches the DOM during import).

import assert_ from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, '..');
const ENDING_PAGE_PATH = resolvePath(REPO_ROOT, 'public', 'scripts', 'endingPage.js');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`);
  }
}

// ---------------------------------------------------------------------
// 1) Static guards.
// ---------------------------------------------------------------------
{
  const cmd = `grep -rE "/api/(admin|dev)/" ${REPO_ROOT}/public --include="*.js" || true`;
  const out = execSync(cmd, { encoding: 'utf8' });
  check(
    'static guard: public/**/*.js does NOT reference /api/admin/ or /api/dev/',
    out.trim() === '',
    `unexpected matches:\n${out}`,
  );
}

// ---------------------------------------------------------------------
// 2) Source-level inspection — api() must accept options.
// ---------------------------------------------------------------------
{
  const src = readFileSync(ENDING_PAGE_PATH, 'utf8');
  check(
    'endingPage.js declares `api(path, options = {})`',
    /async\s+function\s+api\s*\(\s*path\s*,\s*options\s*=\s*\{\s*\}\s*\)/.test(src),
  );
  check(
    'endingPage.js api() body actually references `options`',
    /\bopts\.body\b|\boptions\.body\b|\bopts\.method\b|\boptions\.method\b|\bopts\.headers\b/.test(src),
  );
  check(
    'endingPage.js api() body calls fetch() with computed options (not just path)',
    /fetch\(\s*path\s*,\s*[A-Za-z_$][\w$]*\b/.test(src),
  );
}

// ---------------------------------------------------------------------
// 3) Behavioural harness via child process.
// ---------------------------------------------------------------------
const harness = `
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import assert_ from 'node:assert/strict';

const ENDING_PAGE_PATH = ${JSON.stringify(ENDING_PAGE_PATH)};

const fakeDoc = {
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({
    _children: [], classList: { toggle: () => {} }, dataset: {}, children: [],
    appendChild: function (c) { this._children.push(c); },
    removeChild: () => {}, setAttribute: () => {},
    addEventListener: () => {}, style: {}, textContent: '', className: '',
  }),
  createTextNode: (s) => ({ textContent: s }),
};
globalThis.document = fakeDoc;
globalThis.window = globalThis;

const src = readFileSync(ENDING_PAGE_PATH, 'utf8');
const exposedSrc = src + '\\nexport { api, fetchEcosystemDiscussions, pickRelatedDiscussions, buildEcosystemQuery };\\n';
const tmpPath = ENDING_PAGE_PATH.replace(/endingPage\\.js\$/, '__ending_test_wrapper.mjs');
writeFileSync(tmpPath, exposedSrc);
const mod = await import(tmpPath);

const failures = [];
function check(name, ok, detail = '') {
  if (ok) console.log('  ok   ' + name);
  else { failures.push(name + (detail ? ' (' + detail + ')' : '')); console.log('  FAIL ' + name + (detail ? ' (' + detail + ')' : '')); }
}

// Test 1: api(path, options) — POST with body must actually pass body.
let receivedMethod = null;
let receivedHeaders = null;
let receivedBody = null;
globalThis.fetch = async (url, options) => {
  receivedMethod = options && options.method ? options.method : 'GET';
  receivedHeaders = options && options.headers ? options.headers : {};
  receivedBody = options && options.body !== undefined ? options.body : null;
  return {
    ok: true, status: 200,
    json: async () => ({ ok: true }),
  };
};
await mod.api('/v1/ecosystem/discussions', { method: 'POST', body: { query: 'foo' }, headers: { 'content-type': 'application/json' } });
check('api() default method is POST when body is provided', receivedMethod === 'POST');
check('api() forwards the body stringified', typeof receivedBody === 'string' && JSON.parse(receivedBody).query === 'foo');
check('api() forwards caller-provided content-type', receivedHeaders['content-type'] === 'application/json');

// Test 2: api(path) — GET with no body, no content-type.
receivedMethod = null; receivedBody = null;
await mod.api('/some/path');
check('api() default method is GET when no body', receivedMethod === 'GET');
check('api() does NOT send a body on plain GET', receivedBody === null);

// Test 3: api() honors explicit method=GET even when caller might forget.
receivedMethod = null;
await mod.api('/foo', { method: 'GET' });
check('api() honors caller-supplied method=GET', receivedMethod === 'GET');

// Test 4: api() surfaces non-2xx as a thrown error.
globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'bad_request', message: 'nope' }) });
let thrown = null;
try { await mod.api('/foo'); } catch (e) { thrown = e; }
check('api() throws on non-2xx', !!thrown && thrown.code === 'bad_request' && thrown.status === 400);

// Test 5: fetchEcosystemDiscussions calls api() with POST + body.
let lastCall = null;
globalThis.fetch = async (url, options) => {
  lastCall = { url, options };
  return { ok: true, status: 200, json: async () => ({ discussions: [], provenance: 'cache', ecosystem_status: 'ok' }) };
};
await mod.fetchEcosystemDiscussions({ query: 'foo bar', story_version_uuid: '11111111-2222-3333-4444-555555555555', community_profile_version: 'v1' });
check('fetchEcosystemDiscussions POSTs to /v1/ecosystem/discussions', lastCall.url === '/v1/ecosystem/discussions');
check('fetchEcosystemDiscussions uses POST method', lastCall.options.method === 'POST');
const sentBody = JSON.parse(lastCall.options.body);
check('fetchEcosystemDiscussions body carries the query', sentBody.query === 'foo bar');
check('fetchEcosystemDiscussions body carries community_profile_version', sentBody.community_profile_version === 'v1');
check('fetchEcosystemDiscussions body carries story_version_uuid', sentBody.story_version_uuid === '11111111-2222-3333-4444-555555555555');

// Test 6: pickRelatedDiscussions uses keyword overlap (no LLM call).
const fake = [
  { thread_uuid: 'a', title: 'foo bar baz', snippet: 'contains foo', url: 'https://www.zhihu.com/x/1', score: 100, source: 'mock' },
  { thread_uuid: 'b', title: 'unrelated', snippet: 'nothing matches', url: 'https://www.zhihu.com/x/2', score: 50, source: 'mock' },
  { thread_uuid: 'c', title: 'bar', snippet: 'foo and bar', url: 'https://www.zhihu.com/x/3', score: 80, source: 'mock' },
];
const ranked = mod.pickRelatedDiscussions({ ending_title: 'foo bar', ending_summary: 'baz' }, fake);
check('pickRelatedDiscussions returns an array', Array.isArray(ranked));
check('pickRelatedDiscussions prefers foo-bearing entries', ranked[0].thread_uuid === 'a' || ranked[0].thread_uuid === 'c');
check('pickRelatedDiscussions never returns LLM call markers', !ranked.some((d) => d.llm || d.prompt));

// Test 7: buildEcosystemQuery joins ending title + first key choice.
const q = mod.buildEcosystemQuery({
  ending_title: '结局A',
  key_choices: ['choice1', 'choice2'],
  character_outcomes: [{ label: '角色X' }],
});
check('buildEcosystemQuery joins title + first choice + first outcome', q.includes('结局A') && q.includes('choice1') && q.includes('角色X'));

// Test 8: fetchEcosystemDiscussions gracefully degrades on 500.
globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'oops' }) });
const degraded = await mod.fetchEcosystemDiscussions({ query: 'foo' });
check('fetchEcosystemDiscussions degrades on 500 (returns unavailable shape)', degraded && degraded.provenance === 'unavailable' && Array.isArray(degraded.discussions));

try { unlinkSync(tmpPath); } catch {}
if (failures.length > 0) { console.error('FAILURES=' + failures.length); process.exit(1); }
else { console.log('ALL_OK endingPageApi.test.mjs'); }
`;

const harnessPath = resolvePath(__dirname, '__ending_behaviour_harness.mjs');
writeFileSync(harnessPath, harness);
const res = spawnSync(process.execPath, [harnessPath], { encoding: 'utf8' });
process.stdout.write(res.stdout || '');
if (res.stderr) process.stderr.write(res.stderr);
try { unlinkSync(harnessPath); } catch {}

if (res.status !== 0 || failures > 0) {
  console.error(`FAILURES=${failures} (harness exit=${res.status})`);
  process.exit(1);
} else {
  console.log('ALL_OK endingPageApi.test.mjs (parent)');
}
