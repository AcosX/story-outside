// tests/contextBuilder.test.mjs — unit tests for the long-context compact
// pipeline introduced for ClickUp 10.
//
// DEPENDENCY NOTE: pure module. No DB, no sessionService, no provider.
// Asserts the public contract of `contextBuilder.mjs` as it actually is.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  selectCompactWindow,
  buildCompactSummary,
  renderCompactSummary,
  assembleContext,
  __testing,
} from '../src/agent/contextBuilder.mjs';

const {
  KEPT_RECENT_DEFAULT,
  KEPT_RECENT_MIN,
  KEPT_RECENT_MAX,
  EVENT_TYPES_THAT_NEVER_COMPACT,
  isEventProtected,
  projectForCompact,
  fallbackEstimateTokens,
} = __testing;

function makeEvent({ event_seq, event_type, text }) {
  return {
    event_seq,
    event_id: '00000000-0000-4000-8000-' + String(event_seq).padStart(12, '0'),
    session_uuid: '11111111-1111-4111-8111-111111111111',
    event_type,
    text: text || null,
    speaker: null,
    role_id: null,
    payload: text ? { type: event_type, text } : { type: event_type },
    source: 'opening_cache',
    revision: event_seq,
    occurred_at: new Date(2026, 8, 1, 0, 0, event_seq).toISOString(),
    created_at: new Date(2026, 8, 1, 0, 0, event_seq).toISOString(),
  };
}

test('isEventProtected: ask_player_choice and player_input always protected', () => {
  assert.equal(isEventProtected({ event_type: 'ask_player_choice' }), true);
  assert.equal(isEventProtected({ event_type: 'player_input' }), true);
  assert.equal(isEventProtected({ event_type: 'narrative' }), false);
  assert.equal(isEventProtected({ event_type: 'agent_message' }), false);
  assert.equal(isEventProtected(null), true);
  assert.equal(isEventProtected(undefined), true);
  assert.equal(isEventProtected({}), false); // no type info → not protected
});

test('isEventProtected: payload.type fallback honored when event_type absent', () => {
  // No event_type at all → falls through to payload.type
  assert.equal(isEventProtected({ payload: { type: 'ask_player_choice' } }), true);
  assert.equal(isEventProtected({ payload: { type: 'player_input' } }), true);
  // event_type wins over payload.type when both present (current contract)
  assert.equal(isEventProtected({ event_type: 'narrative', payload: { type: 'ask_player_choice' } }), false);
});

test('EVENT_TYPES_THAT_NEVER_COMPACT contains the right entries', () => {
  assert.ok(EVENT_TYPES_THAT_NEVER_COMPACT.has('ask_player_choice'));
  assert.ok(EVENT_TYPES_THAT_NEVER_COMPACT.has('player_input'));
  assert.ok(!EVENT_TYPES_THAT_NEVER_COMPACT.has('narrative'));
  assert.ok(!EVENT_TYPES_THAT_NEVER_COMPACT.has('agent_message'));
});

test('selectCompactWindow: empty history returns selected=[], next_through_seq=-1', () => {
  const result = selectCompactWindow([], { kept_recent: 8 });
  assert.equal(result.selected.length, 0);
  assert.equal(result.kept_recent.length, 0);
  // Empty history: no events to compact, so through_seq is sentinel (-1)
  assert.equal(result.next_through_seq, -1);
  assert.equal(result.skipped_protected, 0);
});

test('selectCompactWindow: small history all goes to kept_recent', () => {
  // When history length <= kept_recent, every event is kept recent
  const events = [
    makeEvent({ event_seq: 1, event_type: 'narrative' }),
    makeEvent({ event_seq: 2, event_type: 'narrative' }),
    makeEvent({ event_seq: 3, event_type: 'narrative' }),
  ];
  const result = selectCompactWindow(events, { kept_recent: 8 });
  assert.equal(result.selected.length, 0);
  assert.equal(result.kept_recent.length, 3);
  assert.equal(result.next_through_seq, -1); // nothing compacted
});

test('selectCompactWindow: big history → older part selected, last N kept_recent', () => {
  const events = Array.from({ length: 20 }, (_, i) =>
    makeEvent({ event_seq: i + 1, event_type: 'narrative', text: `event ${i + 1}` }),
  );
  const result = selectCompactWindow(events, { kept_recent: 5 });
  // 20 - 5 = 15 selected, 5 kept_recent
  assert.equal(result.selected.length, 15);
  assert.equal(result.kept_recent.length, 5);
  assert.equal(result.next_through_seq, 15);
  assert.equal(result.kept_recent[0].event_seq, 16);
  assert.equal(result.kept_recent[4].event_seq, 20);
});

test('selectCompactWindow: ask_player_choice stops compact window', () => {
  const events = [
    makeEvent({ event_seq: 1, event_type: 'narrative', text: 'a' }),
    makeEvent({ event_seq: 2, event_type: 'narrative', text: 'b' }),
    makeEvent({ event_seq: 3, event_type: 'narrative', text: 'c' }),
    makeEvent({ event_seq: 4, event_type: 'narrative', text: 'd' }),
    makeEvent({ event_seq: 5, event_type: 'ask_player_choice' }),
    makeEvent({ event_seq: 6, event_type: 'player_input' }),
    makeEvent({ event_seq: 7, event_type: 'narrative', text: 'after choice' }),
  ];
  const result = selectCompactWindow(events, { kept_recent: 2 });
  // Compact stops before seq 5
  assert.equal(result.next_through_seq, 4);
  // Recent = last 2 (seq 6, 7)
  assert.equal(result.kept_recent.length, 2);
  assert.equal(result.kept_recent[0].event_seq, 6);
  assert.equal(result.kept_recent[1].event_seq, 7);
  // skipped_protected counts the protected events we passed over
  assert.ok(result.skipped_protected >= 1);
});

test('selectCompactWindow: respects already-compacted compacted_through_seq', () => {
  const events = Array.from({ length: 10 }, (_, i) =>
    makeEvent({ event_seq: i + 1, event_type: 'narrative' }),
  );
  const result = selectCompactWindow(events, { kept_recent: 3, compacted_through_seq: 4 });
  assert.equal(result.selected.length, 3);
  assert.equal(result.selected[0].event_seq, 5);
  assert.equal(result.selected[2].event_seq, 7);
  assert.equal(result.next_through_seq, 7);
  assert.equal(result.kept_recent.length, 3);
  assert.equal(result.kept_recent[0].event_seq, 8);
});

test('selectCompactWindow: respects KEPT_RECENT_MIN even when caller passes 0', () => {
  const events = Array.from({ length: 100 }, (_, i) =>
    makeEvent({ event_seq: i + 1, event_type: 'narrative' }),
  );
  const result = selectCompactWindow(events, { kept_recent: 0 });
  assert.ok(result.kept_recent.length >= KEPT_RECENT_MIN);
});

test('selectCompactWindow: clamps kept_recent above MAX', () => {
  const events = Array.from({ length: 200 }, (_, i) =>
    makeEvent({ event_seq: i + 1, event_type: 'narrative' }),
  );
  const result = selectCompactWindow(events, { kept_recent: 1000 });
  assert.ok(result.kept_recent.length <= KEPT_RECENT_MAX);
});

test('selectCompactWindow: KEPT_RECENT_DEFAULT is in valid range', () => {
  assert.ok(KEPT_RECENT_DEFAULT >= KEPT_RECENT_MIN);
  assert.ok(KEPT_RECENT_DEFAULT <= KEPT_RECENT_MAX);
});

test('buildCompactSummary: produces structured payload with sections', () => {
  const events = [
    makeEvent({ event_seq: 1, event_type: 'narrative', text: 'opened cafe in the rain' }),
    makeEvent({ event_seq: 2, event_type: 'narrative', text: 'met a stranger' }),
    makeEvent({ event_seq: 3, event_type: 'ask_player_choice' }),
  ];
  const summary = buildCompactSummary(events);
  assert.equal(summary.event_count, 3);
  assert.equal(summary.through_seq, 3);
  assert.ok(summary.sections);
  assert.ok(Array.isArray(summary.sections.facts));
  assert.ok(Array.isArray(summary.sections.relationships));
  assert.ok(Array.isArray(summary.sections.open_threads));
  assert.equal(typeof summary.schema_version, 'number');
  assert.equal(typeof summary.prompt_version, 'number');
});

test('buildCompactSummary: empty events yields summary with through_seq=0', () => {
  const summary = buildCompactSummary([]);
  assert.equal(summary.event_count, 0);
  // Real implementation returns 0 for empty input (no last event_seq)
  assert.equal(summary.through_seq, 0);
  assert.ok(summary.sections);
});

test('buildCompactSummary: extracts text from payload fallback', () => {
  const events = [
    { event_seq: 1, event_type: 'narrative', payload: { type: 'narrative', text: 'only in payload' } },
  ];
  const summary = buildCompactSummary(events);
  assert.equal(summary.event_count, 1);
});

test('renderCompactSummary: produces non-empty string for non-empty input', () => {
  const events = [
    makeEvent({ event_seq: 1, event_type: 'narrative', text: 'opened cafe in the rain' }),
    makeEvent({ event_seq: 2, event_type: 'narrative', text: 'met a stranger named Aria' }),
  ];
  const summary = buildCompactSummary(events);
  const rendered = renderCompactSummary(summary);
  assert.equal(typeof rendered, 'string');
  assert.ok(rendered.length > 0);
  // Header should mention compact + event count
  assert.ok(/compact/.test(rendered), `rendered missing compact header: ${rendered.slice(0, 200)}`);
  assert.ok(/events folded: 2/.test(rendered), `rendered missing event count: ${rendered.slice(0, 200)}`);
});

test('renderCompactSummary: empty summary produces a header with zero events', () => {
  const summary = buildCompactSummary([]);
  const rendered = renderCompactSummary(summary);
  assert.ok(/compact/.test(rendered));
  assert.ok(/events folded: 0/.test(rendered));
});

test('assembleContext: requires estimator', () => {
  assert.throws(() => assembleContext({}), /estimator/);
  assert.throws(() => assembleContext({ estimator: {} }), /estimator/);
});

test('assembleContext: returns minimal frozen payload under threshold', () => {
  const estimator = {
    estimate: () => 0,
    contextWindow: () => 128_000,
    compactThreshold: () => 100_000,
  };
  const result = assembleContext({ estimator });
  assert.ok(Object.isFrozen(result));
  assert.equal(result.decision, 'no_compact');
  assert.equal(result.folded_event_count, 0);
  assert.equal(result.tokens.window, 128_000);
  assert.equal(result.tokens.threshold, 100_000);
});

test('assembleContext: triggers compact when estimate exceeds threshold', () => {
  const events = Array.from({ length: 30 }, (_, i) =>
    makeEvent({ event_seq: i + 1, event_type: 'narrative', text: `line ${i + 1}`.repeat(50) }),
  );
  const estimator = {
    estimate: () => 999_999, // always over threshold
    contextWindow: () => 128_000,
    compactThreshold: () => 100_000,
  };
  const result = assembleContext({
    estimator,
    canonicalHistory: events,
    input: { text: 'continue' },
  });
  assert.equal(result.decision, 'compact');
  assert.ok(result.folded_event_count > 0);
  assert.ok(typeof result.compact_text === 'string' && result.compact_text.length > 0);
});

test('assembleContext: existingCompact is used for the no-compact path', () => {
  const events = [
    makeEvent({ event_seq: 1, event_type: 'narrative' }),
    makeEvent({ event_seq: 2, event_type: 'narrative' }),
  ];
  const estimator = {
    estimate: () => 0,
    contextWindow: () => 128_000,
    compactThreshold: () => 100_000,
  };
  const result = assembleContext({
    estimator,
    canonicalHistory: events,
    existingCompact: { summary_text: 'prior summary here', through_seq: 1 },
  });
  assert.equal(result.decision, 'no_compact');
  assert.equal(result.compact_text, 'prior summary here');
  assert.equal(result.compact_through_seq, 1);
});

test('assembleContext: force_compact=true always compacts even when under threshold', () => {
  const events = [
    makeEvent({ event_seq: 1, event_type: 'narrative', text: 'short' }),
  ];
  const estimator = {
    estimate: () => 1, // well under threshold
    contextWindow: () => 128_000,
    compactThreshold: () => 100_000,
  };
  const result = assembleContext({
    estimator,
    canonicalHistory: events,
    force_compact: true,
  });
  assert.equal(result.decision, 'compact');
});

test('assembleContext: envelope is preserved on the output', () => {
  const estimator = {
    estimate: () => 0,
    contextWindow: () => 128_000,
    compactThreshold: () => 100_000,
  };
  const result = assembleContext({
    estimator,
    envelope: { system_prompt: 'sys', tool_definitions: [{ name: 't' }] },
  });
  assert.equal(result.envelope.system_prompt, 'sys');
  assert.equal(result.envelope.tool_definitions.length, 1);
});

test('assembleContext: throws on null/undefined/non-object args', () => {
  assert.throws(() => assembleContext(null), /args/);
  assert.throws(() => assembleContext(undefined), /args/);
  assert.throws(() => assembleContext('not an object'), /args/);
});

test('assembleContext: schema_version and prompt_version are stringified', () => {
  const estimator = {
    estimate: () => 0,
    contextWindow: () => 128_000,
    compactThreshold: () => 100_000,
  };
  const result = assembleContext({ estimator });
  assert.equal(typeof result.schema_version, 'string');
  assert.equal(typeof result.prompt_version, 'string');
});

test('projectForCompact: returns a projection of the event', () => {
  const event = makeEvent({ event_seq: 1, event_type: 'narrative', text: 'line' });
  const projected = projectForCompact(event);
  assert.ok(projected);
  assert.ok(typeof projected === 'object');
});
