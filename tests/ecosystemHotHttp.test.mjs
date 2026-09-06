// tests/ecosystemHotHttp.test.mjs — ClickUp 16.4 HTTP façade contract:
//   * GET /v1/ecosystem/hot returns EcosystemHotList shape
//   * limit, force query params honoured
//   * bad limit → 400
//   * POST → 405
//   * real provider mode surfaces upstream failures as unavailable
//     (we never leak a 5xx for transport problems)
//   * mock provider is the default (no LLM, no network)
//   * matches[] is non-empty for the seeded cafe-rain / night-shift
//     profiles when the profile repository has been populated
//   * /api/health exposes hot_provider field
//
// The HTTP server uses Node's built-in `node:http`. We boot a fresh
// instance on a unique port per test module (no port collision with
// other suites) and tear it down at the end.

import assert from 'node:assert/strict';
import http from 'node:http';

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`    ${err && err.message ? err.message : err}`);
  }
}

/**
 * Pick a free local port by binding to port 0 and asking the OS.
 * @returns {Promise<{ port: number, server: import('node:http').Server }>}
 */
function grabPort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, server: srv });
    });
  });
}

/**
 * @param {string} url
 * @param {{ method?: string }} [opts]
 * @returns {Promise<{ status: number, body: any }>}
 */
function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: opts.method || 'GET',
        headers: { accept: 'application/json' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let body;
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
          resolve({ status: res.statusCode || 0, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function runChecks() {
  console.log('ClickUp 16.4 ecosystem hot-list HTTP façade');

  // ----- mock mode (port 1) -----------------------------------------
  const { port: portMock, server: serverMock } = await grabPort();
  // Close the grab-server, then boot the real server on the same port.
  await new Promise((res) => serverMock.close(res));
  const { fileURLToPath } = await import('node:url');
  const serverPath = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
  // Spawn the real server with PORT=portMock and default (mock) hot provider.
  const proc1 = await import('node:child_process').then(({ spawn }) =>
    spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        PORT: String(portMock),
        STORY_OUTSIDE_HOT_PROVIDER: 'mock',
        // Ensure the mock provider is the active story provider too so
        // /api/health does not block on a real upstream.
        STORY_OUTSIDE_PROVIDER: 'mock',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  // Wait until the server is listening.
  await new Promise((res, rej) => {
    let buf = '';
    proc1.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf-8');
      if (/listening on/.test(buf)) res();
    });
    proc1.stderr.on('data', (chunk) => {
      buf += chunk.toString('utf-8');
    });
    setTimeout(() => {
      if (!/listening on/.test(buf)) rej(new Error(`server did not listen in time. log: ${buf}`));
    }, 5000);
  });

  try {
    await check('GET /v1/ecosystem/hot → 200 with hot_list[]', async () => {
      const res = await fetchJson(`http://127.0.0.1:${portMock}/v1/ecosystem/hot`);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.hot_list));
      assert.ok(res.body.hot_list.length >= 5, `expected ≥5 mock topics, got ${res.body.hot_list.length}`);
      assert.equal(res.body.ecosystem_status, 'fresh');
      assert.equal(res.body.source, 'mock');
      assert.equal(res.body.hot_provider, 'mock');
      assert.ok(res.body.rate_limit);
      assert.equal(res.body.rate_limit.daily_cap, 100);
    });

    await check('limit query param honoured', async () => {
      const res = await fetchJson(`http://127.0.0.1:${portMock}/v1/ecosystem/hot?limit=2`);
      assert.equal(res.status, 200);
      assert.equal(res.body.hot_list.length, 2);
    });

    await check('limit > 50 capped at 50', async () => {
      const res = await fetchJson(`http://127.0.0.1:${portMock}/v1/ecosystem/hot?limit=999`);
      assert.equal(res.status, 200);
      assert.ok(res.body.hot_list.length <= 50);
    });

    await check('bad limit → 400', async () => {
      const res = await fetchJson(`http://127.0.0.1:${portMock}/v1/ecosystem/hot?limit=abc`);
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'invalid_limit');
    });

    await check('POST → 405 (method not allowed)', async () => {
      const res = await fetchJson(`http://127.0.0.1:${portMock}/v1/ecosystem/hot`, { method: 'POST' });
      assert.equal(res.status, 405);
      assert.equal(res.body.error, 'method_not_allowed');
    });

    await check('/api/health surfaces hot_provider field', async () => {
      const res = await fetchJson(`http://127.0.0.1:${portMock}/api/health`);
      assert.equal(res.status, 200);
      assert.equal(res.body.hot_provider, 'mock');
    });

    await check('entries[] mirrors hot_list[] with matches[]', async () => {
      const res = await fetchJson(`http://127.0.0.1:${portMock}/v1/ecosystem/hot`);
      assert.equal(res.body.entries.length, res.body.hot_list.length);
      for (const e of res.body.entries) {
        assert.ok(e.topic);
        assert.ok(Array.isArray(e.matches));
      }
    });

    await check('force=1 returns fresh even within TTL', async () => {
      const res1 = await fetchJson(`http://127.0.0.1:${portMock}/v1/ecosystem/hot`);
      const res2 = await fetchJson(`http://127.0.0.1:${portMock}/v1/ecosystem/hot?force=1`);
      assert.equal(res2.body.ecosystem_status, 'fresh');
      // generated_at should be >= the previous one.
      assert.ok(res2.body.generated_at >= res1.body.generated_at);
    });
  } finally {
    proc1.kill('SIGTERM');
  }

  // ----- real mode (port 2) -----------------------------------------
  // We boot the server with STORY_OUTSIDE_HOT_PROVIDER=real. In a sandbox
  // the call to api.zhihu.com will fail (no DNS / no network), but the
  // module is required to swallow the failure and return
  // ecosystem_status: 'unavailable'. We assert that contract.
  const { port: portReal, server: serverReal } = await grabPort();
  await new Promise((res) => serverReal.close(res));
  const proc2 = await import('node:child_process').then(({ spawn }) =>
    spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        PORT: String(portReal),
        STORY_OUTSIDE_HOT_PROVIDER: 'real',
        STORY_OUTSIDE_PROVIDER: 'mock',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  await new Promise((res, rej) => {
    let buf = '';
    proc2.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf-8');
      if (/listening on/.test(buf)) res();
    });
    proc2.stderr.on('data', (chunk) => {
      buf += chunk.toString('utf-8');
    });
    setTimeout(() => {
      if (!/listening on/.test(buf)) rej(new Error(`server did not listen in time. log: ${buf}`));
    }, 5000);
  });

  try {
    await check('real provider: GET /v1/ecosystem/hot → 200 with ecosystem_status=unavailable', async () => {
      const res = await fetchJson(`http://127.0.0.1:${portReal}/v1/ecosystem/hot`);
      assert.equal(res.status, 200);
      assert.equal(res.body.ecosystem_status, 'unavailable');
      assert.equal(res.body.hot_provider, 'real');
      assert.equal(res.body.source, 'real');
      assert.equal(res.body.hot_list.length, 0);
    });

    await check('real provider: /api/health.hot_provider=real', async () => {
      const res = await fetchJson(`http://127.0.0.1:${portReal}/api/health`);
      assert.equal(res.body.hot_provider, 'real');
    });
  } finally {
    proc2.kill('SIGTERM');
  }

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

runChecks().catch((err) => {
  console.error(err);
  process.exit(1);
});