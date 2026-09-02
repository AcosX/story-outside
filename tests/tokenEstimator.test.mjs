// tests/tokenEstimator.test.mjs — unit tests for the pluggable token
// estimator introduced for ClickUp 10 (long-context compact).
//
// DEPENDENCY NOTE: pure module, no DB, no session. Asserts the public
// contract of `tokenEstimator.mjs` only.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MODEL_CONTEXT_WINDOWS,
  DEFAULT_SAFETY_RATIO,
  DEFAULT_RESERVED_COMPLETION_TOKENS,
  fallbackEstimateTokens,
  resolveContextWindow,
  createTokenEstimator,
  __testing,
} from '../src/agent/tokenEstimator.mjs';

const { countCjkChars, stringTokenEstimate, walkValue } = __testing;

test('default model windows are frozen and bounded', () => {
  assert.ok(Object.isFrozen(DEFAULT_MODEL_CONTEXT_WINDOWS));
  for (const [model, window] of Object.entries(DEFAULT_MODEL_CONTEXT_WINDOWS)) {
    assert.ok(Number.isInteger(window) && window > 0, `${model} window not positive int`);
    assert.ok(window <= 1_000_000, `${model} window above safety cap`);
  }
  assert.equal(DEFAULT_MODEL_CONTEXT_WINDOWS['anthropic/claude-sonnet-4.5'], 200_000);
  assert.equal(DEFAULT_MODEL_CONTEXT_WINDOWS['openai/gpt-4o'], 128_000);
});

test('safety ratio and reserved completion are sane defaults', () => {
  assert.equal(DEFAULT_SAFETY_RATIO, 0.10);
  assert.equal(DEFAULT_RESERVED_COMPLETION_TOKENS, 1024);
});

test('countCjkChars: counts CJK Unified Ideographs only', () => {
  // Implementation covers 0x4E00-0x9FFF + CJK Ext A + CJK Ext B.
  // Hiragana / Katakana / Hangul are NOT counted (they would be latin-equivalent).
  assert.equal(countCjkChars(''), 0);
  assert.equal(countCjkChars('hello'), 0);
  assert.equal(countCjkChars('汉'), 1);
  assert.equal(countCjkChars('汉汉汉'), 3);
  assert.equal(countCjkChars('あ'), 0); // Hiragana — not in CJK Unified Ideographs
  assert.equal(countCjkChars('ア'), 0); // Katakana
  assert.equal(countCjkChars('한'), 0); // Hangul
  assert.equal(countCjkChars('hello世界'), 2); // 2 CJK chars, 'hello' is latin
});

test('stringTokenEstimate: latin (4 chars/token) + CJK (1 char/token) + whitespace', () => {
  // 4 latin chars, no whitespace → 1 token
  assert.equal(stringTokenEstimate('abcd'), 1);
  // 8 latin chars, no whitespace → 2 tokens
  assert.equal(stringTokenEstimate('abcdefgh'), 2);
  // 1 CJK char → 1 token
  assert.equal(stringTokenEstimate('汉'), 1);
  // 4 CJK chars → 4 tokens
  assert.equal(stringTokenEstimate('汉字中文'), 4);
  // empty → 0
  assert.equal(stringTokenEstimate(''), 0);
  // non-string → 0
  assert.equal(stringTokenEstimate(null), 0);
  assert.equal(stringTokenEstimate(undefined), 0);
  assert.equal(stringTokenEstimate(123), 0);
});

test('fallbackEstimateTokens: handles primitives via walkValue', () => {
  assert.equal(fallbackEstimateTokens(null), 0);
  assert.equal(fallbackEstimateTokens(undefined), 0);
  assert.equal(fallbackEstimateTokens(''), 0);
  assert.equal(fallbackEstimateTokens([]), 0);
  assert.equal(fallbackEstimateTokens({}), 0);
  // numbers and booleans count as 1 token each in the walk
  assert.equal(fallbackEstimateTokens(42), 1);
  assert.equal(fallbackEstimateTokens(true), 1);
  assert.equal(fallbackEstimateTokens(false), 1);
});

test('walkValue: sums string + key overhead over an object', () => {
  // walkValue(value, sink) — second arg is a sink function
  // For { a: 'abcd', b: 'efgh' }:
  //   key 'a' (1 char) + 2 overhead = 3, value 'abcd' (4 latin) = 1 → 4
  //   key 'b' + 2 = 3, value 'efgh' = 1 → 4
  //   total = 8
  let total = 0;
  walkValue({ a: 'abcd', b: 'efgh' }, (d) => { total += d; });
  assert.equal(total, 8);
});

test('walkValue: walks arrays and string children', () => {
  // ['abcd', 'efgh', 'ijkl']
  // each: key (none for array) + value (4 latin = 1) → 1 each
  let total = 0;
  walkValue(['abcd', 'efgh', 'ijkl'], (d) => { total += d; });
  assert.equal(total, 3);
});

test('resolveContextWindow: returns default for known model', () => {
  assert.equal(resolveContextWindow('openai/gpt-4o'), 128_000);
  assert.equal(resolveContextWindow('anthropic/claude-sonnet-4.5'), 200_000);
});

test('resolveContextWindow: returns custom override', () => {
  assert.equal(resolveContextWindow('openai/gpt-4o', { window: 64_000 }), 64_000);
});

test('resolveContextWindow: returns safe default for unknown model', () => {
  const w = resolveContextWindow('totally-unknown-model-xyz');
  assert.ok(Number.isInteger(w) && w > 0);
  assert.ok(w <= 64_000, `unknown model should not get a huge default window, got ${w}`);
});

test('createTokenEstimator: returns a frozen object with the expected surface', () => {
  const est = createTokenEstimator({ model: 'openai/gpt-4o' });
  assert.ok(Object.isFrozen(est));
  assert.equal(typeof est.estimate, 'function');
  assert.equal(typeof est.contextWindow, 'function');
  assert.equal(typeof est.compactThreshold, 'function');
  assert.equal(typeof est.reservedCompletionTokens, 'function');
  assert.equal(typeof est.model, 'function');
  assert.equal(typeof est.describe, 'function');
  assert.equal(est.contextWindow(), 128_000);
  assert.equal(est.model(), 'openai/gpt-4o');
  assert.equal(est.reservedCompletionTokens(), 1024);
});

test('createTokenEstimator: threshold is window minus safety minus completion', () => {
  const est = createTokenEstimator({ model: 'openai/gpt-4o' });
  // 128000 * 0.9 = 115200, minus 1024 completion = 114176
  const expected = Math.max(1, Math.floor(128_000 * 0.9) - 1024);
  assert.equal(est.compactThreshold(), expected);
});

test('createTokenEstimator: estimate over a draft object returns finite non-negative integer', () => {
  const est = createTokenEstimator({ model: 'openai/gpt-4o' });
  const result = est.estimate({
    compact_text: 'prior summary',
    recent_events: [{ role: 'narrator', text: 'line 1' }, { role: 'narrator', text: 'line 2' }],
    input: { text: 'continue' },
  });
  assert.ok(Number.isInteger(result));
  assert.ok(result > 0);
  assert.ok(result < 200);
});

test('createTokenEstimator: estimate handles various inputs', () => {
  const est = createTokenEstimator({ model: 'openai/gpt-4o' });
  // Empty object with no walkable content → 0
  assert.equal(est.estimate({}), 0);
  // null → 0
  assert.equal(est.estimate(null), 0);
  // Non-object primitive → walkValue returns the right per-type token (number=1)
  assert.equal(est.estimate(42), 1);
});

test('createTokenEstimator: respects context window override', () => {
  const est = createTokenEstimator({ model: 'openai/gpt-4o', window: 8_192 });
  assert.equal(est.contextWindow(), 8_192);
});

test('createTokenEstimator: invalid safetyRatio falls back to default (no throw)', () => {
  // The real implementation falls back to DEFAULT_SAFETY_RATIO rather than
  // throwing — easier to integrate with the runtime path.
  const est1 = createTokenEstimator({ model: 'openai/gpt-4o', safetyRatio: 1.5 });
  assert.equal(est1.describe().safetyRatio, DEFAULT_SAFETY_RATIO);
  const est2 = createTokenEstimator({ model: 'openai/gpt-4o', safetyRatio: -0.1 });
  assert.equal(est2.describe().safetyRatio, DEFAULT_SAFETY_RATIO);
  const est3 = createTokenEstimator({ model: 'openai/gpt-4o', safetyRatio: 'high' });
  assert.equal(est3.describe().safetyRatio, DEFAULT_SAFETY_RATIO);
});

test('createTokenEstimator: window=0 falls back to default (no throw)', () => {
  const est = createTokenEstimator({ model: 'openai/gpt-4o', window: 0 });
  // window=0 is not a positive integer override → resolveContextWindow
  // returns the default (128k for gpt-4o).
  assert.equal(est.contextWindow(), 128_000);
});

test('createTokenEstimator: defaults to mock/test model when none provided', () => {
  const est = createTokenEstimator({});
  assert.equal(est.model(), 'mock/test');
  // mock/test has 8k window
  assert.equal(est.contextWindow(), 8_000);
});

test('createTokenEstimator: custom estimator function is invoked', () => {
  const est = createTokenEstimator({
    model: 'openai/gpt-4o',
    estimator: () => 42,
  });
  assert.equal(est.estimate({ recent_events: [{}] }), 42);
});

test('createTokenEstimator: describe returns frozen snapshot of settings', () => {
  const est = createTokenEstimator({ model: 'openai/gpt-4o' });
  const d = est.describe();
  assert.equal(d.window, 128_000);
  assert.equal(d.safetyRatio, 0.10);
  assert.equal(d.reservedCompletionTokens, 1024);
  assert.ok(d.threshold > 0);
  assert.ok(Object.isFrozen(d));
});

test('createTokenEstimator: estimate catches estimator errors and returns 0', () => {
  const est = createTokenEstimator({
    model: 'openai/gpt-4o',
    estimator: () => { throw new Error('boom'); },
  });
  // safe() wraps and catches — should return 0, not throw
  assert.equal(est.estimate({ recent_events: [{}] }), 0);
});
