// Explicit EMPTY disposable database only; never auto-create or drop a DB.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import mysql from 'mysql2/promise';
import { loadDatabaseConfig } from '../src/db/mariadb.mjs';
import { createMariaStoryCache } from '../src/db/storyUpstreamCache.mjs';
import { createStoryTransport } from '../src/providers/storyTransport.mjs';
import { createRealZhihuStoryProvider, validateStoryTransportPayload as validate } from '../src/providers/realProvider.mjs';

const databaseUrl=process.env.STORY_OUTSIDE_TEST_DATABASE_URL;
if (!databaseUrl) {
  console.log('skip - story cache integration requires an empty STORY_OUTSIDE_TEST_DATABASE_URL');
} else {
  const pool=mysql.createPool({...loadDatabaseConfig({STORY_OUTSIDE_DATABASE_URL:databaseUrl}),
    ...(process.env.STORY_OUTSIDE_TEST_DATABASE_SOCKET ? {socketPath:process.env.STORY_OUTSIDE_TEST_DATABASE_SOCKET} : {}), multipleStatements:true});
  const url='https://api.zhihu.com/km-indep-home/hackathon/v2/story/list';
  const list=[{work_id:'123',title:'Real story',artwork:'https://example.com/cover',labels:['genre']}];
  const detail={work_id:'123',chapter_name:'Chapter',introduction:'原'.repeat(650),content:'正文'.repeat(4000)};
  const offline=async()=>{throw Error('both exits unavailable')};
  try {
    const cacheStore=createMariaStoryCache(pool);
    if (process.argv.includes('--read-only-child')) {
      const p=createRealZhihuStoryProvider({fetchImpl:createStoryTransport({cacheStore,validate,direct:offline,alternate:offline})});
      const summaries=await p.listStories();const d=await p.getStory('123');
      assert.equal(summaries.length,1);assert.equal(summaries[0].cover_url,list[0].artwork);assert.deepEqual(summaries[0].categories,list[0].labels);
      assert.equal(d.source.introduction,detail.introduction);assert.equal(d.beats[0].text,detail.content);
      console.log('PASS new process: complete MariaDB catalog metadata and正文 with both exits unavailable');
    } else {
      const [tables]=await pool.query('SHOW TABLES');assert.equal(tables.length,0,'An EMPTY disposable database is required');
      await pool.query('CREATE TABLE schema_migrations (migration_name VARCHAR(255) PRIMARY KEY, applied_by BIGINT NULL)');
      const migration=await readFile(new URL('../db/migrations/0010_story_upstream_cache.sql',import.meta.url),'utf8');
      await pool.query(migration);await pool.query(migration);
      const f=createStoryTransport({cacheStore,validate,direct:async target=>Response.json(target===url?list:detail)});
      await f(url);await f(url.replace('/list','/123'));
      const child=spawnSync(process.execPath,[new URL(import.meta.url).pathname,'--read-only-child'],{encoding:'utf8',env:process.env});
      assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/PASS new process/);
      const saved=await cacheStore.get(url);
      await cacheStore.put(url,{...saved,savedAt:saved.savedAt-1000,payload:[]});
      assert.deepEqual((await cacheStore.get(url)).payload,list,'late old response cannot overwrite newer data');
      const bad=createStoryTransport({cacheStore,validate,direct:async()=>Response.json({error:'challenge'}),alternate:offline});
      assert.deepEqual(await (await bad(url)).json(),list);

      // Verify a failed transaction rolls back and does not poison the queue.
      let failCommit=true;
      const failing=createMariaStoryCache({getConnection:async()=>{
        const connection=await pool.getConnection();return {
          query:async opts=>{if(opts.sql==='COMMIT'&&failCommit){failCommit=false;throw Error('injected before COMMIT');}return connection.query(opts);},
          release:()=>connection.release(), destroy:()=>connection.destroy(),
        };
      }});
      const rollbackUrl=url.replace('/list','/rollback');
      await assert.rejects(failing.put(rollbackUrl,{...saved,payload:{},savedAt:Date.now()}));
      assert.equal(await cacheStore.get(rollbackUrl),null);
      await failing.put(rollbackUrl,{...saved,payload:{},savedAt:Date.now()});
      assert.ok(await cacheStore.get(rollbackUrl));

      // Seed enough independent cache rows to exercise bounded retention.
      const values=Array.from({length:257},(_,i)=>[String(i).padStart(64,'0'),url.replace('/list',`/seed-${i}`),`seed-${i}`,saved.savedAt+100+i,JSON.stringify({work_id:`seed-${i}`,chapter_name:'seed',content:''})]);
      await pool.query('INSERT INTO story_upstream_cache (cache_key,source_url,resource_id,fetched_at_ms,payload_json) VALUES ?', [values]);
      await cacheStore.put(url,saved);
      const [[row]]=await pool.query('SELECT COUNT(*) AS n FROM story_upstream_cache');assert.equal(Number(row.n),256);
      assert.ok(await cacheStore.get(url),'complete list is never evicted by detail rows');
      console.log('PASS MariaDB migration rerun, cross-process restore, metadata, stale-write protection, COMMIT rollback/recovery and 256-row retention');
    }
  } finally { await pool.end(); }
}
