import assert from 'node:assert/strict';
import { createAIProvider } from '../src/agent/aiProvider.mjs';
import { playerInteraction } from '../src/agent/playerInteraction.mjs';
const opening = { event_seq: 1, event_type: 'story_opening', payload: { type: 'narration', text: '林舟在门外。', text_by_role: { traveler: '我停在门外。', guard: '你守在门口。' }, text_first_person: '旧的第一人称。' } };
assert.equal(playerInteraction([opening]).awaiting_first_choice, true);
assert.equal(playerInteraction([{ ...opening, committed: false }]).awaiting_first_choice, false);
assert.equal(playerInteraction([opening, { event_type: 'player_input' }]).awaiting_first_choice, false);
assert.equal(playerInteraction([opening, { event_type: 'player_input', status: 'pending' }]).awaiting_first_choice, true);
const original = structuredClone(opening);
const requests = [];
const choice = { name: 'ask_player_choice', arguments: { question: '接下来，你想怎么做？', options: [{ id: 'ask', label: '询问来意' }, { id: 'wait', label: '等候' }] } };
const provider = createAIProvider({
 story: { first_person_role_id: 'traveler', roles: [{ id: 'traveler', label: '林舟' }, { id: 'guard', label: '门卫' }] },
 config: { apiKey: 'test', baseURL: 'https://test.invalid', model: 'test', timeoutMs: 1000, maxRetries: 1, retryBaseDelayMs: 0, retryMaxDelayMs: 0 },
 fetchImpl: async (_url, options) => {
  requests.push(JSON.parse(options.body));
  return Response.json({ choices: [{ message: { content: JSON.stringify({ arc_status: 'ongoing', items: [{ type: 'narration', text: '门外传来脚步声。' }], ...(requests.length === 1 ? {} : { tool_call: choice }) }) } }] });
 },
});
const request = { pinned: { role_id: 'guard' }, input: { kind: 'continue' }, canonical_history: [opening] };
const result = await provider.complete(request);
assert.equal(requests.length, 2, 'first choice is mandatory immediately after the cached opening');
assert.equal(result.tool_call.name, 'ask_player_choice');
assert.equal(result.items.length, 1, 'do not pad an existing choice boundary to three items');
assert.ok(requests[0].tools[0].function.parameters.required.includes('tool_call'));
for (const body of requests) {
 const context = JSON.parse(body.messages[1].content);
 for (const events of [context.committed_history, context.current_worldline_tail]) {
  assert.equal(events[0].payload.text, '你守在门口。');
  assert.equal(events[0].payload.text_by_role, undefined, 'other perspectives do not enter model history');
  assert.equal(events[0].payload.text_first_person, undefined);
  assert.equal(events[0].event_seq, 1);
 }
}
assert.deepEqual(opening, original, 'projection must never rewrite pinned cache or canonical history');
const compact = provider.contextPolicy.measure({ ...request, context: { compact_text: '门口有人。', recent_events: [opening] } });
assert.equal(JSON.parse(compact[1].content).committed_history[0].payload.text, '你守在门口。');
const firstPerson = provider.contextPolicy.measure({ ...request, pinned: { role_id: 'traveler' } });
assert.equal(JSON.parse(firstPerson[1].content).committed_history[0].payload.text, '我停在门外。');
const summaryRequests = [];
const summarizer = createAIProvider({ story: { first_person_role_id: 'traveler' },
 config: { apiKey: 'test', baseURL: 'https://test.invalid', model: 'test', timeoutMs: 1000, maxRetries: 0 },
 fetchImpl: async (_url, options) => {
  summaryRequests.push(JSON.parse(options.body));
  return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: '门卫守在门口。' }) } }] });
 },
});
await summarizer.summarize({ previous_summary: null, new_committed_events: [opening], pinned: { role_id: 'guard' } });
const summaryPayload = JSON.parse(summaryRequests[0].messages[1].content);
assert.equal(summaryPayload.player_role_id, 'guard');
assert.equal(summaryPayload.new_committed_events[0].payload.text, '你守在门口。');
assert.equal(summaryPayload.new_committed_events[0].payload.text_by_role, undefined);
assert.deepEqual(opening, original, 'summarizing keeps persisted history immutable');
console.log('Narrative scene: initial choice, role-projected full/compact context, immutable history PASS');
