import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createSeededRepository, FIXTURE_UUIDS } from '../src/stories/fixture.mjs';
import { ensureOpeningCache, defaultGenerationProfile } from '../src/stories/storyService.mjs';
import { createSession, getSession, recoverSession, commitOpeningEvent, commitNarrativeEvent, interruptWithPlayerInput, stageNarrativeBatch, exportSessionPersistenceSnapshot, hydrateSessionPersistence } from '../src/stories/sessionService.mjs';
import { createAgentRuntime, createMockAgentProvider, runTurn } from '../src/agent/runtime.mjs';
import { generateOpeningCache } from '../src/stories/openingGenerator.mjs';
import { latestStoryProgress } from '../src/stories/plotProgress.mjs';

// Run the real browser calculation/rendering against committed server history.
const player = await readFile(new URL('../public/scripts/player.js', import.meta.url), 'utf8');
const fill = { style: {}, setAttribute() {} };
const context = vm.createContext({ state: { canonicalHistory: [] }, $: () => fill, setText() {}, setGenerationStatus() {}, clearTimeout() {}, STATUS_LABEL: {} });
vm.runInContext(player.slice(player.indexOf('function setStatus('), player.indexOf('function showToast(')), context);
function checkProgress(history, expected) {
  context.state.canonicalHistory = history;
  assert.equal(latestStoryProgress(history) ?? 0, expected);
  vm.runInContext('setProgress(computeProgress())', context);
  assert.equal(fill.style.width, `${(expected * 100).toFixed(1)}%`);
}
checkProgress(Array.from({length:500}, () => ({ event_type:'narrative_beat', payload:{text:'旧剧情'} })), 0);

const { repository } = createSeededRepository();
const version = repository.findVersion(FIXTURE_UUIDS['cafe-rain'].story_version_uuid);
const { cache } = await ensureOpeningCache({ repository, story_version_uuid:version.version_uuid, options:{profile:defaultGenerationProfile(), generator:({story,profile}) => generateOpeningCache({story_uuid:version.story_uuid,story_version_uuid:version.version_uuid,profile,story:{...story,ai_opening_events:[{type:'narration',text:'开场第一幕',story_progress:0.03}]}})} });
const session_uuid = randomUUID();
const identity = { repository, session_uuid };
const profile = { ...cache.generation_profile, cache_uuid:cache.cache_uuid };
createSession({ ...identity, story_uuid:version.story_uuid, story_version_uuid:version.version_uuid, user_ref:'plot-test', role_id:version.roles_payload[0].id, model:'plot-test', prompt:'plot', generation_profile:profile });
function runtime(provider) {
  return createAgentRuntime({ ...identity, provider, system_prompt:{}, tool_definitions:[], expected_story_version_uuid:version.version_uuid, expected_story_version_checksum:version.checksum, expected_model:'plot-test', expected_generation_profile:profile });
}
const history = () => recoverSession(identity).history;
const revision = () => getSession(identity).revision;
commitOpeningEvent({...identity,cache_uuid:cache.cache_uuid,event:{...cache.content_payload.events[0],displayed:true},expected_revision:revision()});
checkProgress(history(),0.03);
const provider = createMockAgentProvider({responses:[{items:[
  {type:'narration',text:'开端',story_progress:0.08},
  {type:'narration',text:'跨到原作后半段',story_progress:0.85},
  {type:'narration',text:'尚未读到的终局',story_progress:1},
]}]});
const turnArgs = { request_id:'plot-turn', input:{}, expected_revision:revision() };
const turn = await runTurn(runtime(provider), turnArgs);
assert.equal(turn.items[1].story_progress,0.85);
assert.equal(recoverSession(identity).pending.events[2].story_progress,1);
checkProgress(history(),0.03); // generation/prefetch never advances the displayed bar
assert.deepEqual(await runTurn(runtime(provider),turnArgs),turn);
assert.equal(provider.callCount,1);
const commit = (sequence, request_id) => commitNarrativeEvent({ ...identity, pending_id:turn.pending_id, sequence, expected_revision:revision(), client_request_id:request_id });
const firstRevision = revision();
const first = commit(0,'plot-first');
checkProgress(history(),0.08);
assert.deepEqual(commitNarrativeEvent({...identity,pending_id:turn.pending_id,sequence:0,expected_revision:firstRevision,client_request_id:'plot-first'}),first);
assert.throws(() => stageNarrativeBatch({...identity,items:turn.items.map((item,i)=>({...item,story_progress:i===0?0.2:item.story_progress})),source:'runtime',expected_revision:revision()}), /unconsumed pending/);
commit(1,'plot-second');
checkProgress(history(),0.85);
interruptWithPlayerInput({...identity,text:'返回早期现场',expected_revision:revision()});
checkProgress(history(),0.85); // discard unplayed 100% tail
const back = await runTurn(runtime(createMockAgentProvider({responses:[{items:[{type:'action',text:'重新面对早期的悬念',story_progress:0.18}]}]})),{input:{},expected_revision:revision()});
commitNarrativeEvent({...identity,pending_id:back.pending_id,sequence:0,expected_revision:revision()});
checkProgress(history(),0.18); // no monotonic max or artificial incremental cap

// Actual session persistence export/hydrate preserves estimates, without a new column.
const row = JSON.parse(JSON.stringify(exportSessionPersistenceSnapshot(repository)[0]));
const restored = createSeededRepository().repository;
hydrateSessionPersistence({repository:restored,row,history:row.history,runtime_payload:row.runtime_payload});
checkProgress(recoverSession({repository:restored,session_uuid}).history,0.18);

for (const value of [undefined,null,'90%',-1,2]) {
  const invalid = await runTurn(runtime(createMockAgentProvider({responses:[{items:[{type:'narration',text:'继续叙事',story_progress:value}]}]})),{input:{},expected_revision:revision()});
  assert.equal(invalid.items[0].story_progress,undefined);
  commitNarrativeEvent({...identity,pending_id:invalid.pending_id,sequence:0,expected_revision:revision()});
  checkProgress(history(),0.18); // bad advisory metadata must not block narrative
}
checkProgress([...history(), {event_type:'player_input',payload:{story_progress:0.99}}],0.18);
const atEnd = await runTurn(runtime(createMockAgentProvider({responses:[{items:[{type:'narration',text:'到达原作末尾但继续新的分支',story_progress:1}]}]})),{input:{},expected_revision:revision()});
const stillPlaying = commitNarrativeEvent({...identity,pending_id:atEnd.pending_id,sequence:0,expected_revision:revision()});
assert.equal(stillPlaying.pending_tool_call,null);
checkProgress(history(),1);
vm.runInContext("setStatus('playing')",context);
assert.equal(context.state.status,'playing');
const end = await runTurn(runtime(createMockAgentProvider({responses:[{items:[{type:'narration',text:'提前落幕',story_progress:0.2}],tool_call:{name:'finish_story',tool_call_id:'end',arguments:{summary:'结束',ending:'新的结局',original_difference:'提前收束',key_choices:['离开'],character_outcomes:[{character:'我',fate:'回家'}]}}}]})),{input:{},expected_revision:revision()});
const ended = commitNarrativeEvent({...identity,pending_id:end.pending_id,sequence:0,expected_revision:revision()});
vm.runInContext("setStatus('finished')", context);
assert.equal(fill.style.width,'100.0%');
assert.equal(ended.pending_tool_call.name,'finish_story'); // low estimate cannot prevent ending
console.log('Plot progress: committed-only, jumps/backtracking, discarded tail, retry, persistence, legacy and invalid metadata, early ending passed');
