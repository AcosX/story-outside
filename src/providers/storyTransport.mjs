// Transport is opt-in and restricted to the unauthenticated story API.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink, readdir, stat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { warn } from '../observability/logger.mjs';

const run = promisify(execFile);
const PREFIX = 'https://api.zhihu.com/km-indep-home/hackathon/v2/story/';
const MAX_BYTES = 1024 * 1024;
const MAX_ENTRIES = 256;
const HEADERS = { accept: 'application/json', 'user-agent': 'story-outside/0.1 (zhihu-hackathon-2026-p2; read-only)' };

export function storyTransportId(url) {
  if (typeof url !== 'string' || !url.startsWith(PREFIX)) throw new Error('Unsupported story URL');
  const u = new URL(url);
  if (u.search || u.hash || u.username || u.password) throw new Error('Unsupported story URL');
  const id = decodeURIComponent(url.slice(PREFIX.length));
  if (!id || id.trim() !== id || id.length > 128 || /[/?#\x00-\x1f\x7f]/u.test(id) || id === '.' || id === '..') throw new Error('Unsupported story ID');
  return id;
}

async function bodyText(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('Oversized response');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty response');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('Oversized response');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}

export function sshStoryFetch(host, runner = run) {
  if (!/^(?:[a-z_][a-z0-9_-]*@)?[a-z0-9][a-z0-9.-]*$/i.test(host)) throw new Error('Invalid story SSH host');
  return async (url) => {
    const arg = Buffer.from(storyTransportId(url)).toString('base64url');
    // The command and argument alphabet are fixed; no URL, headers or secrets
    // from the incoming request are interpolated into the remote shell.
    const { stdout } = await runner('/usr/bin/ssh', [
      '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', 'ConnectTimeout=3', '-o', 'ConnectionAttempts=1',
      '-o', 'ServerAliveInterval=3', '-o', 'ServerAliveCountMax=1', host,
      `/usr/local/libexec/story-outside-zhihu-get.py ${arg}`,
    ], { timeout: 9000, killSignal: 'SIGKILL', maxBuffer: MAX_BYTES + 1024, encoding: 'utf8' });
    const split = stdout.lastIndexOf('\n');
    const status = Number(stdout.slice(split + 1));
    if (split < 0 || !Number.isInteger(status) || status < 200 || status > 599) throw new Error('Invalid relay response');
    return new Response(stdout.slice(0, split), { status, headers: { 'content-type': 'application/json' } });
  };
}

export function createStoryTransport({ direct = globalThis.fetch, alternate, cacheDir, validate, now = Date.now } = {}) {
  if (!alternate && !cacheDir) return direct;
  if (cacheDir && !isAbsolute(cacheDir)) throw new Error('Story cache directory must be absolute');
  if (typeof validate !== 'function') throw new Error('Story response validator is required');
  let blockedUntil = 0;
  let writes = Promise.resolve();
  const inflight = new Map();
  const log = (event) => warn(event, { component: 'storyTransport' });
  const filename = (url) => join(cacheDir, `${createHash('sha256').update(url).digest('hex')}.json`);
  const response = (text) => new Response(text, { headers: { 'content-type': 'application/json' } });
  const checked = (url, text) => { validate(storyTransportId(url), JSON.parse(text)); return text; };

  async function save(url, text) {
    if (!cacheDir) return;
    const operation = writes.then(async () => {
      await mkdir(cacheDir, { recursive: true, mode: 0o700 });
      const file = filename(url);
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temp, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ version: 1, url, savedAt: now(), payload: JSON.parse(text) })); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temp, file);
        const dir = await open(cacheDir, 'r');
        try { await dir.sync(); } finally { await dir.close(); }
        const names = (await readdir(cacheDir)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
        if (names.length > MAX_ENTRIES) {
          const entries = await Promise.all(names.map(async (name) => ({ name, at: (await stat(join(cacheDir, name))).mtimeMs })));
          entries.sort((a, b) => a.at - b.at);
          const listName = filename(`${PREFIX}list`);
          const evictable = entries.filter((entry) => join(cacheDir, entry.name) !== listName);
          for (const entry of evictable.slice(0, entries.length - MAX_ENTRIES)) await unlink(join(cacheDir, entry.name));
        }
      } finally { await unlink(temp).catch(() => {}); }
    });
    writes = operation.catch(() => { log('stories.transport.cache_write_failed'); });
    await writes;
  }

  async function cached(url) {
    if (!cacheDir) return null;
    try {
      const handle = await open(filename(url), 'r');
      let data;
      try {
        // JSON escaping can expand the original text; keep the disk read bounded.
        if ((await handle.stat()).size > MAX_BYTES * 6 + 4096) throw new Error('Oversized cache');
        data = JSON.parse(await handle.readFile('utf8'));
      } finally { await handle.close(); }
      if (data.version !== 1 || data.url !== url || !Number.isFinite(data.savedAt)) throw new Error('Invalid cache');
      const text = JSON.stringify(data.payload);
      if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Oversized cached payload');
      checked(url, text);
      log('stories.transport.disk_stale_served');
      return response(text);
    } catch (error) { if (error.code !== 'ENOENT') log('stories.transport.cache_read_failed'); return null; }
  }

  async function fetchOne(url) {
    let original;
    let failure;
    let mayRelay = true;
    if (now() >= blockedUntil || !alternate) {
      try {
        original = await direct(url, { method: 'GET', headers: HEADERS, redirect: 'manual', signal: AbortSignal.timeout(4000) });
        if (original.status === 200) {
          const text = checked(url, await bodyText(original));
          await save(url, text);
          return response(text);
        }
        // No alternate traffic on rate limits, missing works or redirects.
        mayRelay = original.status === 403 || original.status >= 500;
        if (!mayRelay && original.status !== 429) return original;
        if (mayRelay) blockedUntil = now() + 60_000;
      } catch { failure = new Error('Story primary request failed'); blockedUntil = now() + 60_000; }
    }
    if (alternate && mayRelay) {
      try {
        const result = await alternate(url);
        if (result.status === 200) {
          const text = checked(url, await bodyText(result));
          await save(url, text);
          await original?.body?.cancel().catch(() => {});
          log('stories.transport.alternate_success');
          return response(text);
        }
        await result.body?.cancel();
      } catch { /* Cache remains eligible when SSH, TLS or validation fails. */ }
      log('stories.transport.alternate_failed');
    }
    const hit = await cached(url);
    if (hit) { await original?.body?.cancel().catch(() => {}); return hit; }
    if (original && !original.bodyUsed) return original;
    throw failure || new Error('Story upstream unavailable');
  }

  return async (url, init = {}) => {
    storyTransportId(url);
    if (init.method && init.method !== 'GET') throw new Error('Only story GET is allowed');
    if (inflight.has(url)) return (await inflight.get(url)).clone();
    // Bound distinct concurrent SSH processes and disk buffers; provider stale
    // caches can still satisfy excess callers without spawning extra processes.
    if (inflight.size >= 4) {
      const hit = await cached(url);
      if (hit) return hit;
      throw new Error('Story transport busy');
    }
    const pending = fetchOne(url);
    inflight.set(url, pending);
    try { return (await pending).clone(); }
    finally { inflight.delete(url); }
  };
}

export function storyTransportFromEnv(validate) {
  const host = process.env.STORY_OUTSIDE_STORY_SSH_HOST;
  return createStoryTransport({
    direct: globalThis[Symbol.for('story-outside.story-transport.original-fetch')] || globalThis.fetch,
    alternate: host ? sshStoryFetch(host) : undefined,
    cacheDir: process.env.STORY_OUTSIDE_STORY_CACHE_DIR,
    validate,
  });
}
