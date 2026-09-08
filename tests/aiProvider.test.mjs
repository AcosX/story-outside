import assert from 'node:assert/strict';
import { AIProviderError, createAICompletion, createAIProvider, loadAIConfig } from '../src/agent/aiProvider.mjs';
const config = {apiKey:'private-test-secret',baseURL:'https://example.invalid/v1',model:'test-model',timeoutMs:1000,contextChars:1000};
assert.equal(loadAIConfig({STORY_OUTSIDE_AI_PROVIDER:'mock'}),null);
assert.throws(()=>loadAIConfig({STORY_OUTSIDE_AI_PROVIDER:'invalid'}));
const env = { STORY_OUTSIDE_AI_PROVIDER: 'real', STORY_OUTSIDE_AI_API_KEY: 'test', STORY_OUTSIDE_AI_BASE_URL: 'https://example.invalid/v1', STORY_OUTSIDE_AI_MODEL: 'test', STORY_OUTSIDE_AI_SECRET_FILE: '/nonexistent/compact-test-secret' };
assert.equal(loadAIConfig({ ...env, STORY_OUTSIDE_AI_CONTEXT_TOKENS: '128000' }).contextWindow, 128000);
assert.throws(() => loadAIConfig({ ...env, STORY_OUTSIDE_AI_CONTEXT_TOKENS: '3500' }), /token context window/);
const story={content:'完整原作'.repeat(500)};
const calls=[];
const provider=createAIProvider({config,story,fetchImpl:async(url,opts)=>{
  calls.push({url,body:JSON.parse(opts.body)});
  const content={items:[{type:'narration',text:'门开了。'}],tool_call:{name:'ask_player_choice',arguments:{question:'进入吗？',options:[{id:'a',label:'进入'},{id:'b',label:'等待'}]}}};
  return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(content)},finish_reason:'stop'}]})};
}});
const result=await provider.complete({pinned:{role_id:'me'},canonical_history:Array.from({length:20},(_,i)=>({event_seq:i,event_type:'narrative_beat',payload:i===0?{story_progress:0.23}:{},text:'事件'})),context:{compact_text:'保留玩家选择和人物事实',recent_events:Array.from({length:16},(_,i)=>({event_seq:i+4,text:'事件'}))},input:{text:'看看'}});
assert.equal(calls.length,1);
const sent=JSON.parse(calls[0].body.messages[1].content);
assert.deepEqual(sent.original_story,story);
assert.equal(sent.committed_history.length,16);
assert.equal(sent.committed_summary,'保留玩家选择和人物事实');
assert.equal(sent.current_story_progress,0.23, 'latest estimate survives compacted-away event');
assert.match(calls[0].body.messages[0].content, /story_progress/);
assert.ok(result.tool_call.tool_call_id);
assert.ok(!JSON.stringify(calls).includes(config.apiKey));
for(const stub of [async()=>({ok:false,status:401}),async()=>({ok:true,json:async()=>({choices:[{message:{content:'not json'}}]})})]) {
  await assert.rejects(createAIProvider({config,story:{},fetchImpl:stub}).complete({canonical_history:[],input:{},pinned:{}}));
}
console.log('AI provider: config, full original, compact, validated choice, upstream failure and malformed JSON passed');

const retryConfig = { ...config, maxRetries: 2, retryBaseDelayMs: 0, retryMaxDelayMs: 0 };
const completionPayload = { choices: [{ message: { content: JSON.stringify({ items: [{ text: '重试成功。' }] }) }, finish_reason: 'stop' }] };

// Transient upstream responses and transport failures are retried twice at
// most; the request body and model remain unchanged across attempts.
{
  let calls = 0;
  const completion = createAICompletion({
    config: retryConfig,
    fetchImpl: async (_url, options) => {
      calls += 1;
      assert.equal(JSON.parse(options.body).model, config.model);
      if (calls < 3) return { ok: false, status: 503, headers: { get: () => null } };
      return { ok: true, json: async () => completionPayload };
    },
  });
  const result = await completion([{ role: 'user', content: 'test' }], 100);
  assert.deepEqual(result, { items: [{ text: '重试成功。' }] });
  assert.equal(calls, 3);
}

{
  let calls = 0;
  const completion = createAICompletion({
    config: retryConfig,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('socket closed');
      return { ok: true, json: async () => completionPayload };
    },
  });
  await completion([{ role: 'user', content: 'test' }], 100);
  assert.equal(calls, 2);
}

{
  let calls = 0;
  const completion = createAICompletion({
    config: retryConfig,
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 401, headers: { get: () => null } };
    },
  });
  await assert.rejects(
    () => completion([{ role: 'user', content: 'test' }], 100),
    (error) => error instanceof AIProviderError
      && error.status === 401 && error.retryable === false,
  );
  assert.equal(calls, 1);
}

{
  let calls = 0;
  const completion = createAICompletion({
    config: retryConfig,
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'not-json' } }] }) };
    },
  });
  await assert.rejects(
    () => completion([{ role: 'user', content: 'test' }], 100),
    (error) => error instanceof AIProviderError && error.retryable === false,
  );
  assert.equal(calls, 1);
}

{
  let calls = 0;
  const completion = createAICompletion({
    config: retryConfig,
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 503, headers: { get: () => '0' } };
    },
  });
  await assert.rejects(
    () => completion([{ role: 'user', content: 'test' }], 100),
    (error) => error instanceof AIProviderError
      && error.status === 503 && error.retryable === true,
  );
  assert.equal(calls, 3);
}
console.log('AI provider: transient retries, transport retry, and deterministic failures passed');

// Provider never owns session state, even when handed an old compact cache.
const { mkdtemp, rm, writeFile, readdir } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const cacheDir = await mkdtemp(join(tmpdir(), 'story-ai-'));
try {
  await writeFile(join(cacheDir, 'compact-old.json'), JSON.stringify({ summary: 'obsolete file state' }));
  let sent;
  const fresh = createAIProvider({ config: { ...config, cacheDir }, story, fetchImpl: async (_url, opts) => {
    sent = JSON.parse(JSON.parse(opts.body).messages[1].content);
    return { ok: true, json: async () => completionPayload };
  } });
  const history = Array.from({ length: 20 }, (_, i) => ({ event_seq: i, text: '事件' }));
  await fresh.complete({ pinned: {}, canonical_history: history, input: {} });
  assert.equal(sent.committed_summary, null);
  assert.deepEqual(sent.committed_history, history);
  assert.deepEqual(await readdir(cacheDir), ['compact-old.json']);
  console.log('AI provider ignores session file cache and preserves all supplied context');
} finally { await rm(cacheDir, { recursive: true, force: true }); }
