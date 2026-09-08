import { canonicalJsonStringify, canonicalSha256 } from '../stories/canonicalHash.mjs';

const EVENT_COLUMNS = [
  'event_id', 'session_id', 'event_seq', 'prev_event_seq', 'event_type', 'origin',
  'source', 'source_sequence', 'payload', 'client_request_id', 'hash', 'occurred_at',
];
const NUMERIC_COLUMNS = new Set(['session_id', 'event_seq', 'prev_event_seq', 'source_sequence']);

function comparableValue(column, value) {
  if (value === null || value === undefined) return null;
  if (NUMERIC_COLUMNS.has(column)) return String(value);
  if (column === 'payload') {
    return canonicalJsonStringify(typeof value === 'string' ? JSON.parse(value) : value);
  }
  if (column === 'occurred_at') return new Date(value).toISOString();
  return value;
}

// session_events is append-only. An existing identical event is a replay;
// every other uniqueness or data constraint failure must abort the flush.
export async function appendSessionEvent(connection, sessionId, event) {
  const record = {
    ...event,
    session_id: sessionId,
    payload: JSON.stringify(event.payload || {}),
    client_request_id: event.client_request_id || null,
    occurred_at: new Date(event.occurred_at),
  };
  try {
    await connection.query(
      `INSERT INTO session_events (${EVENT_COLUMNS.join(', ')})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      EVENT_COLUMNS.map((column) => record[column]),
    );
  } catch (error) {
    if (error.code !== 'ER_DUP_ENTRY') throw error;
    const [rows] = await connection.query(
      `SELECT ${EVENT_COLUMNS.join(', ')} FROM session_events WHERE event_id = ? FOR UPDATE`,
      [event.event_id],
    );
    const existing = rows[0];
    if (!existing || EVENT_COLUMNS.some((column) => (
      comparableValue(column, existing[column]) !== comparableValue(column, record[column])
    ))) {
      throw new Error(`MariaDB persistence: conflicting canonical event ${event.event_id}`, { cause: error });
    }
  }
}

export function pendingRequestFingerprint(sessionUuid, batchUuid, requestPayload) {
  return canonicalSha256({ session_uuid: sessionUuid, batch_uuid: batchUuid, request_payload: requestPayload });
}
