import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAIProvider } from '../src/agent/aiProvider.mjs';
import { createInMemoryFollowingRepository } from '../src/ecosystem/following/repository.mjs';
import { createFollowingService } from '../src/ecosystem/following/service.mjs';
import { createMariaDbRepositories } from '../src/db/mariaPersistence.mjs';
import { createInMemoryStoryRepository } from '../src/stories/repository.mjs';
import { createInMemoryCommunityProfileRepository } from '../src/community/repository.mjs';
import { createInMemoryEcosystemSearchCacheRepository } from '../src/providers/ecosystem/search.mjs';

const alice = randomUUID(), bob = randomUUID();
const repository = createInMemoryFollowingRepository();
repository.rememberAccount({ user_uuid: bob, url_token: 'bob' });
const activities = [{session_uuid: randomUUID(), owner_user_uuid: bob, story_uuid: randomUUID(), updated_at: '2026-09-13T00:00:00Z'}];
const service = createFollowingService({ repository, accountDirectory: {resolve: t => repository.resolveAccount(t)},
  fetchFollowees: async () => ({ items: [{url_token:'bob',fullname:'Bob'}] }), listActivities: () => activities });
const feed = () => service.friendTimelinesSafe({ followerUuid:alice, oauthToken:'test' });
assert.equal((await feed()).items.length,1,'new activity visible without explicit sharing');
repository.setVisibility(bob,false);
assert.equal((await feed()).items.length,0,'hidden immediately, including cached feed');
assert.equal(repository.isVisible(alice),true,'other account unchanged');
repository.rememberAccount({user_uuid:bob,url_token:'bob-new'});
assert.equal(repository.isVisible(bob),false,'re-login preserves hidden state');
assert.equal(repository.resolveAccount('bob'),null,'old handle removed');
const restored = createInMemoryFollowingRepository();
restored._hydrateSnapshot(repository._exportSnapshot());
assert.equal(restored.isVisible(bob),false);
assert.equal(restored.resolveAccount('bob-new'),bob);
repository.setVisibility(bob,true);
assert.equal((await feed()).items.length,0,'old followee handle no longer matches');
repository.rememberAccount({user_uuid:bob,url_token:'bob'});
repository.upsertBlock(bob,alice);
assert.equal((await feed()).items.length,0,'blocks still win over visibility');
repository.removeBlock(bob,alice);
assert.equal((await feed()).items.length,1);

// Adapter roundtrip: preferences and handle survive a new repository instance.
let stored = [];
const pool = {query: async sql => [sql.includes('FROM ecosystem_account_preferences') ? stored : []],
 getConnection: async () => ({beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release(){},
 query:async(sql,values)=>{if(sql==='DELETE FROM ecosystem_account_preferences') stored=[];
 if(sql.startsWith('INSERT INTO ecosystem_account_preferences')) stored.push({user_uuid:values[0],url_token:values[1],visible:values[2]?1:0});return [[]];}})};
const adapter = () => createMariaDbRepositories({pool,storyRepository:createInMemoryStoryRepository(),communityProfileRepository:createInMemoryCommunityProfileRepository(),followingRepository:createInMemoryFollowingRepository(),ecosystemSearchCacheRepository:createInMemoryEcosystemSearchCacheRepository()});
const first = await adapter();
first.followingRepository.rememberAccount({user_uuid:bob,url_token:'bob'});
first.followingRepository.setVisibility(bob,false);
await first.flush();
const second = await adapter();
assert.equal(second.followingRepository.isVisible(bob),false);
assert.equal(second.followingRepository.resolveAccount('bob'),bob);

// Screenshot regression: invalid structure and wrong narrative voice retry before staging.
const config = {apiKey:'test',model:'test',baseURL:'https://test.invalid',timeoutMs:1000,maxRetries:2,retryBaseDelayMs:0,retryMaxDelayMs:0};
const story = {roles:[{id:'mother',label:'林岚'},{id:'father',label:'陈平'}],first_person_role_id:'mother'};
let calls=0;
const provider = createAIProvider({config,story,fetchImpl:async()=>{
 const result = ++calls===1 ? {items:[]} : calls===2 ? {items:[{type:'narration',text:'你轻声说完，准备退出房间。'}]} : {
 items:[{type:'narration',text:'我轻声说完，准备退出房间。'}],tool_call:{name:'ask_player_choice',arguments:{question:'接下来，你想怎么做？',options:[{id:'a',label:'我问他有什么事。'},{id:'b',label:'我留在门口等他。'}]}}};
 return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(result)}}]})};}});
const result=await provider.complete({pinned:{role_id:'mother'},input:{text:'继续'}});
assert.equal(calls,3);
assert.equal(result.tool_call.arguments.question,'接下来，你想怎么做？');
assert.match(result.items[0].text,/^我/);
console.log('Online fixes: visibility, account isolation, persistence, block, model structure and perspective retry PASS');
