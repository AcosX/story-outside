import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAIProvider } from '../src/agent/aiProvider.mjs';
import { normalizeProviderResult } from '../src/agent/runtime.mjs';

const line = text => ({ type: 'narration', text });
const choice = { name: 'ask_player_choice', arguments: {
  question: '进入吗？', options: [{ id: 'enter', label: '进入' }, { id: 'wait', label: '等待' }],
} };
const requests = [];
const provider = createAIProvider({
  config: { apiKey: 'test', baseURL: 'https://example.test/v1', model: 'test', timeoutMs: 1000,
    maxRetries: 1, retryBaseDelayMs: 0, retryMaxDelayMs: 0 },
  story: { roles: [{ id: 'self', label: '旅人' }] },
  fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    // A provider can ignore JSON-schema constraints. Do not silently keep
    // the first line and reveal a choice based on an omitted second line.
    const items = requests.length === 1 ? [line('门开了。'), line('门内有人挥手。')] : [line('门内有人挥手。')];
    return { ok: true, json: async () => ({ choices: [{ message: { tool_calls: [{ function: {
      name: 'narrate', arguments: JSON.stringify({ arc_status: 'ongoing', items, tool_call: choice }),
    } }] }, finish_reason: 'tool_calls' }] }) };
  },
});
const result = await provider.complete({ pinned: { model: 'test', role_id: 'self' }, canonical_history: [], input: { text: '继续' } });
assert.equal(requests.length, 2, 'multi-line output is retried instead of truncated');
assert.equal(result.items.length, 1);
assert.equal(result.items[0].text, '门内有人挥手。');
assert.equal(result.tool_call.name, 'ask_player_choice');
for (const body of requests) {
  assert.equal(body.tools[0].function.parameters.properties.items.minItems, 1);
  assert.equal(body.tools[0].function.parameters.properties.items.maxItems, 1);
  assert.match(body.messages[0].content, /每次只返回一句/);
  assert.match(body.messages[0].content, /不必每句都询问玩家/);
}
assert.equal(normalizeProviderResult({ items: [line('旧批次一。'), line('旧批次二。'), line('旧批次三。')] }).items.length, 3,
  'runtime remains compatible with existing multi-line batches');

const source = await readFile(new URL('../public/scripts/player.js', import.meta.url), 'utf8');
const scheduler = source.slice(source.indexOf('const STEP_DELAY_MS ='), source.indexOf('// Release a pending batch'));
const generation = source.slice(source.indexOf('function startNextBatch()'), source.indexOf('async function surfaceToolCall('));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function harness() {
  const state = { sessionUuid: 's', status: 'playing', lastRevision: 1, lastPlayerRequestId: 1,
    canonicalHistory: [], canonicalEventsById: new Map(), pending: null, pendingIdx: 0 };
  const timers = new Map(), generations = [], commits = [], displayed = [], surfaced = [];
  let timerId = 0;
  const setTimer = (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; };
  const api = (path, options) => {
    const request = { ...deferred(), body: JSON.parse(options.body) };
    if (path.endsWith('/generate')) generations.push(request);
    else if (path.endsWith('/narrative-events')) commits.push(request);
    else throw new Error(`Unexpected endpoint ${path}`);
    return request.promise;
  };
  const player = new Function('state', 'api', 'setTimeout', 'clearTimeout', 'displayed', 'surfaced', `
    const pendingNodes = new Map();
    const setGenerationStatus=()=>{}, setText=()=>{}, inOpeningPhase=()=>false, scheduleOpeningStep=()=>{};
    const registerPendingNode=(key,node)=>pendingNodes.set(key,node), clearPendingNode=key=>pendingNodes.delete(key);
    const renderPendingPlaceholder=item=>{displayed.push(item.text);return {}}, commitPendingLineInDomNode=()=>{}, commitPendingLineInDom=()=>{};
    const setProgress=()=>{},computeProgress=()=>0,$=()=>({}),setStatus=s=>{state.status=s},showToast=()=>{};
    const surfaceToolCall=async tool=>{surfaced.push(tool);state.queuedToolCall=null;state.status='awaiting-choice'};
    ${scheduler}
    ${generation}
    return {startNextBatch,runStep,scheduleNextStep};
  `)(state, api, setTimer, id => timers.delete(id), displayed, surfaced);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const tick = async () => {
    assert.equal(timers.size, 1, 'only one playback timer may be queued');
    const [id, timer] = timers.entries().next().value;
    timers.delete(id); timer.fn(); await settle(); return timer.delay;
  };
  const resolveGeneration = (index, tool = null) => generations[index].resolve({ revision: state.lastRevision,
    pending_id: `p${index}`, events: [line(`line-${index}`)], tool_call: tool });
  const resolveCommit = (index, tool = null) => commits[index].resolve({ revision: state.lastRevision + 1,
    event: { event_id: `e${index}`, event_type: 'narrative_beat', payload: line(`line-${index}`) }, pending_tool_call: tool });
  return { state, player, timers, generations, commits, displayed, surfaced, settle, tick, resolveGeneration, resolveCommit };
}
{
  const h = harness();
  const first = h.player.startNextBatch();
  assert.equal(h.generations.length, 1);
  assert.deepEqual(h.displayed, []);
  h.resolveGeneration(0); await first;
  assert.deepEqual(h.displayed, ['line-0'], 'first line renders as soon as its generation returns');
  assert.equal(await h.tick(), 0, 'no playback delay before committing the visible line');
  assert.equal(h.commits.length, 1);
  assert.equal(h.generations.length, 1, 'next generation must wait for durable commit');
  assert.equal(h.timers.size, 0);
  h.resolveCommit(0); await h.settle();
  assert.equal(await h.tick(), 0, 'no extra 1100ms between durable commit and next generation');
  assert.equal(h.generations.length, 2);
  assert.equal(h.generations[1].body.expected_revision, 2);
  assert.notEqual(h.generations[1].body.request_id, h.generations[0].body.request_id);
  assert.deepEqual(h.displayed, ['line-0'], 'first line stays readable while second generation is blocked');
  h.resolveGeneration(1, choice); await h.settle();
  assert.deepEqual(h.displayed, ['line-0', 'line-1']);
  assert.equal(await h.tick(), 0);
  h.resolveCommit(1, choice); await h.settle();
  assert.equal(h.generations.length, 2, 'do not generate past a choice');
  await h.tick();
  assert.equal(h.surfaced.length, 1);
  assert.equal(h.timers.size, 0);
}
{
  const h = harness();
  const first = h.player.startNextBatch();
  h.resolveGeneration(0); await first;
  await h.tick();
  h.state.status = 'paused';
  h.resolveCommit(0); await h.settle();
  assert.equal(h.generations.length, 1, 'pause during commit stops the next request');
  assert.equal(h.timers.size, 0);
  h.state.status = 'playing'; h.player.scheduleNextStep();
  assert.equal(await h.tick(), 0);
  assert.equal(h.generations.length, 2, 'resume continues after the committed line');
  h.state.status = 'paused'; h.resolveGeneration(1); await h.settle();
  assert.equal(h.timers.size, 0, 'paused generation response cannot restart autoplay');
}
{
  const h = harness();
  h.state.pending = { pending_id: 'legacy', events: [line('旧一。'), line('旧二。')], committed_count: 0 };
  h.player.scheduleNextStep();
  assert.equal([...h.timers.values()][0].delay, 1100, 'recovered multi-line batches retain reading pace');
  h.state.inputInFlight = true;
  await h.tick();
  assert.equal(h.commits.length, 0, 'queued playback cannot race a player interrupt');
  assert.equal(h.generations.length, 0);
}
{
  const h = harness();
  const first = h.player.startNextBatch();
  h.resolveGeneration(0, choice); await first; await h.tick();
  h.state.status = 'paused';
  h.resolveCommit(0, choice); await h.settle();
  assert.equal(h.timers.size, 0, 'pause/save failure during acceptance must not reveal a tool in the background');
  assert.equal(h.state.queuedToolCall.name, 'ask_player_choice');
  h.state.status = 'playing'; await h.player.runStep();
  assert.equal(h.surfaced.length, 1);
  assert.equal(h.generations.length, 1);
}
console.log('Single-line generation: schema enforcement, legacy replay, immediate display/commit/continuation, pause and choice ordering PASS');
