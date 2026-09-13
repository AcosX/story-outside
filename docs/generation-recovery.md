# Generation and timeout recovery

The public `POST /api/sessions/:uuid/generate` accepts `Prefer: respond-async` with a nonempty `request_id`. Clients must keep the same request ID, input and `expected_revision` for every poll and retry of one logical turn.

- A fast completion still returns the existing 200 envelope.
- After one second, an unfinished operation returns 202 with `status: pending`, `request_id`, `session_uuid` and `Retry-After: 1`. This acknowledges ongoing work, not persisted progress.
- Repeat the same POST until 200 or a terminal error. The model and durable flush share one task. A result is returned only after its database commit succeeds.
- Original request IDs replay their saved turn result. A new keyed request over an unconsumed pending batch fails before calling the model; recover the session and consume its pending batch.
- Clients without `Prefer: respond-async` keep the synchronous response contract. Legacy unkeyed calls retain their existing payload-based staging semantics.

The HTTP task registry is process-local and bounded. Undelivered completed outcomes expire after five minutes; delivered successes replay through the session's existing idempotency store. A process restart during unfinished model work may require a new attempt. Committed results remain recoverable from the database. The player polls for up to ten minutes and retains the logical request identity and input for manual retries; a new revision is part of each new turn ID to prevent reuse after reload.

HTTP 408/504/524 are reported as timeouts, including HTML gateway pages. Non-2xx HTML errors retain their HTTP status; `invalid_json_response` is reserved for successful responses with an invalid body. Automatic retries remain restricted to GET and POST requests carrying a stable identity.

## Persistence

Flushes compare against the last committed snapshot. Changed stories, versions, caches, profiles and sessions are written; unchanged history is skipped, while changed existing events still undergo append-only conflict checks. Unrelated following/search collections are left untouched. First-choice marker changes also mark their session for persistence. An existing session's creation timestamp is retained in upsert candidates so temporal SQL constraints are checked against its actual creation time.

LRU access timestamps do not independently trigger a write. They still update in memory and are included with the next real mutation. A failed transaction never advances the comparison baseline; a queued flush captures mutations that arrived while the earlier transaction committed. Successful business writes still wait for durable persistence.

## Timing

- `http.session.response`: route, status, elapsed time and connection abandonment; excludes URL query strings and response bodies.
- `generation.task`: generation and persistence elapsed times, associated with the session.
- `database.flush`: queue, SQL and commit durations, success and changed entity counts.

These measurements separate model work, write-queue contention and database commit latency. A longer edge timeout can help synchronous bootstrap and older clients, but does not replace short generation polls or make a slow database faster.
