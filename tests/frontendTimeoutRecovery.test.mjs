import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source=await readFile(new URL('../public/scripts/player.js',import.meta.url),'utf8');
const apiSource=source.slice(source.indexOf('const RETRYABLE_HTTP_STATUSES'),source.indexOf('\n}',source.indexOf('async function requestApi'))+2);
let calls=0;
const request=new Function('state','fetch','setTimeout',`${apiSource};return requestApi;`)({sessionUuid:'s'},async()=>{
 calls++;return new Response('<html>524 timeout</html>',{status:524});
},fn=>{fn();return 0;});
await assert.rejects(request('/api/sessions/s/generate',{method:'POST',body:JSON.stringify({request_id:'same'})}),e=>e.code==='request_timeout'&&e.status===524&&!e.message.includes('json'));
assert.equal(calls,3);
const generation=source.slice(source.indexOf('function startNextBatch()'),source.indexOf('async function surfaceToolCall('));
const state={sessionUuid:'s',lastRevision:1,lastPlayerRequestId:1,status:'playing',canonicalHistory:[],nextBatchInput:'chosen action'};
const bodies=[];let mode='timeout';
const api=async(path,options)=>{
 const b=JSON.parse(options.body);bodies.push(b);
 assert.equal(options.headers.prefer,'respond-async');
 if(mode==='timeout')throw Object.assign(new Error('timeout'),{code:'request_timeout'});
 if(mode==='poll'){mode='done';return {status:'pending'};}
 return {revision:1,pending_id:'p',events:[{text:'result'}]};
};
const player=new Function('state','api','setTimeout',`
const setText=()=>{},setStatus=s=>{state.status=s},inOpeningPhase=()=>false,showToast=()=>{},scheduleNextStep=()=>{},scheduleOpeningStep=()=>{},renderPendingPlaceholder=()=>({}),registerPendingNode=()=>{},surfaceToolCall=()=>{};
${generation};return {startNextBatch};`)(state,api,fn=>{fn();return 0;});
await player.startNextBatch();
mode='poll';await player.startNextBatch();
assert.equal(bodies.length,3);assert.deepEqual(bodies[1],bodies[0]);assert.deepEqual(bodies[2],bodies[0]);
assert.equal(bodies[0].input.text,'chosen action');assert.equal(state.pending.pending_id,'p');
console.log('Frontend timeout: HTTP 524 classification, stable manual retry identity/input, async polling PASS');
