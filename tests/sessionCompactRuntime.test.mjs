import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSeededRepository } from '../src/stories/fixture.mjs';
import { ensureOpeningCache } from '../src/stories/storyService.mjs';
import {
  createSession, getSession, getSessionCompact, interruptWithPlayerInput,
  listSessionEvents, exportSessionPersistenceSnapshot, hydrateSessionPersistence,
  discardPendingTail,
} from '../src/stories/sessionService.mjs';
import { createAgentRuntime, runTurn } from '../src/agent/runtime.mjs';
import { createAIProvider } from '../src/agent/aiProvider.mjs';

const config = { apiKey: 'test-secret', baseURL: 'https://example.invalid/v1', model: 'test-model', timeoutMs: 1000, contextChars: 1000, maxRetries: 0 };
async function fixture() {
  const { repository, fixtures } = createSeededRepository();
  const story = fixtures.find(item => item.slug === 'cafe-rain');
  const { cache } = await ensureOpeningCache({ repository, story_version_uuid: story.story_version_uuid });
  const identity = { repository, session_uuid: randomUUID() };
  createSession({ ...identity, story_uuid: story.story_uuid, story_version_uuid: story.story_version_uuid,
    user_ref: 'compact-test', role_id: 'stranger', model: config.model, prompt: 'test',
    generation_profile: { ...cache.generation_profile, cache_uuid: cache.cache_uuid } });
  appendInputs(identity, 20);
  return identity;
}
function appendInputs(identity, count) {
  for (let i = 0; i < count; i++) {
    const revision = getSession(identity).revision;
    interruptWithPlayerInput({ ...identity, text: `玩家决定 ${revision}: 保留因果和选择`, expected_revision: revision });
  }
}
function run(identity, provider, request_id = randomUUID()) {
  const session = getSession(identity);
  const runtime = createAgentRuntime({ ...identity, provider, system_prompt: {}, tool_definitions: [],
    expected_story_version_uuid: session.story_version_uuid, expected_story_version_checksum: session.story_version_checksum,
    expected_model: session.model, expected_generation_profile: session.generation_profile });
  return runTurn(runtime, { request_id, input: { text: '继续' }, expected_revision: session.revision });
}
function ai(handler) {
  const requests = [];
  const provider = createAIProvider({ config, story: { text: '完整原作'.repeat(500) }, fetchImpl: async (_url, opts) => {
    const messages = JSON.parse(opts.body).messages;
    const compact = messages[0].content.includes('事实摘要');
    const payload = JSON.parse(messages[1].content);
    requests.push({ compact, payload });
    const result = handler ? await handler({ compact, payload }) : compact ? { summary: '保留玩家选择，event_seq=1' } : { items: [{ text: '继续剧情' }, { text: '夜色渐深。' }, { text: '远处传来钟声。' }] };
    if (!compact && payload.story_pacing?.must_finish && result.items) result.tool_call = { name: 'finish_story', arguments: { summary: '旅程结束', ending: '重逢', original_difference: '留下', key_choices: ['留下'], character_outcomes: [{ character: '友人', fate: '重逢' }] } };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] }) };
  } });
  return { provider, requests };
}

// Real provider HTTP payload, canonical player inputs, single-flight, replay,
// and the same export/hydrate contract used by the MariaDB adapter.
const identity = await fixture();
const history = listSessionEvents(identity);
const first = ai();
const id = randomUUID();
const [a, b] = await Promise.all([run(identity, first.provider, id), run(identity, first.provider, id)]);
assert.equal(a.turn_id, b.turn_id);
assert.equal(first.requests.filter(r => r.compact).length, 1);
assert.deepEqual(first.requests[0].payload.new_committed_events, history.slice(0, 4));
assert.deepEqual(first.requests[1].payload.committed_history, history.slice(4));
assert.deepEqual(listSessionEvents(identity), history);
const saved = getSessionCompact(identity);
assert.equal(saved.compacted_through_seq, history[3].event_seq);
assert.equal(saved.last_compact_status, 'compacted');
assert.equal(saved.context_compact_text, first.requests[1].payload.committed_summary);
const row = exportSessionPersistenceSnapshot(identity.repository)[0];
assert.deepEqual(row.runtime_payload.compact_history[0].folded_event_seqs, history.slice(0, 4).map(e => e.event_seq));
const restored = { repository: createSeededRepository().repository, session_uuid: identity.session_uuid };
hydrateSessionPersistence({ repository: restored.repository, row, history: row.history, runtime_payload: row.runtime_payload });
const afterRestart = ai();
assert.deepEqual(await run(restored, afterRestart.provider, id), a);
assert.equal(afterRestart.requests.length, 0, 'replay after hydrate must not call AI');
discardPendingTail(restored);
await run(restored, afterRestart.provider);
assert.equal(afterRestart.requests.length, 1, 'persisted summary reused without regeneration');
assert.equal(afterRestart.requests[0].payload.committed_summary, saved.context_compact_text);
assert.deepEqual(afterRestart.requests[0].payload.committed_history, history.slice(4));
appendInputs(restored, 16);
const extended = ai();
await run(restored, extended.provider);
assert.equal(extended.requests[0].payload.previous_summary, saved.context_compact_text);
assert.deepEqual(extended.requests[0].payload.new_committed_events, listSessionEvents(restored).slice(4, 20));
assert.equal(getSessionCompact(restored).compacted_through_seq, 20);
assert.equal(exportSessionPersistenceSnapshot(restored.repository)[0].runtime_payload.compact_history.length, 2);

// Invalid compaction leaves previous summary/cursor intact, records a sanitized
// failure, and never stages speculative narrative. Retry can then advance it.
appendInputs(restored, 16);
const beforeFailure = getSessionCompact(restored);
const invalid = ai(({ compact }) => compact ? { summary: '' } : { items: [{ text: 'must not be called' }] });
await assert.rejects(run(restored, invalid.provider), error => error.code === 'provider_failure' && error.retryable);
const failed = getSessionCompact(restored);
assert.equal(failed.context_compact_text, beforeFailure.context_compact_text);
assert.equal(failed.compacted_through_seq, beforeFailure.compacted_through_seq);
assert.equal(failed.last_compact_status, 'failed');
assert.equal(invalid.requests.length, 1);
assert.ok(!JSON.stringify(failed).includes(config.apiKey));
await run(restored, ai().provider);
assert.equal(getSessionCompact(restored).compacted_through_seq, 36);

// A narrative failure after successful compact must retain that paid summary;
// retry reuses it rather than buying another summary or committing any events.
{
  const current = await fixture();
  const canonical = listSessionEvents(current);
  const brokenNarrative = ai(({ compact }) => {
    if (compact) return { summary: '已成功压缩' };
    throw new Error('narrative unavailable');
  });
  await assert.rejects(run(current, brokenNarrative.provider), error => error.code === 'provider_failure');
  assert.equal(getSessionCompact(current).context_compact_text, '已成功压缩');
  assert.deepEqual(listSessionEvents(current), canonical);
  const retry = ai();
  await run(current, retry.provider);
  assert.equal(retry.requests.length, 1);
  assert.equal(retry.requests[0].payload.committed_summary, '已成功压缩');
}

// Interrupt while summarizing: a newer revision can finish its own compact;
// neither late success nor failure may overwrite its summary or audit status.
for (const rejectOld of [false, true]) {
  const current = await fixture();
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const old = ai(async ({ compact }) => {
    assert.equal(compact, true);
    started();
    await gate;
    if (rejectOld) throw new Error('old upstream failure');
    return { summary: '旧摘要不得覆盖' };
  });
  const pending = run(current, old.provider);
  const rejection = assert.rejects(pending, error => error.code === 'revision_mismatch');
  await entered;
  appendInputs(current, 1);
  const newer = ai(({ compact }) => compact ? { summary: '新摘要' } : { items: [{ text: '新剧情' }, { text: '新剧情继续。' }, { text: '新剧情暂歇。' }] });
  await run(current, newer.provider);
  const latest = getSessionCompact(current);
  release();
  await rejection;
  assert.deepEqual(getSessionCompact(current), latest);
  assert.equal(latest.context_compact_text, '新摘要');
  assert.equal(old.requests.length, 1);
  assert.equal(exportSessionPersistenceSnapshot(current.repository)[0].runtime_payload.compact_history.length, 1);
}
console.log('Session compact runtime: real provider, hydrate/replay, incremental prefix, failure and interrupt races passed');
