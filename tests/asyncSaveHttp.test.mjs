import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
const root=fileURLToPath(new URL('..',import.meta.url));
const isolated=await mkdtemp(join(tmpdir(),'story-async-save-'));
const env={...process.env}, nativeFetch=globalThis.fetch;
let server, repo, sessionUuid, recoverSession;
const writes=[], modelRequests=[];
function gate(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const waitFor=async test=>{for(let i=0;i<100&&!test();i++)await new Promise(r=>setTimeout(r,10));assert.ok(test());};
async function promptly(promise) {
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('HTTP waited for the blocked database')),800)})]);}
  finally{clearTimeout(timer);}
}
try {
  await cp(join(root,'src'),join(isolated,'src'),{recursive:true});
  await cp(join(root,'package.json'),join(isolated,'package.json'));
  await symlink(resolve(root,'node_modules'),join(isolated,'node_modules'));
  // Replace only the DB boundary in an isolated copy; all routes, runtime,
  // revisions, pending slots and persistence coordination are real code.
  const serverPath=join(isolated,'src/server.mjs');
  const source=await readFile(serverPath,'utf8');
  assert.ok(source.includes('let databasePersistence = null;'));
  await writeFile(serverPath,source.replace('let databasePersistence = null;', 'let databasePersistence = globalThis.__ASYNC_SAVE_TEST_DB__;'));
  globalThis.__ASYNC_SAVE_TEST_DB__={flush:()=>{
    const write=gate();
    write.snapshot=recoverSession({repository:repo,session_uuid:sessionUuid});
    writes.push(write);return write.promise;
  }};
  for(const key of Object.keys(process.env))if(key.startsWith('STORY_OUTSIDE_')||key.startsWith('ZHIHU_'))delete process.env[key];
  Object.assign(process.env,{STORY_OUTSIDE_PROVIDER:'mock',STORY_OUTSIDE_AI_PROVIDER:'mock'});
  const app=await import(pathToFileURL(serverPath));server=app.server;repo=app.storyRepo;
  const service=await import(pathToFileURL(join(isolated,'src/stories/sessionService.mjs')));
  recoverSession=service.recoverSession;
  const {ensureOpeningCache}=await import(pathToFileURL(join(isolated,'src/stories/storyService.mjs')));
  const fixture=app.storyFixtures.find(row=>row.slug==='cafe-rain');
  const {cache}=await ensureOpeningCache({repository:repo,story_version_uuid:fixture.story_version_uuid});
  sessionUuid=randomUUID();
  service.createSession({repository:repo,session_uuid:sessionUuid,story_uuid:fixture.story_uuid,story_version_uuid:fixture.story_version_uuid,user_ref:'test',role_id:'stranger',model:'test-model',prompt:'test',generation_profile:{...cache.generation_profile,cache_uuid:cache.cache_uuid}});
  Object.assign(process.env,{STORY_OUTSIDE_AI_PROVIDER:'real',STORY_OUTSIDE_AI_API_KEY:'fake',STORY_OUTSIDE_AI_MODEL:'test-model',STORY_OUTSIDE_AI_BASE_URL:'https://example.invalid/v1',STORY_OUTSIDE_AI_SECRET_FILE:join(isolated,'absent')});
  globalThis.fetch=async(url,options)=>{
    assert.ok(String(url).startsWith('https://example.invalid'));
    modelRequests.push(JSON.parse(JSON.parse(options.body).messages[1].content));
    return Response.json({choices:[{message:{content:JSON.stringify({arc_status:'ongoing',items:[{type:'narration',text:`门外传来第${modelRequests.length}声敲门声。`}]})},finish_reason:'stop'}]});
  };
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}/api/sessions/${sessionUuid}`;
  const request=async(path,body,prefer)=>{
    const response=await nativeFetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(prefer?{prefer}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,...await response.json()};
  };
  const generate=(revision,id)=>request('/generate',{input:{text:'继续'},expected_revision:revision,request_id:id},'respond-async, persist-async');
  const commit=(turn,revision,id,prefer='persist-async')=>request('/narrative-events',{pending_id:turn.pending_id,sequence:0,expected_revision:revision,client_request_id:id},prefer);
  const first=await promptly(generate(0,'turn-1'));
  assert.equal(first.status,200);assert.equal(first.persistence.status,'pending');
  assert.equal(writes.length,1);
  const accepted=await promptly(commit(first,0,'commit-1'));
  assert.equal(accepted.status,200);assert.equal(accepted.revision,1);
  const second=await promptly(generate(1,'turn-2'));
  assert.equal(second.status,200);assert.equal(modelRequests.length,2);
  assert.equal(modelRequests[1].committed_history.at(-1).payload.text,first.events[0].text,'next model sees the accepted line before its SQL write finishes');
  const accepted2=await promptly(commit(second,1,'commit-2'));
  assert.equal(accepted2.revision,2);
  assert.equal(writes.length,1,'SQL work is coalesced instead of adding a flush per response');
  const recovered=await promptly(request('/recover', undefined, 'persist-async'));
  assert.equal(recovered.revision,2);assert.equal(recovered.persistence.status,'pending');
  const replay=await promptly(commit(first,0,'commit-1'));
  assert.equal(replay.event.event_id,accepted.event.event_id,'lost acceptance response replays exactly once');
  assert.equal(recoverSession({repository:repo,session_uuid:sessionUuid}).revision,2);
  writes[0].resolve();await waitFor(()=>writes.length===2);
  let status=await promptly(request('/save-status'));
  assert.equal(status.persistence.status,'pending');
  assert.ok(status.persistence.saved_version<accepted2.persistence.requested_version,'old transaction does not acknowledge later lines');
  assert.equal(writes[1].snapshot.revision,2);
  assert.equal(writes[1].snapshot.history.filter(e=>e.event_type==='narrative_beat').length,2);
  writes[1].resolve();await settle();
  status=await request('/save-status');assert.equal(status.persistence.status,'saved');
  const third=await promptly(generate(2,'turn-3'));
  await waitFor(()=>writes.length===3);writes[2].reject(new Error('injected database failure'));await settle();
  status=await promptly(request('/save-status'));assert.equal(status.persistence.status,'failed');
  const retry=await promptly(request('/save-status',{request_id:'retry-save'}));assert.equal(retry.persistence.status,'pending');
  await waitFor(()=>writes.length===4);writes[3].resolve();await settle();
  assert.equal((await request('/save-status')).persistence.status,'saved');
  let returned=false;
  const durable=commit(third,2,'commit-3','').then(value=>{returned=true;return value});
  await waitFor(()=>writes.length===5);
  assert.equal(returned,false,'clients without persist-async still wait for SQL');
  writes[4].resolve();assert.equal((await durable).status,200);
  console.log('Async save HTTP: generation/display and next model independent of SQL, canonical ordering, recover, idempotent replay, truthful receipts, retry, legacy durability PASS');
} finally {
  for(const write of writes)write.resolve();
  globalThis.fetch=nativeFetch;delete globalThis.__ASYNC_SAVE_TEST_DB__;
  if(server)await new Promise(resolve=>server.close(resolve));
  process.env=env;await rm(isolated,{recursive:true,force:true});
}
