import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source=await readFile(new URL('../public/scripts/player.js',import.meta.url),'utf8');
const helpers=source.slice(source.indexOf('function updateSaveStatus()'),source.indexOf('const READING_HISTORY_PREFIX'));
const indicator=source.slice(source.indexOf('function setGenerationStatus('),source.indexOf('async function discardSupersededPending('));
const statuses=source.slice(source.indexOf('function setStatus('),source.indexOf('\n}',source.indexOf('function setStatus('))+2);
function gate(){let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function harness(){
 const state={sessionUuid:'a',status:'playing',pending:null,pendingIdx:0};
 const nodes=new Map(),requests=[],timers=[];let reloaded=false;
 const element=()=>({children:[],setAttribute(){},remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(n=>n!==this);this.parentNode=null;},appendChild(el){el.remove();el.parentNode=this;this.children.push(el);},hidden:false});
 for(const id of ['#story-log','#screen-player','#player-input-form','#pause-btn','#player-choices','#player-ending','#pause-btn-label','#autosave-retry'])nodes.set(id,element());
 const $=id=>id==='#player-generation'?nodes.get('#story-log').children.find(n=>n.id==='player-generation'):nodes.get(id);
 const labels=new Map();
 const player=new Function('state','$','document','setTimeout','clearTimeout','requestApi','setText','window',`
 const STATUS_LABEL={},setProgress=()=>{},computeProgress=()=>0,scrollLogToEnd=()=>{};
 ${indicator}
 ${statuses}
 ${helpers}
 return {setGenerationStatus,setStatus,trackSessionSave,retrySessionSave};
 `)(state,$,{createElement:element},fn=>{timers.push(fn);return timers.length;},()=>{},(path,options)=>{const request={...gate(),path,options};requests.push(request);return request.promise;},(id,value)=>labels.set(id,value),{location:{reload(){reloaded=true}}});
 const poll=async()=>{assert.equal(timers.length,1);timers.shift()();await settle();return requests.at(-1);};
 return {state,player,nodes,$,labels,requests,timers,poll,get reloaded(){return reloaded;}};
}
const snapshot=(requested,saved,status='pending',epoch='epoch')=>({epoch,requested_version:requested,saved_version:saved,status});
{
 const h=harness();
 h.player.trackSessionSave(snapshot(1,0),'a');
 assert.equal(h.labels.get('#autosave-status'),'正在保存…');
 assert.equal(h.state.status,'playing','saving must not block playback');
 const old=await h.poll();
 h.player.trackSessionSave(snapshot(2,0),'a');
 old.resolve({persistence:snapshot(1,1,'saved')});await settle();
 assert.equal(h.labels.get('#autosave-status'),'正在保存…','older success cannot acknowledge a newer in-flight save');
 const current=await h.poll();current.resolve({persistence:snapshot(2,2,'saved')});await settle();
 assert.equal(h.labels.get('#autosave-status'),'已自动保存');
 h.player.trackSessionSave(snapshot(3,2),'a');
 const failure=await h.poll();failure.resolve({persistence:snapshot(3,2,'failed')});await settle();
 assert.equal(h.state.status,'paused');assert.equal(h.nodes.get('#autosave-retry').hidden,false);
 h.player.setStatus('playing');assert.equal(h.state.status,'paused','cannot resume over an unresolved save failure');
 const retry=h.player.retrySessionSave();
 assert.equal(h.requests.at(-1).options.method,'POST');
 h.requests.at(-1).resolve({persistence:snapshot(3,2)});await retry;
 const successfulRetry=await h.poll();successfulRetry.resolve({persistence:snapshot(3,3,'saved')});await settle();
 assert.equal(h.labels.get('#autosave-status'),'已自动保存');
 assert.equal(h.state.status,'paused','a background save cannot unexpectedly resume playback');
 h.player.setStatus('playing');assert.equal(h.state.status,'playing');
}
{
 const h=harness();h.player.trackSessionSave(snapshot(4,3),'a');const old=await h.poll();
 h.state.sessionUuid='b';h.player.trackSessionSave(snapshot(0,0,'saved'),'b');
 old.resolve({persistence:snapshot(4,3,'failed')});await settle();
 assert.equal(h.state.status,'playing','late save failures from another session cannot pause the current one');
 assert.equal(h.labels.get('#autosave-status'),'已自动保存');
}
{
 const h=harness();h.player.trackSessionSave(snapshot(4,3),'a');const old=await h.poll();
 old.resolve({persistence:snapshot(0,0,'saved','new-process')});await settle();
 assert.equal(h.state.status,'paused');assert.equal(h.nodes.get('#autosave-retry').textContent,'重新载入');
 await h.player.retrySessionSave();assert.equal(h.reloaded,true,'lost process receipts require authoritative reload, never false saved status');
}
{
 const h=harness();const log=h.nodes.get('#story-log');
 h.player.setGenerationStatus(true);assert.ok(h.$('#player-generation'));
 h.state.pending={events:[{text:'一句'}],tool_call:null};
 h.player.setGenerationStatus(false);
 assert.ok(h.$('#player-generation'),'cue stays during response -> accepted commit, not just model fetch');
 const message={remove(){},parentNode:null};log.appendChild(message);h.player.setGenerationStatus();
 assert.equal(log.children.at(-1),h.$('#player-generation'),'cue sits below the latest message');
 h.player.setStatus('paused');assert.equal(h.$('#player-generation'),undefined);
 h.player.setGenerationStatus(true);assert.equal(h.$('#player-generation'),undefined,'an in-flight response cannot show the cue while paused');
 h.player.setStatus('playing');assert.ok(h.$('#player-generation'));
 h.state.pendingIdx=1;h.player.setGenerationStatus();assert.ok(h.$('#player-generation'),'cue remains while requesting the next turn');
 h.state.pending={events:[{text:'选择前一句'}],tool_call:{name:'ask_player_choice'}};h.state.pendingIdx=0;
 h.player.setGenerationStatus(false);assert.equal(h.$('#player-generation'),undefined,'choice node hides cue before deferred choice-card rendering');
 h.state.pending=null;h.state.queuedToolCall={name:'finish_story'};h.player.setGenerationStatus();assert.equal(h.$('#player-generation'),undefined);
 h.player.setStatus('finished');assert.equal(h.$('#player-generation'),undefined);
}
console.log('Frontend async saves: truthful status, stale receipts, failure/retry, session isolation, restart, continuous cue and pause/choice/finish PASS');
