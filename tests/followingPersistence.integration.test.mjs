// Opt-in: run only against the named disposable database, migrated beforehand.
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { createZhihuOAuth, ownerFromProfile } from '../src/auth/zhihuOAuth.mjs';
import { createMariaDbRepositories } from '../src/db/mariaPersistence.mjs';
import { createInMemoryStoryRepository } from '../src/stories/repository.mjs';
import { createInMemoryCommunityProfileRepository } from '../src/community/repository.mjs';
import { createInMemoryFollowingRepository } from '../src/ecosystem/following/repository.mjs';
import { createInMemoryEcosystemSearchCacheRepository } from '../src/providers/ecosystem/search.mjs';
const database=process.env.STORY_OUTSIDE_TEST_DATABASE_NAME;
if (!database?.startsWith('story_outside_test_')) throw new Error('Explicit disposable test database required');
const pool=mysql.createPool({socketPath:process.env.STORY_OUTSIDE_TEST_DATABASE_SOCKET,user:'root',database});
const adapter=()=>createMariaDbRepositories({pool,storyRepository:createInMemoryStoryRepository(),communityProfileRepository:createInMemoryCommunityProfileRepository(),followingRepository:createInMemoryFollowingRepository(),ecosystemSearchCacheRepository:createInMemoryEcosystemSearchCacheRepository()});
try {
 const [existing]=await pool.query('SELECT COUNT(*) AS n FROM ecosystem_account_preferences');
 assert.equal(Number(existing[0].n),0,'test starts with no account rows');
 const profile={uid:'1234567890123456789',hash_id:'0123456789abcdef0123456789abcdef',url:'https://openapi.zhihu.com/users/1234567890123456789'};
 const id=ownerFromProfile(profile,'413').user_uuid;
 const first=await adapter();
 const config={appId:'413',appKey:'fixture-app-key',redirectUri:'https://story.example/auth/callback',origin:'https://story.example'};
 const oauth=createZhihuOAuth(config,{onLogin:owner=>first.followingRepository.rememberAccount(owner),fetchImpl:async url=>Response.json(
  url.endsWith('/access_token')?{access_token:'fixture-token',expires_in:3600}:url==='https://openapi.zhihu.com/user'?profile:{id:profile.hash_id,url_token:'roundtrip-user'}
 )});
 const makeResponse=()=>({headers:{},getHeader(k){return this.headers[k]},setHeader(k,v){this.headers[k]=v}});
 const start=makeResponse();
 const authorize=new URL(oauth.start({headers:{}},start,new URL('https://story.example/auth/login')));
 await oauth.callback({headers:{cookie:start.headers['Set-Cookie'][0].split(';')[0]}},makeResponse(),new URL(config.redirectUri+'?code=fixture-code&state='+authorize.searchParams.get('state')));
 assert.equal(first.followingRepository.resolveAccount('roundtrip-user'),id);
 first.followingRepository.setVisibility(id,false);
 await first.flush();
 const second=await adapter();
 assert.equal(second.followingRepository.isVisible(id),false);
 assert.equal(second.followingRepository.resolveAccount('roundtrip-user'),id);
 second.followingRepository.rememberAccount({user_uuid:id,url_token:'renamed-user'});
 await second.flush();
 const third=await adapter();
 assert.equal(third.followingRepository.isVisible(id),false);
 assert.equal(third.followingRepository.resolveAccount('roundtrip-user'),null);
 assert.equal(third.followingRepository.resolveAccount('renamed-user'),id);
 third.followingRepository.setVisibility(id,true);
 await third.flush();
 assert.equal((await adapter()).followingRepository.isVisible(id),true);
 console.log('MariaDB following visibility and directory restart roundtrip PASS');
} finally {await pool.end();}
