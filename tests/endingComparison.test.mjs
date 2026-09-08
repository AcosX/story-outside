import assert from 'node:assert/strict';
import { validateFinishStory, TOOL_DEFINITIONS } from '../src/agent/tools.mjs';
import { buildEnding } from '../src/stories/endingService.mjs';
const base={summary:'玩家与友人重逢。',ending:'重逢',original_difference:'选择不同。',key_choices:['留在车站'],character_outcomes:[{character:'old-friend',fate:'找到友人'}]};
const original='那天我选择离开车站，从此再也没有见过她。多年后，我独自在海边终老。';
const full={...base,first_divergence:{original_choice:'原作的我离开了车站。',player_choice:'玩家选择留在车站等待。',original_evidence:'我选择离开车站',player_event_seq:2},original_ending:'原作主人公独自在海边终老。',original_ending_evidence:'我独自在海边终老',same_as_original:false,ending_comparison_reason:'原作失去友人独自终老，玩家选择等待后重逢，结果不同。'};
const sessionUuid='11111111-1111-4111-8111-111111111111';
function project(payload){
  const session={story_uuid:'story',story_version_uuid:'version',cache_uuid:'cache',history:[
    {event_seq:1,event_type:'narrative_beat',payload:{text:'旧友推开门。',speaker:'old-friend'}},
    {event_seq:2,event_type:'player_input',payload:{text:'我留在车站等她'}},
  ],finish_envelope:{tool_call:{name:'finish_story',payload}},requestIds:new Map()};
  const repository={sessionState:{sessions:new Map([[sessionUuid,session]])},findStoryByUuid:()=>({slug:'work'}),findVersion:()=>({version_no:1,roles_payload:[{id:'old-friend',label:'旧友'}],content_payload:{beats:[{text:original}]}}),findOpeningCacheByUuid:()=>({content_payload:{events:[]}})};
  return buildEnding({repository,session_uuid:sessionUuid});
}
const normalized=validateFinishStory(full);
assert.equal(normalized.same_as_original,false);
assert.equal(TOOL_DEFINITIONS[1].function.parameters.properties.same_as_original.type[0],'boolean');
const ending=project(normalized);
assert.equal(ending.first_divergence.original_choice,full.first_divergence.original_choice);
assert.equal(ending.first_divergence.player_choice,'我留在车站等她');
assert.equal(ending.first_deviation.speaker_label,'旧友');
assert.equal(ending.character_outcomes[0].character_label,'旧友');
assert.equal(ending.original_ending,full.original_ending);
assert.equal(ending.same_as_original,false);
assert.equal(project({...normalized,same_as_original:true}).same_as_original,true);
const unknown=project(validateFinishStory(base));
assert.equal(unknown.first_divergence,null);
assert.equal(unknown.original_ending,null);
assert.equal(unknown.same_as_original,null);
assert.match(unknown.ending_comparison_reason,/不足/);
assert.equal(project({...normalized,original_ending_evidence:'原文根本没有这句话'}).same_as_original,null);
assert.equal(project({...normalized,first_divergence:{...normalized.first_divergence,player_event_seq:99}}).first_divergence,null);
assert.equal(project({...normalized,first_divergence:{...normalized.first_divergence,original_evidence:'编造的原作节点'}}).first_divergence,null);
assert.throws(()=>validateFinishStory({...full,same_as_original:'false'}));
assert.throws(()=>validateFinishStory({...full,first_divergence:{...full.first_divergence,unexpected:true}}));
assert.equal(validateFinishStory({...base,original_ending:null,same_as_original:null,first_divergence:null}).same_as_original,null);
console.log('Ending comparison: original/player node, original ending, same/different/unknown, original quote provenance, canonical player event and legacy compatibility passed');
