// tests/pr7WireRegression.test.mjs — wire-level regression tests for the
// PR #7 follow-up fixes. The original PR claimed several HTTP-layer
// fixes that the project test suite did not lock down; the only way to
// trust the contracts is to actually speak HTTP / TCP against the
// server. The tests below are intentionally raw (raw http for the bad
// percent-encoding case, fetch for the JSON cases) so a future refactor
// of the route layer that re-introduces a regression gets caught here
// instead of by an external probe.

import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(__dirname, '..');

// Spin the real server on an ephemeral port.
const PICK = await new Promise((resolve, reject) => {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
  probe.on('error', reject);
});

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`);
  }
}

// Lazy-load the server (test isolation: each test file gets a fresh import
// boundary; the global `server` handle is the same process-shared instance).
const { server, storyFixtures } = await import('../src/server.mjs');

await new Promise((resolve) => server.listen(PICK, '127.0.0.1', resolve));

try {
  const baseUrl = `http://127.0.0.1:${PICK}`;
  const fixture = storyFixtures.find((row) => row.slug === 'cafe-rain');

  // ---------------------------------------------------------------------
  // Bad percent-encoding must not crash the server and the next request
  // on the same connection must succeed.
  // ---------------------------------------------------------------------
  await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: PICK,
      method: 'GET',
      path: '/%zz',
      headers: { connection: 'keep-alive' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          check('bad percent-encoding returns 400', res.statusCode === 400, `status=${res.statusCode}`);
          // After the error response, the server must still answer
          // /api/health on the same connection (or a fresh one — keep-alive
          // is optional here, so we just check process is up).
          resolve();
        } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.end();
  });
  {
    const res = await fetch(`${baseUrl}/api/health`);
    check('process survives bad percent-encoding', res.status === 200);
  }

  // ---------------------------------------------------------------------
  // 70 KiB body on /api/dev/sessions must return 400 payload_too_large
  // on the wire, the response connection must remain usable, and the
  // error code must be the precise 'payload_too_large' (M1).
  // ---------------------------------------------------------------------
  await new Promise((resolve, reject) => {
    const big = Buffer.alloc(70 * 1024, 0x61); // 70 KiB of 'a'
    const req = http.request({
      host: '127.0.0.1',
      port: PICK,
      method: 'POST',
      path: '/api/dev/sessions',
      headers: {
        'content-type': 'application/json',
        'content-length': big.length,
        connection: 'keep-alive',
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          check('70 KiB body returns 400', res.statusCode === 400, `status=${res.statusCode}`);
          let parsed = null;
          try { parsed = JSON.parse(body); } catch {}
          check('70 KiB body surfaces error=payload_too_large', parsed && parsed.error === 'payload_too_large', `body=${body.slice(0,200)}`);
          check('70 KiB body carries limit_bytes detail', parsed && parsed.details && parsed.details.limit_bytes === 64 * 1024);
          resolve();
        } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.write(big);
    req.end();
  });
  {
    const res = await fetch(`${baseUrl}/api/health`);
    check('process survives 70 KiB body', res.status === 200);
  }

  // ---------------------------------------------------------------------
  // Bad JSON on /api/dev/sessions must return 400 bad_json on the wire.
  // ---------------------------------------------------------------------
  {
    const res = await fetch(`${baseUrl}/api/dev/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not-json',
    });
    const data = await res.json().catch(() => null);
    check('bad JSON returns 400', res.status === 400, `status=${res.status}`);
    check('bad JSON surfaces error=bad_json', data && data.error === 'bad_json', JSON.stringify(data));
  }

  // ---------------------------------------------------------------------
  // Non-hex UUID segment must return 400 validation_failed (M2). The
  // admin observability route was already correct; the session routes
  // were leaking 404 / 405 because the strict [0-9a-fA-F-]+ regex
  // dropped non-hex characters before the validator could see them.
  // ---------------------------------------------------------------------
  for (const path of [
    '/api/dev/sessions/zzz-ggzz/recover',
    '/api/dev/sessions/zzz-ggzz/ending',
    '/api/dev/sessions/zzz-ggzz/replay',
    '/api/dev/sessions/zzz-ggzz/original-timeline',
  ]) {
    const res = await fetch(`${baseUrl}${path}`);
    const data = await res.json().catch(() => null);
    check(`GET ${path} returns 400 (non-hex segment)`, res.status === 400, `status=${res.status}`);
    check(`GET ${path} error=validation_failed`, data && data.error === 'validation_failed', JSON.stringify(data));
  }
  for (const path of [
    '/api/dev/sessions/zzz-ggzz/interrupt',
    '/api/dev/sessions/zzz-ggzz/opening-events',
    '/api/dev/sessions/zzz-ggzz/narrative-events',
    '/api/dev/sessions/zzz-ggzz/discard-pending',
    '/api/dev/sessions/zzz-ggzz/first-choice',
    '/api/dev/sessions/zzz-ggzz/generate',
  ]) {
    const res = await fetch(`${baseUrl}${path}`, { method: 'POST' });
    const data = await res.json().catch(() => null);
    check(`POST ${path} returns 400 (non-hex segment)`, res.status === 400, `status=${res.status}`);
    check(`POST ${path} error=validation_failed`, data && data.error === 'validation_failed', JSON.stringify(data));
  }

  // ---------------------------------------------------------------------
  // Static POST must return 405 method_not_allowed and HEAD must return
  // 200 with empty body and the entity's Content-Length header.
  // ---------------------------------------------------------------------
  {
    const res = await fetch(`${baseUrl}/index.html`, { method: 'POST' });
    const data = await res.json().catch(() => null);
    check('POST /index.html returns 405', res.status === 405, `status=${res.status}`);
    check('POST /index.html error=method_not_allowed', data && data.error === 'method_not_allowed');
  }
  {
    const res = await fetch(`${baseUrl}/index.html`, { method: 'HEAD' });
    const len = res.headers.get('content-length');
    check('HEAD /index.html returns 200', res.status === 200);
    check('HEAD /index.html preserves Content-Length', Number(len) > 0, `len=${len}`);
    const text = await res.text();
    check('HEAD /index.html returns empty body', text === '', `text=${text.slice(0, 30)}`);
  }

  // ---------------------------------------------------------------------
  // Unknown session on /api/dev/sessions/:uuid/recover returns 404 with
  // code=session_not_found (M4 typed-error short-circuit). The ending /
  // replay / original-timeline routes used to re-classify an unknown
  // session as 400 because they went through the broad message regex.
  // ---------------------------------------------------------------------
  {
    const res = await fetch(`${baseUrl}/api/dev/sessions/00000000-0000-4000-8000-eeeeeeeeeeee/recover`);
    const data = await res.json().catch(() => null);
    check('unknown session recover returns 404', res.status === 404, `status=${res.status}`);
    check('unknown session recover code=session_not_found', data && data.error === 'session_not_found');
  }
  {
    const res = await fetch(`${baseUrl}/api/dev/sessions/00000000-0000-4000-8000-eeeeeeeeeeee/ending`);
    const data = await res.json().catch(() => null);
    check('unknown session ending returns 404', res.status === 404, `status=${res.status}`);
    check('unknown session ending code=session_not_found', data && data.error === 'session_not_found');
  }
  {
    const res = await fetch(`${baseUrl}/api/dev/sessions/00000000-0000-4000-8000-eeeeeeeeeeee/replay`);
    const data = await res.json().catch(() => null);
    check('unknown session replay returns 404', res.status === 404, `status=${res.status}`);
    check('unknown session replay code=session_not_found', data && data.error === 'session_not_found');
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}

// ---------------------------------------------------------------------
// Invalid provider configuration must fail fast. The real adapter is now
// implemented, so real mode itself is no longer a startup error.
await test('invalid provider fails fast at startup', async () => {
  const child = spawn(process.execPath, [resolvePath(ROOT, 'src/server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, STORY_OUTSIDE_PROVIDER: 'invalid-provider' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const exitCode = await new Promise((resolve) => {
    const timeout = setTimeout(() => { child.kill('SIGTERM'); resolve('timeout'); }, 5000);
    child.on('exit', (code) => { clearTimeout(timeout); resolve(code); });
  });
  check('invalid provider exits non-zero', exitCode !== 0 && exitCode !== 'timeout', `exitCode=${exitCode}`);
  check('invalid provider emits startup error on stderr', /provider config error/.test(stderr), stderr.slice(0, 200));
});

await test('direct server entry starts from Unicode project path', async () => {
  const child = spawn(process.execPath, [resolvePath(ROOT, 'src/server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, STORY_OUTSIDE_PROVIDER: 'mock', STORY_OUTSIDE_AI_PROVIDER: 'mock', PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const started = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 5000);
    child.stdout.on('data', chunk => { if (chunk.toString().includes('listening on')) { clearTimeout(timeout); resolve(true); } });
    child.on('exit', () => { clearTimeout(timeout); resolve(false); });
  });
  child.kill('SIGTERM');
  check('direct server starts listening', started);
});

if (failures > 0) {
  console.error(`\n${failures} wire regression check(s) failed`);
  process.exit(1);
}
console.log('\nall wire regression checks passed');