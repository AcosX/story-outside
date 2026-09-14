// tests/observability.test.mjs — Story 14 observability suite.
//
// Coverage matrix (mirrors the acceptance criteria):
//   1. Structured log fields are stable (logger).
//   2. Sensitive fields are redacted (logger).
//   3. Metrics aggregate per-session + globally (metrics).
//   4. Latency histograms bucket correctly (metrics + timing).
//   5. Agent generation vs commit timing are kept separate (timing).
//   6. opening_cache hit counter increments (cacheStats).
//   7. Agent turn success/failure log shape (agent hooks).
//   8. Cache read tokens exposed (metrics + agent hooks).
//   9. Real-boundary docs: hot path never throws on logger errors.

import assert from 'node:assert/strict';
import {
  _resetLoggerForTests,
  buildLogRecord,
  getAllowList,
  log,
  redactText,
  setAllowList,
  setServiceName,
  setSink,
} from '../src/observability/logger.mjs';
import {
  _resetMetricsForTests,
  recordAgentFailure,
  recordAgentTurn,
  recordCacheReadTokens,
  recordCommit,
  recordCompact,
  recordDbQuery,
  recordOpeningCacheHit,
  recordOpeningCacheMiss,
  recordProviderRateLimit,
  recordProviderRequest,
  recordRealtimeTransition,
  recordToolCall,
  snapshotAll,
  snapshotSession,
} from '../src/observability/metrics.mjs';
import {
  computeFrontendPlaybackMs,
  Stopwatch,
  timeAgentTurn,
  timeCommit,
  timeDb,
  timeProvider,
} from '../src/observability/timing.mjs';
import {
  _resetCacheStatsForTests,
  MAX_CACHE_AGGREGATES,
  recordHit,
  recordMiss,
  snapshotAll as cacheSnapshotAll,
  snapshotCache,
} from '../src/observability/cacheStats.mjs';
import {
  applyOutputLimits,
  createHookContext,
  observeProviderCall,
  onToolDispatched,
  onTurnFailure,
  onTurnStart,
  onTurnSuccess,
  PROVIDER_USAGE,
} from '../src/agent/observabilityHooks.mjs';
import {
  createStoriesHookContext,
  onCompact,
  onInterrupt,
  onOpeningCacheHit,
  onOpeningCacheMiss,
  onOpeningCommit,
  onSessionCreate,
  onStateTransition as onStoriesStateTransition,
} from '../src/stories/observabilityHooks.mjs';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`not ok - ${name}`);
    throw err;
  }
}

function collectSink() {
  const lines = [];
  const previous = setSink((line) => lines.push(line));
  return {
    lines,
    restore: () => setSink(previous),
  };
}

// ---------------------------------------------------------------------------
// logger.mjs
// ---------------------------------------------------------------------------

await test('logger: buildLogRecord produces stable schema', () => {
  setServiceName('test-service');
  const ctx = {
    level: 'info',
    event: 'agent.turn.success',
    session_uuid: '11111111-1111-4111-8111-111111111111',
    component: 'agent',
    model: 'gpt-test',
    latency_ms: 123,
    in_tokens: 12,
    out_tokens: 7,
    truncated: false,
    request_id: 'req-1',
  };
  const rec = buildLogRecord(ctx);
  for (const k of ['ts', 'level', 'service', 'host', 'event']) {
    assert.ok(k in rec, `missing field ${k}`);
  }
  assert.equal(rec.level, 'info');
  assert.equal(rec.event, 'agent.turn.success');
  assert.equal(rec.session_uuid, ctx.session_uuid);
  assert.equal(rec.component, 'agent');
  assert.equal(rec.model, 'gpt-test');
  assert.equal(rec.latency_ms, 123);
  assert.equal(rec.in_tokens, 12);
  assert.equal(rec.out_tokens, 7);
  assert.equal(rec.truncated, false);
  assert.equal(rec.request_id, 'req-1');
});

await test('logger: log writes one JSON line through the active sink', () => {
  const sink = collectSink();
  try {
    log({ level: 'info', event: 'session.create', session_uuid: 'uuid-1', extra: { foo: 'bar' } });
    assert.equal(sink.lines.length, 1);
    const parsed = JSON.parse(sink.lines[0]);
    assert.equal(parsed.event, 'session.create');
    assert.equal(parsed.session_uuid, 'uuid-1');
    assert.equal(parsed.extra.foo, 'bar');
  } finally {
    sink.restore();
  }
});

await test('logger: sensitive keys are redacted in extra', () => {
  const sink = collectSink();
  try {
    log({
      level: 'info',
      event: 'test.sensitive',
      extra: { token: 'ghp_secret123', password: 'pwd', nested: { authorization: 'Bearer abc', safe: 'kept' } },
    });
    const parsed = JSON.parse(sink.lines[0]);
    assert.equal(parsed.extra.token, '[REDACTED]');
    assert.equal(parsed.extra.password, '[REDACTED]');
    assert.equal(parsed.extra.nested.authorization, '[REDACTED]');
    assert.equal(parsed.extra.nested.safe, 'kept');
  } finally {
    sink.restore();
  }
});

await test('logger: allowList overrides redaction', () => {
  setAllowList(['authorization']);
  const sink = collectSink();
  try {
    log({ level: 'info', event: 'test.allow', extra: { authorization: 'Bearer xyz', token: 'ghp_x' } });
    const parsed = JSON.parse(sink.lines[0]);
    assert.equal(parsed.extra.authorization, 'Bearer xyz');
    assert.equal(parsed.extra.token, '[REDACTED]');
  } finally {
    sink.restore();
    setAllowList(getAllowList().filter((k) => k !== 'authorization'));
  }
});

await test('logger: long text and text keys are redacted to {length, hash}', () => {
  const sink = collectSink();
  try {
    const long = 'x'.repeat(200);
    log({ level: 'info', event: 'test.long', extra: { text: long, player_input: { text: 'player said something' } } });
    const parsed = JSON.parse(sink.lines[0]);
    assert.equal(parsed.extra.text.length, 200);
    assert.ok(/^[0-9a-f]{16}$/.test(parsed.extra.text.hash));
    assert.equal(parsed.extra.player_input.text.length, 'player said something'.length);
    assert.ok(/^[0-9a-f]{16}$/.test(parsed.extra.player_input.text.hash));
    const fp = redactText('player said something');
    assert.equal(fp.length, 'player said something'.length);
    assert.equal(fp.hash, parsed.extra.player_input.text.hash);
  } finally {
    sink.restore();
  }
});

await test('logger: never throws when sink rejects', () => {
  setSink(() => { throw new Error('sink broke'); });
  let ok = false;
  try {
    log({ level: 'info', event: 'test.fail', session_uuid: 'uuid-x' });
    ok = true;
  } catch {
    ok = false;
  }
  assert.equal(ok, true);
  // restore
  setSink(() => {});
});

// ---------------------------------------------------------------------------
// metrics.mjs
// ---------------------------------------------------------------------------

await test('metrics: agentTurn aggregation per session + global', () => {
  _resetMetricsForTests();
  recordAgentTurn({ session_uuid: 's1', latency_ms: 200, in_tokens: 10, out_tokens: 5 });
  recordAgentTurn({ session_uuid: 's1', latency_ms: 300, in_tokens: 12, out_tokens: 6, retry: true });
  recordAgentTurn({ session_uuid: 's2', latency_ms: 100, in_tokens: 7, out_tokens: 4, truncated: true });
  const all = snapshotAll();
  assert.equal(all.global.agentTurns, 3);
  assert.equal(all.global.agentRetries, 1);
  assert.equal(all.global.truncated, 1);
  assert.equal(all.global.inTokens, 29);
  assert.equal(all.global.outTokens, 15);
  assert.equal(all.sessions.s1.agentTurns, 2);
  assert.equal(all.sessions.s1.agentRetries, 1);
  assert.equal(all.sessions.s2.agentTurns, 1);
  assert.equal(all.sessions.s2.truncated, 1);
});

await test('metrics: histograms bucket latency correctly', () => {
  _resetMetricsForTests();
  for (const ms of [10, 75, 200, 800, 2500, 9000, 30000, 60000]) {
    recordAgentTurn({ session_uuid: 's1', latency_ms: ms });
  }
  const all = snapshotAll();
  const buckets = all.sessions.s1.agentLatency;
  // Each bucket is the count of samples whose latency is <= that boundary.
  // Samples: [10, 75, 200, 800, 2500, 9000, 30000, 60000]
  assert.equal(buckets.le_50, 1);    // 10
  assert.equal(buckets.le_100, 1);   // 75
  assert.equal(buckets.le_250, 1);   // 200
  assert.equal(buckets.le_1000, 1);  // 800
  assert.equal(buckets.le_5000, 1);  // 2500
  assert.equal(buckets.le_30000, 2); // 9000, 30000
  assert.equal(buckets.gt_30000, 1); // 60000
  assert.equal(buckets.count, 8);
});

await test('metrics: cacheReadTokens aggregated separately', () => {
  _resetMetricsForTests();
  recordCacheReadTokens({ session_uuid: 's1', cache_read_tokens: 50 });
  recordCacheReadTokens({ session_uuid: 's1', cache_read_tokens: 30 });
  const all = snapshotAll();
  assert.equal(all.sessions.s1.cacheReadTokens, 80);
  assert.equal(all.global.cacheReadTokens, 80);
});

await test('metrics: commit + provider + db timings are tracked separately', () => {
  _resetMetricsForTests();
  recordCommit({ session_uuid: 's1', latency_ms: 10 });
  recordProviderRequest({ session_uuid: 's1', latency_ms: 200, success: true });
  recordProviderRequest({ session_uuid: 's1', latency_ms: 0, success: false });
  recordDbQuery({ session_uuid: 's1', latency_ms: 4 });
  const all = snapshotAll();
  assert.equal(all.sessions.s1.commitLatency.count, 1);
  assert.equal(all.sessions.s1.providerLatency.count, 2);
  assert.equal(all.sessions.s1.dbLatency.count, 1);
  assert.equal(all.global.providerErrors, 1);
});

await test('metrics: compact + toolCall + realtime + providerRateLimit counters', () => {
  _resetMetricsForTests();
  recordCompact({ session_uuid: 's1' });
  recordCompact({ session_uuid: 's1' });
  recordToolCall({ session_uuid: 's1', tool_name: 'ask_player_choice' });
  recordRealtimeTransition({ session_uuid: 's1' });
  recordProviderRateLimit({ session_uuid: 's1' });
  recordAgentFailure({ session_uuid: 's1', error_code: 'provider_failure' });
  const s = snapshotSession('s1');
  assert.equal(s.compactCount, 2);
  assert.equal(s.toolCalls, 1);
  assert.equal(s.realtimeTransitions, 1);
  assert.equal(s.providerRateLimits, 1);
  assert.equal(s.agentFailures, 1);
  assert.equal(s.lastErrorCode, 'provider_failure');
});

await test('metrics: snapshotSession returns null for unknown uuid', () => {
  _resetMetricsForTests();
  assert.equal(snapshotSession('missing'), null);
});

await test('metrics: missing or bad input is silently ignored', () => {
  _resetMetricsForTests();
  // Should not throw.
  recordAgentTurn({});
  recordAgentTurn({ session_uuid: null });
  recordOpeningCacheHit({});
  recordOpeningCacheMiss();
  assert.deepEqual(snapshotAll().global, snapshotAll().global);
});

await test('metrics: session store eviction is LRU, not FIFO', () => {
  _resetMetricsForTests();
  // Fill the store to its cap with sessions s0..s{cap-1}.
  const cap = 1000; // mirrors MAX_SESSION_METRICS in metrics.mjs
  for (let i = 0; i < cap; i += 1) {
    recordToolCall({ session_uuid: `s${i}` });
  }
  // Touch s0 so it becomes the most recently used session.
  recordToolCall({ session_uuid: 's0' });
  // One more session forces an eviction of the least recently used key.
  recordToolCall({ session_uuid: 's-new' });
  // With pure FIFO the eviction victim would have been s0; LRU keeps it.
  assert.ok(snapshotSession('s0'), 'active session s0 must survive eviction (LRU)');
  assert.ok(!snapshotSession('s1'), 'least recently used session s1 is evicted');
  assert.ok(snapshotSession('s-new'), 'newly inserted session is present');
  // Global counters are not rolled back on eviction: 1000 fills + 1
  // refresh + 1 new session, every call counted.
  assert.equal(snapshotAll().global.toolCalls, cap + 2);
});

// ---------------------------------------------------------------------------
// timing.mjs
// ---------------------------------------------------------------------------

await test('timing: timeAgentTurn and timeCommit are independent buckets', async () => {
  _resetMetricsForTests();
  await timeAgentTurn({ session_uuid: 's1' }, async () => {
    // 20ms sampling headroom: a 5ms sleep can round to <5ms on coarse
    // clocks and flake the >= 5ms assertion below.
    await new Promise((r) => setTimeout(r, 20));
  });
  await timeCommit({ session_uuid: 's1' }, async () => {
    await new Promise((r) => setTimeout(r, 1));
  });
  const s = snapshotSession('s1');
  assert.ok(s.agentLatency.count >= 1, 'agent latency not recorded');
  assert.ok(s.commitLatency.count >= 1, 'commit latency not recorded');
  assert.ok(s.agentLatency.sum >= 5, 'agent latency should be ≥ 5ms');
  // Single-recorder contract: timeAgentTurn is a latency-only stopwatch.
  // Turn counters belong to agent hooks onTurnSuccess; wiring both for
  // the same turn would double-count. See docs/observability.md §3.
  assert.equal(s.agentTurns, 0, 'timeAgentTurn must not record agentTurns');
  assert.equal(snapshotAll().global.agentTurns, 0, 'timeAgentTurn must not bump global agentTurns');
});

await test('timing: timeProvider records failure on throw', async () => {
  _resetMetricsForTests();
  await assert.rejects(() => timeProvider({ session_uuid: 's1' }, async () => {
    throw new Error('upstream 5xx');
  }));
  const all = snapshotAll();
  assert.equal(all.global.providerErrors, 1);
  assert.ok(all.sessions.s1.providerLatency.count >= 1);
});

await test('timing: timeDb records even when fn throws', async () => {
  _resetMetricsForTests();
  await assert.rejects(() => timeDb({ session_uuid: 's1' }, async () => {
    throw new Error('db down');
  }));
  const s = snapshotSession('s1');
  assert.equal(s.dbLatency.count, 1);
});

await test('timing: Stopwatch stops once and is idempotent', () => {
  const sw = new Stopwatch();
  sw.stop();
  const first = sw.elapsedMs();
  sw.stop();
  const second = sw.elapsedMs();
  assert.ok(first >= 0);
  assert.equal(second, first);
});

await test('timing: computeFrontendPlaybackMs returns diff or null', () => {
  const a = '2026-09-02T20:00:00.000Z';
  const b = '2026-09-02T20:00:00.500Z';
  assert.equal(computeFrontendPlaybackMs({ server_commit_at: a, client_playback_at: b }), 500);
  // A negative diff (client clock behind the server) is clamped to 0 —
  // deliberate trade-off documented in the source and docs/observability.md §3.
  assert.equal(computeFrontendPlaybackMs({ server_commit_at: b, client_playback_at: a }), 0);
  assert.equal(computeFrontendPlaybackMs({ server_commit_at: a }), null);
  assert.equal(computeFrontendPlaybackMs({ client_playback_at: b }), null);
  assert.equal(computeFrontendPlaybackMs({}), null);
});

// ---------------------------------------------------------------------------
// cacheStats.mjs
// ---------------------------------------------------------------------------

await test('cacheStats: hit increments per cache + global', () => {
  _resetCacheStatsForTests();
  recordHit({ session_uuid: 's1', cache_uuid: 'c1', story_uuid: 'story-1', story_version_uuid: 'v1', generation_hash: 'h1' });
  recordHit({ session_uuid: 's2', cache_uuid: 'c1', story_uuid: 'story-1', story_version_uuid: 'v1', generation_hash: 'h1' });
  recordHit({ session_uuid: 's1', cache_uuid: 'c2', story_uuid: 'story-2', story_version_uuid: 'v2', generation_hash: 'h2' });
  const snap = cacheSnapshotAll();
  assert.equal(snap.global.hits, 3);
  assert.equal(snap.caches.c1.hits, 2);
  assert.equal(snap.caches.c2.hits, 1);
  assert.equal(snap.caches.c1.firstHitAt, snap.caches.c1.firstHitAt);
  assert.ok(snap.caches.c1.lastHitAt);
  assert.equal(snap.caches.c1.story_uuid, 'story-1');
});

await test('cacheStats: miss increments global misses only', () => {
  _resetCacheStatsForTests();
  recordMiss({ session_uuid: 's1' });
  recordMiss({ session_uuid: 's1' });
  const snap = cacheSnapshotAll();
  assert.equal(snap.global.misses, 2);
});

await test('cacheStats: snapshotCache returns null for unknown cache', () => {
  _resetCacheStatsForTests();
  assert.equal(snapshotCache('missing'), null);
});

await test('cacheStats: opening cache hit metrics also increment', () => {
  _resetMetricsForTests();
  _resetCacheStatsForTests();
  recordHit({ session_uuid: 's1', cache_uuid: 'c1' });
  recordHit({ session_uuid: 's1', cache_uuid: 'c1' });
  const all = snapshotAll();
  assert.equal(all.sessions.s1.openingCacheHits, 2);
  assert.equal(all.global.openingCacheHits, 2);
});

await test('cacheStats: per-cache aggregates are bounded, global counters are not rolled back', () => {
  _resetMetricsForTests();
  _resetCacheStatsForTests();
  const cap = MAX_CACHE_AGGREGATES;
  // One hit per cache_uuid, in insertion order c0, c1, … c{cap+1}.
  for (let i = 0; i < cap + 2; i += 1) {
    recordHit({ session_uuid: 's1', cache_uuid: `c${i}` });
  }
  const snap = cacheSnapshotAll();
  assert.equal(Object.keys(snap.caches).length, cap, 'store must stay at the cap');
  assert.ok(!snap.caches.c0, 'oldest-inserted aggregate is evicted');
  assert.ok(!snap.caches.c1, 'second-oldest aggregate is evicted');
  assert.ok(snap.caches[`c${cap + 1}`], 'newest aggregate is present');
  // Global counters keep every hit — eviction never rolls them back.
  assert.equal(snap.global.hits, cap + 2);
  assert.equal(snapshotAll().global.openingCacheHits, cap + 2);
});

// ---------------------------------------------------------------------------
// agent/observabilityHooks.mjs
// ---------------------------------------------------------------------------

await test('agent hooks: createHookContext freezes the shape', () => {
  const ctx = createHookContext({ session_uuid: 's1', model: 'gpt-x', request_id: 'r1', prompt_version: 'v3' });
  assert.equal(ctx.session_uuid, 's1');
  assert.equal(ctx.model, 'gpt-x');
  assert.equal(ctx.request_id, 'r1');
  assert.equal(ctx.prompt_version, 'v3');
  assert.equal(Object.isFrozen(ctx), true);
});

await test('agent hooks: onTurnStart emits debug log with required fields', () => {
  const sink = collectSink();
  try {
    const ctx = createHookContext({ session_uuid: 's1' });
    const timer = onTurnStart(ctx);
    assert.ok(timer && typeof timer.startedAt === 'number');
    assert.equal(sink.lines.length, 1);
    const parsed = JSON.parse(sink.lines[0]);
    assert.equal(parsed.event, 'agent.turn.start');
    assert.equal(parsed.level, 'debug');
    assert.equal(parsed.session_uuid, 's1');
    assert.equal(parsed.component, 'agent');
  } finally {
    sink.restore();
  }
});

await test('agent hooks: onTurnSuccess emits success log and aggregates tokens', () => {
  const sink = collectSink();
  _resetMetricsForTests();
  try {
    const ctx = createHookContext({ session_uuid: 's1', model: 'm1', request_id: 'r1' });
    onTurnSuccess({
      hookCtx: ctx,
      timer: { startedAt: Date.now() - 12 },
      usage: { in_tokens: 30, out_tokens: 9, cache_read_input_tokens: 12, model: 'm1', prompt_version: 'v1' },
      result: { tool_calls: [] },
      truncated: false,
      retry: false,
    });
    const parsed = JSON.parse(sink.lines.find((l) => l.includes('agent.turn.success')));
    assert.equal(parsed.event, 'agent.turn.success');
    assert.equal(parsed.in_tokens, 30);
    assert.equal(parsed.out_tokens, 9);
    assert.equal(parsed.cache_read_tokens, 12);
    assert.equal(parsed.kind, 'narrative');
    const s = snapshotSession('s1');
    assert.equal(s.agentTurns, 1);
    assert.equal(s.cacheReadTokens, 12);
  } finally {
    sink.restore();
  }
});

await test('agent hooks: onTurnFailure emits warn log + failure counter', () => {
  const sink = collectSink();
  _resetMetricsForTests();
  try {
    const ctx = createHookContext({ session_uuid: 's1' });
    onTurnFailure({ hookCtx: ctx, error: { code: 'provider_failure', message: 'upstream 502' } });
    const parsed = JSON.parse(sink.lines.find((l) => l.includes('agent.turn.failure')));
    assert.equal(parsed.event, 'agent.turn.failure');
    assert.equal(parsed.level, 'warn');
    assert.equal(parsed.error_code, 'provider_failure');
    const s = snapshotSession('s1');
    assert.equal(s.agentFailures, 1);
  } finally {
    sink.restore();
  }
});

await test('agent hooks: onToolDispatched records tool_name', () => {
  const sink = collectSink();
  _resetMetricsForTests();
  try {
    const ctx = createHookContext({ session_uuid: 's1' });
    onToolDispatched({ hookCtx: ctx, toolCall: { name: 'ask_player_choice', tool_call_id: 't1' } });
    const s = snapshotSession('s1');
    assert.equal(s.toolCalls, 1);
    assert.equal(s.lastToolName, 'ask_player_choice');
  } finally {
    sink.restore();
  }
});

await test('agent hooks: applyOutputLimits flags truncated when above caps', () => {
  const limits = applyOutputLimits({
    session_uuid: 's1',
    usage: { in_tokens: 5, out_tokens: 2000 },
    result: { messages: [] },
  });
  assert.equal(limits.truncated, true);
  const ok = applyOutputLimits({
    session_uuid: 's1',
    usage: { in_tokens: 5, out_tokens: 100 },
    result: { messages: [] },
  });
  assert.equal(ok.truncated, false);
  assert.equal(PROVIDER_USAGE.out_tokens_max, 1024);
});

await test('agent hooks: observeProviderCall wraps full lifecycle without mutating', async () => {
  const sink = collectSink();
  _resetMetricsForTests();
  try {
    const ctx = createHookContext({ session_uuid: 's1', model: 'm1' });
    const result = await observeProviderCall({
      hookCtx: ctx,
      provider: async () => ({ messages: [{ role: 'assistant', content: 'hi' }], usage: { in_tokens: 4, out_tokens: 2, cache_read_input_tokens: 0 } }),
      request: { foo: 'bar' },
    });
    assert.ok(result && Array.isArray(result.messages));
    const events = sink.lines.map((l) => JSON.parse(l).event);
    assert.ok(events.includes('agent.turn.start'));
    assert.ok(events.includes('agent.turn.success'));
    const s = snapshotSession('s1');
    assert.equal(s.agentTurns, 1);
  } finally {
    sink.restore();
  }
});

await test('agent hooks: observeProviderCall records failure on throw', async () => {
  const sink = collectSink();
  _resetMetricsForTests();
  try {
    const ctx = createHookContext({ session_uuid: 's1' });
    await assert.rejects(() => observeProviderCall({
      hookCtx: ctx,
      provider: async () => { throw new Error('boom'); },
      request: {},
    }));
    const s = snapshotSession('s1');
    assert.equal(s.agentFailures, 1);
    const events = sink.lines.map((l) => JSON.parse(l).event);
    assert.ok(events.includes('agent.turn.failure'));
  } finally {
    sink.restore();
  }
});

// ---------------------------------------------------------------------------
// stories/observabilityHooks.mjs
// ---------------------------------------------------------------------------

await test('stories hooks: onSessionCreate logs + observes session', () => {
  const sink = collectSink();
  _resetMetricsForTests();
  try {
    const ctx = createStoriesHookContext({ session_uuid: 's1', cache_uuid: 'c1', story_uuid: 'st1', story_version_uuid: 'sv1', state: 'opening' });
    onSessionCreate(ctx);
    const s = snapshotSession('s1');
    assert.ok(s);
    assert.equal(s.lastState, 'opening');
    const parsed = JSON.parse(sink.lines.find((l) => l.includes('session.create')));
    assert.equal(parsed.event, 'session.create');
  } finally {
    sink.restore();
  }
});

await test('stories hooks: onOpeningCommit records commit latency', () => {
  const sink = collectSink();
  _resetMetricsForTests();
  try {
    const ctx = createStoriesHookContext({ session_uuid: 's1' });
    onOpeningCommit({ hookCtx: ctx, event: { sequence: 0, type: 'narration' }, latency_ms: 7 });
    const s = snapshotSession('s1');
    assert.equal(s.commitLatency.count, 1);
  } finally {
    sink.restore();
  }
});

await test('stories hooks: onOpeningCommit without latency records no fake 0ms sample', () => {
  const sink = collectSink();
  _resetMetricsForTests();
  try {
    const ctx = createStoriesHookContext({ session_uuid: 's1' });
    onOpeningCommit({ hookCtx: ctx, event: { sequence: 0, type: 'narration' }, latency_ms: null });
    const s = snapshotSession('s1');
    // The commit is still attributed to the session record, but a
    // missing latency must not land in the histogram as a 0ms sample
    // (it would pollute le_50 and depress commitLatency.sum).
    assert.ok(s, 'commit still touches the session record');
    assert.equal(s.commitLatency.count, 0, 'no latency sample recorded');
    assert.equal(s.commitLatency.le_50, 0, 'le_50 bucket stays clean');
    // The event log is still emitted.
    const parsed = JSON.parse(sink.lines.find((l) => l.includes('session.opening.commit')));
    assert.equal(parsed.event, 'session.opening.commit');
  } finally {
    sink.restore();
  }
});

await test('stories hooks: onInterrupt transitions to realtime', () => {
  const sink = collectSink();
  _resetMetricsForTests();
  try {
    const ctx = createStoriesHookContext({ session_uuid: 's1' });
    onInterrupt({ hookCtx: ctx, text_length: 42, latency_ms: 12 });
    const s = snapshotSession('s1');
    assert.equal(s.realtimeTransitions, 1);
    assert.equal(s.lastState, 'realtime');
  } finally {
    sink.restore();
  }
});

await test('stories hooks: onOpeningCacheHit increments hit counter', () => {
  _resetMetricsForTests();
  _resetCacheStatsForTests();
  const ctx = createStoriesHookContext({ session_uuid: 's1', cache_uuid: 'c1', story_uuid: 'st1', story_version_uuid: 'sv1', generation_hash: 'h1' });
  onOpeningCacheHit(ctx);
  const s = snapshotSession('s1');
  assert.equal(s.openingCacheHits, 1);
  const snap = cacheSnapshotAll();
  assert.equal(snap.caches.c1.hits, 1);
});

await test('stories hooks: onOpeningCacheMiss increments miss counter', () => {
  _resetMetricsForTests();
  _resetCacheStatsForTests();
  const ctx = createStoriesHookContext({ session_uuid: 's1' });
  onOpeningCacheMiss(ctx, 'test reason');
  const snap = cacheSnapshotAll();
  assert.equal(snap.global.misses, 1);
});

await test('stories hooks: onStateTransition ignores unknown states', () => {
  _resetMetricsForTests();
  const ctx = createStoriesHookContext({ session_uuid: 's1' });
  onStoriesStateTransition({ hookCtx: ctx, from_state: 'opening', to_state: 'no_such_state' });
  // Unknown states must short-circuit BEFORE touching the session store,
  // so the session record is never created.
  assert.equal(snapshotSession('s1'), null);
});

await test('stories hooks: onCompact bumps compact count', () => {
  _resetMetricsForTests();
  const ctx = createStoriesHookContext({ session_uuid: 's1' });
  onCompact(ctx);
  const s = snapshotSession('s1');
  assert.equal(s.compactCount, 1);
});

// ---------------------------------------------------------------------------
// Cross-module acceptance: fixed demo paths produce cache hits
// ---------------------------------------------------------------------------

await test('acceptance: cache hit path provably produces no realtime tokens', () => {
  _resetMetricsForTests();
  _resetCacheStatsForTests();
  const ctx = createStoriesHookContext({
    session_uuid: 'demo-session',
    cache_uuid: 'cafe-rain-cache',
    story_uuid: 'cafe-rain-uuid',
    story_version_uuid: 'cafe-rain-version',
    generation_hash: 'cafe-rain-hash',
  });
  onSessionCreate(ctx);
  onOpeningCacheHit(ctx);
  onOpeningCommit({ hookCtx: ctx, latency_ms: 3 });
  const s = snapshotSession('demo-session');
  assert.equal(s.openingCacheHits, 1);
  assert.equal(s.agentTurns, 0);
  assert.equal(s.inTokens, 0);
  assert.equal(s.outTokens, 0);
  const snap = cacheSnapshotAll();
  assert.equal(snap.caches['cafe-rain-cache'].hits, 1);
});

// Reset state after the suite so the next test file in the same
// process starts from a clean slate. `_reset*` are exported precisely
// for this reason; subsequent suites can be added without touching
// them.
_resetLoggerForTests();
_resetMetricsForTests();
_resetCacheStatsForTests();

console.log('\n# observability suite passed');
