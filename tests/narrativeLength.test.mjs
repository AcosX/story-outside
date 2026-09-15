import assert from 'node:assert/strict';
import { createAIProvider } from '../src/agent/aiProvider.mjs';
import { normalizeProviderResult } from '../src/agent/runtime.mjs';
const choice = { name: 'ask_player_choice', arguments: { question: '接下来，你想怎么做？', options: [{ id: 'enter', label: '进入' }, { id: 'wait', label: '等待' }] } };
const batch = texts => ({ arc_status: 'ongoing', items: texts.map(text => ({ type: 'narration', text })), tool_call: structuredClone(choice) });
const request = { pinned: { model: 'test', role_id: 'self' }, canonical_history: [], input: { text: '继续' } };
function harness(outputs) {
  const requests = [];
  const provider = createAIProvider({ config: { apiKey: 'test', baseURL: 'https://example.test/v1', model: 'test', timeoutMs: 1000, maxRetries: 1, retryBaseDelayMs: 0, retryMaxDelayMs: 0 }, story: { roles: [{ id: 'self' }] }, fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const result = outputs[Math.min(requests.length - 1, outputs.length - 1)];
    return { ok: true, json: async () => ({ choices: [{ message: { tool_calls: [{ function: { name: 'narrate', arguments: JSON.stringify(result) } }] }, finish_reason: 'tool_calls' }] }) };
  } });
  return { requests, run: () => provider.complete(structuredClone(request)) };
}
const short = batch(['门开了。', '灯亮了。', '脚步声停在门内。']);
for (const tooLong of [batch(['风'.repeat(81), '门开了。', '灯亮了。']), batch(Array(5).fill('风'.repeat(50)))]) {
  const h = harness([tooLong, short]);
  const result = await h.run();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(result.items, short.items, 'return complete rewritten prose, never a truncated candidate');
  assert.deepEqual(result.tool_call.arguments, choice.arguments);
  assert.match(h.requests[1].messages.at(-1).content, /最多240字/);
}
for (const character of ['风', '𠮷']) {
  const exact = batch(Array(3).fill(character.repeat(80)));
  const h = harness([exact]);
  assert.deepEqual((await h.run()).items, exact.items);
  assert.equal(h.requests.length, 1, '80 codepoints per item and 240 per batch are accepted');
}
const legacy = batch(['风'.repeat(150), '门开了。', '灯亮了。']);
const exhausted = harness([legacy]);
await assert.rejects(exhausted.run(), error => error.code === 'invalid_response');
assert.equal(exhausted.requests.length, 2, 'overlength retry is bounded');
assert.equal(normalizeProviderResult({ items: legacy.items }).items[0].text.length, 150, 'stored long prose remains replayable');
console.log('Narrative length: per-item/total limits, rewrite, choice preservation, Unicode, bounded failure, legacy replay PASS');
