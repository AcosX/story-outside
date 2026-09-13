// Opt-in: run only against the named disposable database, migrated beforehand.
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
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
 const id=randomUUID();
 const first=await adapter();
 first.followingRepository.rememberAccount({user_uuid:id,url_token:'roundtrip-user'});
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
