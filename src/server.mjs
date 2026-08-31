// Story Outside — minimal Node HTTP server (no framework).
// Serves static files from ./public and exposes a few JSON endpoints
// used by the home page demo flow. The endpoints are clearly marked as
// demo/mock — they do NOT call any official Zhihu API yet.
//
// Data layer: every /api/stories* route reads through src/providers/index.mjs.
// The active provider is selected at startup via STORY_OUTSIDE_PROVIDER
// (default: mock). Routes never call Zhihu APIs directly.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getStoryProvider,
  ProviderError,
  StoryNotFoundError,
  ValidationError,
} from './providers/index.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const PUBLIC_DIR = resolve(ROOT, 'public');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';

const DEMO_FLAG = Object.freeze({
  mode: 'demo',
  official_zhihu_api: false,
  reason:
    'Phase 2 builds an interactive narrative demo without touching the real Zhihu Open Platform. Data is served by src/providers/mockProvider.mjs (default STORY_OUTSIDE_PROVIDER=mock). See docs/official-zhihu-skill.md for the planned real-provider integration boundary.',
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text, 'utf-8');
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function serveStatic(req, res, urlPath) {
  let safePath = normalize(decodeURIComponent(urlPath.split('?')[0]));
  if (safePath === '/' || safePath === '') safePath = '/index.html';
  const absolutePath = join(PUBLIC_DIR, safePath);
  if (!absolutePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  try {
    const stats = await stat(absolutePath);
    if (!stats.isFile()) {
      sendText(res, 404, 'Not Found');
      return;
    }
    const data = await readFile(absolutePath);
    const ext = extname(absolutePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') sendText(res, 404, 'Not Found');
    else sendText(res, 500, 'Internal Server Error');
  }
}

async function readJsonBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 64 * 1024) {
        reject(new ValidationError('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolveBody({});
      try {
        resolveBody(JSON.parse(raw));
      } catch (err) {
        reject(new ValidationError('bad_json'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Map a ProviderError to an HTTP status code. Provider-agnostic so a future
 * Real provider can raise its own domain errors (rate-limit, upstream 5xx)
 * and still get a sensible default without touching routes.
 * @param {unknown} err
 * @returns {{ status: number, code: string }}
 */
function classifyProviderError(err) {
  if (err instanceof StoryNotFoundError) return { status: 404, code: err.code };
  if (err instanceof ValidationError) return { status: 400, code: err.code };
  if (err instanceof ProviderError) return { status: 502, code: err.code };
  return { status: 500, code: 'provider_error' };
}

const server = http.createServer(async (req, res) => {
  const method = req.method || 'GET';
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // Health & meta
  if (method === 'GET' && pathname === '/api/health') {
    return jsonResponse(res, 200, {
      ok: true,
      name: 'story-outside',
      version: '0.1.0',
      phase: 2,
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      demo: DEMO_FLAG,
    });
  }

  // Resolve the data provider once per request; routes below call methods on it.
  let provider;
  try {
    provider = getStoryProvider();
  } catch (err) {
    return jsonResponse(res, 500, {
      error: 'provider_unavailable',
      message: String(err && err.message ? err.message : err),
      demo: DEMO_FLAG,
    });
  }

  // Story catalog
  if (method === 'GET' && pathname === '/api/stories') {
    try {
      const stories = await provider.listStories();
      return jsonResponse(res, 200, { demo: DEMO_FLAG, stories });
    } catch (err) {
      const { status, code } = classifyProviderError(err);
      return jsonResponse(res, status, { error: code, demo: DEMO_FLAG });
    }
  }

  // Single story
  const storyMatch = pathname.match(/^\/api\/stories\/([a-z0-9-]+)$/);
  if (method === 'GET' && storyMatch) {
    try {
      const story = await provider.getStory(storyMatch[1]);
      return jsonResponse(res, 200, { demo: DEMO_FLAG, story });
    } catch (err) {
      const { status, code } = classifyProviderError(err);
      return jsonResponse(res, status, { error: code, demo: DEMO_FLAG });
    }
  }

  // Advance story beat
  if (method === 'POST' && pathname === '/api/stories/advance') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      const { status, code } = classifyProviderError(err);
      return jsonResponse(res, status, { error: code, demo: DEMO_FLAG });
    }
    try {
      const result = await provider.advanceStory({
        storyId: body && body.storyId,
        roleId: body && body.roleId,
        index: body && body.index,
      });
      return jsonResponse(res, 200, { demo: DEMO_FLAG, ...result });
    } catch (err) {
      const { status, code } = classifyProviderError(err);
      return jsonResponse(res, status, { error: code, demo: DEMO_FLAG });
    }
  }

  // Demo "group chat" placeholder — echoes input, no real LLM behind it.
  if (method === 'POST' && pathname === '/api/chat') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      const { status, code } = classifyProviderError(err);
      return jsonResponse(res, status, { error: code, demo: DEMO_FLAG });
    }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      return jsonResponse(res, 400, { error: 'empty_text', demo: DEMO_FLAG });
    }
    return jsonResponse(res, 200, {
      demo: DEMO_FLAG,
      reply: `(mock)你说了：${text.slice(0, 280)}`,
      timestamp: new Date().toISOString(),
    });
  }

  // Root → static
  if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return serveStatic(req, res, '/index.html');
  }
  return serveStatic(req, res, pathname);
});

server.on('clientError', (err, socket) => {
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  }
});

// Auto-listen when run directly (e.g. `node src/server.mjs`).
// When imported as a module, expose the server so tests / tools can
// control the listen lifecycle.
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(`/${process.argv[1]}`);

if (isMainModule) {
  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`[story-outside] listening on http://${HOST}:${PORT} (demo mode)`);
  });
}

export { server, DEMO_FLAG, classifyProviderError };