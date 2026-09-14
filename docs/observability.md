# 《故事之外》Observability (Story 14)

This document is the field contract for Story 14 — performance, model
cost, and observability. It covers:

1. The structured-log schema the runtime emits.
2. The metrics store and its per-session / global shape.
3. The timing categories used for slow-point triage.
4. The `opening_cache` hit tracker.
5. The two admin endpoints that surface the data.
6. The redaction contract (what counts as a secret).
7. Production boundaries and known limits.

The implementation is a **read-only sidecar**: business code paths are
never blocked, awaited, or mutated by observability calls. Every hook
that talks to the logger / metrics store is best-effort and wraps its
mutators in `try/catch`.

---

## 1. Structured logger (`src/observability/logger.mjs`)

The logger writes one JSON object per line via `console.log`. Production
deployments can swap the sink by calling `setSink(fn)` from
operator-only bootstrap code. The schema is stable — new optional fields
may be added, but existing names and types are frozen.

### Core fields (always present)

| field     | type    | description |
|-----------|---------|-------------|
| `ts`      | string  | ISO-8601 timestamp emitted at write time. |
| `level`   | string  | `debug` \| `info` \| `warn` \| `error`. |
| `service` | string  | Service identifier; defaults to `story-outside`. |
| `host`    | string  | OS hostname; useful for multi-process deploys. |
| `event`   | string  | Stable dotted event name (e.g. `agent.turn.success`). |

### Optional scalar fields (event-dependent)

`session_uuid`, `component`, `model`, `prompt_version`, `request_id`,
`tool_name`, `latency_ms`, `in_tokens`, `out_tokens`,
`cache_read_tokens`, `error_code`, `error_message`, `truncated`,
`retried`, `cache_hit`, `from_cache`, `kind`, `sequence`, `event_type`,
`state`.

Everything else goes into `extra`, where the logger applies the
**redaction contract**.

### Known event names

- `agent.turn.start`, `agent.turn.success`, `agent.turn.failure`,
  `agent.output.truncated`, `agent.cache.hit`, `agent.tool.dispatched`
- `session.create`, `session.opening.commit`, `session.interrupt`,
  `session.tool.commit`, `session.state.transition`, `session.cache.hit`,
  `session.cache.miss`, `session.compact`

A new event name is acceptable as long as the producer keeps its
emission rate bounded and its fields inside the contract above.

### Redaction contract

The logger applies two rules to every value that lands in `extra`:

1. **Sensitive keys**: any key whose normalised form (`a-z` only) is
   in `{password, token, accesstoken, secret, apikey, appkey,
   authorization, cookie, headers, header}` is replaced by
   `"[REDACTED]"`. The default allow-list (overrides redaction) is
   `[session_uuid, request_id, cache_uuid, story_uuid,
   story_version_uuid]`. Operators may extend it via `setAllowList`,
   but a tighter allow-list is recommended in production.
2. **Long strings** (> 64 chars) and any `*.text` keys are replaced by
   `{ length, hash }` where `hash` is the first 16 hex chars of the
   sha-256 of the original string. Operators can correlate repeated
   values across log lines without ever seeing the underlying text.

The logger **never throws** into business code. A broken sink returns
silently; a malformed context record is skipped.

---

## 2. Metrics store (`src/observability/metrics.mjs`)

Two aggregation axes:

- **per session** (`session_uuid` → counters + latency histograms)
- **global** (process-wide totals + the same histograms)

Storage is a process-local `Map`. Restart wipes everything. The
production bridge (Prometheus / StatsD) is documented below in §7.

The Map is **bounded and LRU-evicted**: at most 1000 sessions are kept.
`touchSession` re-inserts a key on every hit, so eviction targets the
least recently *active* session, not merely the oldest-inserted one.
Global counters are never rolled back when a session record is evicted.

### Per-session fields

```
firstSeenAt, lastSeenAt,
agentTurns, agentRetries, agentFailures,
toolCalls, openingCacheHits, realtimeTransitions,
inTokens, outTokens, cacheReadTokens,
truncated, compactCount,
providerErrors, providerRateLimits,
agentLatency, commitLatency, providerLatency, dbLatency
```

Latency histograms share one schema: `{ le_50, le_100, le_250,
le_1000, le_5000, le_30000, gt_30000, sum, count }`. Buckets are
non-cumulative: each bucket counts samples whose latency is **≤** that
boundary in ms. Sum and count are unaggregated.

### Global fields

Same counters, plus `sessionsObserved`, `openingCacheMisses`,
`sessionsByState{opening,awaiting_first_choice,realtime,finished}`,
and the four latency histograms.

### Public mutators

`recordAgentTurn`, `recordAgentLatency`, `recordAgentFailure`,
`recordToolCall`, `recordOpeningCacheHit`, `recordOpeningCacheMiss`,
`recordRealtimeTransition`, `recordCommit`, `recordProviderRequest`,
`recordProviderRateLimit`, `recordDbQuery`, `recordCompact`,
`recordCacheReadTokens`, `observeSession`. All are wrapped — they
silently swallow invalid input.

### Single-recorder contract (agent turn)

`recordAgentTurn` (turn counter + tokens + latency) is called **exactly
once per successful agent turn**, by
`agent/observabilityHooks.onTurnSuccess` — the only place that owns the
full usage / truncated / retry context. `timeAgentTurn`
(`observability/timing.mjs`) is a latency-only stopwatch: it feeds the
`agentLatency` histogram via `recordAgentLatency` and never bumps turn
or token counters. Wiring both helpers around the same turn therefore
cannot double-count.

---

## 3. Timing categories (`src/observability/timing.mjs`)

The slow-point triage table maps a symptom to a category:

| category   | source                                        |
|------------|-----------------------------------------------|
| `agent`    | Server-side: LLM generation wall clock.       |
| `commit`   | Server-side: opening event / tool commit.     |
| `provider` | Network: outbound HTTP to the upstream.       |
| `db`       | Storage: MariaDB projection flush / query latency; in-memory fallback when DB is disabled. |
| `frontend` | Client-side: browser playback wall clock.     |

The first four categories are measured server-side via the four
`timeAgentTurn`, `timeCommit`, `timeProvider`, and `timeDb` wrappers.
Each one returns a `Stopwatch` whose `elapsedMs()` is bucketed into
the corresponding histogram in §2. Note the `agent` wrapper records
latency only (see the single-recorder contract above) — turn counters
come from the hooks layer.

### Why "frontend" is not server-side

We cannot trust the browser clock to align with the server clock for
absolute values, but the **diff** between the server's commit
timestamp and the browser's `client_playback_at` is meaningful. Use
`computeFrontendPlaybackMs({ server_commit_at, client_playback_at })`
to compute it; the helper returns `null` (not `0`) when either side is
missing so callers can distinguish "never played" from "played
instantly". Negative diffs (client clock behind the server clock) are
**clamped to 0**: this deliberately hides client clock skew in exchange
for a non-negative value operators can aggregate without filtering.
The admin endpoint exposes the storage; the diff is computed per
commit by whoever consumes the metrics.

---

## 4. Opening cache stats (`src/observability/cacheStats.mjs`)

Tracks `opening_cache` hits per cache and globally.

- `recordHit({ session_uuid, cache_uuid, story_uuid, story_version_uuid, generation_hash })`
  increments the per-cache aggregate and the global hit counter, and
  forwards to `metrics.recordOpeningCacheHit`.
- `recordMiss({ session_uuid })` increments the global miss counter
  and forwards to `metrics.recordOpeningCacheMiss`.

The per-cache store is **bounded**: at most 500 aggregates are kept
(the cache_uuid is externally controllable via the rebuild endpoint).
When the cap is reached the oldest-inserted aggregate is evicted; the
global hit/miss counters are never rolled back, so the demo-path
acceptance proof below survives eviction of individual aggregates.

Snapshots:

- `snapshotCache(cache_uuid)` — one cache's `{ hits, misses, firstHitAt, lastHitAt, story_uuid, story_version_uuid, generation_hash }`.
- `snapshotAll()` — global totals + every cache aggregate.

### Demo-path acceptance

The acceptance criterion "fixed test story demo paths must not produce
real-time model calls" is provable from the metrics endpoint: the
`global.openingCacheHits` counter rises for each cache hit, and the
per-session `agentTurns` / `inTokens` / `outTokens` stay at zero for
sessions that only replay the opening cache.

---

## 5. Agent / stories hook points

### `src/agent/observabilityHooks.mjs`

| function                                          | when to call                                   |
|---------------------------------------------------|-----------------------------------------------|
| `createHookContext({ session_uuid, model, prompt_version, request_id })` | once at runtime construction. |
| `onTurnStart(hookCtx)` → `timer`                  | right before `provider.complete()`.            |
| `applyOutputLimits({ session_uuid, usage, result })` → `{ truncated, in_tokens, out_tokens }` | in the provider adapter, before returning to the runtime. |
| `onTurnSuccess({ hookCtx, timer, usage, result, truncated, retry })` | on a successful provider response.            |
| `onTurnFailure({ hookCtx, error, retry })`        | on a provider / runtime failure.               |
| `onToolDispatched({ hookCtx, toolCall })`         | once per `tool_call` the provider returns.     |
| `observeProviderCall({ hookCtx, provider, request, retry })` | convenience wrapper that runs the full lifecycle. |

The runtime / tools source files do **not** import this module
directly. Hooks are opt-in for tests and for future middleware that
sits between the runtime and the provider. The runtime stays
observability-free.

### `src/stories/observabilityHooks.mjs`

| function                                          | when to call                                   |
|---------------------------------------------------|-----------------------------------------------|
| `createStoriesHookContext({ session_uuid, ... })` | once per request.                              |
| `onSessionCreate(hookCtx)`                        | after `createSession(...)` succeeds.           |
| `onOpeningCommit({ hookCtx, event, latency_ms })` | after `commitOpeningEvent(...)` succeeds. A missing/non-numeric `latency_ms` records the commit event without a latency sample — never a fake 0ms sample. |
| `onInterrupt({ hookCtx, text_length, latency_ms })` | after `interruptWithPlayerInput(...)` succeeds. |
| `onToolCommit({ hookCtx, tool_name, latency_ms })` | after a tool call has been recorded into the session. |
| `onStateTransition({ hookCtx, from_state, to_state })` | for state-machine transitions not covered above. |
| `onOpeningCacheHit(hookCtx)`                      | every time the route serves the session from a pinned opening cache. |
| `onOpeningCacheMiss(hookCtx, reason)`             | every time the session falls back to realtime.  |
| `onCompact(hookCtx)`                              | when a session is compacted (currently unused by the session service; hook reserved). |

The session service source does not call these hooks directly; the
HTTP route layer (and tests) call them after each service call
returns. Keeping the service observability-free means the
sessionService tests stay green without any new test fixtures.

---

## 6. Admin endpoints (`src/server.mjs`)

Two new GET routes live under `/api/admin/*`:

- `GET /api/admin/observability/sessions/:uuid`
  Returns the per-session metrics snapshot + the canonical session
  state (recovered from the repository). A malformed uuid (the route
  accepts any single path segment and validates it with
  `isSessionUuid`) returns `400 validation_failed`; 404
  (`session_not_observed`) is returned when the session has no
  recorded metrics yet.
- `GET /api/admin/observability/metrics/summary`
  Returns the full metrics snapshot (global + every session) and the
  cache-stats snapshot. It exposes storage only — frontend playback
  diffs are computed per commit from committed events, not here.

Both routes are demo/dev-only (no auth), carry the standard `demo` and
`dev` banners, and never mutate server state.

---

## 7. Real boundaries

### Where we land in production today

- **Logging**: structured JSON Lines to stdout. Operators pipe to any
  log sink (`journald`, Loki, Cloud Logging, etc.).
- **Metrics**: process-local `Map`. Restart zeros everything. Bridge
  to Prometheus / StatsD is a future iteration (likely 14.x or
  15+).
- **Tokens**: when the upstream provider exposes
  `cache_read_input_tokens` we surface it; if the field is missing
  (e.g. the mock provider today), the metrics accept `null` and the
  per-session counter stays at zero — this is the documented
  behaviour, not a bug.
- **Rate-limit fields**: the mock provider does not emit 429s or
  `Retry-After`. The `providerRateLimits` counter will stay at zero
  until the real provider lands (Story 13). Documented in
  `docs/official-zhihu-skill.md` and the route layer.
- **Frontend playback**: not measured server-side. Operators compute
  the diff per commit using the helper in §3.

### Demo warmup

The acceptance criterion "fixed test story demo paths produce no
real-time model calls" is satisfied by the current code path:
`opening_cache` is hit on every demo replay and `recordAgentTurn` is
never called for cached openings.

To warm a fresh deployment:

1. Boot the server (`node src/server.mjs`).
2. Hit `POST /api/admin/opening-cache/rebuild` for each seeded story
   (or rely on the implicit warmup performed by the first `/api/dev/
   sessions` request — the sessionService pins the existing valid
   cache when one is present).
3. Hit `GET /api/admin/observability/metrics/summary` and confirm
   `global.openingCacheHits > 0` after the first demo replay.

There is no separate "prewarm" script — the cache rebuild endpoint is
the public API for warming.

### Future bridges

- Replace `setSink` to forward JSON Lines to a structured log shipper.
- Replace `snapshotAll` consumers with a Prometheus exporter.
- Extend `recordProviderRequest` to surface real 429 / 5xx fields
  once the real provider is wired (Story 13).
