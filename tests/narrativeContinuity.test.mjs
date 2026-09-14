import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAIProvider, resolveNarrativeInput, PLAYER_CHOICE_QUESTION } from '../src/agent/aiProvider.mjs';
const history=[{event_seq:11,event_type:'narrative_beat',payload:{text:'我仍站在楼下，大家正在选择楼层。'}},{event_seq:12,event_type:'player_input',payload:{text:'A. 选30层'}}];
assert.deepEqual(resolveNarrativeInput({input:{text:'hello'},canonical_history:history}),{kind:'player_action',text:'A. 选30层'},'old clients recover actual choice from canonical tail');
assert.equal(resolveNarrativeInput({input:{text:'hello'},canonical_history:history.slice(0,1)}).kind,'continue');
assert.equal(resolveNarrativeInput({input:{text:'hello',kind:'player_action'},canonical_history:history}).text,'hello','literal player text is not interpreted as a demo command');
assert.equal(resolveNarrativeInput({input:{kind:'continue'},canonical_history:history}).kind,'continue','continuation must not replay the last choice');
const bodies=[];
const corrected='我按下30层，电梯缓缓上升。门打开时，一扇暗红色的门出现在走廊尽头，我停在门前。';
const provider=createAIProvider({story:{roles:[{id:'i',label:'我'}],first_person_role_id:'i',beats:['原作后续：午后已经入住，遇见女儿。']},config:{apiKey:'test',baseURL:'https://test.invalid',model:'test',timeoutMs:1000,maxRetries:1,retryBaseDelayMs:0,retryMaxDelayMs:0},fetchImpl:async(_url,options)=>{
 bodies.push(JSON.parse(options.body));
 return Response.json({choices:[{message:{tool_calls:[{function:{name:'narrate',arguments:JSON.stringify({arc_status:'ongoing',items:[{type:'narration',text:bodies.length===1?'我按下30层。':corrected}],tool_call:{name:'ask_player_choice',arguments:{question:bodies.length===1?'电梯升到30层，我来到暗红色门前。现在怎么做？':PLAYER_CHOICE_QUESTION,options:[{id:'knock',label:'敲门'},{id:'wait',label:'等一会儿'}]}}})}}]},finish_reason:'tool_calls'}]});
}});
const result=await provider.complete({pinned:{role_id:'i'},canonical_history:history,input:{text:'A. 选30层',kind:'player_action'}});
assert.equal(bodies.length,2,'hidden narrative in a question must retry, never be silently erased');
assert.equal(result.items.length,1);assert.equal(result.items[0].text,corrected);
assert.equal(result.tool_call.arguments.question,PLAYER_CHOICE_QUESTION);
assert.match(bodies[1].messages.at(-1).content,/尚未展示或提交/);
const payload=JSON.parse(bodies[0].messages[1].content);
assert.equal(payload.player_input.text,'A. 选30层');assert.deepEqual(payload.current_worldline_tail,history);
const branches=bodies[0].tools[0].function.parameters.properties.tool_call.anyOf;
assert.deepEqual(branches.find(x=>x.properties.name.enum[0]==='ask_player_choice').properties.arguments.properties.question.enum,[PLAYER_CHOICE_QUESTION]);
const next=provider.contextPolicy.measure({pinned:{role_id:'i'},canonical_history:[...history,{event_seq:13,event_type:'narrative_beat',payload:{text:corrected}}],input:{kind:'continue',text:'继续'}});
const nextPayload=JSON.parse(next[1].content);
assert.equal(nextPayload.player_input,null);assert.equal(nextPayload.turn_instruction.kind,'continue');
assert.equal(nextPayload.committed_history.at(-1).payload.text,corrected,'all displayed transition facts reach the next request');

// Option IDs identify UI controls, not story facts. Complete only missing
// IDs deterministically; keep labels and existing IDs intact, including collisions.
const idProvider=createAIProvider({story:{},config:{apiKey:'test',baseURL:'https://test.invalid',model:'test',timeoutMs:1000,maxRetries:0},fetchImpl:async()=>Response.json({choices:[{message:{content:JSON.stringify({items:[{type:'narration',text:'门前传来脚步声。'}],tool_call:{name:'ask_player_choice',arguments:{question:PLAYER_CHOICE_QUESTION,options:[{label:'继续敲门'},{id:'choice-1',label:'等待'},{label:'后退'}]}}})}}]})});
const withIds=await idProvider.complete({pinned:{},canonical_history:[],input:{kind:'continue'}});
assert.deepEqual(withIds.tool_call.arguments.options.map(option=>option.id),['choice-2','choice-1','choice-3']);
assert.deepEqual(withIds.tool_call.arguments.options.map(option=>option.label),['继续敲门','等待','后退']);

// Run the real selection handler: no demo hint may replace an actual action.
const source=await readFile(new URL('../public/scripts/player.js',import.meta.url),'utf8');
const choose=source.slice(source.indexOf('async function chooseOption('),source.indexOf('// -------- Pause / resume / skip'));
const generation=source.slice(source.indexOf('function startNextBatch()'),source.indexOf('async function surfaceToolCall('));
const state={sessionUuid:'s',status:'playing',lastRevision:12,lastPlayerRequestId:1,canonicalHistory:[]};const sent=[];
const player=new Function('state','sent',`
const formatOptionText=o=>o.label,sendPlayerInputChoice=async text=>{state.nextBatchInput=text;return true},setStatus=s=>state.status=s,clearAutoplayTimer=()=>{},scheduleNext=()=>{},setGenerationStatus=()=>{},inOpeningPhase=()=>false,scheduleOpeningStep=()=>{},setText=()=>{},renderPendingPlaceholder=()=>({}),registerPendingNode=()=>{},scheduleNextStep=()=>{},showToast=()=>{};
const api=async(_p,options)=>{sent.push(JSON.parse(options.body));return {revision:state.lastRevision,pending_id:'p',events:[{text:'新的一条'}]}};
${choose}
${generation}
return {chooseOption,startNextBatch};`)(state,sent);
await player.chooseOption({id:'b',label:'我选30层'});await player.startNextBatch();
assert.deepEqual(sent[0].input,{text:'我选30层',kind:'player_action'});
await player.startNextBatch();assert.deepEqual(sent[1].input,{text:'继续',kind:'continue'});
console.log('Narrative continuity: real choices, legacy commands, explicit continuation, schema/retry without lost narrative, full next-turn context PASS');
