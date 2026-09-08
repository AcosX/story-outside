import assert from 'node:assert/strict';
import { createAIProvider, loadAIConfig } from '../src/agent/aiProvider.mjs';
const config = {apiKey:'private-test-secret',baseURL:'https://example.invalid/v1',model:'test-model',timeoutMs:1000,contextChars:1000};
assert.equal(loadAIConfig({STORY_OUTSIDE_AI_PROVIDER:'mock'}),null);
assert.throws(()=>loadAIConfig({STORY_OUTSIDE_AI_PROVIDER:'invalid'}));
const story={content:'完整原作'.repeat(500)};
const calls=[];
const provider=createAIProvider({config,story,fetchImpl:async(url,opts)=>{
  calls.push({url,body:JSON.parse(opts.body)});
  const content=calls.length===1?{summary:'保留玩家选择和人物事实'}:{items:[{type:'narration',text:'门开了。'}],tool_call:{name:'ask_player_choice',arguments:{question:'进入吗？',options:[{id:'a',label:'进入'},{id:'b',label:'等待'}]}}};
  return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(content)},finish_reason:'stop'}]})};
}});
const result=await provider.complete({pinned:{role_id:'me'},canonical_history:Array.from({length:20},(_,i)=>({event_seq:i,text:'事件'})),input:{text:'看看'}});
assert.equal(calls.length,2);
const sent=JSON.parse(calls[1].body.messages[1].content);
assert.deepEqual(sent.original_story,story);
assert.equal(sent.committed_history.length,16);
assert.equal(sent.committed_summary,'保留玩家选择和人物事实');
assert.ok(result.tool_call.tool_call_id);
assert.ok(!JSON.stringify(calls).includes(config.apiKey));
for(const stub of [async()=>({ok:false,status:401}),async()=>({ok:true,json:async()=>({choices:[{message:{content:'not json'}}]})})]) {
  await assert.rejects(createAIProvider({config,story:{},fetchImpl:stub}).complete({canonical_history:[],input:{},pinned:{}}));
}
console.log('AI provider: config, full original, compact, validated choice, upstream failure and malformed JSON passed');

// Persisted compact reuses committed-prefix summaries across provider instances.
const { mkdtemp, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const cacheDir = await mkdtemp(join(tmpdir(), 'story-ai-'));
try {
  let compactCalls = 0;
  const fetchCached = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const isCompact = body.messages[0].content.includes('事实摘要');
    if (isCompact) compactCalls++;
    return { ok:true, json:async()=>({choices:[{message:{content:JSON.stringify(isCompact ? {summary:'事实和选择'} : {items:[{text:'继续。'}]})}}]}) };
  };
  const history=Array.from({length:20},(_,i)=>({event_seq:i,text:'事件'}));
  const request={session:{session_uuid:'cache-test'},pinned:{},canonical_history:history,input:{}};
  await createAIProvider({config:{...config,cacheDir},story,fetchImpl:fetchCached}).complete(request);
  await createAIProvider({config:{...config,cacheDir},story,fetchImpl:fetchCached}).complete({...request,canonical_history:[...history,{event_seq:20,text:'新增事件'}]});
  assert.equal(compactCalls,1);
  console.log('AI compact persisted-prefix reuse passed');
} finally { await rm(cacheDir,{recursive:true,force:true}); }
