// Story Outside — minimal Node HTTP server (no framework).
// Serves static files from ./public and exposes a few JSON endpoints
// used by the home page demo flow. The endpoints are clearly marked as
// demo/mock — they do NOT call any official Zhihu API yet.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const PUBLIC_DIR = resolve(ROOT, 'public');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';

const DEMO_FLAG = {
  mode: 'demo',
  official_zhihu_api: false,
  reason:
    'Phase 1 builds an interactive narrative demo without touching the real Zhihu Open Platform. See docs/official-zhihu-skill.md for the planned integration boundary.',
};

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

// Demo stories — kept inline. Replace with a real catalog later.
const STORIES = [
  {
    id: 'cafe-rain',
    title: '雨夜咖啡馆',
    hook: '凌晨的咖啡馆只剩你和她。',
    roles: [
      { id: 'stranger', label: '陌生人', mood: '疏离' },
      { id: 'old-friend', label: '旧友', mood: '怀念' },
    ],
    beats: [
      '雨声裹着玻璃窗，咖啡机嗡地停了。',
      '她把杯沿推向你的方向。',
      '你想起一个还没问出口的问题。',
    ],
  },
  {
    id: 'night-shift',
    title: '凌晨两点的便利店',
    hook: '夜班店员在货架尽头发现你。',
    roles: [
      { id: 'clerk', label: '店员', mood: '警觉' },
      { id: 'wanderer', label: '夜行人', mood: '迷惘' },
    ],
    beats: [
      '日光灯闪了一下，卷帘门外没人。',
      '你挑了一罐不属于今天的饮料。',
      '店员没有说话，只是把零钱推过来。',
    ],
  },
];

function listStories() {
  return STORIES.map((s) => ({ id: s.id, title: s.title, hook: s.hook, roles: s.roles }));
}

function getStory(id) {
  return STORIES.find((s) => s.id === id) || null;
}

async function readJsonBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 64 * 1024) {
        reject(new Error('payload_too_large'));
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
        reject(new Error('bad_json'));
      }
    });
    req.on('error', reject);
  });
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
      phase: 1,
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      demo: DEMO_FLAG,
    });
  }

  // Demo catalog
  if (method === 'GET' && pathname === '/api/stories') {
    return jsonResponse(res, 200, {
      demo: DEMO_FLAG,
      stories: listStories(),
    });
  }

  // Demo single story
  const storyMatch = pathname.match(/^\/api\/stories\/([a-z0-9-]+)$/);
  if (method === 'GET' && storyMatch) {
    const story = getStory(storyMatch[1]);
    if (!story) return jsonResponse(res, 404, { error: 'story_not_found', demo: DEMO_FLAG });
    return jsonResponse(res, 200, { demo: DEMO_FLAG, story });
  }

  // Demo "play next beat" — increments a tiny in-memory counter, returns next line.
  if (method === 'POST' && pathname === '/api/stories/advance') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return jsonResponse(res, 400, { error: String(err.message || err), demo: DEMO_FLAG });
    }
    const story = getStory(body.storyId);
    if (!story) return jsonResponse(res, 404, { error: 'story_not_found', demo: DEMO_FLAG });
    const idx = Number.isInteger(body.index) ? body.index : 0;
    const nextIndex = Math.min(idx + 1, story.beats.length);
    const finished = nextIndex >= story.beats.length;
    return jsonResponse(res, 200, {
      demo: DEMO_FLAG,
      storyId: story.id,
      roleId: body.roleId || null,
      index: nextIndex,
      finished,
      beat: finished ? null : story.beats[nextIndex],
    });
  }

  // Demo "group chat" placeholder — echoes input, no real LLM behind it.
  if (method === 'POST' && pathname === '/api/chat') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return jsonResponse(res, 400, { error: String(err.message || err), demo: DEMO_FLAG });
    }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return jsonResponse(res, 400, { error: 'empty_text', demo: DEMO_FLAG });
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

export { server, listStories, getStory, DEMO_FLAG };