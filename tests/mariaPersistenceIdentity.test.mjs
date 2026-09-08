import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { appendSessionEvent, pendingRequestFingerprint } from '../src/db/sessionEventPersistence.mjs';

const event = {
  event_id: '10000000-0000-4000-8000-000000000001',
  event_seq: 1,
  prev_event_seq: null,
  event_type: 'player_input',
  origin: 'user',
  source: 'player',
  source_sequence: 0,
  payload: { text: 'hello', metadata: { b: 2, a: 1 } },
  client_request_id: '20000000-0000-4000-8000-000000000001',
  hash: 'a'.repeat(64),
  occurred_at: '2026-09-08T01:00:00.000Z',
};
const stored = { ...event, session_id: 7, payload: JSON.stringify(event.payload), occurred_at: new Date(event.occurred_at) };
const duplicate = Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });

function conflictConnection(existing, insertError = duplicate) {
  let reads = 0;
  return {
    get reads() { return reads; },
    async query(sql, args) {
      if (/^INSERT INTO session_events/.test(sql)) throw insertError;
      assert.match(sql, /WHERE event_id = \? FOR UPDATE$/);
      assert.deepEqual(args, [event.event_id]);
      reads++;
      return [existing ? [existing] : []];
    },
  };
}

// Idempotent replay accepts driver numeric strings and reordered JSON keys.
const replay = conflictConnection({
  ...stored,
  session_id: '7', event_seq: '1', source_sequence: '0',
  payload: { metadata: { a: 1, b: 2 }, text: 'hello' },
});
await appendSessionEvent(replay, 7, event);
assert.equal(replay.reads, 1);

// A duplicate unrelated event (request, sequence, or source-sequence key)
// must not disappear behind INSERT IGNORE and a successful checkpoint.
await assert.rejects(appendSessionEvent(conflictConnection(null), 7, event), /conflicting canonical event/);
for (const [column, value] of Object.entries({
  event_id: 'other-event', session_id: 8, event_seq: 2, prev_event_seq: 0,
  event_type: 'system_event', origin: 'system', source: 'other', source_sequence: 1,
  payload: JSON.stringify({ text: 'changed' }), client_request_id: null,
  hash: 'b'.repeat(64), occurred_at: new Date('2026-09-08T01:00:01.000Z'),
})) {
  await assert.rejects(
    appendSessionEvent(conflictConnection({ ...stored, [column]: value }), 7, event),
    /conflicting canonical event/,
    `${column} mismatch must reject replay`,
  );
}

const constraintError = Object.assign(new Error('invalid row'), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
const invalidRow = conflictConnection(null, constraintError);
await assert.rejects(appendSessionEvent(invalidRow, 7, event), (error) => error === constraintError);
assert.equal(invalidRow.reads, 0);

// Two separate sessions may persist exactly the same client request UUID.
const inserts = [];
await appendSessionEvent({ query: async (sql, args) => { inserts.push({ sql, args }); } }, 7, event);
await appendSessionEvent({ query: async (sql, args) => { inserts.push({ sql, args }); } }, 8, { ...event, event_id: 'other-event' });
assert.equal(inserts.length, 2);
assert.deepEqual(inserts.map(({ args }) => [args[1], args[9]]), [[7, event.client_request_id], [8, event.client_request_id]]);
assert.ok(inserts.every(({ sql }) => !/IGNORE/.test(sql)));

const request = { items: [{ text: 'identical generated content' }], tool_call: null, request_id: null };
const first = pendingRequestFingerprint('session-a', 'batch-a', request);
assert.equal(first, pendingRequestFingerprint('session-a', 'batch-a', structuredClone(request)));
assert.notEqual(first, pendingRequestFingerprint('session-b', 'batch-a', request));
assert.notEqual(first, pendingRequestFingerprint('session-a', 'batch-b', request));

// Both fresh schema and existing installations use the same uniqueness scope.
for (const path of ['../db/schema.sql', '../db/migrations/0007_session_event_request_scope.sql']) {
  const sql = await readFile(new URL(path, import.meta.url), 'utf8');
  assert.match(sql, /UNIQUE KEY uq_session_events_client_request \(session_id, client_request_id\)/);
  assert.match(sql, /'0007_session_event_request_scope'/);
}

console.log('MariaDB event and pending identity regression tests passed');
