// Opt-in only: point STORY_OUTSIDE_TEST_DATABASE_URL at an EMPTY disposable
// MariaDB database. This test leaves its fixtures for inspection, never drops data.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import mysql from 'mysql2/promise';
import { createAIProvider } from '../src/agent/aiProvider.mjs';
import { createAgentRuntime, runTurn } from '../src/agent/runtime.mjs';
import { getSession, getSessionCompact } from '../src/stories/sessionService.mjs';
import { loadDatabaseConfig, connectDatabase, closeDatabase } from '../src/db/mariadb.mjs';
import { createMariaDbRepositories } from '../src/db/mariaPersistence.mjs';
import { appendSessionEvent } from '../src/db/sessionEventPersistence.mjs';
import { createInMemoryCommunityProfileRepository } from '../src/community/repository.mjs';
import { createInMemoryFollowingRepository } from '../src/ecosystem/following/repository.mjs';
import { createInMemoryEcosystemSearchCacheRepository } from '../src/providers/ecosystem/search.mjs';
import {
  createSeededRepository, createInMemoryStoryRepository, ensureOpeningCache,
  createSession, interruptWithPlayerInput, listSessionEvents, stageNarrativeBatch,
  discardPendingTail, recoverPendingSession,
} from '../src/stories/index.mjs';

const databaseUrl = process.env.STORY_OUTSIDE_TEST_DATABASE_URL;
if (!databaseUrl) {
  console.log('skip - MariaDB integration requires STORY_OUTSIDE_TEST_DATABASE_URL');
} else {
  const config = loadDatabaseConfig({ STORY_OUTSIDE_DATABASE_URL: databaseUrl });
  const pool = mysql.createPool(config);
  try {
    const [tables] = await pool.query('SHOW TABLES');
    assert.equal(tables.length, 0, 'Integration tests require an empty disposable database');
    // Bootstrap the pre-fix schema, including its original global request key.
    const migrations = new URL('../db/migrations/', import.meta.url);
    const connection = await pool.getConnection();
    try {
      for (const name of (await readdir(migrations)).filter((name) => /^000[1-6]_.*\.sql$/.test(name)).sort()) {
        let delimiter = ';';
        let buffer = '';
        for (const line of (await readFile(new URL(name, migrations), 'utf8')).split(/\r?\n/)) {
          const directive = line.match(/^\s*DELIMITER\s+(\S+)\s*$/i);
          if (directive) { delimiter = directive[1]; continue; }
          buffer += `${line}\n`;
          if (buffer.trimEnd().endsWith(delimiter)) {
            await connection.query(buffer.trimEnd().slice(0, -delimiter.length));
            buffer = '';
          }
        }
        assert.equal(buffer.trim(), '');
      }
    } finally { connection.release(); }

    await assert.rejects(connectDatabase({ STORY_OUTSIDE_DATABASE_URL: databaseUrl }), /SCHEMA_MIGRATION_REQUIRED/);
    async function adapter(repository) {
      return createMariaDbRepositories({ pool, storyRepository: repository,
        communityProfileRepository: createInMemoryCommunityProfileRepository(),
        followingRepository: createInMemoryFollowingRepository(),
        ecosystemSearchCacheRepository: createInMemoryEcosystemSearchCacheRepository() });
    }
    const seeded = createSeededRepository();
    const db = await adapter(seeded.repository);
    const repository = db.storyRepository;
    const story = seeded.fixtures.find((item) => item.slug === 'cafe-rain');
    const { cache } = await ensureOpeningCache({ repository, story_version_uuid: story.story_version_uuid });
    const sessions = [randomUUID(), randomUUID()];
    const requestId = randomUUID();
    function addSession(session_uuid) {
      createSession({ repository, session_uuid, story_uuid: story.story_uuid,
        story_version_uuid: story.story_version_uuid, user_ref: 'integration-user',
        role_id: 'stranger', model: 'mock', prompt: 'integration',
        generation_profile: { ...cache.generation_profile, cache_uuid: cache.cache_uuid } });
      interruptWithPlayerInput({ repository, session_uuid, text: 'same input',
        client_request_id: requestId, expected_revision: 0 });
    }
    addSession(sessions[0]);
    await db.flush();
    const original = listSessionEvents({ repository, session_uuid: sessions[0] })[0];
    const root = new URL('../', import.meta.url);
    for (let pass = 0; pass < 2; pass++) {
      const result = spawnSync(process.execPath, ['scripts/migrate.mjs'], {
        cwd: root, encoding: 'utf8', env: { ...process.env, STORY_OUTSIDE_DATABASE_URL: databaseUrl },
      });
      assert.equal(result.status, 0, `migration pass ${pass + 1} failed: ${result.stderr}`);
    }
    await connectDatabase({ STORY_OUTSIDE_DATABASE_URL: databaseUrl });
    await closeDatabase();
    // Also exercise direct SQL reapplication (without the migration registry).
    const upgrade = await readFile(new URL('0007_session_event_request_scope.sql', migrations), 'utf8');
    const direct = await mysql.createConnection({ ...config, multipleStatements: true });
    try { await direct.query(upgrade); } finally { await direct.end(); }
    const [keys] = await pool.query("SHOW INDEX FROM session_events WHERE Key_name = 'uq_session_events_client_request'");
    assert.deepEqual(keys.sort((a, b) => a.Seq_in_index - b.Seq_in_index).map((row) => row.Column_name), ['session_id', 'client_request_id']);
    addSession(sessions[1]);
    const events = [{ type: 'narration', sequence: 0, text: 'identical pending content' }];
    const batches = sessions.map((session_uuid) => stageNarrativeBatch({ repository,
      session_uuid, events, source: 'runtime', expected_revision: 1 }));
    await db.flush();
    const [eventRows] = await pool.query('SELECT event_id FROM session_events WHERE client_request_id = ?', [requestId]);
    assert.equal(eventRows.length, 2);
    assert.ok(eventRows.some((row) => row.event_id === original.event_id), 'upgrade preserves existing canonical events');
    const [batchRows] = await pool.query(`SELECT pb.batch_uuid, pb.session_id, pb.request_fingerprint,
      COUNT(pi.id) AS item_count FROM pending_batches pb
      JOIN pending_batch_items pi ON pi.batch_id = pb.id GROUP BY pb.id`);
    assert.equal(batchRows.length, 2);
    assert.equal(new Set(batchRows.map((row) => row.session_id)).size, 2);
    assert.equal(new Set(batchRows.map((row) => row.request_fingerprint)).size, 2);
    for (const batch of batches) assert.equal(Number(batchRows.find((row) => row.batch_uuid === batch.pending_id)?.item_count), 1);

    const restored = await adapter(createInMemoryStoryRepository());
    for (const [index, session_uuid] of sessions.entries()) {
      const history = listSessionEvents({ repository: restored.storyRepository, session_uuid });
      assert.equal(history.length, 1);
      assert.equal(history[0].client_request_id, requestId);
      assert.equal(recoverPendingSession({ repository: restored.storyRepository, session_uuid }).pending.pending_id, batches[index].pending_id);
    }
    // Force a resync to exercise identical canonical-event replay after restart.
    restored.followingRepository.upsertFollow(randomUUID(), randomUUID());
    await restored.flush();
    const [[unchanged]] = await pool.query('SELECT COUNT(*) AS total FROM session_events');
    assert.equal(Number(unchanged.total), 2);
    // A later batch with identical content in the SAME session remains distinct.
    discardPendingTail({ repository, session_uuid: sessions[0] });
    const replacement = stageNarrativeBatch({ repository, session_uuid: sessions[0],
      events, source: 'runtime', expected_revision: 1 });
    await db.flush();
    const [[counts]] = await pool.query('SELECT COUNT(*) AS total FROM pending_batches');
    assert.equal(Number(counts.total), 3);
    const [[replacementRow]] = await pool.query('SELECT id FROM pending_batches WHERE batch_uuid = ?', [replacement.pending_id]);
    assert.ok(replacementRow);
    const tx = await pool.getConnection();
    try {
      const [[session]] = await tx.query('SELECT id FROM game_sessions WHERE session_uuid = ?', [sessions[0]]);
      await tx.beginTransaction();
      await assert.rejects(appendSessionEvent(tx, session.id, { ...original, payload: { text: 'conflicting payload' } }), /conflicting canonical event/);
      await tx.rollback();
      const [[persisted]] = await tx.query('SELECT payload FROM session_events WHERE event_id = ?', [original.event_id]);
      assert.deepEqual(typeof persisted.payload === 'string' ? JSON.parse(persisted.payload) : persisted.payload, original.payload);
    } finally { tx.release(); }
    // Exercise runtime -> real provider -> SQL compact -> fresh adapter -> next
    // real provider request. HTTP is stubbed; persistence uses the isolated DB.
    const compactIdentity = { repository, session_uuid: sessions[0] };
    for (let i = 0; i < 19; i++) interruptWithPlayerInput({ ...compactIdentity,
      text: `SQL compact player choice ${i}`, expected_revision: getSession(compactIdentity).revision });
    const beforeCompact = listSessionEvents(compactIdentity);
    const aiRequests = [];
    let invalidCompact = false;
    const makeProvider = () => createAIProvider({ config: { apiKey: 'test', baseURL: 'https://example.invalid/v1',
      model: 'mock', timeoutMs: 1000, contextChars: 1000, maxRetries: 0 },
      story: { text: '原作'.repeat(1000) }, fetchImpl: async (_url, opts) => {
        const messages = JSON.parse(opts.body).messages;
        const compact = messages[0].content.includes('事实摘要');
        aiRequests.push({ compact, payload: JSON.parse(messages[1].content) });
        const result = compact ? { summary: invalidCompact ? '' : 'SQL保存的事实摘要' } : { items: [{ text: '继续剧情' }] };
        return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] }) };
      } });
    const generate = (identity, request_id = randomUUID()) => {
      const session = getSession(identity);
      return runTurn(createAgentRuntime({ ...identity, provider: makeProvider(), system_prompt: {}, tool_definitions: [],
        expected_story_version_uuid: session.story_version_uuid, expected_story_version_checksum: session.story_version_checksum,
        expected_model: session.model, expected_generation_profile: session.generation_profile }),
        { request_id, input: { text: '继续' }, expected_revision: session.revision });
    };
    const compactRequest = randomUUID();
    const generated = await generate(compactIdentity, compactRequest);
    await db.flush();
    const [[compactRow]] = await pool.query('SELECT context_compact_text, compacted_through_seq FROM game_sessions WHERE session_uuid = ?', [sessions[0]]);
    assert.equal(compactRow.context_compact_text, 'SQL保存的事实摘要');
    assert.equal(Number(compactRow.compacted_through_seq), 4);
    const [[audit]] = await pool.query(`SELECT COUNT(*) AS total FROM compact_compacted_events c
      JOIN game_sessions s ON s.id = c.session_id WHERE s.session_uuid = ?`, [sessions[0]]);
    assert.equal(Number(audit.total), 1);
    const freshDb = await adapter(createInMemoryStoryRepository());
    const freshIdentity = { repository: freshDb.storyRepository, session_uuid: sessions[0] };
    // created_at is DB insertion metadata, not part of the canonical event
    // hash or replay contract; occurred_at and every canonical field must match.
    const canonicalEvents = events => events.map(({ created_at, ...event }) => event);
    const hydratedHistory = listSessionEvents(freshIdentity);
    assert.deepEqual(canonicalEvents(hydratedHistory), canonicalEvents(beforeCompact));
    assert.deepEqual(await generate(freshIdentity, compactRequest), generated);
    assert.equal(aiRequests.length, 2, 'hydrated replay makes no model call');
    discardPendingTail(freshIdentity);
    await generate(freshIdentity);
    assert.equal(aiRequests.length, 3, 'hydrated compact is reused without regeneration');
    assert.equal(aiRequests[2].payload.committed_summary, compactRow.context_compact_text);
    assert.deepEqual(aiRequests[2].payload.committed_history, hydratedHistory.slice(4));
    for (let i = 0; i < 16; i++) interruptWithPlayerInput({ ...freshIdentity,
      text: `after restart ${i}`, expected_revision: getSession(freshIdentity).revision });
    invalidCompact = true;
    await assert.rejects(generate(freshIdentity), error => error.code === 'provider_failure');
    await freshDb.flush();
    const failedDb = await adapter(createInMemoryStoryRepository());
    const failure = getSessionCompact({ repository: failedDb.storyRepository, session_uuid: sessions[0] });
    assert.equal(failure.last_compact_status, 'failed');
    assert.equal(failure.context_compact_text, compactRow.context_compact_text);
    assert.equal(failure.compacted_through_seq, 4);
    assert.equal(getSessionCompact({ repository: failedDb.storyRepository, session_uuid: sessions[1] }).context_compact_text, null);
    console.log('ok - MariaDB runtime compact, SQL audit, fresh adapter reuse, canonical retention and failure persistence');
    console.log('ok - MariaDB legacy upgrade, idempotent migrations, session request isolation, pending isolation, rehydration and conflict rollback');
  } finally { await pool.end(); }
}
