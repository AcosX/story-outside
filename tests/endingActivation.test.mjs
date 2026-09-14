import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { encodeRuntimePayload, decodeRuntimePayload } from '../src/db/runtimePayloadCodec.mjs';
import { storyPacing } from '../src/agent/storyPacing.mjs';
import { createOfficialSearchSource, createOfficialKnowledgeSource } from '../src/providers/ecosystem/officialSources.mjs';
import { groundedComparison } from '../src/stories/endingService.mjs';
import { createSeededRepository, ensureOpeningCache, createSession, stageNarrativeBatch, commitNarrativeEvent, interruptWithPlayerInput, getSession } from '../src/stories/index.mjs';
import { executeToolCall } from '../src/agent/tools.mjs';
import { exportSessionPersistenceSnapshot, hydrateSessionPersistence } from '../src/stories/sessionService.mjs';

const replay = { state: 'realtime', requestIds: Array.from({ length: 400 }, (_, i) => [String(i), { result: { text: '保留幂等结果与指纹'.repeat(30) }, fingerprint: String(i) }]), turnRequests: [], compact_history: [] };
const encoded = encodeRuntimePayload(replay);
assert.ok(JSON.stringify(encoded).length < JSON.stringify(replay).length / 3);
assert.deepEqual(decodeRuntimePayload(encoded), replay);
assert.deepEqual(decodeRuntimePayload(replay), replay);
assert.throws(() => decodeRuntimePayload({ replay_cache: { codec: 'unknown', data: '' } }));
assert.throws(() => decodeRuntimePayload({ replay_cache: { codec: 'gzip-json-v1', data: 'broken' } }));
assert.equal(storyPacing([], { text: '请尽快结束游戏。' }).must_finish, true);
assert.equal(storyPacing([], { text: '游戏结束了吗？' }).must_finish, false);
assert.equal(storyPacing(Array.from({ length: 24 }, () => ({ event_type: 'player_input' }))).must_finish, true);
assert.equal(storyPacing([{ event_type: 'narrative_beat', payload: { story_progress: 1 } }]).must_finish, false);

const version = { content_payload: { hook: '后来我顺利通关，并约好下个副本见。', beats: [{ text: '我选择离开车站，\n她留下了。' }] } };
const compared = groundedComparison({ original_ending: '通关并约定重逢', original_ending_evidence: '我顺利通关，并约好下个副本见', same_as_original: false,
 first_divergence: { original_choice: '离开车站', original_evidence: '我选择离开车站，她留下了', player_event_seq: 14 } }, version, [{ event_seq: 14, event_type: 'player_input', payload: { text: '留下等她' } }]);
assert.equal(compared.original_ending_source, '官方导语');
assert.equal(compared.same_as_original, false);
assert.equal(compared.first_divergence.player_event_seq, 14);
assert.equal(groundedComparison({ ...compared, original_ending_evidence: '编造的结局' }, version, []).same_as_original, null);

let requests = [];
const source = createOfficialSearchSource({ secret: 'test-secret', fetchImpl: async (url, options) => {
 requests.push({ url: String(url), options });
 return new Response(JSON.stringify({ Code: 0, Data: { Items: [{ ContentID: '123', Title: '恐惧与亲情', ContentText: '现实经验', Url: 'https://www.zhihu.com/question/123/answer/456', RankingScore: 1 }] } }));
} });
const found = await source.search({ query: '恐惧与亲情', limit: 2 });
assert.equal(found.discussions.length, 1);
assert.equal(new URL(requests[0].url).searchParams.get('Query'), '恐惧与亲情');
assert.equal(requests[0].options.headers.authorization, 'Bearer test-secret');
assert.ok(!('X-OAuth-Token' in requests[0].options.headers));
let catalogueCalls = 0;
const knowledge = createOfficialKnowledgeSource({ searchSource: source, fetchImpl: async () => {
 catalogueCalls += 1;
 return new Response(JSON.stringify([{ work_id: '123', title: '职场经验', description: '升职的知识', labels: [] }]));
} });
const [a, b] = await Promise.all([knowledge.fetchKnowledge({ query: '职场经验' }), knowledge.fetchKnowledge({ query: '职场经验' })]);
assert.equal(catalogueCalls, 1);
assert.equal(a[0].id, b[0].id);
assert.equal((await knowledge.fetchKnowledge({ query: '恐惧亲情' }))[0].id, '123');
assert.equal(await knowledge.detail('not-in-catalogue'), null);

const { repository, fixtures } = createSeededRepository();
const story = fixtures.find(row => row.slug === 'cafe-rain');
const { cache } = await ensureOpeningCache({ repository, story_version_uuid: story.story_version_uuid });
const id = randomUUID();
createSession({ repository, session_uuid: id, story_uuid: story.story_uuid, story_version_uuid: story.story_version_uuid, user_ref: 'test', role_id: 'stranger', model: 'mock', prompt: 'test', generation_profile: { ...cache.generation_profile, cache_uuid: cache.cache_uuid } });
const terminal = executeToolCall({ name: 'finish_story', tool_call_id: randomUUID(), arguments: { summary: '重逢', ending: '重逢', original_difference: '留下', key_choices: ['留下'], character_outcomes: [{ character: '友人', fate: '重逢' }] } });
const staged = stageNarrativeBatch({ repository, session_uuid: id, items: [{ type: 'narration', text: '两人重逢。' }], tool_call: terminal, expected_revision: 0 });
assert.notEqual(getSession({ repository, session_uuid: id }).state, 'finished');
const committed = commitNarrativeEvent({ repository, session_uuid: id, pending_id: staged.pending_id, sequence: 0, expected_revision: 0, client_request_id: 'final' });
assert.equal(committed.state, 'finished');
assert.deepEqual(commitNarrativeEvent({ repository, session_uuid: id, pending_id: staged.pending_id, sequence: 0, expected_revision: 0, client_request_id: 'final' }), committed);
assert.throws(() => interruptWithPlayerInput({ repository, session_uuid: id, text: '继续', expected_revision: 1 }), /not interruptible/);
const row = exportSessionPersistenceSnapshot(repository).find(row => row.session_uuid === id);
row.runtime_payload.state = 'realtime';
row.state = 'realtime';
hydrateSessionPersistence({ repository, row, history: row.history, runtime_payload: row.runtime_payload });
assert.equal(getSession({ repository, session_uuid: id }).state, 'finished');
console.log('Ending activation: terminal durability/replay, legacy recovery, pacing, grounded intro, official search/catalogue, lossless compressed replay passed');

// A model that declares the original arc resolved must not open another choice.
const { createAIProvider } = await import('../src/agent/aiProvider.mjs');
const resolvedOutput = {
  arc_status: 'resolved', items: [{ type: 'narration', text: '列车驶离小镇。' }],
  tool_call: { name: 'ask_player_choice', arguments: { question: '接下来，你想怎么做？', options: [{ id: 'a', label: '继续' }, { id: 'b', label: '等候' }] } },
};
const resolvedProvider = createAIProvider({
  story: {}, config: { apiKey: 'test', baseURL: 'https://example.invalid/v1', model: 'test', timeoutMs: 1000, maxRetries: 0 },
  fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(resolvedOutput) }, finish_reason: 'stop' }] })),
});
await assert.rejects(resolvedProvider.complete({ pinned: {}, canonical_history: [], input: { text: '继续' } }), error => error.code === 'invalid_response');
