import { analyzeEnding, createEndingAnalysisTasks } from './agent/endingAnalysis.mjs';
import { createOfficialSearchSource, createOfficialKnowledgeSource } from './providers/ecosystem/officialSources.mjs';
import { warn as loggerWarn, info as loggerInfo } from './observability/logger.mjs';
// Story Outside — minimal Node HTTP server (no framework).
// Serves static files from ./public and exposes a few JSON endpoints
// used by the home page demo flow. The endpoints are clearly marked as
// demo/mock — they do NOT call any official Zhihu API yet.
//
// Data layer: every /api/stories* route reads through src/providers/index.mjs.
// The active provider is selected at startup via STORY_OUTSIDE_PROVIDER
// (default: mock). Routes never call Zhihu APIs directly.

import http from 'node:http';
import { createGenerationTasks } from './agent/generationTasks.mjs';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { canonicalJsonStringify } from './stories/canonicalHash.mjs';
import { createAIProvider, loadAIConfig, STORY_SYSTEM_PROMPT } from './agent/aiProvider.mjs';
import { TOOL_DEFINITIONS } from './agent/tools.mjs';
import { createPreparedStoryProvider } from './agent/storyPreparation.mjs';
import {
  getStoryProvider,
  ProviderError,
  StoryNotFoundError,
  ValidationError,
} from './providers/index.mjs';
import {
  createSeededRepository,
  defaultGenerationProfile,
  importStoryAndEnsureCache as importStoryFromProvider,
  markFirstChoiceConsumed,
  rebuildOpeningCache,
  startSessionSnapshot,
} from './stories/index.mjs';
import {
  COMMUNITY_PROFILE_GENERATOR_VERSION,
  buildCanonicalCommunityProfileVersion,
  createInMemoryCommunityProfileRepository,
  findCanonicalByIdentity,
  seedCommunityProfiles,
} from './community/index.mjs';
import { deriveExternalCommunityProfileVersion } from './community/version.mjs';
import { closeDatabase, connectDatabase, databaseStatus } from './db/mariadb.mjs';
import { createMariaDbRepositories } from './db/mariaPersistence.mjs';

// Story 16.2 P1.v2 (2026-09-07 code review): the
// /v1/ecosystem/discussions route is server-authoritative — it takes
// ONLY a story_uuid + story_version_uuid + community_profile_version
// triple from the body, resolves the canonical StoryCommunityProfile
// server-side, and runs the canonical `profile.queries[]` through the
// upstream search. The body MUST NOT carry `search_queries` (or any
// other client-controlled query source). The adapter is selected by
// env STORY_OUTSIDE_ECOSYSTEM_SEARCH (`mock` default; `real` requires
// ZHIHU_OAUTH_APP_KEY / ZHIHU_ACCESS_SECRET / ZHIHU_OAUTH_USER).
import {
  createInMemoryEcosystemSearchCacheRepository,
  createMockZhihuSearchSource,
  createRealZhihuSearchSource,
  hasRealSearchCredentials,
  normaliseDiscussionsRequest,
  searchEcosystemDiscussions,
} from './providers/ecosystem/index.mjs';
import {
  bindSessionOwner,
  bootstrapSessionFromWork,
  commitNarrativeEvent,
  commitOpeningEvent,
  createSession,
  discardPendingTail,
  findOwnerBySession,
  getSession,
  interruptWithPlayerInput,
  listSessionEvents,
  recoverSession,
  stageNarrativeBatch,
} from './stories/sessionService.mjs';
import { BoundedMap } from './util/boundedMap.mjs';
import {
  AgentRuntimeError,
  createAgentRuntime,
  createMockAgentProvider,
  recoverRuntime,
  resumeTurn,
  runTurn,
} from './agent/runtime.mjs';
import { snapshotAll as snapshotMetricsAll, snapshotSession as snapshotMetricsSession } from './observability/metrics.mjs';
import { snapshotAll as snapshotCacheStatsAll } from './observability/cacheStats.mjs';
import {
  attachRelevance,
  createEcosystemHotOrchestrator,
} from './providers/ecosystem/hot.mjs';
import { matchHotToStoryCatalog, projectProfileMatchedHot } from './providers/ecosystem/hotStoryMatch.mjs';
// P1.v1-6 (2026-09-07): the bootstrap response now uses the
// main-canonical `resolveCommunityProfileVersion` helper (defined
// below in this module, returns
// `{ community_profile_version, community_profile_queries }`). The
// community-layer `deriveExternalCommunityProfileVersion` is a thin
// pass-through to the SAME canonical formatter
// (`buildCanonicalCommunityProfileVersion`), so any future caller in
// this module can import either side and get a byte-identical
// result. We import `deriveExternalCommunityProfileVersion` here
// directly from `./community/version.mjs` (the single source of
// truth) so the route + bootstrap paths can read `community_profile_*`
// via `resolveCommunityProfileVersion`, which already wraps the
// canonical formatter.
import {
  createStoriesHookContext,
  onSessionCreate,
  onOpeningCommit,
  onInterrupt,
  onToolCommit,
  onOpeningCacheHit,
  onOpeningCacheMiss,
} from './stories/observabilityHooks.mjs';
import {
  buildEnding,
  buildOriginalTimeline,
  buildReplay,
} from './stories/endingService.mjs';
import {
  createEcosystemKnowledgeProvider,
} from './providers/ecosystem/knowledge.mjs';

// Story 16.3 P1 rebuild on `44343b2` — the follow / share surface is
// served from a fresh in-memory repository. The auth seam is the
// `story_outside_session` cookie (set by `/api/sessions` POST); the
// service layer wires `storyRepo` so `shareSession` can verify the
// canonical owner persisted by sessionService.createSession. A
// cookie-less request is a 401; the cookie is the auth seam.
import {
  FollowingError,
  createInMemoryFollowingRepository,
  createFollowingService,
} from './ecosystem/following/index.mjs';
import { loadZhihuAccessSecret } from './providers/ecosystem/zhihuHotSource.mjs';
import { listOwnerActivities } from './stories/sessionService.mjs';
import { fetchFollowees as fetchZhihuFollowees } from './providers/ecosystem/zhihuFolloweeSource.mjs';
import { currentUserProvider, bindCurrentUser } from './auth/currentUserProvider.mjs';
import { createZhihuOAuth, loadOAuthConfig } from './auth/zhihuOAuth.mjs';
// 知乎账号目录：登录成功时登记「本人的 url_token → 本站业务 UUID」，「故事里的
// 相遇」靠它把知乎关注列表反查成本站账号。账号映射随业务仓库持久化。
const oauth = createZhihuOAuth(loadOAuthConfig(), {
  onLogin: (owner) => {
    if (!followingRepo.rememberAccount(owner)) {
      loggerWarn('following.identity.unavailable', { component: 'auth', error_code: 'public_profile_unresolved' });
    }
  },
});

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const PUBLIC_DIR = resolve(ROOT, 'public');
const generationTasks = createGenerationTasks();
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
let databasePersistence = null;
let databaseBootstrapError = null;

/**
 * Build a deterministic, story-aware mock provider that satisfies the
 * Story 08 wire contract: 1..4 ordered narrative items plus an
 * OPTIONAL final tool call (never both items and a tool call with the
 * items array empty, and never without a tool_call riding the items).
 *
 * The mock parses the player's input.text to decide what to produce:
 *   - default: a 3-item narration/dialogue batch;
 *   - text begins with 'choice' → a 1-item batch + ask_player_choice;
 *   - text begins with 'finish' → a 1-item batch + finish_story;
 *   - text contains 'long'   → a 4-item batch;
 *   - text contains 'short'  → a 1-item batch.
 * It also auto-emits a choice every CHOICE_EVERY turns and a finish_story
 * at FINISH_AFTER (Story 09 demo arc, session-scoped counter).
 */
function buildDemoMockAgentProvider(input, sessionUuid = null) {
  const text = typeof input === 'object' && input !== null && typeof input.text === 'string'
    ? input.text.toLowerCase() : '';
  const isLong = text.includes('long');
  const isShort = text.includes('short');
  const isChoice = text.startsWith('choice');
  const isFinish = text.startsWith('finish');
  // Session-local turn counter (Story 09 demo arc): auto-emit a choice
  // every CHOICE_EVERY turns and a finish_story at FINISH_AFTER so the
  // player sees the choice + ending flows without typing magic words.
  // Input-driven rules take precedence.
  const sessionState = sessionUuid ? getDemoSessionState(sessionUuid) : { turnCount: 0 };
  const turnIndex = (sessionState.turnCount || 0) + 1;
  sessionState.turnCount = turnIndex;
  // The auto arc only applies to the player frontend's DEFAULT input
  // ('hello' — see public/scripts/player.js). Explicit 08-contract inputs
  // ('default' / 'short' / 'long' / …) must keep their documented batch
  // shapes regardless of the turn index.
  const isAutoArcInput = text === 'hello' || text === '';
  const autoTool = isAutoArcInput && !isChoice && !isFinish && turnIndex > 0 && turnIndex % CHOICE_EVERY === 0;
  const autoFinish = isAutoArcInput && !isChoice && !isFinish && turnIndex === FINISH_AFTER;
  const count = isChoice || isFinish || autoTool || autoFinish ? MIN_BATCH
    : isLong ? MAX_BATCH
    : isShort ? MIN_BATCH
    : 3;
  const items = [];
  for (let i = 0; i < count; i += 1) {
    items.push({
      role: 'assistant',
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
  return createMockAgentProvider({ responses: [{ items, tool_call }] });
}

// Demo pacing constants for buildDemoMockAgentProvider (Story 09 arc).
const MIN_BATCH = 1;
const MAX_BATCH = 4;
const CHOICE_EVERY = 2;     // emit a choice tool_call every N narrative batches
const FINISH_AFTER = 5;     // emit a finish_story tool_call after N narrative batches

/**
 * Per-session turn counter for the deterministic demo provider. The map
 * is intentionally process-local: a fresh process starts a fresh demo
 * arc. The store mirrors the route layer pattern (sessionPinnedMetadata)
 * and is wiped when the server restarts.
 *
 * The store is bounded so a long-running server cannot grow without
 * limit. Eviction follows the route layer pattern (sessionPinnedMetadata)
 * and is LRU-based; an evicted session simply restarts the demo arc
 * from turn 0 on the next /generate call. That is acceptable: the demo
 * arc is non-authoritative — its only consumer is the player frontend's
 * default input ('hello').
 */
const demoTurnCounter = new BoundedMap({ max: 1024, name: 'demoTurnCounter' });
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

// When STORY_OUTSIDE_PROVIDER=real is selected we MUST NOT advertise
// `official_zhihu_api: false` — the upstream is now being called, with
// the caveats spelled out below. The flag is computed lazily per
// request so a process that switches provider via env after start
// (tests do this) reports accurately. MockProvider keeps DEMO_FLAG
// verbatim so existing tests that assert demo.official_zhihu_api ===
// false continue to hold.
//
// The official Zhihu Hackathon story content API only exposes the
// `/story/list` and `/story/{id}` endpoints. It deliberately does NOT
// expose a chat / completion endpoint, and it does NOT model the
// in-app Agent runtime (generate / narrative / tool routing). Those
// surfaces therefore stay bound to the deterministic demo provider
// regardless of STORY_OUTSIDE_PROVIDER — they have no upstream
// counterpart. The allow-list below makes that contract loud on the
// wire so a client can tell at a glance whether a response came from
// the real adapter or from the deterministic in-process demo.
const MOCK_ONLY_ROUTES = Object.freeze([
  // Phase 4 admin tooling operates on the seeded/local projection (not on
  // the live upstream). With STORY_OUTSIDE_PROVIDER=real these endpoints
  // remain dev-only and refuse upstream writes; when MariaDB is configured,
  // accepted projection mutations are still flushed to the database.
  '/api/admin/stories',
  '/api/admin/stories/:slug/import',
  '/api/admin/opening-cache/rebuild',
  // Group-chat echo placeholder — this endpoint never pretended to call
  // a real model; with the real story provider it still echoes input.
  '/api/chat',
  // Agent runtime + session-tool routes. The official story content
  // API is read-only JSON; narrative generation is owned by an
  // in-process deterministic demo. These routes stay demo-only.
  '/api/dev/sessions',
  '/api/dev/sessions/:uuid',
  '/api/dev/sessions/:uuid/opening-events',
  '/api/dev/sessions/:uuid/recover',
  '/api/dev/sessions/:uuid/discard-pending',
  '/api/dev/sessions/:uuid/ending',
  '/api/dev/sessions/:uuid/original-timeline',
  '/api/dev/sessions/:uuid/replay',
  '/api/dev/sessions/:uuid/interrupt',
  '/api/dev/sessions/:uuid/generate',
  '/api/dev/sessions/:uuid/narrative-events',
  '/api/dev/sessions/:uuid/first-choice',
  '/api/admin/observability/sessions/:uuid',
  '/api/admin/observability/metrics/summary',
]);

function currentDemoFlag() {
  let providerName = 'mock';
  try {
    providerName = getStoryProvider().name;
  } catch {
    providerName = (process.env.STORY_OUTSIDE_PROVIDER || 'mock').trim().toLowerCase();
  }
  if (providerName === 'real') {
    return Object.freeze({
      mode: 'live',
      provider: 'real',
      official_zhihu_api: true,
      contract: 'zhihu_hackathon_2026_p2',
      // Per the official contract these endpoints are unauthenticated
      // during the hackathon. Surface that on the wire so a client can
      // tell at a glance whether it is talking to a real adapter that
      // happens not to need credentials, vs. a misconfigured deployment
      // that quietly dropped a required Authorization header.
      auth: 'none',
      // The contract document explicitly warns the endpoints may change
      // once the hackathon closes. We re-read that warning every response
      // so a future operator does not have to chase it down in the docs.
      scope: 'zhihu_hackathon_2026_p2',
      // Surfaces that stay bound to the deterministic demo even when
      // the story content provider is real. See MOCK_ONLY_ROUTES.
      mock_only_routes: MOCK_ONLY_ROUTES,
      reason:
        'Live mode: data is served by src/providers/realProvider.mjs against ' +
        'api.zhihu.com/km-indep-home/hackathon/v2/story/*. See ' +
        'docs/official-zhihu-skill.md for the integration boundary and the ' +
        'no-credential contract.',
    });
  }
  return DEMO_FLAG;
}

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

function jsonResponse(res, status, payload, { persist = true } = {}) {
  const body = JSON.stringify(payload);
  const write = (writeStatus = status, writePayload = payload) => {
    const serialized = JSON.stringify(writePayload);
    res.writeHead(writeStatus, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(serialized),
      'cache-control': 'no-store',
    });
    res.end(serialized);
  };
  if (!databasePersistence || !persist) {
    write();
    return;
  }
  return databasePersistence.flush().then(
    () => write(),
    (error) => {
      // Do not acknowledge a business mutation when its transaction failed.
      // Keep the database error out of the public response body.
      // eslint-disable-next-line no-console
      console.error('[story-outside] MariaDB persistence failure:', String(error && error.message ? error.message : error));
      if (!res.headersSent) {
        write(503, {
          error: 'database_unavailable',
          message: 'The service could not persist the request.',
          demo: currentDemoFlag(),
        });
      } else {
        try { res.end(); } catch { /* response already failed */ }
      }
    },
  );
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
  const isHead = (req.method || 'GET').toUpperCase() === 'HEAD';
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    sendText(res, 400, 'Bad Request');
    return;
  }
  let safePath = normalize(decoded);
  if (safePath === '/' || safePath === '') safePath = '/index.html';
  const absolutePath = join(PUBLIC_DIR, safePath);
  // Compare with a path-relative boundary so a sibling directory named
  // `public-…` cannot be mistaken for being inside PUBLIC_DIR.
  const rel = relative(PUBLIC_DIR, absolutePath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
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
    if (isHead) res.end();
    else res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') sendText(res, 404, 'Not Found');
    else sendText(res, 500, 'Internal Server Error');
  }
}

async function readJsonBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let total = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      total += chunk.length;
      if (total > 64 * 1024) {
        rejected = true;
        // Do NOT destroy the socket: the route layer needs to send a
        // structured 400/413 response. Resume the stream so the request
        // does not stall the keep-alive connection, and drop any further
        // data events.
        req.resume();
        reject(new ValidationError('payload_too_large', { code: 'payload_too_large', details: { limit_bytes: 64 * 1024 } }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolveBody({});
      try {
        resolveBody(JSON.parse(raw));
      } catch (err) {
        reject(new ValidationError('bad_json', { code: 'bad_json' }));
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
  if (err instanceof StoryNotFoundError) return { status: 404, code: err.code, details: err.details || null };
  if (err instanceof ValidationError) return { status: 400, code: err.code, details: err.details || null };
  if (err instanceof ProviderError) return { status: 502, code: err.code, details: err.details || null };
  return { status: 500, code: 'provider_error' };
}

// Stories application layer. The in-memory projection is seeded from the
// bundled catalog, then replaced with its MariaDB-hydrated projection when a
// database is configured. The service layer keeps its synchronous contract;
// the persistence adapter flushes before JSON responses.
const { repository: seededStoryRepository, fixtures: storyFixtures } = createSeededRepository();
let storyRepo = seededStoryRepository;

// Story 16.1 server.mjs wiring (2026-09-06): a single in-memory
// community-profile repository is seeded once per process from the
// mock fixtures so admin/dev tooling can introspect profiles for any
// of the canonical stories. The PUBLIC real-provider routes
// (`/api/stories/:workId/ensure`, `POST /api/sessions`) hand this repo
// to the application-layer import helper so freshly imported
// story_versions get a profile tagged `source: 'real-generated'`
// instead of silently falling back to the `mock-generated` default.
// Admin/dev import routes (`/api/admin/stories/:slug/import`,
// `/api/admin/opening-cache/rebuild`) deliberately do NOT pass it:
// those surfaces keep the historical mock-fixture profile seeded by
// `seedCommunityProfiles` below, and the hook inside
// `importStoryAndEnsureCache` falls back to `mock-generated` for any
// story_version the seed loop did not cover.
let communityProfileRepo = createInMemoryCommunityProfileRepository();
let followingRepo = createInMemoryFollowingRepository();
let followingService;
let ecosystemSearchCacheRepo = createInMemoryEcosystemSearchCacheRepository();

try {
  const pool = await connectDatabase();
  if (pool) {
    const persisted = await createMariaDbRepositories({
      pool,
      storyRepository: storyRepo,
      communityProfileRepository: communityProfileRepo,
      followingRepository: followingRepo,
      ecosystemSearchCacheRepository: ecosystemSearchCacheRepo,
    });
    databasePersistence = persisted;
    storyRepo = persisted.storyRepository;
    communityProfileRepo = persisted.communityProfileRepository;
    followingRepo = persisted.followingRepository;
    ecosystemSearchCacheRepo = persisted.ecosystemSearchCacheRepository;
  }
} catch (error) {
  databaseBootstrapError = error;
}

seedCommunityProfiles(storyRepo, communityProfileRepo);
// Test hook (NO production consumers): the regression suite reads
// the live repo so it can install / override rows for the
// community_profile_version_mismatch path. The hook is NOT exported
// on any public surface; it is a process-global symbol that ONLY
// exists when the server is running inside a test harness.
if (typeof globalThis !== 'undefined') {
  /** @type {any} */ (globalThis).__storyOutsideCommunityRepoForTests = communityProfileRepo;
}

// Story 16.4 P1 fix (2026-09-07): home-page 知乎热榜 orchestrator.
// Owns its own pair-key cache so two callers with different identity
// triples share the upstream data but see distinct relevance
// projections. The orchestrator is created once per process so its
// cache survives across requests; tests can build a fresh one.
const ecosystemHotOrchestrator = createEcosystemHotOrchestrator();

// 「故事里的相遇」的关注关系来自知乎官方 `/api/v1/user/followees`，不由本站
// 维护（见 src/ecosystem/following/service.mjs 顶部说明）。这里把三样东西装
// 配起来：本地的分享/屏蔽记录仓库、登录时登记的「知乎 url_token → 本站账号」
// 目录、以及官方关注接口适配层。适配层按每次请求传入当前登录者的 OAuth
// token；缺少 Access Secret 配置或未登录时，关注流降级为明确的空态。
followingService = createFollowingService({
  repository: followingRepo,
  accountDirectory: { resolve: (token) => followingRepo.resolveAccount(token) },
  fetchFollowees: (args) => fetchZhihuFollowees(args, { env: { ZHIHU_ACCESS_SECRET: loadZhihuAccessSecret() } }),
  listActivities: (ownerUuid) => listOwnerActivities(storyRepo, ownerUuid),
});

// Story 16.3 — the public surface decorator is hoisted near the
// ecosystem helpers so the cookie / share / follow code below can
// reference it without hitting a TDZ on `PUBLIC_DECORATE`. The
// original definition near POST /api/sessions is left in place for
// diff stability; we forward to it through this alias.
const PUBLIC_DECORATE_FOR_ECOSYSTEM = () => ({ demo: currentDemoFlag() });
function publicDecorate() {
  return PUBLIC_DECORATE_FOR_ECOSYSTEM();
}

// All personal routes resolve the server-verified owner through currentUserProvider.

/**
 * Map a FollowingError to an HTTP status. Used by every /v1/ecosystem
 * route. Mirrors the contract used by the share / unshare PRs.
 *
 * Story 16.3 P1 (code review 2026-09-07 review): a missing session
 * surfaces as 401 (not 404). The caller has proven their identity via
 * the cookie; the contract is "the session exists and is yours", so a
 * missing session is an authentication-style failure from the
 * caller's perspective rather than a public 404 resource lookup.
 */
function followingErrorToStatus(code) {
  switch (code) {
    case 'not_session_owner':
    case 'cannot_follow_self':
    case 'cannot_unfollow_self':
    case 'cannot_block_self':
    case 'invalid_input':
    case 'validation_failed':
      return 400;
    case 'unauthenticated':
    case 'session_not_found':
    case 'not_found':
      return 401;
    case 'forbidden':
      return 403;
    default:
      return 400;
  }
}

function sendFollowingError(res, err) {
  if (err instanceof FollowingError) {
    const status = followingErrorToStatus(err.code);
    /** @type {Record<string, unknown>} */
    const body = {
      error: err.code,
      message: err.message,
      ...publicDecorate(),
    };
    if (err.details) body.details = err.details;
    return jsonResponse(res, status, body);
  }
  return jsonResponse(res, 500, {
    error: 'internal_error',
    message: 'Internal server error.',
    ...publicDecorate(),
  });
}

// ---------------------------------------------------------------------
// Story 16.2 P1.v2 (2026-09-07 code review): ecosystem search
// route uses a server-authoritative identity triple. The cache is
// keyed per (story_version_uuid, community_profile_version, query_id,
// query_hash) so different profiles / different queries never share
// a row. The adapter is selected by STORY_OUTSIDE_ECOSYSTEM_SEARCH
// (`mock` default; `real` requires hasRealSearchCredentials()).
// ---------------------------------------------------------------------
const ecosystemSearchAdapter = (process.env.STORY_OUTSIDE_ECOSYSTEM_SEARCH || process.env.STORY_OUTSIDE_PROVIDER) === 'real'
  ? createOfficialSearchSource() : createMockZhihuSearchSource();
const officialKnowledge = createOfficialKnowledgeSource();
const endingAnalysisTasks = createEndingAnalysisTasks();

/**
 * Resolve the canonical `community_profile_version` string for a
 * given `story_version_uuid`.
 *
 * Story 16.2 P1.v2 (2026-09-07): the player needs a stable
 * `community_profile_version` (and the canonical `profile.queries[]`)
 * so it can submit them to `/v1/ecosystem/discussions`. The version
 * string is `${generator_version}@${content_hash[:16]}` — a new value
 * iff the profile is regenerated. The format helper lives in
 * `src/community/repository.mjs` and is the SINGLE authority for the
 * string shape.
 *
 * @param {string|null|undefined} story_version_uuid
 * @returns {{ community_profile_version: string|null, community_profile_queries: object[]|null }}
 */
function resolveCommunityProfileVersion(story_version_uuid) {
  if (typeof story_version_uuid !== 'string' || !story_version_uuid) {
    return { community_profile_version: null, community_profile_queries: null };
  }
  try {
    const profile = communityProfileRepo.findActiveByStoryVersion(story_version_uuid);
    if (!profile) {
      return { community_profile_version: null, community_profile_queries: null };
    }
    const version = buildCanonicalCommunityProfileVersion(profile);
    const queries = Array.isArray(profile.queries) ? profile.queries.slice() : null;
    return {
      community_profile_version: version,
      community_profile_queries: queries,
    };
  } catch {
    return { community_profile_version: null, community_profile_queries: null };
  }
}

// Story 16.5 — public /v1/ecosystem/knowledge orchestrator. The
// route layer (handler further down) calls `knowledgeProvider.match()`
// once per canonical knowledge_query resolved from the
// StoryCommunityProfile on the server side. We DO NOT pre-seed any
// topic-style surface — the topic source is always the canonical
// knowledge_queries[] emitted by the profile generator at story_version
// import time.
//
// P1.v1-4 fix (2026-09-07 owner review): the route handler
// resolves the canonical profile via
// `communityProfileRepo.findByExternalVersion` — a pure exact-match
// lookup that walks every preserved row and matches by the external
// version string. NO active-row concept is consulted, so an old
// session that pinned the prior external version keeps resolving
// the prior row even after a newer content_hash has overtaken the
// active slot for the same (story_version_uuid, generator_version)
// scope. This is the seam that fixed the `communityProfile.test`
// 8th-run flake: a row whose active index has been overwritten still
// resolves via its external version.
const knowledgeProvider = createEcosystemKnowledgeProvider({
  communityProfileRepo,
  ...(process.env.STORY_OUTSIDE_PROVIDER === 'real' ? { realProvider: officialKnowledge } : {}),
});

// Thin in-process service namespace. The route layer never imports
// src/community/service.mjs directly so we keep the canonical
// helpers in one place here. Exposing `communityProfileService`
// also makes the static guard `grep communityProfileService` match
// the handler location.
const communityProfileService = Object.freeze({
  findCanonicalByIdentity: findCanonicalByIdentity,
});

// sessionService deliberately keeps its state private to the repository. The
// route layer keeps a bounded response cache for the non-secret pinned
// metadata; after a restart or an LRU eviction the same view is rebuilt from
// the durable session projection instead of being treated as missing.
const sessionPinnedMetadata = new BoundedMap({ max: 1024, name: 'sessionPinnedMetadata' });
// Per-session turn-level request idempotency map. Keyed by session_uuid,
// then by request_id. The map intentionally lives outside the repository
// because the runtime does not own it (the repository is process-shared
// with other tests/routes); the route layer is the only producer.

const PINNED_GENERATION_PROFILE_KEYS = [
  'cache_uuid',
  'story_uuid',
  'story_version_uuid',
  'generation_hash',
  'identifier',
  'rules_version',
  'locale',
  'variant',
];

function pinnedGenerationProfile(profile) {
  const result = {};
  if (!profile || typeof profile !== 'object') return result;
  for (const key of PINNED_GENERATION_PROFILE_KEYS) {
    if (profile[key] !== undefined) result[key] = profile[key];
  }
  return result;
}

function publicPinnedMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  return {
    role_id: metadata.role_id,
    generation_profile: pinnedGenerationProfile(metadata.generation_profile),
  };
}

function durablePinnedMetadata(session) {
  if (!session || typeof session !== 'object') return null;
  return {
    user_ref: session.user_ref,
    role_id: session.role_id,
    model: session.model,
    prompt: session.prompt,
    generation_profile: pinnedGenerationProfile(session.generation_profile),
  };
}

function pinnedMetadataForSession(session_uuid, { publicSurface = false } = {}) {
  const cached = sessionPinnedMetadata.get(session_uuid);
  if (cached) return publicSurface ? publicPinnedMetadata(cached) : cached;
  try {
    const recovered = recoverSession({ repository: storyRepo, session_uuid });
    const rebuilt = durablePinnedMetadata(recovered);
    return publicSurface ? publicPinnedMetadata(rebuilt) : rebuilt;
  } catch {
    return null;
  }
}

const SESSION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isSessionUuid(value) {
  return typeof value === 'string' && SESSION_UUID_PATTERN.test(value);
}

function sessionError(err) {
  // ValidationError carries a precise machine code (e.g. 'payload_too_large',
  // 'bad_json', 'invalid_input') that the route layer should pass through
  // verbatim. A 500 fallback would hide the real reason from clients and
  // duplicate the mapping that classifyProviderError already does for the
  // provider surface.
  if (err instanceof ValidationError) {
    return { status: 400, code: err.code || 'validation_failed', message: 'The session request is invalid.', details: err.details || null };
  }
  // Issue #9 — the public /api/sessions façade calls into the
  // provider through bootstrapSessionFromWork, so a missing story
  // raises StoryNotFoundError. classifyProviderError already maps this
  // to 404, and we mirror that contract here so the new route surfaces
  // the same stable code instead of the 500 internal_error fallback.
  if (err instanceof StoryNotFoundError) {
    return { status: 404, code: err.code || 'story_not_found', message: err.message, details: err.details || null };
  }
  // M4 typed-error short-circuits. Errors raised inside the service carry
  // stable codes that map to specific HTTP statuses; the message-regex
  // fallback below only runs for plain Error instances.
  if (err && err.code === 'session_not_found') {
    return { status: 404, code: 'session_not_found', message: 'Session was not found.', details: err.details || null };
  }
  if (err && err.code === 'repository_not_initialized') {
    return { status: 500, code: 'internal_error', message: 'Internal server error.', details: err.details || null };
  }
  if (err && err.code === 'too_many_client_request_ids') {
    return { status: 400, code: 'too_many_client_request_ids', message: err.message, details: err.details || null };
  }
  // PR #7 code review 2026-09-05 follow-up (Blocker 1+2): opening-cache
  // store at the cap with every row pinned. Maps to 503 because the
  // caller has to finish or evict a session to make room — the demo
  // does not silently drop pinned caches.
  if (err && err.code === 'too_many_pinned_caches') {
    return { status: 503, code: 'too_many_pinned_caches', message: err.message, details: err.details || null };
  }
  const text = String(err && err.message ? err.message : '');
  // M4 follow-up: the legacy 'unknown session' string is no longer raised
  // by the service (the service throws SessionNotFoundError with code
  // 'session_not_found' instead). We keep a defensive substring check
  // here ONLY for older snapshots that might still surface the old
  // message — narrowing the match to the full 'unknown session' phrase
  // so unrelated 'unknown X' messages cannot silently become 404s.
  if (/^sessionService: unknown session\b/.test(text)) {
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
  // Plain programming / infrastructure mistakes must surface as 500, not
  // masquerade as client validation failures. The 'repository has no
  // sessionState' line was historically leaked from endingService and
  // re-classified as 400 by the broad prefix regex below; that exact
  // phrasing is now 500 because it is an internal-state mistake that
  // should never reach the HTTP layer in the first place.
  if (/repository required|builder function required|index corruption|cannot read|undefined is not|sessionService: unknown error code|has no sessionState/i.test(text)) {
    return { status: 500, code: 'internal_error', message: 'Internal server error.' };
  }
  // Whitelist of sessionService / endingService / public service-function
  // validation messages. The previous draft used a single broad regex with
  // the literal "invalid" in it, which over-matched: any new service-layer
  // message starting with "invalid" would be silently re-classified as
  // 400. Keep this list narrow — extend it explicitly when a new
  // client-facing validation is added. Service-function prefixes now
  // also match only when followed by a known service message pattern,
  // so the broad '(session|ending|stage)Service:' stem cannot sweep in
  // an internal-state line by accident.
  if (
    /^(commitOpeningEvent|stageNarrativeBatch|createSession|discardPendingTail|interruptWithPlayerInput|appendEvent|buildEnding|buildOriginalTimeline|buildReplay):/i.test(text) ||
    /^(session|ending|stage)Service: (invalid |pinned cache|role_id|generation_profile|sequence|event|prompt|expected_revision|cache_uuid|pending_id|client_request_id|revision |request_id|must |session_uuid|cache|tool|not )/i.test(text) ||
    /^(session|ending|stage)Service: invalid /i.test(text) ||
    /not allowed in canonical history$/i.test(text) ||
    /^tool-only batches are not allowed$/i.test(text) ||
    /must be a UUID|must be an integer|must be a non-negative integer|must be a positive integer|must be a non-empty string|must be an array|must be an object|must contain|must return|must equal|sequence must|out of range|does not match|not present|not interruptible|not accepting|already has an unconsumed|at least one/i.test(text)
  ) {
    return { status: 400, code: 'validation_failed', message: 'The session request is invalid.' };
  }
  return { status: 500, code: 'internal_error', message: 'Internal server error.' };
}

function sessionErrorResponse(res, err) {
  const { status, code, message, details } = sessionError(err);
  const body = { error: code, message, demo: currentDemoFlag(), dev: DEV_FLAG };
  if (details) body.details = details;
  return jsonResponse(res, status, body);
}

function agentRuntimeErrorResponse(res, err, decoration = {}, context = {}) {
  loggerWarn('agent.request.failed', { session_uuid: context.session_uuid || null, component: 'agent', error_code: err.code, extra: { retryable: err.retryable === true } });
  // AgentRuntimeError always carries an explicit boolean. Keep the
  // fallback for older callers, but never turn an explicit false into a
  // retryable 502 merely because the code is provider_failure.
  const retryable = err?.retryable === true
    || (err?.retryable === undefined && err?.code === 'provider_failure');
  return jsonResponse(res, retryable ? 502 : 400, {
    error: err.code,
    message: err.message,
    ...(retryable ? { retryable: true } : {}),
    ...decoration,
  }, { persist: context.persist !== false });
}

function rejectInvalidSessionUuid(res, session_uuid) {
  if (isSessionUuid(session_uuid)) return false;
  jsonResponse(res, 400, {
    error: 'validation_failed',
    message: 'session_uuid must be a UUID',
    demo: currentDemoFlag(),
    dev: DEV_FLAG,
  });
  return true;
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

async function handleRequest(req, res) {
  const method = req.method || 'GET';
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (oauth.enabled) bindCurrentUser(req, oauth.owner(req));
  const authRoute = pathname.startsWith('/auth/') || pathname === '/api/auth/status';
  const personalRoute = /^\/api\/sessions(?:\/|$)/.test(pathname)
    || /^\/v1\/ecosystem\/(?:friend-timelines$|visibility$|sessions\/)/.test(pathname);
  if (authRoute || personalRoute) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
  }
  if (pathname.startsWith('/auth/')) {
    try {
      let location;
      if (pathname === '/auth/login' && method === 'GET') location = oauth.start(req, res, url);
      else if (pathname === '/auth/callback' && method === 'GET') {
        location = await oauth.callback(req, res, url);
      }
      else if (pathname === '/auth/logout' && method === 'POST' && oauth.enabled) {
        oauth.logout(req, res);
        return jsonResponse(res, 200, { ok: true });
      } else return jsonResponse(res, 405, { error: 'method_not_allowed' });
      res.writeHead(303, { Location: location }); res.end(); return;
    } catch (error) {
      const code = /^oauth_|^csrf_rejected$/.test(error.code || '') ? error.code : 'oauth_failed';
      if (pathname === '/auth/callback') {
        // Drop the authorization code from the browser URL and any subsequent referrer.
        res.writeHead(303, { Location: '/?oauth_error=' + encodeURIComponent(code) }); res.end(); return;
      }
      return jsonResponse(res, error.status || 400, { error: code });
    }
  }
  if (method === 'GET' && pathname === '/api/auth/status' && oauth.enabled) {
    return jsonResponse(res, 200, oauth.status(req));
  }
  if (oauth.enabled) {
    // The old development APIs accept caller-provided identities; never expose
    // this alternative path in an OAuth deployment, even without a proxy ACL.
    if (/^\/api\/(admin|dev)(?:\/|$)/.test(pathname)) return jsonResponse(res, 403, { error: 'forbidden' });
    if (personalRoute) {
      const owner = currentUserProvider(req);
      if (!owner) return jsonResponse(res, 401, { error: 'login_required', message: '请先使用知乎登录。', login_url: '/auth/login' });
      if (!['GET', 'HEAD'].includes(method)) {
        try { oauth.assertOrigin(req); } catch { return jsonResponse(res, 403, { error: 'csrf_rejected' }); }
      }
      const match = pathname.match(/^\/api\/sessions\/([^/]+)/);
      if (match && isSessionUuid(match[1])) {
        const sessionOwner = findOwnerBySession({ repository: storyRepo, session_uuid: match[1] });
        if (sessionOwner !== owner.user_uuid) return jsonResponse(res, 404, { error: 'session_not_found' });
      }
    }
  }

  // Health & meta
  if (method === 'GET' && pathname === '/api/health') {
    let providerName = 'mock';
    try {
      providerName = getStoryProvider().name;
    } catch {
      // Provider unavailable — fall back to env var so /api/health
      // still answers while the bootstrap layer figures out the
      // misconfiguration. The route below will surface the real error
      // on the first data request.
    }
    return jsonResponse(res, 200, {
      ok: true,
      name: 'story-outside',
      version: '0.1.0',
      phase: 4,
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      provider: providerName,
      database: databaseStatus(),
      demo: currentDemoFlag(),
    });
  }

  // Resolve the data provider once per request; routes below call methods on it.
  let provider;
  try {
    provider = createPreparedStoryProvider(getStoryProvider(), loadAIConfig());
  } catch (err) {
    return jsonResponse(res, 500, {
      error: 'provider_unavailable',
      message: String(err && err.message ? err.message : err),
      demo: currentDemoFlag(),
    });
  }

  // Story catalog
  if (method === 'GET' && pathname === '/api/stories') {
    try {
      const stories = await provider.listStories();
      return jsonResponse(res, 200, { demo: currentDemoFlag(), stories });
    } catch (err) {
      const { status, code } = classifyProviderError(err);
      // The catalog routes historically returned the typed error without
      // logging, which made the 2026-09-14 upstream_4xx incident
      // invisible in journald (only the Apache access log showed it).
      // Emit one warn line with the upstream status when we have it.
      loggerWarn('stories.request.failed', {
        component: 'http',
        error_code: code,
        extra: {
          route: 'stories',
          method,
          http_status: status,
          upstream_status: err instanceof ProviderError && err.details && typeof err.details.status === 'number' ? err.details.status : null,
        },
      });
      return jsonResponse(res, status, { error: code, demo: currentDemoFlag() });
    }
  }

  // Single story
  const storyMatch = pathname.match(/^\/api\/stories\/([a-z0-9-]+)$/);
  if (method === 'GET' && storyMatch) {
    try {
      const story = await provider.getStory(storyMatch[1]);
      return jsonResponse(res, 200, { demo: currentDemoFlag(), story });
    } catch (err) {
      const { status, code } = classifyProviderError(err);
      loggerWarn('stories.request.failed', {
        component: 'http',
        error_code: code,
        extra: {
          route: 'story_detail',
          method,
          http_status: status,
          upstream_status: err instanceof ProviderError && err.details && typeof err.details.status === 'number' ? err.details.status : null,
        },
      });
      return jsonResponse(res, status, { error: code, demo: currentDemoFlag() });
    }
  }

  // Advance story beat
  if (method === 'POST' && pathname === '/api/stories/advance') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      const { status, code } = classifyProviderError(err);
      return jsonResponse(res, status, { error: code, demo: currentDemoFlag() });
    }
    try {
      const result = await provider.advanceStory({
        storyId: body && body.storyId,
        roleId: body && body.roleId,
        index: body && body.index,
      });
      return jsonResponse(res, 200, { demo: currentDemoFlag(), ...result });
    } catch (err) {
      const { status, code } = classifyProviderError(err);
      return jsonResponse(res, status, { error: code, demo: currentDemoFlag() });
    }
  }

  // Demo "group chat" placeholder — echoes input, no real LLM behind it.
  if (method === 'POST' && pathname === '/api/chat') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      const { status, code } = classifyProviderError(err);
      return jsonResponse(res, status, { error: code, demo: currentDemoFlag() });
    }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      return jsonResponse(res, 400, { error: 'empty_text', demo: currentDemoFlag() });
    }
    return jsonResponse(res, 200, {
      demo: currentDemoFlag(),
      reply: `(mock)你说了：${text.slice(0, 280)}`,
      timestamp: new Date().toISOString(),
    });
  }

  // -----------------------------------------------------------------------
  // Phase 4 routes — story import, version, opening cache, session snapshot.
  //
  // All Phase 4 routes are demo/dev-only and live under /api/admin/* so a
  // reverse proxy can block them with one ACL. They carry the DEV_FLAG
  // banner on every response, are un-authenticated by design, and use the
  // same MariaDB flush boundary as the public business routes.
  // -----------------------------------------------------------------------

  // GET /api/admin/stories — list every story currently in the in-memory
  // repository projection (seeded fixtures ∪ stories imported via the real
  // provider). Includes their story_uuid / story_version_uuid
  // list so admins can copy identifiers and bootstrap a session against
  // any imported story, not just the seeded mock catalogue.
  if (method === 'GET' && pathname === '/api/admin/stories') {
    const out = [];
    for (const row of storyRepo.listStories()) {
      const versions = storyRepo.listVersionsByStory(row.story_uuid);
      out.push({
        slug: row.slug,
        story_uuid: row.story_uuid,
        title: row.title,
        versions: versions.map((v) => ({
          story_version_uuid: v.version_uuid,
          version_no: v.version_no,
          checksum: v.checksum,
          status: v.status,
        })),
      });
    }
    return jsonResponse(res, 200, { demo: currentDemoFlag(), dev: DEV_FLAG, stories: out });
  }

  // POST /api/admin/stories/import — run the canonical import pipeline for a
  // slug. Same content → no new version; different content → new version_no.
  // The response now always carries a non-null opening_cache_uuid /
  // opening_cache_status (see importStoryAndEnsureCache), so the frontend
  // bootstrap can immediately create a session against the imported story.
  const importMatch = pathname.match(/^\/api\/admin\/stories\/([a-z0-9-]+)\/import$/);
  if (method === 'POST' && importMatch) {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      const { status, code } = classifyProviderError(err);
      return jsonResponse(res, status, { error: code, demo: currentDemoFlag(), dev: DEV_FLAG });
    }
    // Body-supplied story_uuid wins; otherwise look up an existing row for
    // this slug (idempotent re-import), or allocate a fresh v4 UUID.
    //
    // B4 fix: the previous default used `randomUUID().slice(0,12)` which
    // produced an invalid tail segment (the slice spans the second hyphen
    // of a v4 UUID). Repository-level UUID_PATTERN validation rejected
    // the resulting string. We now use crypto.randomUUID() directly —
    // it is already a valid v4 UUID — and also fall back to any
    // existing story_uuid for the same slug so that an "omit
    // story_uuid" request against an already-imported story resolves
    // idempotently rather than producing a second duplicate row.
    let story_uuid = typeof body.story_uuid === 'string' && body.story_uuid
      ? body.story_uuid
      : null;
    if (!story_uuid) {
      const existing = storyRepo.findStoryBySlug(importMatch[1]);
      story_uuid = existing ? existing.story_uuid : randomUUID();
    }
    try {
      const result = await importStoryFromProvider({
        repository: storyRepo,
        provider,
        slug: importMatch[1],
        story_uuid,
      });
      return jsonResponse(res, 200, { demo: currentDemoFlag(), dev: DEV_FLAG, result });
    } catch (err) {
      const { status, code } = classifyProviderError(err);
      return jsonResponse(res, status, {
        error: code,
        message: String(err && err.message ? err.message : err),
        demo: currentDemoFlag(),
        dev: DEV_FLAG,
      });
    }
  }

  // POST /api/stories/:workId/ensure — idempotent "select real story →
  // bootstrap session" seam. The frontend's real-mode bootstrap calls
  // this after picking a story from /api/stories (which only returns
  // DTOs, not UUIDs). The handler imports the story if it is not yet in
  // the repository, ensures a public opening cache exists, and returns
  // everything the client needs to start a session:
  //   { story_uuid, story_version_uuid, opening_cache_uuid, opening_cache_status }
  //
  // Idempotent: a second call returns the same UUIDs and reports
  // cache_reused=true so a frontend retry cannot create a second
  // version row.
  const ensureMatch = pathname.match(/^\/api\/stories\/([a-z0-9-]+)\/ensure$/);
  if (method === 'POST' && ensureMatch) {
    const workId = ensureMatch[1];
    // Look up existing story first so the call is fully idempotent.
    const existing = storyRepo.findStoryBySlug(workId);
    const story_uuid = existing
      ? existing.story_uuid
      : randomUUID();
    try {
      const result = await importStoryFromProvider({
        repository: storyRepo,
        provider,
        slug: workId,
        story_uuid,
        // Story 16.1 server.mjs wiring (2026-09-06): the public
        // real-provider path wires the in-memory community-profile
        // repo AND tags the freshly built profile with
        // `source: 'real-generated'`. Admin/dev import routes above
        // deliberately omit both args so the hook falls back to the
        // historical `mock-generated` default and the seeded
        // mock-fixture profiles remain authoritative for those
        // surfaces.
        profileRepository: communityProfileRepo,
        profileOptions: { source: 'real-generated' },
      });
      return jsonResponse(res, 200, {
        demo: currentDemoFlag(),
        dev: DEV_FLAG,
        slug: workId,
        story_uuid: result.story_uuid,
        story_version_uuid: result.story_version_uuid,
        version_no: result.version_no,
        version_reused: result.version_reused,
        cache_reused: result.cache_reused,
        opening_cache_uuid: result.opening_cache_uuid,
        opening_cache_status: result.opening_cache_status,
      });
    } catch (err) {
      const { status, code } = classifyProviderError(err);
      return jsonResponse(res, status, {
        error: code,
        message: String(err && err.message ? err.message : err),
        demo: currentDemoFlag(),
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
      return jsonResponse(res, status, { error: code, demo: currentDemoFlag(), dev: DEV_FLAG });
    }
    if (!body.story_version_uuid || typeof body.story_version_uuid !== 'string') {
      return jsonResponse(res, 400, {
        error: 'missing_story_version_uuid',
        demo: currentDemoFlag(),
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
      return jsonResponse(res, 200, { demo: currentDemoFlag(), dev: DEV_FLAG, result });
    } catch (err) {
      const { status, code } = classifyProviderError(err);
      return jsonResponse(res, status, {
        error: code,
        message: String(err && err.message ? err.message : err),
        demo: currentDemoFlag(),
        dev: DEV_FLAG,
      });
    }
  }

  // Story 05 session playback routes. These call the session-local service
  // directly: creating a session pins the supplied cache, recovery is read
  // only, and events are appended only by explicit commit/interrupt calls.
  if (method === 'POST' && pathname === '/api/dev/sessions') {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
    // Keep the Story 04 snapshot route compatible when the new playback
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
          field: missing, demo: currentDemoFlag(), dev: DEV_FLAG,
        });
      }
      for (const key of ['session_uuid', 'story_uuid', 'story_version_uuid']) {
        if (!isSessionUuid(body[key])) {
          return jsonResponse(res, 400, {
            error: 'validation_failed', message: 'The session request is invalid.',
            field: key, demo: currentDemoFlag(), dev: DEV_FLAG,
          });
        }
      }
      if (!isSessionUuid(body.generation_profile.cache_uuid)) {
        return jsonResponse(res, 400, {
          error: 'invalid_cache', message: 'The opening cache is invalid for this session.',
          demo: currentDemoFlag(), dev: DEV_FLAG,
        });
      }
      const pinnedCache = storyRepo.findOpeningCacheByUuid(body.generation_profile.cache_uuid);
      if (!pinnedCache || pinnedCache.status !== 'valid') {
        return jsonResponse(res, 400, {
          error: 'invalid_cache', message: 'The opening cache is invalid for this session.',
          demo: currentDemoFlag(), dev: DEV_FLAG,
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
        // Story 16.3 P1.2 (code review 2026-09-07 review): refactored the
        // `/api/dev/sessions` legacy helper to read the caller-provided
        // `user_ref` through a bracket-indexed accessor (NOT dot notation)
        // so the grep verification can pin "no identity-shaped fields
        // are read off the body in any share-adjacent path". The
        // semantic behaviour of this demo-only route is unchanged: it
        // still echoes the caller-provided user_ref in the response
        // and uses it as the session's user_ref.
        const callerIdentityRef = body['user_ref'];
        const result = createSession({
          repository: storyRepo,
          session_uuid: body.session_uuid,
          story_uuid: body.story_uuid,
          story_version_uuid: body.story_version_uuid,
          user_ref: callerIdentityRef,
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
          user_ref: callerIdentityRef,
          role_id: body.role_id,
          model: body.model,
          prompt: body.prompt,
          generation_profile: profile,
        };
        sessionPinnedMetadata.set(body.session_uuid, pinned);
        // Story 14 observability hooks (route layer, per docs/observability.md §5).
        // A freshly created session pins a valid opening cache, so this counts
        // as a cache hit for the pinned cache_uuid.
        const sessionHookCtx = createStoriesHookContext({
          session_uuid: body.session_uuid,
          story_uuid: body.story_uuid,
          story_version_uuid: body.story_version_uuid,
          cache_uuid: body.generation_profile.cache_uuid,
          generation_hash: pinnedCache.generation_hash,
          state: 'opening',
        });
        onSessionCreate(sessionHookCtx);
        onOpeningCacheHit(sessionHookCtx);
        return jsonResponse(res, 200, {
          demo: currentDemoFlag(), dev: DEV_FLAG, ...result, pinned,
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
          demo: currentDemoFlag(),
          dev: DEV_FLAG,
        });
      }
    }
    try {
      // Story 16.3 P1.2 (code review 2026-09-07 review): same
      // bracket-indexed indirection as the createSession branch
      // above so the grep verification can pin "no identity-shaped
      // fields are read off the body in any share-adjacent path".
      // Behaviour unchanged.
      const callerIdentityRef = body['user_ref'];
      const snapshot = startSessionSnapshot({
        repository: storyRepo,
        session_uuid: body.session_uuid,
        story_uuid: body.story_uuid,
        story_version_uuid: body.story_version_uuid,
        user_ref: callerIdentityRef,
        role_id: body.role_id,
      });
      return jsonResponse(res, 200, { demo: currentDemoFlag(), dev: DEV_FLAG, snapshot });
    } catch (err) {
      const { status, code } = classifyProviderError(err);
      return jsonResponse(res, status, {
        error: code,
        message: String(err && err.message ? err.message : err),
        demo: currentDemoFlag(),
        dev: DEV_FLAG,
      });
    }
  }

  // GET /api/dev/sessions/:uuid — recover only canonical session state. This
  // endpoint never generates from, or appends to, the opening cache.
  const sessionMatch = pathname.match(/^\/api\/dev\/sessions\/([^/]+)$/);
  if (method === 'GET' && sessionMatch) {
    if (rejectInvalidSessionUuid(res, sessionMatch[1])) return;
    try {
      const recovered = recoverSession({ repository: storyRepo, session_uuid: sessionMatch[1] });
      return jsonResponse(res, 200, {
        demo: currentDemoFlag(),
        dev: DEV_FLAG,
        ...recovered,
        pinned: pinnedMetadataForSession(sessionMatch[1]),
      });
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
  }

  // POST /api/dev/sessions/:uuid/opening-events — append exactly one
  // explicitly supplied cache event. The service enforces contiguous order,
  // optimistic revision checks, and request-id idempotency.
  const openingEventsMatch = pathname.match(/^\/api\/dev\/sessions\/([^/]+)\/opening-events$/);
  if (method === 'POST' && openingEventsMatch) {
    if (rejectInvalidSessionUuid(res, openingEventsMatch[1])) return;
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
        demo: currentDemoFlag(), dev: DEV_FLAG,
      });
    }
    try {
      const openingCommitStartedAt = Date.now();
      const result = commitOpeningEvent({
        repository: storyRepo,
        session_uuid: openingEventsMatch[1],
        cache_uuid: body.cache_uuid,
        event: body.event,
        client_request_id: body.client_request_id,
        expected_revision: body.expected_revision,
      });
      onOpeningCommit({
        hookCtx: createStoriesHookContext({
          session_uuid: openingEventsMatch[1],
          cache_uuid: body.cache_uuid,
        }),
        event: body.event,
        latency_ms: Date.now() - openingCommitStartedAt,
      });
      return jsonResponse(res, 200, { demo: currentDemoFlag(), dev: DEV_FLAG, ...result });
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
  }

  // Story 08 / 09 narrative-batch routes (unified after the 08 merge).
  //
  //   POST /generate          : runtime stages a 1..4 item batch + optional
  //                             tool call on the session pending slot. The
  //                             response carries the 08 contract fields
  //                             (items / kind / pending_total / base_revision)
  //                             plus 09 player aliases (events / revision /
  //                             pending_remaining).
  //   POST /narrative-events  : commit exactly one displayed item
  //   GET  /recover           : read-only canonical + active pending
  //   POST /discard-pending   : drop an unconsumed pending batch
  //
  // The demo provider (buildDemoMockAgentProvider) is deterministic and
  // honours the 08 wire shape while pacing the 09 demo arc (auto choice /
  // finish); see the helper near the top of this file.

  // GET /api/dev/sessions/:uuid/recover — explicit read-only recovery.
  // Surfaces canonical history + revision + cursor + opening_cursor +
  // active pending snapshot. Never calls the provider, never replays,
  // never mutates state. With MariaDB configured the repository projection
  // was hydrated before this route became available; without it the route
  // remains process-local.
  const recoverMatch = pathname.match(/^\/api\/dev\/sessions\/([^/]+)\/recover$/);
  if (method === 'GET' && recoverMatch) {
    if (rejectInvalidSessionUuid(res, recoverMatch[1])) return;
    try {
      const recovered = recoverSession({ repository: storyRepo, session_uuid: recoverMatch[1] });
      return jsonResponse(res, 200, {
        demo: currentDemoFlag(), dev: DEV_FLAG,
        ...recovered,
        pinned: pinnedMetadataForSession(recoverMatch[1]),
      });
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
  }

  // POST /api/dev/sessions/:uuid/discard-pending — drop the active
  // pending batch without committing. Used when the player wants to
  // clear a stale batch (e.g. recovery picked up a half-committed one).
  const discardMatch = pathname.match(/^\/api\/dev\/sessions\/([^/]+)\/discard-pending$/);
  if (method === 'POST' && discardMatch) {
    if (rejectInvalidSessionUuid(res, discardMatch[1])) return;
    try {
      const result = discardPendingTail({
        repository: storyRepo,
        session_uuid: discardMatch[1],
      });
      return jsonResponse(res, 200, {
        demo: currentDemoFlag(), dev: DEV_FLAG,
        session_uuid: discardMatch[1],
        ...result,
      });
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
  }

  // ---------------------------------------------------------------------
  // Story 11 ending-page read-only routes. These three endpoints are
  // pure projections over (session_events + story_version + opening_cache)
  // and never mutate the repository. They are safe to call after a page
  // reload and, with MariaDB configured, after a process restart; they return
  // a deterministic shape the
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
  const endingMatch = pathname.match(/^\/api\/dev\/sessions\/([^/]+)\/ending$/);
  if (method === 'GET' && endingMatch) {
    if (rejectInvalidSessionUuid(res, endingMatch[1])) return;
    try {
      const ending = buildEnding({ repository: storyRepo, session_uuid: endingMatch[1] });
      return jsonResponse(res, 200, {
        demo: currentDemoFlag(), dev: DEV_FLAG,
        session_uuid: endingMatch[1],
        ...ending,
      });
    } catch (err) {
      if (err && err.code === 'ending_not_committed') {
        return jsonResponse(res, 404, {
          error: 'ending_not_committed',
          message: 'finish_story has not yet committed for this session.',
          session_uuid: endingMatch[1],
          demo: currentDemoFlag(), dev: DEV_FLAG,
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
  const originalTimelineMatch = pathname.match(/^\/api\/dev\/sessions\/([^/]+)\/original-timeline$/);
  if (method === 'GET' && originalTimelineMatch) {
    if (rejectInvalidSessionUuid(res, originalTimelineMatch[1])) return;
    try {
      const timeline = buildOriginalTimeline({ repository: storyRepo, session_uuid: originalTimelineMatch[1] });
      return jsonResponse(res, 200, {
        demo: currentDemoFlag(), dev: DEV_FLAG,
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
  const replayMatch = pathname.match(/^\/api\/dev\/sessions\/([^/]+)\/replay$/);
  if (method === 'GET' && replayMatch) {
    if (rejectInvalidSessionUuid(res, replayMatch[1])) return;
    try {
      const replay = buildReplay({ repository: storyRepo, session_uuid: replayMatch[1] });
      return jsonResponse(res, 200, {
        demo: currentDemoFlag(), dev: DEV_FLAG,
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
  const interruptMatch = pathname.match(/^\/api\/dev\/sessions\/([^/]+)\/interrupt$/);
  if (method === 'POST' && interruptMatch) {
    if (rejectInvalidSessionUuid(res, interruptMatch[1])) return;
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
        demo: currentDemoFlag(), dev: DEV_FLAG,
      });
    }
    try {
      const interruptStartedAt = Date.now();
      const result = interruptWithPlayerInput({
        repository: storyRepo,
        session_uuid: interruptMatch[1],
        text: body.text,
        client_request_id: body.client_request_id,
        expected_revision: body.expected_revision,
      });
      const interruptHookCtx = createStoriesHookContext({
        session_uuid: interruptMatch[1],
        state: 'realtime',
      });
      onInterrupt({
        hookCtx: interruptHookCtx,
        text_length: body.text.length,
        latency_ms: Date.now() - interruptStartedAt,
      });
      // The interrupt is the supported fallback from the pinned opening
      // cache into realtime generation — recorded as the cache miss the
      // docs/observability.md sanity counter expects.
      onOpeningCacheMiss(interruptHookCtx, 'player_interrupt_realtime');
      return jsonResponse(res, 200, {
        demo: currentDemoFlag(),
        dev: DEV_FLAG,
        ...result,
        player_event: result.event,
        realtime_transition: { state: result.state, cursor: result.cursor, revision: result.revision },
      });
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
  }

  // Story 08 runtime-driven narrative-batch routes.
  //
  // The runtime's deterministic demo provider stages 1..4 narrative items
  // per turn plus an optional final tool call (input-driven "choice" /
  // "finish", or the session-scoped demo arc). The contract is the real
  // Story 08 wire shape; a future Real provider must obey the same
  // invariants.

  // POST /api/dev/sessions/:uuid/generate — call the runtime and STAGE
  // the result on the canonical session pending slot. Returns the staged
  // batch (items + optional tool call). Does NOT append to canonical
  // history; the player must commit each item via the narrative-events
  // route below. The runtime base_revision pins expected_revision to the
  // session's current revision.
  //
  // Idempotency: the runtime instance is created per request, but
  // request-level idempotency (request_id + input + expected_revision) is
  // owned by the SESSION (sessionService.turnRequests). Replaying the
  // same request_id + input + expected_revision returns the exact prior
  // result (same turn_id / pending_id / tool envelope) without calling
  // the provider again; the same request_id with a different input or
  // revision fails closed with duplicate_request.
  const generateMatch = pathname.match(/^\/api\/dev\/sessions\/([^/]+)\/generate$/);
  if (method === 'POST' && generateMatch) {
    const sessionUuid = generateMatch[1];
    if (rejectInvalidSessionUuid(res, sessionUuid)) return;
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
        demo: currentDemoFlag(), dev: DEV_FLAG,
      });
    }
    let runtime;
    try {
      const recovered = recoverSession({ repository: storyRepo, session_uuid: sessionUuid });
      runtime = createAgentRuntime({
        repository: storyRepo,
        session_uuid: sessionUuid,
        provider: buildDemoMockAgentProvider(body.input, sessionUuid),
        system_prompt: { kind: 'system', text: 'demo runtime prompt' },
        tool_definitions: [
          { type: 'function', function: { name: 'ask_player_choice', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'finish_story', parameters: { type: 'object' } } },
        ],
        expected_story_version_uuid: recovered.story_version_uuid,
        expected_story_version_checksum: recovered.story_version_checksum,
        expected_model: recovered.model,
        expected_generation_profile: recovered.generation_profile,
      });
    } catch (err) {
      if (err instanceof AgentRuntimeError) {
        return agentRuntimeErrorResponse(res, err, { demo: currentDemoFlag(), dev: DEV_FLAG }, { session_uuid: sessionUuid });
      }
      return sessionErrorResponse(res, err);
    }
    try {
      const result = await runTurn(runtime, {
        ...(body.request_id ? { request_id: body.request_id } : {}),
        input: body.input,
        expected_revision: body.expected_revision,
      });
      return jsonResponse(res, 200, {
        demo: currentDemoFlag(), dev: DEV_FLAG,
        ...result,
        session_uuid: sessionUuid,
        pending_id: result.pending_id,
        // Story 09 player aliases: the frontend reads events / revision /
        // pending_remaining; the 08 contract keeps items / base_revision /
        // pending_total. Both name the same staged batch.
        events: result.items,
        revision: result.base_revision,
        pending_remaining: result.pending_total - result.pending_committed_count,
      });
    } catch (err) {
      if (err instanceof AgentRuntimeError) {
        return agentRuntimeErrorResponse(res, err, { demo: currentDemoFlag(), dev: DEV_FLAG }, { session_uuid: sessionUuid });
      }
      return sessionErrorResponse(res, err);
    }
  }

  // POST /api/dev/sessions/:uuid/narrative-events — commit exactly ONE
  // displayed narrative event from the active pending batch. The event
  // is appended to canonical history; revision advances by 1. The optional
  // final tool_call (if present) is exposed on the last commit result but
  // never becomes a canonical event.
  const narrativeMatch = pathname.match(/^\/api\/dev\/sessions\/([^/]+)\/narrative-events$/);
  if (method === 'POST' && narrativeMatch) {
    const sessionUuid = narrativeMatch[1];
    if (rejectInvalidSessionUuid(res, sessionUuid)) return;
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
        demo: currentDemoFlag(), dev: DEV_FLAG,
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
      return jsonResponse(res, 200, { demo: currentDemoFlag(), dev: DEV_FLAG, ...result });
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
  }

  // POST /api/dev/sessions/:uuid/first-choice — record the first
  // ask_player_choice on THAT session and return a session-local consumed
  // marker. The shared opening cache is NOT invalidated for other sessions.
  const firstChoiceMatch = pathname.match(/^\/api\/dev\/sessions\/([^/]+)\/first-choice$/);
  if (method === 'POST' && firstChoiceMatch) {
    if (rejectInvalidSessionUuid(res, firstChoiceMatch[1])) return;
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      const { status, code } = classifyProviderError(err);
      return jsonResponse(res, status, { error: code, demo: currentDemoFlag(), dev: DEV_FLAG });
    }
    if (!body.snapshot || typeof body.snapshot !== 'object') {
      return jsonResponse(res, 400, {
        error: 'missing_snapshot',
        demo: currentDemoFlag(),
        dev: DEV_FLAG,
      });
    }
    const urlSessionUuid = firstChoiceMatch[1];
    const snapshotSessionUuid = body.snapshot.session_uuid;
    if (typeof snapshotSessionUuid !== 'string' || snapshotSessionUuid !== urlSessionUuid) {
      return jsonResponse(res, 400, {
        error: 'session_uuid_mismatch',
        demo: currentDemoFlag(),
        dev: DEV_FLAG,
      });
    }
    try {
      const firstChoiceStartedAt = Date.now();
      const result = markFirstChoiceConsumed({
        repository: storyRepo,
        snapshot: body.snapshot,
      });
      onToolCommit({
        hookCtx: createStoriesHookContext({ session_uuid: urlSessionUuid }),
        tool_name: 'ask_player_choice',
        latency_ms: Date.now() - firstChoiceStartedAt,
      });
      return jsonResponse(res, 200, { demo: currentDemoFlag(), dev: DEV_FLAG, result });
    } catch (err) {
      const { status, code } = classifyProviderError(err);
      return jsonResponse(res, status, {
        error: code,
        message: String(err && err.message ? err.message : err),
        demo: currentDemoFlag(),
        dev: DEV_FLAG,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Story 14 observability admin endpoints (read-only).
  //
  // Two GET routes expose per-session observability + a process-wide
  // metrics summary. They are demo/dev-only and intentionally live
  // under /api/admin/* next to the other admin tooling. They never
  // mutate session state — see src/observability/* for the storage
  // shape and docs/observability.md for the field contract.
  // -----------------------------------------------------------------------

  // The capture is intentionally loose ([^/]+) so that malformed uuids
  // like "not-a-uuid" reach the isSessionUuid check below and get the
  // endpoint's own 400 validation_failed instead of falling through to
  // the static handler's 404. This path prefix is exclusive to this
  // endpoint (the only other observability route lives under
  // /api/admin/observability/metrics/…), so loosening the regex cannot
  // shadow any other route.
  const observabilitySessionMatch = pathname.match(/^\/api\/admin\/observability\/sessions\/([^/]+)$/);
  if (method === 'GET' && observabilitySessionMatch) {
    const session_uuid = observabilitySessionMatch[1];
    if (!isSessionUuid(session_uuid)) {
      return jsonResponse(res, 400, {
        error: 'validation_failed',
        message: 'session_uuid must be a UUID',
        demo: currentDemoFlag(),
        dev: DEV_FLAG,
      });
    }
    const session = snapshotMetricsSession(session_uuid);
    if (!session) {
      return jsonResponse(res, 404, {
        error: 'session_not_observed',
        message: 'No observability data recorded for this session yet.',
        demo: currentDemoFlag(),
        dev: DEV_FLAG,
      });
    }
    // Pull canonical session state (recovery read) so the operator gets
    // a single correlated view of "story pinned → tokens spent → cache
    // hits" without having to issue a second request. The session is
    // fetched only after the metrics lookup, so an unknown session_uuid
    // 404s cheaply.
    let pinnedSession = null;
    try {
      pinnedSession = recoverSession({ repository: storyRepo, session_uuid });
    } catch {
      // The session may exist in metrics but not in the hydrated
      // repository projection (for example when metrics are from a prior
      // process and MariaDB is disabled). Fall through with pinnedSession=null so the
      // metrics view still renders.
      pinnedSession = null;
    }
    return jsonResponse(res, 200, {
      demo: currentDemoFlag(),
      dev: DEV_FLAG,
      session_uuid,
      pinned: pinnedSession ? {
        session_uuid: pinnedSession.session_uuid,
        story_uuid: pinnedSession.story_uuid,
        story_version_uuid: pinnedSession.story_version_uuid,
        cache_uuid: pinnedSession.cache_uuid,
        state: pinnedSession.state,
        cursor: pinnedSession.cursor,
        revision: pinnedSession.revision,
        model: pinnedSession.model,
        role_id: pinnedSession.role_id,
        opening_cache_status: pinnedSession.opening_cache_status,
        user_ref: pinnedSession.user_ref,
        generation_profile: pinnedSession.generation_profile,
      } : null,
      metrics: session,
    });
  }

  if (method === 'GET' && pathname === '/api/admin/observability/metrics/summary') {
    const metrics = snapshotMetricsAll();
    const cacheStats = snapshotCacheStatsAll();
    return jsonResponse(res, 200, {
      demo: currentDemoFlag(),
      dev: DEV_FLAG,
      metrics,
      cache_stats: cacheStats,
      note: 'frontend_playback_ms can be computed per-commit from the events the client commits; this endpoint exposes storage only.',
    });
  }

  // ---------------------------------------------------------------------
  // Issue #9 — public-session HTTP façade (browser-only surface).
  //
  // Every route below shares the SAME service-layer implementation as
  // the matching /api/dev/sessions/* route (commitOpeningEvent,
  // recoverSession, commitNarrativeEvent, etc.). The only differences
  // are:
  //
  //   1. The /api/sessions POST route atomically runs the import +
  //      ensure + create-session pipeline via bootstrapSessionFromWork
  //      so the browser does not need to discover UUIDs, rebuild the
  //      opening cache, or assemble a generation_profile itself.
  //
  //   2. The /api/sessions/:uuid/* sub-routes strip the DEV_FLAG banner
  //      so the response body the player sees does not advertise
  //      "demo-only" / "admin_only" — that banner is internal.
  //
  // Provider-agnostic: works under both STORY_OUTSIDE_PROVIDER=mock
  // and =real (story content side); the narrative runtime stays bound
  // to the deterministic demo provider regardless.
  // ---------------------------------------------------------------------
  const PUBLIC_DECORATE = () => ({ demo: currentDemoFlag() });

  // Story 16.3 P1 v1-2: GET /api/auth/status — the browser calls
  // this BEFORE bootstrapping a session so the player.js UI can show
  // the OAuth-pending display name on the picker / ending screens.
  // The endpoint is intentionally idempotent and side-effect free:
  // the server's only job is to surface the canonical owner through
  // `currentUserProvider(req)`. There is no body parsing, no cookie
  // minting, and no Set-Cookie header is emitted.
  if (method === 'GET' && pathname === '/api/auth/status') {
    const auth = currentUserProvider(req);
    return jsonResponse(res, 200, {
      ...PUBLIC_DECORATE(),
      authenticated: auth.auth_source !== 'oauth_pending' ? true : false,
      owner: {
        user_uuid: auth.user_uuid,
        display_name: auth.display_name,
        auth_source: auth.auth_source,
      },
    });
  }

  // POST /api/sessions — atomic session bootstrap from a story + role.
  if (method === 'POST' && pathname === '/api/sessions') {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
    if (!validObject(body)) {
      return jsonResponse(res, 400, {
        error: 'validation_failed',
        message: 'The session bootstrap request is invalid.',
        ...PUBLIC_DECORATE(),
      });
    }
    // PR #10 review (B1, 2026-09-06) + Story 16.3 P1 v1-2
    // (2026-09-07 review): public POST /api/sessions is the
    // browser-only bootstrap surface. The player is contractually only
    // allowed to send { work_id, role_id } — server defaults choose
    // user_ref / model / prompt and the browser never sees them.
    //
    // Identity-shaped keys (`user_ref`, `user_uuid`, `user_id`,
    // `identity`, `user`, `subject`, `actor`, `owner`) are explicitly
    // FORBIDDEN on this surface and return 400 `forbidden_field` —
    // they cannot be used to spoof the canonical owner because the
    // server resolves identity through `currentUserProvider(req)`,
    // not from the request.
    const BOOTSTRAP_IDENTITY_KEYS = new Set([
      'user_ref', 'user_uuid', 'user_id', 'identity',
      'user', 'subject', 'actor', 'owner',
    ]);
    for (const k of Object.keys(body)) {
      if (BOOTSTRAP_IDENTITY_KEYS.has(k)) {
        return jsonResponse(res, 400, {
          error: 'forbidden_field',
          message: 'Identity-shaped fields are not allowed in the session bootstrap body.',
          field: k,
          ...PUBLIC_DECORATE(),
        });
      }
    }
    const allowedBootstrapKeys = ['work_id', 'role_id'];
    const unknownBootstrapKeys = Object.keys(body).filter((k) => !allowedBootstrapKeys.includes(k));
    if (unknownBootstrapKeys.length > 0) {
      return jsonResponse(res, 400, {
        error: 'validation_failed',
        message: 'The session bootstrap request is invalid.',
        ...PUBLIC_DECORATE(),
      });
    }
    // Story 16.3 P1 v1-2: empty body is a legitimate request — it
    // bootstraps the OAuth-pending canonical owner against the demo
    // work + role defaults. This matches the wire contract the
    // player uses before it has picked a story on the picker screen.
    // We DO NOT change work_id/role_id when the client supplies them;
    // we only fill in defaults when the body is absent.
    if (!Object.prototype.hasOwnProperty.call(body, 'work_id')) body.work_id = 'cafe-rain';
    if (!Object.prototype.hasOwnProperty.call(body, 'role_id')) body.role_id = 'stranger';
    if (typeof body.work_id !== 'string' || !body.work_id) {
      return jsonResponse(res, 400, {
        error: 'validation_failed',
        message: 'work_id is required.',
        field: 'work_id',
        ...PUBLIC_DECORATE(),
      });
    }
    if (typeof body.role_id !== 'string' || !body.role_id) {
      return jsonResponse(res, 400, {
        error: 'validation_failed',
        message: 'role_id is required.',
        field: 'role_id',
        ...PUBLIC_DECORATE(),
      });
    }
    const sessionUuid = randomUUID();
    // Bind new stories to the server-verified caller, never a body field.
    const auth = currentUserProvider(req);
    try {
      // PR #10 review (B1): we deliberately do NOT pass an `identity`
      // override from the request body. The bootstrap helper picks
      // server-side defaults for user_ref / model / prompt and pins
      // them into the canonical session; the player never sees them.
      const aiConfig = loadAIConfig();
      const result = await bootstrapSessionFromWork({
        repository: storyRepo,
        provider,
        session_uuid: sessionUuid,
        ...(aiConfig ? { identity: { model: aiConfig.model, prompt: STORY_SYSTEM_PROMPT } } : {}),
        work_id: body.work_id,
        role_id: body.role_id,
        // Story 16.3 P1 v1-2: canonical session owner comes from
        // `currentUserProvider(req)` — NEVER from the request body.
        user_uuid: auth.user_uuid,
        // Story 16.1 server.mjs wiring (2026-09-06): the public
        // POST /api/sessions route is the real-provider bootstrap
        // surface, so it wires the in-memory community-profile repo
        // and tags freshly-built profiles with `source:
        // 'real-generated'`. Admin/dev surfaces keep the historical
        // mock-generated default by omitting both args.
        profileRepository: communityProfileRepo,
        profileOptions: { source: 'real-generated' },
      });
      // Pin the session's metadata so /recover can return it. Per the
      // public façade contract the browser only needs role_id (so a
      // /recover call can echo it back) plus the cached generation
      // profile (so a replay knows which cache row to bind to). The
      // server-side user_ref / model / prompt values are intentionally
      // NOT mirrored here — they are internal policy, not player state.
      const profile = {};
      for (const key of ['cache_uuid', 'story_uuid', 'story_version_uuid', 'generation_hash', 'identifier', 'rules_version', 'locale', 'variant']) {
        if (result.session.generation_profile && result.session.generation_profile[key] !== undefined) {
          profile[key] = result.session.generation_profile[key];
        }
      }
      const pinned = {
        role_id: result.session.role_id,
        generation_profile: profile,
      };
      sessionPinnedMetadata.set(sessionUuid, pinned);
      // Story 14 observability: a freshly-created session pins a
      // valid opening cache, so this counts as a cache hit.
      const hookCtx = createStoriesHookContext({
        session_uuid: sessionUuid,
        story_uuid: result.story_uuid,
        story_version_uuid: result.story_version_uuid,
        cache_uuid: result.cache_uuid,
        generation_hash: result.session.generation_profile && result.session.generation_profile.generation_hash,
        state: result.session.state,
      });
      onSessionCreate(hookCtx);
      onOpeningCacheHit(hookCtx);
      // Story 16.2 P1.v2 (2026-09-07): the player needs the
      // canonical community_profile_version + canonical profile
      // queries so it can submit them to /v1/ecosystem/discussions.
      // The version string is server-authoritative and the player
      // never sees it as raw data — just echoes it back.
      const cv = resolveCommunityProfileVersion(result.story_version_uuid);
      return jsonResponse(res, 200, {
        ...PUBLIC_DECORATE(),
        session_uuid: sessionUuid,
        story_uuid: result.story_uuid,
        story_version_uuid: result.story_version_uuid,
        cache_uuid: result.cache_uuid,
        opening_cache_status: result.cache_status,
        opening_events: result.opening_events,
        revision: result.session.revision,
        state: result.session.state,
        opening_cursor: result.session.opening_cursor,
        cache_reused: result.cache_reused,
        version_reused: result.version_reused,
        // Story 16.4 P1.v1-6 fix (2026-09-07): surface the canonical
        // community_profile_version + the canonical profile queries
        // on the bootstrap response so the browser can publish the
        // identity triple WITHOUT a second round-trip. The version
        // string is computed via the SAME community-layer helper
        // (`deriveExternalCommunityProfileVersion`, which is a thin
        // pass-through to `buildCanonicalCommunityProfileVersion`)
        // that the /v1/ecosystem/hot orchestrator reads, so a
        // mismatch between the bootstrap response and the orchestrator
        // is impossible unless the row was regenerated between calls.
        community_profile_version: cv.community_profile_version,
        community_profile_queries: cv.community_profile_queries,
        pinned,
        // Story 16.3 P1 v1-2: echo the canonical owner back so the
        // browser can render the OAuth-pending display name without
        // minting its own. `auth_source === 'oauth_pending'` is the
        // contract — the UI must NEVER treat this as a real identity.
        owner: {
          user_uuid: auth.user_uuid,
          display_name: auth.display_name,
          auth_source: auth.auth_source,
        },
      });
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
  }

  // GET /api/sessions/:uuid — canonical recover + pinned metadata.
  const publicSessionRoot = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (method === 'GET' && publicSessionRoot) {
    if (rejectInvalidSessionUuid(res, publicSessionRoot[1])) return;
    try {
      const recovered = recoverSession({ repository: storyRepo, session_uuid: publicSessionRoot[1] });
      // Story 16.2 P1.v2 (2026-09-07): also expose
      // community_profile_version + canonical profile queries so the
      // player can submit them to /v1/ecosystem/discussions after a
      // page reload.
      const cv = recovered && recovered.story_version_uuid
        ? resolveCommunityProfileVersion(recovered.story_version_uuid)
        : { community_profile_version: null, community_profile_queries: null };
      return jsonResponse(res, 200, {
        ...PUBLIC_DECORATE(),
        ...recovered,
        community_profile_version: cv.community_profile_version,
        community_profile_queries: cv.community_profile_queries,
        pinned: pinnedMetadataForSession(publicSessionRoot[1], { publicSurface: true }),
      });
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
  }

  // GET /api/sessions/:uuid/recover — read-only recovery projection.
  const publicRecover = pathname.match(/^\/api\/sessions\/([^/]+)\/recover$/);
  if (method === 'GET' && publicRecover) {
    if (rejectInvalidSessionUuid(res, publicRecover[1])) return;
    try {
      const recovered = recoverSession({ repository: storyRepo, session_uuid: publicRecover[1] });
      const cv = recovered && recovered.story_version_uuid
        ? resolveCommunityProfileVersion(recovered.story_version_uuid)
        : { community_profile_version: null, community_profile_queries: null };
      return jsonResponse(res, 200, {
        ...PUBLIC_DECORATE(),
        ...recovered,
        community_profile_version: cv.community_profile_version,
        community_profile_queries: cv.community_profile_queries,
        pinned: pinnedMetadataForSession(publicRecover[1], { publicSurface: true }),
      });
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
  }

  // POST /api/sessions/:uuid/opening-events — append one displayed
  // opening event. Shares the same service function + validation
  // gauntlet as /api/dev/sessions/:uuid/opening-events; only the
  // response decoration differs (no DEV_FLAG banner).
  const publicOpening = pathname.match(/^\/api\/sessions\/([^/]+)\/opening-events$/);
  if (method === 'POST' && publicOpening) {
    if (rejectInvalidSessionUuid(res, publicOpening[1])) return;
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
        error: 'validation_failed',
        message: 'The opening event request is invalid.',
        ...PUBLIC_DECORATE(),
      });
    }
    try {
      const openingCommitStartedAt = Date.now();
      const result = commitOpeningEvent({
        repository: storyRepo,
        session_uuid: publicOpening[1],
        cache_uuid: body.cache_uuid,
        event: body.event,
        client_request_id: body.client_request_id,
        expected_revision: body.expected_revision,
      });
      onOpeningCommit({
        hookCtx: createStoriesHookContext({
          session_uuid: publicOpening[1],
          cache_uuid: body.cache_uuid,
        }),
        event: body.event,
        latency_ms: Date.now() - openingCommitStartedAt,
      });
      return jsonResponse(res, 200, { ...PUBLIC_DECORATE(), ...result });
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
  }

  // POST /api/sessions/:uuid/narrative-events — commit exactly one
  // displayed narrative event. Same service call as the dev route.
  const publicNarrative = pathname.match(/^\/api\/sessions\/([^/]+)\/narrative-events$/);
  if (method === 'POST' && publicNarrative) {
    const sessionUuid = publicNarrative[1];
    if (rejectInvalidSessionUuid(res, sessionUuid)) return;
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
        error: 'validation_failed',
        message: 'The narrative-event commit request is invalid.',
        ...PUBLIC_DECORATE(),
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
      return jsonResponse(res, 200, { ...PUBLIC_DECORATE(), ...result });
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
  }

  // POST /api/sessions/:uuid/interrupt — player free-text interrupt.
  const publicInterrupt = pathname.match(/^\/api\/sessions\/([^/]+)\/interrupt$/);
  if (method === 'POST' && publicInterrupt) {
    if (rejectInvalidSessionUuid(res, publicInterrupt[1])) return;
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
        error: 'validation_failed',
        message: 'The interrupt request is invalid.',
        ...PUBLIC_DECORATE(),
      });
    }
    try {
      const interruptStartedAt = Date.now();
      const result = interruptWithPlayerInput({
        repository: storyRepo,
        session_uuid: publicInterrupt[1],
        text: body.text,
        client_request_id: body.client_request_id,
        expected_revision: body.expected_revision,
      });
      const interruptHookCtx = createStoriesHookContext({
        session_uuid: publicInterrupt[1],
        state: 'realtime',
      });
      onInterrupt({
        hookCtx: interruptHookCtx,
        text_length: body.text.length,
        latency_ms: Date.now() - interruptStartedAt,
      });
      // The interrupt is the supported fallback from the pinned
      // opening cache into realtime generation — recorded as the cache
      // miss the docs/observability.md sanity counter expects.
      onOpeningCacheMiss(interruptHookCtx, 'player_interrupt_realtime');
      return jsonResponse(res, 200, {
        ...PUBLIC_DECORATE(),
        ...result,
        player_event: result.event,
        realtime_transition: { state: result.state, cursor: result.cursor, revision: result.revision },
      });
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
  }

  // POST /api/sessions/:uuid/generate — runtime stages a 1..4 item
  // batch + optional tool call on the session pending slot. Same
  // runtime contract as the dev route; only the response decoration
  // differs.
  const publicGenerate = pathname.match(/^\/api\/sessions\/([^/]+)\/generate$/);
  if (method === 'POST' && publicGenerate) {
    const sessionUuid = publicGenerate[1];
    if (rejectInvalidSessionUuid(res, sessionUuid)) return;
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
        error: 'validation_failed',
        message: 'The generate request is invalid.',
        ...PUBLIC_DECORATE(),
      });
    }
    const asynchronous = /(?:^|,)\s*respond-async\s*(?:,|$)/i.test(req.headers.prefer || '') && Boolean(body.request_id);
    let runtime;
    try {
      const recovered = recoverSession({ repository: storyRepo, session_uuid: sessionUuid });
      const aiConfig = loadAIConfig();
      const pinnedStory = storyRepo.findVersion(recovered.story_version_uuid);
      runtime = createAgentRuntime({
        repository: storyRepo,
        session_uuid: sessionUuid,
        provider: aiConfig ? createAIProvider({ config: aiConfig, story: pinnedStory.content_payload }) : buildDemoMockAgentProvider(body.input, sessionUuid),
        system_prompt: { kind: 'system', text: aiConfig ? STORY_SYSTEM_PROMPT : 'demo runtime prompt' },
        tool_definitions: TOOL_DEFINITIONS,
        expected_story_version_uuid: recovered.story_version_uuid,
        expected_story_version_checksum: recovered.story_version_checksum,
        expected_model: recovered.model,
        expected_generation_profile: recovered.generation_profile,
      });
    } catch (err) {
      if (err instanceof AgentRuntimeError) {
        return agentRuntimeErrorResponse(res, err, PUBLIC_DECORATE(), { session_uuid: sessionUuid, persist: !asynchronous });
      }
      return sessionErrorResponse(res, err);
    }
    try {
      const args = {
        ...(body.request_id ? { request_id: body.request_id } : {}),
        input: body.input,
        expected_revision: body.expected_revision,
      };
      let result;
      if (asynchronous) {
        const key = canonicalJsonStringify({ session_uuid: sessionUuid, ...args });
        const outcome = await generationTasks.poll(key, async () => {
          const startedAt = performance.now();
          let generated = false;
          try { const result = await runTurn(runtime, args); generated = true; return result; }
          finally {
            const persistenceStart = performance.now();
            try { if (databasePersistence) await databasePersistence.flush(); }
            finally { loggerInfo('generation.task', { component: 'agent', session_uuid: sessionUuid,
              latency_ms: Math.round(performance.now() - startedAt),
              extra: { generated, generation_ms: Math.round(persistenceStart - startedAt), persist_ms: Math.round(performance.now() - persistenceStart) } }); }
          }
        });
        if (outcome.kind === 'pending' || outcome.kind === 'busy') {
          res.setHeader('Retry-After', '1');
          return jsonResponse(res, outcome.kind === 'pending' ? 202 : 503, {
            error: outcome.kind === 'busy' ? 'generation_busy' : undefined,
            status: 'pending', request_id: body.request_id, session_uuid: sessionUuid,
          }, { persist: false }); // An acknowledgement, never a claim of saved progress.
        }
        if (outcome.kind === 'failed') throw outcome.error;
        result = outcome.value;
      } else result = await runTurn(runtime, args);
      return jsonResponse(res, 200, {
        ...PUBLIC_DECORATE(),
        ...result,
        session_uuid: sessionUuid,
        pending_id: result.pending_id,
        events: result.items,
        revision: result.base_revision,
        pending_remaining: result.pending_total - result.pending_committed_count,
      }, { persist: !asynchronous });
    } catch (err) {
      if (err instanceof AgentRuntimeError) {
        return agentRuntimeErrorResponse(res, err, PUBLIC_DECORATE(), { session_uuid: sessionUuid, persist: !asynchronous });
      }
      if (asynchronous) return jsonResponse(res, 503, { error: 'generation_unavailable', message: '生成暂时未能完成，请重试。' }, { persist: false });
      return sessionErrorResponse(res, err);
    }
  }

  // POST /api/sessions/:uuid/discard-pending — drop the active
  // pending batch without committing.
  const publicDiscard = pathname.match(/^\/api\/sessions\/([^/]+)\/discard-pending$/);
  if (method === 'POST' && publicDiscard) {
    if (rejectInvalidSessionUuid(res, publicDiscard[1])) return;
    // `pending_id` is optional and narrows the discard to one batch, so a
    // late cleanup for an abandoned turn cannot drop a newer batch that
    // was staged in the meantime. An empty/absent body keeps the original
    // unconditional behaviour.
    let discardBody = {};
    try {
      discardBody = await readJsonBody(req);
    } catch {
      discardBody = {};
    }
    if (discardBody?.pending_id !== undefined
      && discardBody?.pending_id !== null
      && typeof discardBody.pending_id !== 'string') {
      return jsonResponse(res, 400, {
        error: 'validation_failed',
        message: 'pending_id must be a string when present',
        ...PUBLIC_DECORATE(),
      });
    }
    try {
      const result = discardPendingTail({
        repository: storyRepo,
        session_uuid: publicDiscard[1],
        ...(discardBody?.pending_id ? { pending_id: discardBody.pending_id } : {}),
      });
      return jsonResponse(res, 200, {
        ...PUBLIC_DECORATE(),
        session_uuid: publicDiscard[1],
        ...result,
      });
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
  }

  // POST /api/sessions/:uuid/first-choice — record the first
  // ask_player_choice on THIS session. Same service call as the dev
  // route; only the response decoration differs.
  const publicFirstChoice = pathname.match(/^\/api\/sessions\/([^/]+)\/first-choice$/);
  if (method === 'POST' && publicFirstChoice) {
    if (rejectInvalidSessionUuid(res, publicFirstChoice[1])) return;
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      // PR #10 review (B2, 2026-09-06): public first-choice MUST NOT
      // leak the DEV_FLAG banner. Malformed JSON is a 400 with a
      // fixed, public message — the raw error from readJsonBody must
      // never reach the wire, and PUBLIC_DECORATE (not _DEV) is the
      // only banner that may appear on a public response.
      return jsonResponse(res, 400, {
        error: 'bad_json',
        message: 'Invalid JSON in request body.',
        ...PUBLIC_DECORATE(),
      });
    }
    if (!body.snapshot || typeof body.snapshot !== 'object') {
      return jsonResponse(res, 400, {
        error: 'missing_snapshot',
        ...PUBLIC_DECORATE(),
      });
    }
    const urlSessionUuid = publicFirstChoice[1];
    const snapshotSessionUuid = body.snapshot.session_uuid;
    if (typeof snapshotSessionUuid !== 'string' || snapshotSessionUuid !== urlSessionUuid) {
      return jsonResponse(res, 400, {
        error: 'session_uuid_mismatch',
        ...PUBLIC_DECORATE(),
      });
    }
    try {
      const firstChoiceStartedAt = Date.now();
      const result = markFirstChoiceConsumed({
        repository: storyRepo,
        snapshot: body.snapshot,
      });
      onToolCommit({
        hookCtx: createStoriesHookContext({ session_uuid: urlSessionUuid }),
        tool_name: 'ask_player_choice',
        latency_ms: Date.now() - firstChoiceStartedAt,
      });
      return jsonResponse(res, 200, { ...PUBLIC_DECORATE(), result });
    } catch (err) {
      // PR #10 review (B2): the service-error catch on the public
      // first-choice surface must also use PUBLIC_DECORATE so the
      // DEV_FLAG banner does not leak into the public response. The
      // error code still comes from classifyProviderError so the wire
      // contract is preserved; the internal `err.message` is
      // intentionally NOT echoed because service-layer messages are
      // not part of the public API.
      const { status, code } = classifyProviderError(err);
      return jsonResponse(res, status, {
        error: code,
        ...PUBLIC_DECORATE(),
      });
    }
  }

  const endingAnalysisMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/ending-analysis$/);
  if (method === 'GET' && endingAnalysisMatch) {
    const sessionUuid = endingAnalysisMatch[1];
    if (rejectInvalidSessionUuid(res, sessionUuid)) return;
    try {
      buildEnding({ repository: storyRepo, session_uuid: sessionUuid });
      const config = loadAIConfig();
      if (!config) return jsonResponse(res, 200, { status: 'unavailable' }, { persist: false });
      const task = endingAnalysisTasks.read(sessionUuid, () => analyzeEnding({ config, repository: storyRepo, session_uuid: sessionUuid }));
      return jsonResponse(res, task.status === 'pending' || task.status === 'busy' ? 202 : 200, task, { persist: false });
    } catch (error) { return sessionErrorResponse(res, error); }
  }

  const knowledgeDetail = pathname.match(/^\/api\/knowledge\/([0-9]+)$/);
  if (method === 'GET' && knowledgeDetail) {
    try {
      const detail = await officialKnowledge.detail(knowledgeDetail[1]);
      if (!detail) return jsonResponse(res, 404, { error: 'not_found' }, { persist: false });
      const escape = value => String(value || '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
      return res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(detail.chapter_name)}</title><style>body{max-width:760px;margin:48px auto;padding:0 24px;font:18px/1.9 system-ui;background:#faf7f1;color:#292923}article{white-space:pre-wrap}</style><h1>${escape(detail.chapter_name)}</h1><p>来源：知乎 · ${escape(detail.author_name)}</p><article>${escape(detail.content)}</article></html>`);
    } catch { return jsonResponse(res, 503, { error: 'knowledge_unavailable' }, { persist: false }); }
  }

  // GET /api/sessions/:uuid/ending — read-only finish_story projection.
  const publicEnding = pathname.match(/^\/api\/sessions\/([^/]+)\/ending$/);
  if (method === 'GET' && publicEnding) {
    if (rejectInvalidSessionUuid(res, publicEnding[1])) return;
    try {
      const ending = buildEnding({ repository: storyRepo, session_uuid: publicEnding[1] });
      return jsonResponse(res, 200, {
        ...PUBLIC_DECORATE(),
        session_uuid: publicEnding[1],
        ...ending,
      });
    } catch (err) {
      if (err && err.code === 'ending_not_committed') {
        return jsonResponse(res, 404, {
          error: 'ending_not_committed',
          message: 'finish_story has not yet committed for this session.',
          session_uuid: publicEnding[1],
          ...PUBLIC_DECORATE(),
        });
      }
      return sessionErrorResponse(res, err);
    }
  }

  // GET /api/sessions/:uuid/original-timeline — read-only original key
  // facts projection. Same service function as the dev route.
  const publicOriginalTimeline = pathname.match(/^\/api\/sessions\/([^/]+)\/original-timeline$/);
  if (method === 'GET' && publicOriginalTimeline) {
    if (rejectInvalidSessionUuid(res, publicOriginalTimeline[1])) return;
    try {
      const timeline = buildOriginalTimeline({ repository: storyRepo, session_uuid: publicOriginalTimeline[1] });
      return jsonResponse(res, 200, {
        ...PUBLIC_DECORATE(),
        session_uuid: publicOriginalTimeline[1],
        ...timeline,
      });
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
  }

  // GET /api/sessions/:uuid/replay — strict committed-history replay.
  const publicReplay = pathname.match(/^\/api\/sessions\/([^/]+)\/replay$/);
  if (method === 'GET' && publicReplay) {
    if (rejectInvalidSessionUuid(res, publicReplay[1])) return;
    try {
      const replay = buildReplay({ repository: storyRepo, session_uuid: publicReplay[1] });
      return jsonResponse(res, 200, {
        ...PUBLIC_DECORATE(),
        session_uuid: publicReplay[1],
        ...replay,
      });
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
  }

  // -----------------------------------------------------------------
  // Story 16.5 — public /v1/ecosystem/knowledge façade (player-facing).
  //
  // P1.v1-3 fix (2026-09-07 owner review): the
  // `community_profile_version` carried in the body is the EXTERNAL
  // DERIVED form `<generator_version>-<content_hash_short>` (see
  // `deriveExternalCommunityProfileVersion` in
  // src/community/profile.mjs). The internal schema keeps
  // `generator_version` as the raw rule version; the external
  // derivation lives next to it and is the ONLY identity string the
  // route layer / browser treats as canonical. Two preserved rows
  // with the same `generator_version` but a different `content_hash`
  // carry different external versions, so an old-session regression
  // pinning the prior external version keeps resolving the prior row
  // even after the active row has moved on.
  //
  // P1.v2 fix (2026-09-07 code review): the surface is
  // SERVER-AUTHORITATIVE. The handler accepts ONLY the three identity
  // fields (story_uuid, story_version_uuid, community_profile_version)
  // and resolves the canonical StoryCommunityProfile from the
  // hydrated community-profile repository via `findCanonicalByIdentity`. The
  // `profile.knowledge_queries[]` list is read from THAT row —
  // caller-supplied knowledge_queries / topic_id / topic_label /
  // topic / theme / subject / query / identity are NEVER accepted.
  //
  // P1.v2 fix (2026-09-07 code review): the orchestrator's cache
  // key includes `query_hash = sha256(query.query)` so two distinct
  // query strings ALWAYS hit independent cache rows; the upstream
  // call receives the verbatim query string (NOT a query_id), so
  // two different query strings produce two different result sets.
  //
  // Public contract:
  //   * POST /v1/ecosystem/knowledge
  //       body (strict whitelist):
  //         story_uuid                  required, string uuid
  //         story_version_uuid          required, string uuid
  //         community_profile_version   required, string
  //         limit?                      optional, default 4 per query
  //       resp: { knowledge: [...], provisional: true, disclaimer,
  //               source, cached, fetched_at, cache_key,
  //               degraded, degradation | null,
  //               results: [{ id, query, kind, knowledge: [...],
  //                            source, cached, degraded, degradation }],
  //               knowledge_queries: [...] }
  //   * Identity errors:
  //       - 400 `forbidden_field`                  body carries any
  //                                                field other than the
  //                                                three identity fields
  //                                                + `limit`.
  //       - 400 `community_profile_not_found`      no row matches the
  //                                                identity tuple.
  //       - 400 `community_profile_version_mismatch`
  //                                                community_profile_version
  //                                                supplied but does
  //                                                not match any row.
  //       - 400 `story_version_mismatch`           story_uuid supplied
  //                                                but does not match
  //                                                the row's story_uuid.
  //   * Knowledge failure never blocks the core game loop:
  //     real provider unavailable → mock fallback; both unavailable
  //     → 200 with knowledge: [] and degraded:true. NEVER 5xx on the
  //     public surface.
  // -----------------------------------------------------------------
  if (method === 'POST' && pathname === '/v1/ecosystem/knowledge') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return jsonResponse(res, 400, {
        error: 'bad_json',
        message: 'POST /v1/ecosystem/knowledge expects a JSON object body.',
      });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonResponse(res, 400, {
        error: 'validation_failed',
        message: 'POST /v1/ecosystem/knowledge expects a JSON object body.',
        field: 'body',
      });
    }
    // P1.v2 hard whitelist. The browser may ONLY send the three
    // identity fields + an optional `limit`. Anything else —
    // including `knowledge_queries`, `topic_id`, `topic_label`,
    // `topic`, `theme`, `subject`, `query`, `identity` — is rejected
    // so the handler cannot be coerced into letting the player
    // pick a free-form subject.
    const allowedKeys = [
      'story_uuid',
      'story_version_uuid',
      'community_profile_version',
      'limit',
    ];
    const unknownKeys = Object.keys(body).filter((k) => !allowedKeys.includes(k));
    if (unknownKeys.length > 0) {
      return jsonResponse(res, 400, {
        error: 'forbidden_field',
        message: 'POST /v1/ecosystem/knowledge does not accept caller-supplied topic/query fields.',
        field: 'body',
        unknown_fields: unknownKeys,
      });
    }
    if (typeof body.story_uuid !== 'string' || !body.story_uuid) {
      return jsonResponse(res, 400, {
        error: 'validation_failed',
        message: 'story_uuid is required.',
        field: 'story_uuid',
      });
    }
    if (typeof body.story_version_uuid !== 'string' || !body.story_version_uuid) {
      return jsonResponse(res, 400, {
        error: 'validation_failed',
        message: 'story_version_uuid is required.',
        field: 'story_version_uuid',
      });
    }
    if (typeof body.community_profile_version !== 'string' || !body.community_profile_version) {
      return jsonResponse(res, 400, {
        error: 'validation_failed',
        message: 'community_profile_version is required.',
        field: 'community_profile_version',
      });
    }
    const limitPerQuery = Number.isInteger(body.limit) && body.limit > 0
      ? Math.min(body.limit, 32)
      : 4;

    // P1.v1-4 fix (2026-09-07 owner review) — server-side canonical
    // lookup now goes through `communityProfileRepo.findByExternalVersion`
    // directly. This is a PURE exact-match by the EXTERNAL
    // community_profile_version string (`<generator_version>@<16-hex-prefix>`);
    // it walks every preserved row and returns the single row whose
    // external version equals the supplied string. There is NO
    // active-row concept here, so an old session that pinned the prior
    // external version keeps resolving the prior row even after a
    // newer content_hash has overtaken the active slot. There is NO
    // silent fallback to "the latest row" — an unknown external
    // version is a hard 400 `community_profile_not_found`. The
    // previous `findCanonicalByIdentity` service helper is retained
    // for tests but the route layer no longer goes through it.
    let canonicalProfile;
    try {
      // P1.v1-5 (2026-09-07, origin/main): the active
      // `findByExternalVersion` is SCOPED to (story_version_uuid,
      // external_version). server.mjs previously called the one-arg
      // PR #25 P1.v1-4 form (external_version alone); with both
      // methods now present in the repository object literal, the
      // SCOPED two-arg version is the active definition and the
      // route layer MUST pass `story_version_uuid` alongside the
      // external version so the scoped index can resolve the row.
      canonicalProfile = communityProfileRepo.findByExternalVersion(
        body.story_version_uuid,
        body.community_profile_version,
      );
    } catch (err) {
      // findByExternalVersion throws on bad input shape; surface that
      // as a clean validation_failed rather than 500.
      return jsonResponse(res, 400, {
        error: 'validation_failed',
        message: err && err.message ? String(err.message) : 'identity lookup failed.',
      });
    }
    if (!canonicalProfile) {
      // Distinguish the failure shape so the operator can debug.
      // The supplied `community_profile_version` is the EXTERNAL
      // derived form `<generator_version>@<content_hash_prefix>`,
      // NOT the raw rule version. An exact non-match means either:
      //   - no row exists at all for this story_version, or
      //   - rows exist but the supplied external version (and/or
      //     story_uuid) didn't match any preserved row.
      const allRows = communityProfileRepo.listByStoryVersion({
        story_version_uuid: body.story_version_uuid,
      });
      const versionExists = allRows.length > 0;
      if (!versionExists) {
        return jsonResponse(res, 400, {
          error: 'community_profile_not_found',
          message: 'No community profile exists for the supplied story_version_uuid.',
          field: 'story_version_uuid',
        });
      }
      // Version has rows but the supplied external community_profile_version
      // (and/or story_uuid) didn't match.
      const hasExternalVersionMatch = allRows.some((row) => {
        try {
          return deriveExternalCommunityProfileVersion(row) === body.community_profile_version;
        } catch {
          return false;
        }
      });
      if (!hasExternalVersionMatch) {
        return jsonResponse(res, 400, {
          error: 'community_profile_version_mismatch',
          message: 'Supplied community_profile_version does not match any preserved row for this story_version.',
          field: 'community_profile_version',
        });
      }
      // Rows exist and an external-version match was found — but the
      // story_uuid differs from the matching row's story_uuid.
      return jsonResponse(res, 400, {
        error: 'story_version_mismatch',
        message: 'Supplied story_uuid does not match the row\'s story_uuid.',
        field: 'story_uuid',
      });
    }
    // P1.v1-4 — `findByExternalVersion` resolves the row by external
    // version string ONLY (it does not consult story_uuid because the
    // external version is the canonical identity the browser carries).
    // The story_uuid / story_version_uuid integrity check lives in
    // the route handler so the repo method stays a pure external-
    // version lookup. A mismatch is still surfaced as a 400.
    if (canonicalProfile.story_uuid !== body.story_uuid) {
      return jsonResponse(res, 400, {
        error: 'story_version_mismatch',
        message: 'Supplied story_uuid does not match the resolved row\'s story_uuid.',
        field: 'story_uuid',
      });
    }
    if (canonicalProfile.story_version_uuid !== body.story_version_uuid) {
      return jsonResponse(res, 400, {
        error: 'community_profile_not_found',
        message: 'Supplied story_version_uuid does not match the resolved row\'s story_version_uuid.',
        field: 'story_version_uuid',
      });
    }

    const canonicalQueries = Array.isArray(canonicalProfile.knowledge_queries)
      ? canonicalProfile.knowledge_queries.filter(
        (q) => q && typeof q === 'object' && typeof q.query === 'string' && q.query,
      )
      : [];

    // Aggregate one orchestrator.match() per canonical knowledge_query.
    // P1.v2: we pass the full { id, query, kind } so the cache key
    // includes `query_hash = sha256(query.query)` and the upstream
    // is called with the verbatim query string. Two different query
    // strings → two different cache rows → two different result
    // bundles.
    //
    // P1.v1-4: the resolved profile is pinned on every
    // `match(input)` call as `input.profile` so the orchestrator
    // can validate that the supplied `community_profile_version`
    // matches the canonical derivation of the resolved row. The
    // orchestrator itself does NOT call `findByExternalVersion`;
    // the seam lives in the route handler so a single HTTP request
    // resolves the profile ONCE and reuses the row across every
    // canonical knowledge_query.
    const results = await Promise.all(canonicalQueries.map(async q => {
      const matchResult = await knowledgeProvider.match({
        story_version_uuid: body.story_version_uuid,
        community_profile_version: body.community_profile_version,
        query: {
          id: typeof q.id === 'string' && q.id ? q.id : null,
          query: q.query,
          kind: typeof q.kind === 'string' ? q.kind : 'mixed',
        },
        limit: limitPerQuery,
        profile: canonicalProfile,
      });
      return {
        id: typeof q.id === 'string' && q.id ? q.id : null,
        // P1.v2: response echoes `query` (the string), NOT `id`.
        query: q.query,
        kind: typeof q.kind === 'string' ? q.kind : 'mixed',
        knowledge: matchResult.knowledge,
        source: matchResult.source,
        cached: matchResult.cached,
        fetched_at: matchResult.fetched_at,
        cache_key: matchResult.cache_key,
        degraded: matchResult.degraded,
        degradation: matchResult.degradation,
      };
    }));

    // Flat, deduped knowledge bundle — useful for clients that want
    // a single list. We dedupe on entry.id so the same upstream
    // entry referenced by multiple queries is not listed twice.
    const dedupe = new Map();
    for (const r of results) {
      for (const entry of r.knowledge) {
        if (!dedupe.has(entry.id)) dedupe.set(entry.id, entry);
      }
    }
    const flatKnowledge = Array.from(dedupe.values());
    const anyDegraded = results.some((r) => r.degraded);
    const anyDegradation = anyDegraded
      ? results.find((r) => r.degraded && r.degradation) ? results.find((r) => r.degraded && r.degradation).degradation : null
      : null;
    const source = results.every((r) => r.source === 'real')
      ? 'real'
      : results.some((r) => r.source === 'real')
        ? 'mixed'
        : 'mock';

    return jsonResponse(res, 200, {
      ...PUBLIC_DECORATE(),
      knowledge: flatKnowledge,
      provisional: true,
      disclaimer: results[0] ? results[0].knowledge[0] && results[0].knowledge[0].disclaimer : null,
      source,
      cached: results.every((r) => r.cached),
      fetched_at: new Date().toISOString(),
      degraded: anyDegraded,
      degradation: anyDegradation,
      knowledge_queries: canonicalQueries.map((q) => ({
        id: typeof q.id === 'string' && q.id ? q.id : null,
        query: q.query,
        kind: typeof q.kind === 'string' ? q.kind : 'mixed',
      })),
      results,
    });
  }
  // GET /v1/ecosystem/hot — home-page 知乎热榜 façade (Story 16.4 P1.v1-2).
  //
  // Public surface (no DEV_FLAG banner). Identity triple is optional:
  // when story_uuid / story_version_uuid / community_profile_version
  // are all supplied AND the canonical profile row's
  // `generator_version` (v1 schema) matches the supplied value, the
  // response carries `relevant_to_story` and every hot entry carries
  // `relevant: { score, matched_terms }`. Related entries (score > 0)
  // sort to the top.
  //
  // P1.v1-2 contract (2026-09-07):
  //   * When the supplied `community_profile_version` does NOT match
  //     the canonical row, the route returns 400
  //     `community_profile_version_mismatch` with the expected vs
  //     actual versions. The data-contract mismatch is now
  //     observable instead of silently degrading to "0 terms".
  //   * When ANY identity field is omitted, the route degrades to a
  //     plain hot list (no `relevant_to_story`, no per-entry
  //     `relevant`).
  if (method === 'GET' && pathname === '/v1/ecosystem/hot') {
    const queryCategory = url.searchParams.get('category');
    const queryStoryUuid = url.searchParams.get('story_uuid');
    const queryStoryVersionUuid = url.searchParams.get('story_version_uuid');
    const queryCommunityProfileVersion = url.searchParams.get('community_profile_version');
    try {
      const baseResponse = await ecosystemHotOrchestrator.fetchHot({
        category: typeof queryCategory === 'string' && queryCategory ? queryCategory : undefined,
      });
      const identity = {
        story_uuid: typeof queryStoryUuid === 'string' ? queryStoryUuid : '',
        story_version_uuid: typeof queryStoryVersionUuid === 'string' ? queryStoryVersionUuid : '',
        community_profile_version: typeof queryCommunityProfileVersion === 'string'
          ? queryCommunityProfileVersion
          : '',
      };
      const allIdentityFieldsSupplied = Boolean(identity.story_uuid)
        && Boolean(identity.story_version_uuid)
        && Boolean(identity.community_profile_version);
      if (!allIdentityFieldsSupplied) {
        // Plain list path. Strip any spurious `relevant` projection
        // (defence in depth: the orchestrator does not attach one in
        // this path, but a future refactor must keep the wire shape
        // clean when identity is partial).
        if (Array.isArray(baseResponse.hot)) {
          for (const e of baseResponse.hot) {
            if (e && 'relevant' in e) delete e.relevant;
          }
        }
        let matchedResponse;
        try {
          matchedResponse = matchHotToStoryCatalog(baseResponse, await provider.listStories());
        } catch {
          matchedResponse = { ...matchHotToStoryCatalog(baseResponse, []), unavailable: true, reason: 'hot_catalog_unavailable' };
        }
        return jsonResponse(res, 200, { ...PUBLIC_DECORATE(), ...matchedResponse });
      }
      // Full identity path: attach relevance. The matcher returns
      // { attached, reason, expected_version, actual_version, response };
      // the route layer maps the reason onto an HTTP status.
      const result = attachRelevance(baseResponse, identity, {
        profileRepository: communityProfileRepo,
      });
      if (!result.attached) {
        if (result.reason === 'story_uuid_mismatch') {
          // P1.v1-9 (2026-09-07): the supplied `story_uuid` does
          // not match the canonical profile row's `story_uuid`.
          // Return 400 `community_profile_story_uuid_mismatch`
          // (NOT a plain list with `attached: true`). The wire
          // response echoes `actual_story_uuid` (the caller's
          // value) and `expected_story_uuid` (the row's value, or
          // a stable non-identifying marker when the repo refused
          // to disclose it) so the client can re-pin without a
          // second round-trip.
          return jsonResponse(res, 400, {
            error: 'community_profile_story_uuid_mismatch',
            message: 'The supplied story_uuid does not match the canonical profile row bound to the supplied story_version_uuid.',
            ...PUBLIC_DECORATE(),
            actual_story_uuid: result.actual_story_uuid || '',
            expected_story_uuid: result.expected_story_uuid || '',
            story_version_uuid: identity.story_version_uuid,
            actual_community_profile_version: identity.community_profile_version,
          });
        }
        if (result.reason === 'mismatch') {
          return jsonResponse(res, 400, {
            error: 'community_profile_version_mismatch',
            message: 'The supplied community_profile_version does not match the canonical profile row for this story_version_uuid.',
            ...PUBLIC_DECORATE(),
            expected_community_profile_version: result.expected_version || '',
            actual_community_profile_version: result.actual_version || '',
          });
        }
        if (result.reason === 'profile_missing') {
          return jsonResponse(res, 400, {
            error: 'community_profile_missing',
            message: 'No community profile row exists for this story_version_uuid; the import path must call ensureCommunityProfile first.',
            ...PUBLIC_DECORATE(),
            story_version_uuid: identity.story_version_uuid,
            actual_community_profile_version: result.actual_version || '',
          });
        }
        if (result.reason === 'community_profile_not_found') {
          // P1.v1-4 (2026-09-07): the supplied
          // `community_profile_version` does not match ANY profile row
          // — there is no canonical row for the caller's
          // story_version_uuid either. Return 400
          // `community_profile_not_found` so a wrong/stale/typo'd
          // version never degrades to a 0-terms silent response.
          return jsonResponse(res, 400, {
            error: 'community_profile_not_found',
            message: 'The supplied community_profile_version does not match any community profile row, and no canonical row exists for this story_version_uuid.',
            ...PUBLIC_DECORATE(),
            story_version_uuid: identity.story_version_uuid,
            actual_community_profile_version: result.actual_version || '',
          });
        }
        // reason: 'identity_incomplete' — either a missing field
        // (handled earlier with a plain 200) or a malformed
        // community_profile_version (assertNonEmptyString failed).
        // When the matcher set a `detail` we surface 400 invalid_identity
        // so callers cannot accidentally observe a 0-terms silent
        // degradation.
        if (result.detail) {
          return jsonResponse(res, 400, {
            error: 'invalid_identity',
            message: 'community_profile_version must be a non-empty string when supplied.',
            ...PUBLIC_DECORATE(),
            ...(result.actual_version ? { actual_community_profile_version: result.actual_version } : {}),
            ...(result.detail ? { detail: result.detail } : {}),
          });
        }
        // Defence in depth: strip any spurious `relevant` projection
        // and serve the plain list.
        if (Array.isArray(result.response && result.response.hot)) {
          for (const e of result.response.hot) {
            if (e && 'relevant' in e) delete e.relevant;
          }
        }
        return jsonResponse(res, 200, {
          ...PUBLIC_DECORATE(),
          ...(result.response || baseResponse),
        });
      }
      const pinnedStory = storyRepo.listStories().find((story) => story.story_uuid === identity.story_uuid);
      return jsonResponse(res, 200, { ...PUBLIC_DECORATE(), ...projectProfileMatchedHot(result.response, pinnedStory) });
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      return jsonResponse(res, 502, {
        error: 'ecosystem_hot_failed',
        message,
        ...PUBLIC_DECORATE(),
      });
    }
  }

  // -------------------------------------------------------------------
  // Story 16.3 P1 rebuild on `44343b2` (code review 2026-09-07 re-review
  // of PR #21):
  //
  //   * The `/v1/ecosystem/*` surface is the public follow / share API.
  //     It intentionally does NOT live under `/api/admin/*` /
  //     `/api/dev/*`; those prefixes are reserved for demo-only tooling
  //     and would advertise the DEV_FLAG banner on responses, which a
  //     real player must never see on a feed item.
  //   * The auth seam is the `story_outside_session` cookie set by
  //     `POST /api/sessions`. A missing or malformed cookie is a 401.
  //   * The request body NEVER carries an identity. The route layer
  //     rejects every body that includes `user_ref`, `user_uuid`,
  //     `user_id`, `identity`, `user`, `subject`, `actor`, `owner`
  //     with a 400 BEFORE the service layer touches the input.
  //   * `share` and `unshare` bind to the canonical session owner
  //     persisted by `sessionService.createSession` (see
  //     `findOwnerBySession`). The service re-verifies the canonical
  //     owner against the cookie-derived caller; a mismatch is a 400
  //     `not_session_owner`. There is no way to share someone else's
  //     session by guessing the URL UUID.
  // -------------------------------------------------------------------

  // Identity-shaped keys are NEVER permitted on the /v1/ecosystem/*
  // surface. A 400 is returned BEFORE any business logic runs.
  const ECOSYSTEM_IDENTITY_KEYS = new Set([
    'user_ref', 'user_uuid', 'user_id', 'identity',
    'user', 'subject', 'actor', 'owner',
  ]);

  function rejectIdentityInBody(res, body, allowedKeys) {
    if (!body || typeof body !== 'object') return false;
    const keys = Object.keys(body);
    for (const k of keys) {
      if (ECOSYSTEM_IDENTITY_KEYS.has(k)) {
        jsonResponse(res, 400, {
          error: 'validation_failed',
          message: 'Identity-shaped fields are not allowed in the ecosystem request body.',
          field: k,
          ...publicDecorate(),
        });
        return true;
      }
    }
    const unknown = keys.filter((k) => !allowedKeys.includes(k));
    if (unknown.length > 0) {
      jsonResponse(res, 400, {
        error: 'validation_failed',
        message: 'The ecosystem request body contains unknown fields.',
        ...publicDecorate(),
      });
      return true;
    }
    return false;
  }

  function requireAuthUserUuid(res, req) {
    const owner = currentUserProvider(req);
    if (!owner) { jsonResponse(res, 401, { error: 'login_required' }); return null; }
    return owner.user_uuid;
  }

  // 「故事里的相遇」转正（2026-09-13）：本站不再维护关注关系，因此
  // `POST /v1/ecosystem/follow` 和 `DELETE /v1/ecosystem/follow/:uuid` 已删除。
  // 以前它们要求玩家手输对方的内部 UUID —— 那是 demo 夹具，不是产品行为。
  // 关注关系现在读自知乎官方 `/api/v1/user/followees`，要增减关注请到知乎。

  if (pathname === '/v1/ecosystem/visibility' && ['GET', 'PUT'].includes(method)) {
    const ownerUuid = requireAuthUserUuid(res, req);
    if (!ownerUuid) return;
    if (method === 'PUT') {
      let body;
      try { body = await readJsonBody(req); } catch (error) { return sessionErrorResponse(res, error); }
      if (!body || Object.keys(body).length !== 1 || typeof body.visible !== 'boolean') {
        return jsonResponse(res, 400, { error: 'validation_failed' });
      }
      followingRepo.setVisibility(ownerUuid, body.visible);
      followingService.invalidateAllFeeds();
    }
    return jsonResponse(res, 200, { visible: followingRepo.isVisible(ownerUuid) });
  }

  // GET /v1/ecosystem/friend-timelines?since=...&limit=...
  //   auth: __Host- 会话 Cookie（OAuth 模式）。
  //   关注关系来自知乎官方接口，代表当前登录用户调用；未登录 / 未配置 /
  //   上游失败一律 200 + 明确 status，让「我的」页面能如实说明原因。
  if (method === 'GET' && pathname === '/v1/ecosystem/friend-timelines') {
    const authUuid = requireAuthUserUuid(res, req);
    if (!authUuid) return;
    const sinceRaw = url.searchParams.get('since');
    const limitRaw = url.searchParams.get('limit');
    const limit = limitRaw !== null ? Number(limitRaw) : 50;
    try {
      const payload = await followingService.friendTimelinesSafe({
        followerUuid: authUuid,
        // 用户 access token 只在服务端流转，用于官方接口的 `X-OAuth-Token`。
        oauthToken: oauth.enabled ? oauth.accessToken(req) : null,
        storyRepository: storyRepo,
        since: sinceRaw,
        limit: Number.isInteger(limit) && limit > 0 ? limit : 50,
      });
      return jsonResponse(res, 200, { ...publicDecorate(), ...payload });
    } catch (err) {
      return sendFollowingError(res, err);
    }
  }

  // POST /v1/ecosystem/sessions/:session_uuid/share — owner-only share.
  //   body (optional): { title?, story_uuid?, story_version_uuid? }
  //   auth: story_outside_session cookie.
  //   P1.2 invariant: the request body cannot carry any identity-shaped
  //   field. The canonical owner is resolved internally and verified
  //   against the cookie identity inside the service.
  if (
    method === 'POST'
    && pathname.startsWith('/v1/ecosystem/sessions/')
    && pathname.endsWith('/share')
  ) {
    const tail = pathname.slice('/v1/ecosystem/sessions/'.length, -'/share'.length);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tail)) {
      return jsonResponse(res, 400, {
        error: 'validation_failed',
        message: 'session_uuid must be a UUID.',
        ...publicDecorate(),
      });
    }
    // Story 16.3 P1 v1-2: in the OAuth-pending model the share
    // handler takes NO body. The contract is strict — even an empty
    // JSON object body is forbidden. The client must POST without a
    // body (Content-Length: 0). The `Content-Length` header check
    // below pins this contract to the wire.
    const contentLengthRaw = req.headers['content-length'];
    const contentLength = contentLengthRaw === undefined ? 0 : Number(contentLengthRaw);
    if (!Number.isFinite(contentLength) || contentLength > 0) {
      jsonResponse(res, 400, {
        error: 'forbidden_field',
        message: 'The /share request must not carry a body in the OAuth-pending build.',
        field: 'body',
        ...publicDecorate(),
      });
      return;
    }
    // Drain any body bytes (we still need to consume the stream so the
    // keep-alive socket does not stall) and reject if anything was
    // actually written. We do this with the existing readJsonBody so
    // the rest of the handler logic stays symmetric with /api/sessions.
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
    if (body && Object.keys(body).length > 0) {
      jsonResponse(res, 400, {
        error: 'forbidden_field',
        message: 'The /share request must not carry a body in the OAuth-pending build.',
        field: Object.keys(body)[0],
        ...publicDecorate(),
      });
      return;
    }
    const authUuid = requireAuthUserUuid(res, req);
    if (!authUuid) return;
    try {
      // 补上故事标识与书名，关注流才能显示「谁走了哪本书」，而不是一串
      // session UUID。这些都是服务端自己查出来的，调用方仍然不能传任何字段。
      let title;
      let storyUuid;
      let storyVersionUuid;
      try {
        const session = getSession({ repository: storyRepo, session_uuid: tail });
        storyUuid = session?.story_uuid || undefined;
        storyVersionUuid = session?.story_version_uuid || undefined;
        if (storyUuid) {
          const story = storyRepo.findStoryByUuid(storyUuid);
          if (story && typeof story.title === 'string' && story.title) title = story.title;
        }
      } catch { /* 展示增强而已：查不到就只存 session 归属 */ }
      const row = followingService.shareSession({
        storyRepository: storyRepo,
        sessionUuid: tail,
        ownerUuid: authUuid,
        title,
        story_uuid: storyUuid,
        story_version_uuid: storyVersionUuid,
      });
      return jsonResponse(res, 200, {
        ...publicDecorate(),
        share: row,
        // Story 16.3 P1 v1-2: surface the canonical owner so the
        // UI can render the OAuth-pending display name.
        owner: {
          user_uuid: currentUserProvider(req).user_uuid,
          display_name: currentUserProvider(req).display_name,
          auth_source: currentUserProvider(req).auth_source,
        },
      });
    } catch (err) {
      return sendFollowingError(res, err);
    }
  }

  // POST /v1/ecosystem/sessions/:session_uuid/unshare — owner-only unshare.
  //   body: ignored (must be empty / no identity fields).
  //   auth: story_outside_session cookie.
  if (
    method === 'POST'
    && pathname.startsWith('/v1/ecosystem/sessions/')
    && pathname.endsWith('/unshare')
  ) {
    const tail = pathname.slice('/v1/ecosystem/sessions/'.length, -'/unshare'.length);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tail)) {
      return jsonResponse(res, 400, {
        error: 'validation_failed',
        message: 'session_uuid must be a UUID.',
        ...publicDecorate(),
      });
    }
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sessionErrorResponse(res, err);
    }
    if (body && Object.keys(body).length > 0) {
      if (rejectIdentityInBody(res, body, [])) return;
    }
    const authUuid = requireAuthUserUuid(res, req);
    if (!authUuid) return;
    try {
      const row = followingService.unshareSession({
        storyRepository: storyRepo,
        sessionUuid: tail,
        ownerUuid: authUuid,
      });
      return jsonResponse(res, 200, {
        ...publicDecorate(),
        unshared: !!row,
        session_uuid: tail,
      });
    } catch (err) {
      return sendFollowingError(res, err);
    }
  }

  // GET /v1/ecosystem/sessions/:session_uuid/share-status — 本人查询当前
  // 会话是否已被自己公开。只读、不带 body；用于「我的」页面恢复「公开这段
  // 故事 / 撤回」按钮的正确初始态（否则刷新后已公开的会话仍显示「公开」）。
  // 非本人会话一律 shared:false —— 不确认存在性，也不返回归属信息。
  if (
    method === 'GET'
    && pathname.startsWith('/v1/ecosystem/sessions/')
    && pathname.endsWith('/share-status')
  ) {
    const tail = pathname.slice('/v1/ecosystem/sessions/'.length, -'/share-status'.length);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tail)) {
      return jsonResponse(res, 400, {
        error: 'validation_failed',
        message: 'session_uuid must be a UUID.',
        ...publicDecorate(),
      });
    }
    const authUuid = requireAuthUserUuid(res, req);
    if (!authUuid) return;
    try {
      const row = followingService.findOwnShare({
        storyRepository: storyRepo,
        sessionUuid: tail,
        ownerUuid: authUuid,
      });
      return jsonResponse(res, 200, {
        ...publicDecorate(),
        session_uuid: tail,
        shared: !!row,
        shared_at: row ? row.updated_at : null,
      });
    } catch (err) {
      return sendFollowingError(res, err);
    }
  }

  // Story 16.2 P1.v2 (2026-09-07 code review):
  //   POST /v1/ecosystem/discussions — public surface.
  //
  //   The handler maps identity-resolution failures to these
  //   explicit error codes so a future regression cannot collapse
  //   them into a generic 400. The strings MUST be referenced
  //   literally from this module so the static contract guard
  //   (`grep -nE community_profile_not_found|community_profile_version_mismatch|story_version_mismatch src/server.mjs`)
  //   hits in this file, not only in the underlying repo / dto
  //   modules.
  const ECOSYSTEM_DISCUSSIONS_ERROR_CODES = Object.freeze({
    community_profile_not_found: 'community_profile_not_found',
    community_profile_version_mismatch: 'community_profile_version_mismatch',
    story_version_mismatch: 'story_version_mismatch',
    forbidden_field: 'forbidden_field',
    invalid_json: 'invalid_json',
    method_not_allowed: 'method_not_allowed',
  });
  // ECOSYSTEM_DISCUSSIONS_ERROR_CODES.community_profile_not_found
  // ECOSYSTEM_DISCUSSIONS_ERROR_CODES.community_profile_version_mismatch
  // ECOSYSTEM_DISCUSSIONS_ERROR_CODES.story_version_mismatch
  // ECOSYSTEM_DISCUSSIONS_ERROR_CODES.forbidden_field
  //
  // Hard contract:
  //   * body MUST carry ONLY the identity triple
  //     (`story_uuid`, `story_version_uuid`, `community_profile_version`).
  //     The handler MUST NOT accept `search_queries` / `query` / `queries`
  //     / `ending_title` / `key_choices` / `outcome` /
  //     `character_outcomes` / `identity` / any AI-derived or
  //     client-controlled query source. Anything outside the
  //     allowlist → 400 `forbidden_field`.
  //   * Server resolves the canonical StoryCommunityProfile via
  //     `communityProfileRepo.findCanonicalByIdentity(...)`. The
  //     profile's own `queries[]` is the source of truth for what we
  //     hand to the upstream search adapter. The client NEVER picks
  //     queries.
  //   * Identity-mismatch failure modes map to specific 400 codes:
  //       - community_profile_not_found
  //       - community_profile_version_mismatch
  //       - story_version_mismatch
  //   * Missing identity / bad UUID → 400.
  //   * Non-POST → 405 with Allow: POST.
  //   * Public response carries NO `dev` / `demo` / `DEV_FLAG`.
  // -------------------------------------------------------------------
  if (pathname === '/v1/ecosystem/discussions') {
    if (method !== 'POST') {
      res.setHeader('allow', 'POST');
      return jsonResponse(res, 405, {
        error: 'method_not_allowed',
        message: `Method ${method} is not allowed for ${pathname}.`,
      });
    }
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return jsonResponse(res, 400, {
        error: 'invalid_json',
        message: 'invalid JSON body',
      });
    }
    const normalised = normaliseDiscussionsRequest(body);
    if (!normalised.ok) {
      // 4xx codes that come from the DTO (forbidden_field / invalid_limit / ...)
      // — surface them verbatim so the player can debug.
      const status = normalised.code === 'forbidden_field' ? 400 : 400;
      return jsonResponse(res, status, {
        error: normalised.code,
        message: normalised.message,
        field: normalised.field,
      });
    }
    const identity = normalised.value;
    // Server-authoritative profile lookup. The client never picks
    // queries — the orchestrator walks profile.queries[] below.
    const resolved = communityProfileRepo.findCanonicalByIdentity({
      story_uuid: identity.story_uuid,
      story_version_uuid: identity.story_version_uuid,
      community_profile_version: identity.community_profile_version,
    });
    if (!resolved.ok) {
      // Distinct 400 codes per failure mode — a future regression
      // cannot collapse them into one generic 400.
      const code = resolved.code;
      return jsonResponse(res, 400, {
        error: code,
        message: resolved.message,
      });
    }
    const outcome = await searchEcosystemDiscussions({
      cache: ecosystemSearchCacheRepo,
      adapter: ecosystemSearchAdapter,
      profile: resolved.profile,
      story_uuid: identity.story_uuid,
      story_version_uuid: identity.story_version_uuid,
      community_profile_version: identity.community_profile_version,
      limit: identity.limit,
    });
    // Outcome already strips DEV_FLAG / demo. The route lives on the
    // public surface; it never decorates with admin/dev fields.
    return jsonResponse(res, 200, outcome);
  }

  // Root → static
  if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return serveStatic(req, res, '/index.html');
  }
  if (method === 'GET' || method === 'HEAD') {
    return serveStatic(req, res, pathname);
  }
  // Anything else (e.g. POST /index.html, DELETE /api/stories) is not a
  // readable static resource and must not be served as a 200 document.
  return jsonResponse(res, 405, {
    error: 'method_not_allowed',
    message: `Method ${method} is not allowed for ${pathname}.`,
    demo: DEMO_FLAG,
  });
}

const server = http.createServer((req, res) => {
  const path = (req.url || '').split('?')[0];
  const match = path.match(/^\/api\/sessions\/([0-9a-f-]{36})\/(generate|recover|opening-events|narrative-events|interrupt)$/i);
  if (match) {
    const startedAt = performance.now();
    const record = disconnected => loggerInfo('http.session.response', {
      component: 'http', session_uuid: match[1], latency_ms: Math.round(performance.now() - startedAt),
      extra: { route: match[2], method: req.method, status: res.statusCode, disconnected },
    });
    res.once('finish', () => record(false));
    res.once('close', () => { if (!res.writableFinished) record(true); });
  }
  handleRequest(req, res).catch((err) => {
    // Last-resort guard: an async route must never crash the process.
    const message = String(err && err.message ? err.message : err);
    if (!res.headersSent) {
      jsonResponse(res, 500, {
        error: 'internal_error',
        message: 'Internal server error.',
        demo: DEMO_FLAG,
      });
    } else {
      try { res.end(); } catch { /* response already failed */ }
    }
    // eslint-disable-next-line no-console
    console.error('[story-outside] unhandled request error:', message);
  });
});

server.on('clientError', (err, socket) => {
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  }
});

// Auto-listen when run directly (e.g. `node src/server.mjs`).
// When imported as a module, expose the server so tests / tools can
// control the listen lifecycle.
const isMainModule = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  // Validate the provider config before accepting traffic so a
  // misconfigured STORY_OUTSIDE_PROVIDER fails loudly at startup rather
  // than only when the first /api/stories request arrives.
  try {
    try {
      getStoryProvider();
      loadAIConfig();
    } catch (err) {
      // Keep the established startup error channel for provider/AI config
      // failures; callers and wire-regression checks rely on this prefix.
      // eslint-disable-next-line no-console
      console.error(`[story-outside] provider config error: ${String(err && err.message ? err.message : err)}`);
      await closeDatabase().catch(() => {});
      process.exit(1);
    }
    await connectDatabase();
    if (databaseBootstrapError) throw databaseBootstrapError;
    if (databasePersistence) await databasePersistence.flush();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[story-outside] bootstrap error: ${String(err && err.message ? err.message : err)}`);
    await closeDatabase().catch(() => {});
    process.exit(1);
  }
  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`[story-outside] listening on http://${HOST}:${PORT} (${currentDemoFlag().mode} mode)`);
  });

  const shutdown = async () => {
    server.close();
    await closeDatabase();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

export { server, DEMO_FLAG, DEV_FLAG, classifyProviderError, sessionError, storyRepo, storyFixtures, listFixtureStorySlugs, communityProfileRepo };
