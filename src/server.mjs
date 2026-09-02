// Story Outside — minimal Node HTTP server (no framework).
// Serves static files from ./public and exposes a few JSON endpoints
// used by the home page demo flow. The endpoints are clearly marked as
// demo/mock — they do NOT call any official Zhihu API yet.
//
// Data layer: every /api/stories* route reads through src/providers/index.mjs.
// The active provider is selected at startup via STORY_OUTSIDE_PROVIDER
// (default: mock). Routes never call Zhihu APIs directly.

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJsonStringify } from './stories/canonicalHash.mjs';
import {
  getStoryProvider,
  ProviderError,
  StoryNotFoundError,
  ValidationError,
} from './providers/index.mjs';
import {
  createSeededRepository,
  defaultGenerationProfile,
  importStory as importStoryFromProvider,
  markFirstChoiceConsumed,
  rebuildOpeningCache,
  startSessionSnapshot,
} from './stories/index.mjs';
import {
  commitNarrativeEvent,
  commitOpeningEvent,
  createSession,
  discardPendingTail,
  interruptWithPlayerInput,
  recoverSession,
  stageNarrativeBatch,
} from './stories/sessionService.mjs';
import {
  buildEnding,
  buildOriginalTimeline,
  buildReplay,
} from './stories/endingService.mjs';
import { executeToolCall } from './agent/tools.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const PUBLIC_DIR = resolve(ROOT, 'public');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';

// DEPENDENCY NOTE (ClickUp 09):
//
//   The /generate and /narrative-events routes below depend on the
//   ClickUp 08 contract (1..4 narrative items per batch + optional final
//   tool call). main does NOT include 08 yet, so this branch introduces
//   the minimum needed seams in sessionService + a deterministic demo
//   batch builder. When main integrates 08, these helpers should be
//   replaced by the 08 implementation; the wire shape the frontend
//   uses stays stable across both.

const MIN_BATCH = 1;
const MAX_BATCH = 4;

/**
 * Build a single deterministic demo batch from the player input.
 *
 * Wire shape (matches the ClickUp 08 / 09 contract):
 *   { items: [{ type, text, speaker? } x 1..4],
 *     tool_call: { id, name, arguments } | null }
 *
 * The mock parses the player's input.text to decide what to produce:
 *   - default                  : 3-item narration/dialogue batch, no tool
 *   - text begins "choice"     : 1-item batch + ask_player_choice
 *   - text begins "finish"     : 1-item batch + finish_story
 *   - text contains "long"     : 4-item batch
 *   - text contains "short"    : 1-item batch
 *
 * To demonstrate the choice + ending flows without forcing the player to
 * type "choice"/"finish", the mock also emits a choice after every
 * CHOICE_EVERY batches and a finish after FINISH_AFTER, regardless of
 * input. The input-driven rules above still take precedence.
 */
const CHOICE_EVERY = 2;     // emit a choice tool_call every N narrative batches
const FINISH_AFTER = 5;     // emit a finish_story tool_call after N narrative batches

function buildDemoBatch(input, request_id, sessionState) {
  const text = typeof input === 'object' && input !== null && typeof input.text === 'string'
    ? input.text.toLowerCase() : '';
  const isLong = text.includes('long');
  const isShort = text.includes('short');
  const isChoice = text.startsWith('choice');
  const isFinish = text.startsWith('finish');
  // Track session-local turn count to decide when to emit tools even on
  // a default "hello" input. The counter lives in sessionState so each
  // session has its own progression. Read it BEFORE counting items so
  // the auto-tool rule can trim the batch down to 1 item.
  const turnIndex = (sessionState.turnCount || 0) + 1;
  sessionState.turnCount = turnIndex;
  const autoTool = !isChoice && !isFinish && turnIndex > 0 && turnIndex % CHOICE_EVERY === 0;
  const autoFinish = !isChoice && !isFinish && turnIndex === FINISH_AFTER;
  const count = isChoice || isFinish || autoTool || autoFinish ? MIN_BATCH
    : isLong ? MAX_BATCH
    : isShort ? MIN_BATCH
    : 3;
  const items = [];
  for (let i = 0; i < count; i += 1) {
    items.push({
      type: i % 2 === 0 ? 'narration' : 'dialogue',
      text: `demo ${i % 2 === 0 ? 'line' : 'utterance'} ${i + 1}`,
      ...(i % 2 === 1 ? { speaker: 'stranger' } : {}),
    });
  }
  let tool_call = null;
  if (isChoice || autoTool) {
    tool_call = {
      id: `tool-${randomUUID()}`,
      name: 'ask_player_choice',
      arguments: { question: '接下来你想怎么做？', options: [{ id: 'a', label: '继续听下去' }, { id: 'b', label: '换个方向' }] },
    };
  } else if (isFinish || autoFinish) {
    tool_call = {
      id: `tool-${randomUUID()}`,
      name: 'finish_story',
      arguments: {
        summary: 'demo summary',
        ending: 'demo ending',
        original_difference: 'demo diff',
        key_choices: ['demo choice'],
        character_outcomes: [{ character: 'demo', fate: 'demo fate' }],
      },
    };
  }
  let normalized_tool_call = null;
  if (tool_call) {
    try {
      normalized_tool_call = executeToolCall({
        name: tool_call.name,
        arguments: tool_call.arguments,
        tool_call_id: tool_call.id,
        id: tool_call.id,
      });
    } catch (err) {
      const e = new Error(`buildDemoBatch: tool validation failed (${err.message})`);
      e.code = 'invalid_tool_call';
      throw e;
    }
  }
  return {
    turn_id: randomUUID(),
    request_id: request_id || null,
    kind: normalized_tool_call ? (normalized_tool_call.terminal ? 'story_finished' : 'choice_required') : 'narrative',
    items,
    tool_call: normalized_tool_call,
  };
}

/**
 * Strip undefined / function / symbol fields from a value so it round-trips
 * through tools.mjs's strict canonicalJsonStringify walker (which rejects
 * any non-finite JSON token). The normalized tool envelope emitted by
 * executeToolCall carries fields like `session_uuid` / `turn_id` /
 * `base_revision` as undefined when those are not supplied by the
 * caller; we strip them so the envelope is safe to hand to
 * stageNarrativeBatch (which canonicalises the pending snapshot).
 */
function stripUnsupported(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stripUnsupported);
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined || typeof child === 'function' || typeof child === 'symbol') continue;
    out[key] = stripUnsupported(child);
  }
  return out;
}

/**
 * Per-session turn counter for the deterministic demo provider. The map
 * is intentionally process-local: a fresh process starts a fresh demo
 * arc. The store mirrors the route layer pattern (sessionPinnedMetadata,
 * sessionTurnIndex) and is wiped when the server restarts.
 */
const demoTurnCounter = new Map();
function getDemoSessionState(sessionUuid) {
  let state = demoTurnCounter.get(sessionUuid);
  if (!state) {
    state = { turnCount: 0 };
    demoTurnCounter.set(sessionUuid, state);
  }
  return state;
}

const DEMO_FLAG = Object.freeze({
  mode: 'demo',
  official_zhihu_api: false,
  reason:
    'Phase 2 builds an interactive narrative demo without touching the real Zhihu Open Platform. Data is served by src/providers/mockProvider.mjs (default STORY_OUTSIDE_PROVIDER=mock). See docs/official-zhihu-skill.md for the planned real-provider integration boundary.',
});

// Phase 4: admin / dev tooling flag. Every /api/admin/* and /api/dev/* route
// carries this banner so a future frontend / proxy can hide them in prod.
// There is NO authentication here — these routes are demo/dev-only by design
// and MUST NOT be exposed on a public deployment without an upstream auth
// proxy. The flag below is the loud self-warning, not a substitute for it.
const DEV_FLAG = Object.freeze({
  demo: true,
  admin_only: false,
  dev_only: true,
  authenticated: false,
  reason:
    'Phase 4 admin/dev routes are demo-only. There is no auth, no rate limit, ' +
    'and no audit log. Do not expose them publicly. Put an upstream auth proxy ' +
    'in front before deploying beyond localhost.',
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

// Stories application layer. Seeded once per process from the mock catalog so
// admin/dev tooling can rebuild caches against a known set of UUIDs without
// having to POST a separate import for every story. The repository lives in
// memory only; see docs/data-model.md for the MariaDB mapping.
const { repository: storyRepo, fixtures: storyFixtures } = createSeededRepository();

// sessionService deliberately keeps its state private to the repository. The
// route layer keeps only the request's non-secret pinned metadata so recovery
// can return the same metadata without reaching into service internals.
const sessionPinnedMetadata = new Map();
// Per-session turn-level request idempotency map. Keyed by session_uuid,
// then by request_id. The map intentionally lives outside the repository
// because the runtime does not own it (the repository is process-shared
// with other tests/routes); the route layer is the only producer.
const sessionTurnIndex = new Map();

const SESSION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isSessionUuid(value) {
  return typeof value === 'string' && SESSION_UUID_PATTERN.test(value);
}

function sessionError(err) {
  const text = String(err && err.message ? err.message : '');
  if (/unknown session/i.test(text)) {
    return { status: 404, code: 'session_not_found', message: 'Session was not found.' };
  }
  if (/revision mismatch/i.test(text)) {
    return { status: 400, code: 'revision_mismatch', message: 'Expected revision does not match the current session revision.' };
  }
  if (/cache_uuid|pinned cache|cache .*match|invalid cache/i.test(text)) {
    return { status: 400, code: 'invalid_cache', message: 'The opening cache is invalid for this session.' };
  }
  if (/already exists/i.test(text)) {
    return { status: 400, code: 'duplicate_session', message: 'The session already exists.' };
  }
  return { status: 400, code: 'validation_failed', message: 'The session request is invalid.' };
}

function sessionErrorResponse(res, err) {
  const { status, code, message } = sessionError(err);
  return jsonResponse(res, status, { error: code, message, demo: DEMO_FLAG, dev: DEV_FLAG });
}

function validObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Phase 4 catalogue helper: list slugs from the in-memory fixture set so
 * admin/dev routes can map a stable slug → story_version_uuid without
 * hardcoding every id at the route layer.
 * @returns {Array<{ slug: string, story_uuid: string, story_version_uuid: string }>}
 */
function listFixtureStorySlugs() {
  return storyFixtures.slice();
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
      phase: 4,
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

  // -----------------------------------------------------------------------
  // Phase 4 routes — story import, version, opening cache, session snapshot.
  //
  // All Phase 4 routes are demo/dev-only and live under /api/admin/* so a
  // future reverse proxy can block them with one ACL. They carry the DEV_FLAG
  // banner on every response, are un-authenticated by design, and intentionally
  // do not write to MariaDB.
  // -----------------------------------------------------------------------

  // GET /api/admin/stories — list the seeded fixture stories with their
  // story_uuid / story_version_uuid so admins can copy identifiers.
  if (method === 'GET' && pathname === '/api/admin/stories') {
    const out = [];
    for (const f of storyFixtures) {
      const versions = storyRepo.listVersionsByStory(f.story_uuid);
      out.push({
        slug: f.slug,
        story_uuid: f.story_uuid,
        versions: versions.map((v) => ({
          story_version_uuid: v.version_uuid,
          version_no: v.version_no,
          checksum: v.checksum,
          status: v.status,
        })),
      });
    }
    return jsonResponse(res, 200, { demo: DEMO_FLAG, dev: DEV_FLAG, stories: out });
  }

  // POST /api/admin/stories/import — run the canonical import pipeline for a
  // slug. Same content → no new version; different content → new version_no.
  const importMatch = pathname.match(/^\/api\/admin\/stories\/([a-z0-9-]+)\/import$/);
  if (method === 'POST' && importMatch) {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      const { status, code } = classifyProviderError(err);
      return jsonResponse(res, status, { error: code, demo: DEMO_FLAG, dev: DEV_FLAG });
    }
    const story_uuid = typeof body.story_uuid === 'string' && body.story_uuid
      ? body.story_uuid
      : `00000000-0000-4000-8000-${randomUUID().slice(0, 12).padStart(12, '0')}`;
    try {
      const result = await importStoryFromProvider({
        repository: storyRepo,
        provider,
        slug: importMatch[1],
        story_uuid,
      });
      return jsonResponse(res, 200, { demo: DEMO_FLAG, dev: DEV_FLAG, result });
    } catch (err) {
      const { status, code } = classifyProviderError(err);
      return jsonResponse(res, status, {
        error: code,
        message: String(err && err.message ? err.message : err),
        demo: DEMO_FLAG,
        dev: DEV_FLAG,
      });
    }
  }

  // POST /api/admin/opening-cache/rebuild — generate / refresh the public
  // opening cache for a story_version. Body may carry a custom generation
  // profile (identifier/rules_version/locale). Without a different
  // generation_hash the call returns the existing valid cache (idempotent).
  const rebuildMatch = pathname.match(/^\/api\/admin\/opening-cache\/rebuild$/);
  if (method === 'POST' && rebuildMatch) {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      const { status, code } = classifyProviderError(err);
      return jsonResponse(res, status, { error: code, demo: DEMO_FLAG, dev: DEV_FLAG });
    }
    if (!body.story_version_uuid || typeof body.story_version_uuid !== 'string') {
      return jsonResponse(res, 400, {
        error: 'missing_story_version_uuid',
        demo: DEMO_FLAG,
        dev: DEV_FLAG,
      });
    }
    const profile = body.profile && typeof body.profile === 'object'
      ? {
          identifier: String(body.profile.identifier || defaultGenerationProfile().identifier),
          rules_version: String(body.profile.rules_version || defaultGenerationProfile().rules_version),
          locale: typeof body.profile.locale === 'string' ? body.profile.locale : 'zh-CN',
          variant: typeof body.profile.variant === 'string' ? body.profile.variant : 'default',
        }
      : defaultGenerationProfile();
    try {
      const result = await rebuildOpeningCache({
        repository: storyRepo,
        story_version_uuid: body.story_version_uuid,
        profile,
      });
      return jsonResponse(res, 200, { demo: DEMO_FLAG, dev: DEV_FLAG, result });
    } catch (err) {
      const { status, code } = classifyProviderError(err);
      return jsonResponse(res, status, {
        error: code,
        message: String(err && err.message ? err.message : err),
        demo: DEMO_FLAG,
        dev: DEV_FLAG,
      });
    }
  }

  // ClickUp 05 session playback routes. These call the session-local service
  // directly: creating a session pins the supplied cache, recovery is read
  // only, and events are appended only by explicit commit/interrupt calls.
  if (method === 'POST' && pathname === '/api/dev/sessions') {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
    // Keep the ClickUp 04 snapshot route compatible when the new playback
    // fields are absent. A request containing the new fields uses the strict
    // sessionService contract below.
    const isPlaybackRequest = validObject(body) &&
      ['model', 'prompt', 'generation_profile'].some((key) => Object.prototype.hasOwnProperty.call(body, key));
    if (isPlaybackRequest) {
      const required = ['session_uuid', 'story_uuid', 'story_version_uuid', 'user_ref', 'role_id', 'model', 'prompt', 'generation_profile'];
      const missing = required.find((key) => {
        if (!Object.prototype.hasOwnProperty.call(body, key)) return true;
        if (key === 'generation_profile') return !validObject(body[key]);
        if (key === 'prompt') return typeof body[key] !== 'string';
        return typeof body[key] !== 'string' || body[key].length === 0;
      });
      if (missing) {
        return jsonResponse(res, 400, {
          error: 'validation_failed', message: 'The session request is invalid.',
          field: missing, demo: DEMO_FLAG, dev: DEV_FLAG,
        });
      }
      for (const key of ['session_uuid', 'story_uuid', 'story_version_uuid']) {
        if (!isSessionUuid(body[key])) {
          return jsonResponse(res, 400, {
            error: 'validation_failed', message: 'The session request is invalid.',
            field: key, demo: DEMO_FLAG, dev: DEV_FLAG,
          });
        }
      }
      if (!isSessionUuid(body.generation_profile.cache_uuid)) {
        return jsonResponse(res, 400, {
          error: 'invalid_cache', message: 'The opening cache is invalid for this session.',
          demo: DEMO_FLAG, dev: DEV_FLAG,
        });
      }
      const pinnedCache = storyRepo.findOpeningCacheByUuid(body.generation_profile.cache_uuid);
      if (!pinnedCache || pinnedCache.status !== 'valid') {
        return jsonResponse(res, 400, {
          error: 'invalid_cache', message: 'The opening cache is invalid for this session.',
          demo: DEMO_FLAG, dev: DEV_FLAG,
        });
      }
      // A cache-only profile is safe to accept here because every omitted
      // generation dimension is copied from the already pinned cache. Never
      // fill these fields from a process-global/default profile: doing so
      // could combine a valid cache_uuid with a different cache generation.
      const pinnedProfile = validObject(pinnedCache.generation_profile)
        ? pinnedCache.generation_profile
        : {};
      const generation_profile = { ...body.generation_profile };
      for (const key of ['identifier', 'rules_version', 'locale', 'variant']) {
        if (generation_profile[key] === undefined && pinnedProfile[key] !== undefined) {
          generation_profile[key] = pinnedProfile[key];
        }
      }
      try {
        const result = createSession({
          repository: storyRepo,
          session_uuid: body.session_uuid,
          story_uuid: body.story_uuid,
          story_version_uuid: body.story_version_uuid,
          user_ref: body.user_ref,
          role_id: body.role_id,
          model: body.model,
          prompt: body.prompt,
          generation_profile,
        });
        const profile = {};
        for (const key of ['cache_uuid', 'story_uuid', 'story_version_uuid', 'generation_hash', 'identifier', 'rules_version', 'locale', 'variant']) {
          if (generation_profile[key] !== undefined) profile[key] = generation_profile[key];
        }
        const pinned = {
          user_ref: body.user_ref,
          role_id: body.role_id,
          model: body.model,
          prompt: body.prompt,
          generation_profile: profile,
        };
        sessionPinnedMetadata.set(body.session_uuid, pinned);
        return jsonResponse(res, 200, {
          demo: DEMO_FLAG, dev: DEV_FLAG, ...result, pinned,
          session: { ...result, pinned },
        });
      } catch (err) {
        return sessionErrorResponse(res, err);
      }
    }

    // Legacy Phase 4 snapshot contract.
    const required = ['session_uuid', 'story_uuid', 'story_version_uuid', 'user_ref', 'role_id'];
    for (const k of required) {
      if (typeof body[k] !== 'string' || !body[k]) {
        return jsonResponse(res, 400, {
          error: 'missing_field',
          field: k,
          demo: DEMO_FLAG,
          dev: DEV_FLAG,
        });
      }
    }
    try {
      const snapshot = startSessionSnapshot({
        repository: storyRepo,
        session_uuid: body.session_uuid,
        story_uuid: body.story_uuid,
        story_version_uuid: body.story_version_uuid,
        user_ref: body.user_ref,
        role_id: body.role_id,
      });
      return jsonResponse(res, 200, { demo: DEMO_FLAG, dev: DEV_FLAG, snapshot });
    } catch (err) {
      const { status, code } = classifyProviderError(err);
      return jsonResponse(res, status, {
        error: code,
        message: String(err && err.message ? err.message : err),
        demo: DEMO_FLAG,
        dev: DEV_FLAG,
      });
    }
  }

  // GET /api/dev/sessions/:uuid — recover only canonical session state. This
  // endpoint never generates from, or appends to, the opening cache.
  const sessionMatch = pathname.match(/^\/api\/dev\/sessions\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/);
  if (method === 'GET' && sessionMatch) {
    try {
      const recovered = recoverSession({ repository: storyRepo, session_uuid: sessionMatch[1] });
      return jsonResponse(res, 200, {
        demo: DEMO_FLAG,
        dev: DEV_FLAG,
        ...recovered,
        pinned: sessionPinnedMetadata.get(sessionMatch[1]) || null,
      });
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
  }

  // POST /api/dev/sessions/:uuid/opening-events — append exactly one
  // explicitly supplied cache event. The service enforces contiguous order,
  // optimistic revision checks, and request-id idempotency.
  const openingEventsMatch = pathname.match(/^\/api\/dev\/sessions\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/opening-events$/);
  if (method === 'POST' && openingEventsMatch) {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
    if (!validObject(body) || !isSessionUuid(body.cache_uuid) || !validObject(body.event) ||
        !Number.isInteger(body.expected_revision) ||
        typeof body.client_request_id !== 'string' || !body.client_request_id ||
        typeof body.event.type !== 'string' || !body.event.type ||
        !Number.isInteger(body.event.sequence) || typeof body.event.text !== 'string') {
      return jsonResponse(res, 400, {
        error: 'validation_failed', message: 'The opening event request is invalid.',
        demo: DEMO_FLAG, dev: DEV_FLAG,
      });
    }
    try {
      const result = commitOpeningEvent({
        repository: storyRepo,
        session_uuid: openingEventsMatch[1],
        cache_uuid: body.cache_uuid,
        event: body.event,
        client_request_id: body.client_request_id,
        expected_revision: body.expected_revision,
      });
      return jsonResponse(res, 200, { demo: DEMO_FLAG, dev: DEV_FLAG, ...result });
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
  }

  // ClickUp 09 narrative-batch routes. The wire shape matches the
  // ClickUp 08 contract that the player frontend consumes:
  //   POST /generate          : stage a 1..4 item batch + optional tool call
  //   POST /narrative-events  : commit exactly one displayed item
  //   GET  /recover           : read-only canonical + active pending
  //   POST /discard-pending   : drop an unconsumed pending batch
  //
  // The runtime itself is bypassed here: main does not include 08 yet,
  // so the demo uses buildDemoBatch (a deterministic mock that honours
  // the 08 wire shape). When 08 lands in main, this block should be
  // replaced by the 08 runtime+sessionService wiring.

  // POST /api/dev/sessions/:uuid/generate — build the next demo batch
  // and stage it as the active pending batch. The frontend commits each
  // item via /narrative-events. Idempotent on (request_id, input,
  // expected_revision): the same triple replays the prior staged batch
  // without a fresh provider call; a different payload fails closed.
  const generateMatch = pathname.match(/^\/api\/dev\/sessions\/([0-9a-fA-F-]+)\/generate$/);
  if (method === 'POST' && generateMatch) {
    const sessionUuid = generateMatch[1];
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
    if (!validObject(body) || typeof body.input !== 'object' || body.input === null ||
        !Number.isInteger(body.expected_revision) ||
        (body.request_id !== undefined && (typeof body.request_id !== 'string' || !body.request_id.length))) {
      return jsonResponse(res, 400, {
        error: 'validation_failed', message: 'The generate request is invalid.',
        demo: DEMO_FLAG, dev: DEV_FLAG,
      });
    }
    // Turn-level idempotency: replay prior result when the same
    // (request_id, input, expected_revision) triple arrives twice.
    if (body.request_id) {
      const prior = sessionTurnIndex.get(sessionUuid);
      const priorEntry = prior && prior.get(body.request_id);
      const fp = canonicalJsonStringify({ input: body.input, expected_revision: body.expected_revision });
      if (priorEntry) {
        if (priorEntry.fingerprint !== fp) {
          return jsonResponse(res, 400, {
            error: 'duplicate_request',
            message: 'request_id already used for a different request.',
            demo: DEMO_FLAG, dev: DEV_FLAG,
          });
        }
        return jsonResponse(res, 200, { demo: DEMO_FLAG, dev: DEV_FLAG, ...priorEntry.result });
      }
    }
    let batch;
    try {
      batch = buildDemoBatch(body.input, body.request_id || null, getDemoSessionState(sessionUuid));
    } catch (err) {
      const code = err.code || 'provider_failure';
      return jsonResponse(res, 400, {
        error: code,
        message: String(err.message || err),
        demo: DEMO_FLAG, dev: DEV_FLAG,
      });
    }
    let staged;
    try {
      staged = stageNarrativeBatch({
        repository: storyRepo,
        session_uuid: sessionUuid,
        items: batch.items,
        tool_call: batch.tool_call ? stripUnsupported(batch.tool_call) : null,
        ...(body.request_id ? { client_request_id: body.request_id } : {}),
        expected_revision: body.expected_revision,
      });
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
    const turnResult = {
      turn_id: batch.turn_id,
      request_id: body.request_id || null,
      kind: batch.kind,
      pending_id: staged.pending_id,
      events: staged.events,
      tool_call: staged.tool_call,
      pending_committed_count: staged.committed_count,
      pending_remaining: staged.events.length - staged.committed_count,
      cursor: staged.cursor,
      opening_cursor: staged.opening_cursor,
      revision: staged.revision,
      state: staged.state,
    };
    if (body.request_id) {
      const fp = canonicalJsonStringify({ input: body.input, expected_revision: body.expected_revision });
      let prior = sessionTurnIndex.get(sessionUuid);
      if (!prior) {
        prior = new Map();
        sessionTurnIndex.set(sessionUuid, prior);
      }
      prior.set(body.request_id, { fingerprint: fp, result: turnResult });
    }
    return jsonResponse(res, 200, {
      demo: DEMO_FLAG, dev: DEV_FLAG,
      ...turnResult,
      session_uuid: sessionUuid,
    });
  }

  // POST /api/dev/sessions/:uuid/narrative-events — commit exactly ONE
  // displayed narrative event from the active pending batch. The event
  // is appended to canonical history; revision advances by 1. The
  // optional final tool_call (if present) is exposed on the last commit
  // result via pending_tool_call but never becomes a canonical event.
  const narrativeMatch = pathname.match(/^\/api\/dev\/sessions\/([0-9a-fA-F-]+)\/narrative-events$/);
  if (method === 'POST' && narrativeMatch) {
    const sessionUuid = narrativeMatch[1];
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
    if (!validObject(body) || typeof body.pending_id !== 'string' || !body.pending_id ||
        !Number.isInteger(body.sequence) ||
        !Number.isInteger(body.expected_revision) ||
        (body.client_request_id !== undefined && (typeof body.client_request_id !== 'string' || !body.client_request_id.length))) {
      return jsonResponse(res, 400, {
        error: 'validation_failed', message: 'The narrative-event commit request is invalid.',
        demo: DEMO_FLAG, dev: DEV_FLAG,
      });
    }
    try {
      const result = commitNarrativeEvent({
        repository: storyRepo,
        session_uuid: sessionUuid,
        pending_id: body.pending_id,
        sequence: body.sequence,
        expected_revision: body.expected_revision,
        ...(body.client_request_id ? { client_request_id: body.client_request_id } : {}),
      });
      return jsonResponse(res, 200, { demo: DEMO_FLAG, dev: DEV_FLAG, ...result });
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
  }

  // GET /api/dev/sessions/:uuid/recover — explicit read-only recovery.
  // Surfaces canonical history + revision + cursor + opening_cursor +
  // active pending snapshot. Never calls the provider, never replays,
  // never mutates state. Same-process only: the repository is
  // in-memory, so a fresh process does not know this session.
  const recoverMatch = pathname.match(/^\/api\/dev\/sessions\/([0-9a-fA-F-]+)\/recover$/);
  if (method === 'GET' && recoverMatch) {
    try {
      const recovered = recoverSession({ repository: storyRepo, session_uuid: recoverMatch[1] });
      return jsonResponse(res, 200, {
        demo: DEMO_FLAG, dev: DEV_FLAG,
        ...recovered,
        pinned: sessionPinnedMetadata.get(recoverMatch[1]) || null,
      });
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
  }

  // POST /api/dev/sessions/:uuid/discard-pending — drop the active
  // pending batch without committing. Used when the player wants to
  // clear a stale batch (e.g. recovery picked up a half-committed one).
  const discardMatch = pathname.match(/^\/api\/dev\/sessions\/([0-9a-fA-F-]+)\/discard-pending$/);
  if (method === 'POST' && discardMatch) {
    try {
      const result = discardPendingTail({
        repository: storyRepo,
        session_uuid: discardMatch[1],
      });
      return jsonResponse(res, 200, {
        demo: DEMO_FLAG, dev: DEV_FLAG,
        session_uuid: discardMatch[1],
        ...result,
      });
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
  }

  // ---------------------------------------------------------------------
  // ClickUp 11 ending-page read-only routes. These three endpoints are
  // pure projections over (session_events + story_version + opening_cache)
  // and never mutate the repository. They are safe to call after a page
  // reload (in the same process) and return a deterministic shape the
  // ending page can rebuild the full result from.
  //
  //  GET /api/dev/sessions/:uuid/ending             — derived ending
  //  GET /api/dev/sessions/:uuid/original-timeline  — original key facts
  //  GET /api/dev/sessions/:uuid/replay             — committed history
  // ---------------------------------------------------------------------

  // GET /api/dev/sessions/:uuid/ending — surface the finish_story tool
  // envelope plus derived fields (first_deviation, total_analysis,
  // category). Returns 404 ending_not_committed when finish_story has
  // not yet committed for this session.
  const endingMatch = pathname.match(/^\/api\/dev\/sessions\/([0-9a-fA-F-]+)\/ending$/);
  if (method === 'GET' && endingMatch) {
    try {
      const ending = buildEnding({ repository: storyRepo, session_uuid: endingMatch[1] });
      return jsonResponse(res, 200, {
        demo: DEMO_FLAG, dev: DEV_FLAG,
        session_uuid: endingMatch[1],
        ...ending,
      });
    } catch (err) {
      if (err && err.code === 'ending_not_committed') {
        return jsonResponse(res, 404, {
          error: 'ending_not_committed',
          message: 'finish_story has not yet committed for this session.',
          session_uuid: endingMatch[1],
          demo: DEMO_FLAG, dev: DEV_FLAG,
        });
      }
      return sessionErrorResponse(res, err);
    }
  }

  // GET /api/dev/sessions/:uuid/original-timeline — original story
  // version key facts (title / hook / roles / opening cache highlights
  // / choice boundary). NEVER sourced from the AI-parallel timeline.
  // Includes a `source_attribution` label so the UI can mark these
  // entries as "来自原作 …".
  const originalTimelineMatch = pathname.match(/^\/api\/dev\/sessions\/([0-9a-fA-F-]+)\/original-timeline$/);
  if (method === 'GET' && originalTimelineMatch) {
    try {
      const timeline = buildOriginalTimeline({ repository: storyRepo, session_uuid: originalTimelineMatch[1] });
      return jsonResponse(res, 200, {
        demo: DEMO_FLAG, dev: DEV_FLAG,
        session_uuid: originalTimelineMatch[1],
        ...timeline,
      });
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
  }

  // GET /api/dev/sessions/:uuid/replay — strict replay of committed
  // session_events in event_seq order. Excludes tool_call /
  // pending_tool_call / pending / discarded rows (08 contract). Does
  // NOT include pending_batch items with status='staged'.
  const replayMatch = pathname.match(/^\/api\/dev\/sessions\/([0-9a-fA-F-]+)\/replay$/);
  if (method === 'GET' && replayMatch) {
    try {
      const replay = buildReplay({ repository: storyRepo, session_uuid: replayMatch[1] });
      return jsonResponse(res, 200, {
        demo: DEMO_FLAG, dev: DEV_FLAG,
        session_uuid: replayMatch[1],
        ...replay,
      });
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
  }

  // POST /api/dev/sessions/:uuid/interrupt — explicitly switch to realtime
  // by appending player input. This route intentionally never invalidates a
  // shared opening cache.
  const interruptMatch = pathname.match(/^\/api\/dev\/sessions\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/interrupt$/);
  if (method === 'POST' && interruptMatch) {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
    if (!validObject(body) || typeof body.text !== 'string' || !body.text ||
        typeof body.client_request_id !== 'string' || !body.client_request_id ||
        !Number.isInteger(body.expected_revision)) {
      return jsonResponse(res, 400, {
        error: 'validation_failed', message: 'The interrupt request is invalid.',
        demo: DEMO_FLAG, dev: DEV_FLAG,
      });
    }
    try {
      const result = interruptWithPlayerInput({
        repository: storyRepo,
        session_uuid: interruptMatch[1],
        text: body.text,
        client_request_id: body.client_request_id,
        expected_revision: body.expected_revision,
      });
      return jsonResponse(res, 200, {
        demo: DEMO_FLAG,
        dev: DEV_FLAG,
        ...result,
        player_event: result.event,
        realtime_transition: { state: result.state, cursor: result.cursor, revision: result.revision },
      });
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
  }

  // POST /api/dev/sessions/:uuid/first-choice — record the first
  // ask_player_choice on THAT session and return a session-local consumed
  // marker. The shared opening cache is NOT invalidated for other sessions.
  const firstChoiceMatch = pathname.match(/^\/api\/dev\/sessions\/([0-9a-fA-F-]+)\/first-choice$/);
  if (method === 'POST' && firstChoiceMatch) {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      const { status, code } = classifyProviderError(err);
      return jsonResponse(res, status, { error: code, demo: DEMO_FLAG, dev: DEV_FLAG });
    }
    if (!body.snapshot || typeof body.snapshot !== 'object') {
      return jsonResponse(res, 400, {
        error: 'missing_snapshot',
        demo: DEMO_FLAG,
        dev: DEV_FLAG,
      });
    }
    const urlSessionUuid = firstChoiceMatch[1];
    const snapshotSessionUuid = body.snapshot.session_uuid;
    if (typeof snapshotSessionUuid !== 'string' || snapshotSessionUuid !== urlSessionUuid) {
      return jsonResponse(res, 400, {
        error: 'session_uuid_mismatch',
        demo: DEMO_FLAG,
        dev: DEV_FLAG,
      });
    }
    try {
      const result = markFirstChoiceConsumed({
        repository: storyRepo,
        snapshot: body.snapshot,
      });
      return jsonResponse(res, 200, { demo: DEMO_FLAG, dev: DEV_FLAG, result });
    } catch (err) {
      const { status, code } = classifyProviderError(err);
      return jsonResponse(res, status, {
        error: code,
        message: String(err && err.message ? err.message : err),
        demo: DEMO_FLAG,
        dev: DEV_FLAG,
      });
    }
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

export { server, DEMO_FLAG, DEV_FLAG, classifyProviderError, storyRepo, storyFixtures, listFixtureStorySlugs };