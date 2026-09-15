import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSession } from '../src/stories/sessionService.mjs';
import { ensureOpeningCache } from '../src/stories/storyService.mjs';
process.env.STORY_OUTSIDE_PROVIDER='mock';
process.env.STORY_OUTSIDE_AI_PROVIDER='mock';
const {server,storyRepo,storyFixtures}=await import('../src/server.mjs');
const fixture=storyFixtures.find(row=>row.slug==='cafe-rain');
const {cache}=await ensureOpeningCache({repository:storyRepo,story_version_uuid:fixture.story_version_uuid});
const sessionUuid=randomUUID();
createSession({repository:storyRepo,session_uuid:sessionUuid,story_uuid:fixture.story_uuid,story_version_uuid:fixture.story_version_uuid,user_ref:'test',role_id:'stranger',model:'audit-model',prompt:'test',generation_profile:{...cache.generation_profile,cache_uuid:cache.cache_uuid}});
Object.assign(process.env,{STORY_OUTSIDE_AI_PROVIDER:'real',STORY_OUTSIDE_AI_API_KEY:'fake-test',STORY_OUTSIDE_AI_MODEL:'audit-model',STORY_OUTSIDE_AI_BASE_URL:'https://example.invalid/v1',STORY_OUTSIDE_AI_SECRET_FILE:'/nonexistent-test',STORY_OUTSIDE_AI_TIMEOUT_MS:'10000'});
const nativeFetch=globalThis.fetch;let release;const gate=new Promise(resolve=>{release=resolve;});let calls=0;
globalThis.fetch=async(url,opts)=>{
 if(!String(url).startsWith('https://example.invalid'))return nativeFetch(url,opts);
 calls++;await gate;
 return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({items:[{type:'narration',text:'窗外雨声渐渐停了。'},{type:'narration',text:'檐角落下最后一滴水。'},{type:'narration',text:'远处的灯重新亮起。'}]})},finish_reason:'stop'}]}),{status:200,headers:{'content-type':'application/json'}});
};
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/api/sessions/${sessionUuid}/generate`;
const body={input:{text:'继续'},expected_revision:0,request_id:'one-logical-turn'};
const post=async(overrides={})=>{const r=await nativeFetch(url,{method:'POST',headers:{'content-type':'application/json',prefer:'respond-async'},body:JSON.stringify({...body,...overrides})});return {status:r.status,body:await r.json()};};
try{
 const first=await post();assert.equal(first.status,202);assert.equal(first.body.request_id,body.request_id);assert.equal(first.body.pending_id,undefined);
 const second=await post();assert.equal(second.status,202);assert.equal(calls,1);
 release();const done=await post();assert.equal(done.status,200,JSON.stringify(done.body));assert.ok(done.body.pending_id);
 const replay=await post();assert.equal(replay.status,200);assert.equal(replay.body.pending_id,done.body.pending_id);assert.equal(calls,1);
 const conflict=await post({request_id:'new-turn'});assert.equal(conflict.status,400);assert.equal(conflict.body.error,'pending_conflict');assert.equal(calls,1);
 console.log('HTTP async generation: repeated 202, exact durable replay, early pending conflict PASS');
}finally{release();globalThis.fetch=nativeFetch;await new Promise(resolve=>server.close(resolve));}
