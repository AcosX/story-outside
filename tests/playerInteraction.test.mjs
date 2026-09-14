import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { playerInteraction } from '../src/agent/playerInteraction.mjs';
const events=n=>Array.from({length:n},(_,i)=>({event_seq:i+1,event_type:'narrative_beat',payload:{text:'雨仍在下。'}}));
for(const count of [0,1,2,3,4,5,11]){
 const policy=playerInteraction(events(count));
 assert.equal(policy.choice_recommended,count>=2);
 assert.equal(policy.choice_required,count>=4,'the next (fifth) line must return control');
}
assert.equal(playerInteraction([...events(8),{event_type:'player_input'},...events(2)]).choice_required,false);
assert.equal(playerInteraction([...events(3),{event_type:'narrative_beat',status:'pending'}]).choice_required,false);
assert.equal(playerInteraction([{event_type:'story_opening'},...events(2)]).narratives_since_input,2);

// Exercise real public generate/commit/interrupt routes. The simulated model
// omits choices whenever the schema allows it, reproducing endless autoplay.
process.env.STORY_OUTSIDE_PROVIDER='mock';process.env.STORY_OUTSIDE_AI_PROVIDER='mock';
const {server,storyRepo,storyFixtures}=await import('../src/server.mjs');
const {createSession}=await import('../src/stories/sessionService.mjs');
const {ensureOpeningCache}=await import('../src/stories/storyService.mjs');
const fixture=storyFixtures.find(x=>x.slug==='cafe-rain');
const {cache}=await ensureOpeningCache({repository:storyRepo,story_version_uuid:fixture.story_version_uuid});
const sessionUuid=randomUUID();
createSession({repository:storyRepo,session_uuid:sessionUuid,story_uuid:fixture.story_uuid,story_version_uuid:fixture.story_version_uuid,user_ref:'choice-test',role_id:'stranger',model:'choice-test',prompt:'test',generation_profile:{...cache.generation_profile,cache_uuid:cache.cache_uuid}});
Object.assign(process.env,{STORY_OUTSIDE_AI_PROVIDER:'real',STORY_OUTSIDE_AI_API_KEY:'fake-test',STORY_OUTSIDE_AI_MODEL:'choice-test',STORY_OUTSIDE_AI_BASE_URL:'https://choice-test.invalid/v1',STORY_OUTSIDE_AI_SECRET_FILE:'/nonexistent-choice-test',STORY_OUTSIDE_AI_MAX_RETRIES:'1'});
const nativeFetch=globalThis.fetch;let violateOnce=true;const requests=[];
globalThis.fetch=async(url,options)=>{
 if(!String(url).startsWith('https://choice-test.invalid'))return nativeFetch(url,options);
 const body=JSON.parse(options.body);requests.push(body);
 const required=body.tools[0].function.parameters.required.includes('tool_call');
 const payload=JSON.parse(body.messages[1].content);
 assert.equal(required,payload.player_interaction.choice_required);
 let includeChoice=required;
 if(required&&violateOnce){includeChoice=false;violateOnce=false;}
 return Response.json({choices:[{message:{content:JSON.stringify({arc_status:'ongoing',items:[{type:'narration',text:'雨声渐歇，门外传来轻轻的敲门声。'}],...(includeChoice?{tool_call:{name:'ask_player_choice',arguments:{question:'接下来，你想怎么做？',options:[{id:'open',label:'询问来意'},{id:'wait',label:'继续等候'}]}}}:{})})},finish_reason:'stop'}]});
};
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}/api/sessions/${sessionUuid}`;
const post=async(path,body)=>{const response=await nativeFetch(base+path,{method:'POST',headers:{'content-type':'application/json',prefer:'respond-async, persist-async'},body:JSON.stringify(body)});assert.equal(response.status,200);return response.json();};
try{
 let revision=0;
 for(let cycle=0;cycle<2;cycle++){
  for(let line=1;line<=5;line++){
   const turn=await post('/generate',{request_id:`turn-${cycle}-${line}`,expected_revision:revision,input:{kind:'continue',text:'继续'}});
   assert.equal(Boolean(turn.tool_call),line===5,'a model cannot silently bypass the fifth-line decision boundary');
   const commit=await post('/narrative-events',{pending_id:turn.pending_id,sequence:0,expected_revision:revision,client_request_id:`line-${cycle}-${line}`});
   revision=commit.revision;
   assert.equal(Boolean(commit.pending_tool_call),line===5,'choice reaches the same envelope rendered by the player');
  }
  const interrupt=await post('/interrupt',{text:'继续等候',expected_revision:revision,client_request_id:`choice-${cycle}`});revision=interrupt.revision;
 }
 assert.equal(requests.length,11,'one rejected candidate retried without adding a story event');
 assert.ok(requests.some(request=>request.messages.at(-1).content.includes('未返回必须的选择')));
 console.log('Player interaction: third-to-fifth choice window, fifth-line enforcement, invalid-output retry, public commit envelope and next-cycle reset PASS');
}finally{globalThis.fetch=nativeFetch;await new Promise(resolve=>server.close(resolve));}
