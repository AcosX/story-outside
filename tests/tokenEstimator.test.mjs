// tests/tokenEstimator.test.mjs — unit tests for the pluggable token
// estimator introduced for Story 10 (long-context compact).
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

const { countCjkChars, analyzeText, stringTokenEstimate, walkValue } = __testing;

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

test('countCjkChars: counts CJK Extension B via code points (surrogate pairs)', () => {
  // U+20000 (𠀀) is the first CJK Ext B ideograph. It is encoded as a
  // surrogate pair, so a charCodeAt-based scan can never see it — the
  // implementation must iterate code points.
  assert.equal(countCjkChars('\u{20000}'), 1); // 𠀀
  assert.equal(countCjkChars('\u{2A6DF}'), 1); // last char of the Ext B block
  assert.equal(countCjkChars('a\u{20000}b'), 1); // mixed with latin
  assert.equal(countCjkChars('汉\u{20000}'), 2); // BMP CJK + Ext B CJK
  assert.equal(countCjkChars('\u{2B000}'), 0); // U+2B000 is Extension C — out of range
  assert.equal(countCjkChars('\uD800'), 0); // lone high surrogate is not a character
  assert.equal(countCjkChars('\uDC00\uD800'), 0); // lone surrogates are not counted
});

test('analyzeText: splits CJK code points from remaining UTF-16 units', () => {
  assert.deepEqual(analyzeText('a\u{20000}b'), { cjk: 1, otherUnits: 2 });
  assert.deepEqual(analyzeText('汉字'), { cjk: 2, otherUnits: 0 });
  assert.deepEqual(analyzeText('abcd'), { cjk: 0, otherUnits: 4 });
});

test('stringTokenEstimate: astral CJK chars count as CJK, not as latin units', () => {
  // 𠀀𠀀𠀀 = 3 Ext B ideographs → 3 tokens (old surrogate-blind scan
  // counted 6 latin units → ceil(6/4) = 2 tokens — an underestimate).
  assert.equal(stringTokenEstimate('\u{20000}\u{20000}\u{20000}'), 3);
  // 1 BMP CJK + 3 Ext B CJK = 4 tokens (surrogate units must not leak into
  // the latin bucket).
  assert.equal(stringTokenEstimate('汉\u{20000}\u{20000}\u{20000}'), 4);
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

test('createTokenEstimator: estimate walks the value as-is (no stringify/parse round-trip)', () => {
  // The estimator must receive the ORIGINAL value, not a JSON round-tripped
  // clone. The old safe() did JSON.parse(canonicalJsonStringify(value)) on
  // every call — a wasteful full-payload copy for large contexts.
  const sentinel = { recent_events: [{ text: 'original reference' }] };
  const est = createTokenEstimator({
    model: 'openai/gpt-4o',
    estimator: (value) => (value === sentinel ? 7 : 0),
  });
  assert.equal(est.estimate(sentinel), 7, 'estimator must observe the original value reference');
});
