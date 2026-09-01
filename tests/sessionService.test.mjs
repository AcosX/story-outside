import assert from 'node:assert/strict';
import {
  canonicalSha256,
  commitOpeningEvent,
  createInMemoryStoryRepository,
  createSeededRepository,
  createSession,
  defaultGenerationProfile,
  ensureOpeningCache,
  getSession,
  interruptWithPlayerInput,
  listSessionEvents,
  recoverSession,
} from '../src/stories/index.mjs';

const SESSION = '00000000-0000-4000-8000-000000000101';
const OTHER_SESSION = '00000000-0000-4000-8000-000000000102';
const WRONG_UUID = '00000000-0000-4000-8000-000000000999';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function fixture() {
  const { repository, fixtures } = createSeededRepository();
  const story = fixtures.find((item) => item.slug === 'cafe-rain');
  const { cache } = await ensureOpeningCache({ repository, story_version_uuid: story.story_version_uuid });
  const profile = { ...defaultGenerationProfile(), cache_uuid: cache.cache_uuid };
  return { repository, story, cache, profile };
}

async function run() {
  const { repository, story, cache, profile } = await fixture();
  const base = createSession({
    repository, session_uuid: SESSION, story_uuid: story.story_uuid,
    story_version_uuid: story.story_version_uuid, user_ref: 'u-1', role_id: 'stranger',
    model: 'test-model', prompt: 'fixed prompt', generation_profile: profile,
  });
  assert.equal(repository.sessionState.sessions.has(SESSION), true);
  assert.equal(base.story_version_checksum, repository.findVersion(story.story_version_uuid).checksum);
  assert.equal(base.state, 'opening');
  assert.equal(base.cache_uuid, cache.cache_uuid);
  assert.throws(() => createSession({
    repository, session_uuid: SESSION, story_uuid: story.story_uuid,
    story_version_uuid: story.story_version_uuid, user_ref: 'u-1', role_id: 'stranger',
    model: 'changed', prompt: 'changed', generation_profile: profile,
  }), /already exists/);
  assert.throws(() => createSession({
    repository, session_uuid: WRONG_UUID, story_uuid: story.story_uuid,
    story_version_uuid: story.story_version_uuid, user_ref: 'u-1', role_id: 'ghost',
    model: 'm', prompt: 'p', generation_profile: profile,
  }), /role_id/);
  assert.throws(() => createSession({
    repository, session_uuid: '00000000-0000-4000-8000-000000000103', story_uuid: WRONG_UUID,
    story_version_uuid: story.story_version_uuid, user_ref: 'u-1', role_id: 'stranger',
    model: 'm', prompt: 'p', generation_profile: profile,
  }), /story_uuid/);
  assert.throws(() => createSession({
    repository, session_uuid: '00000000-0000-4000-8000-000000000104', story_uuid: story.story_uuid,
    story_version_uuid: story.story_version_uuid, user_ref: 'u-1', role_id: 'stranger',
    model: 'm', prompt: 'p', generation_profile: { ...profile, cache_uuid: WRONG_UUID },
  }), /pinned cache/);

  const events = cache.content_payload.events;
  const shown = (event) => ({ ...event, displayed: true });
  const first = commitOpeningEvent({
    repository, session_uuid: SESSION, cache_uuid: cache.cache_uuid,
    event: shown(events[0]), client_request_id: 'open-1', expected_revision: 0,
  });
  assert.deepEqual(Object.keys(first.event).sort(), ['client_request_id', 'created_at', 'event_id', 'event_seq', 'event_type', 'hash', 'origin', 'occurred_at', 'payload', 'prev_event_seq', 'source', 'source_sequence'].sort());
  assert.match(first.event.event_id, UUID_PATTERN);
  assert.equal(first.event.event_type, 'story_opening');
  assert.equal(first.event.origin, 'imported');
  assert.equal(first.event.source, 'opening_cache');
  assert.equal(first.event.source_sequence, 0);
  assert.equal(first.event.event_seq, 1);
  assert.equal(first.event.prev_event_seq, null);
  assert.equal(first.event.client_request_id, 'open-1');
  assert.match(first.event.created_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(first.event.hash, canonicalSha256({
    event_id: first.event.event_id,
    event_seq: first.event.event_seq,
    prev_event_seq: first.event.prev_event_seq,
    event_type: first.event.event_type,
    origin: first.event.origin,
    source: first.event.source,
    source_sequence: first.event.source_sequence,
    payload: first.event.payload,
    occurred_at: first.event.occurred_at,
    client_request_id: first.event.client_request_id,
  }));
  assert.deepEqual(first.event.payload, { type: events[0].type, text: events[0].text });
  assert.equal(first.cursor, 1);
  assert.equal(first.revision, 1);
  assert.deepEqual(commitOpeningEvent({
    repository, session_uuid: SESSION, cache_uuid: cache.cache_uuid,
    event: shown(events[0]), client_request_id: 'open-1', expected_revision: 0,
  }), first);
  assert.throws(() => commitOpeningEvent({
    repository, session_uuid: SESSION, cache_uuid: cache.cache_uuid,
    event: shown(events[2]), client_request_id: 'wrong-order', expected_revision: 1,
  }), /sequence/);
  assert.throws(() => commitOpeningEvent({
    repository, session_uuid: SESSION, cache_uuid: cache.cache_uuid,
    event: { ...shown(events[1]), text: 'tampered' }, expected_revision: 1,
  }), /payload|pinned/);
  assert.throws(() => commitOpeningEvent({
    repository, session_uuid: SESSION, cache_uuid: cache.cache_uuid,
    event: { ...shown(events[1]), displayed: false }, expected_revision: 1,
  }), /explicitly displayed/);
  assert.throws(() => commitOpeningEvent({
    repository, session_uuid: SESSION, cache_uuid: cache.cache_uuid,
    event: { sequence: 1, type: 'ask_player_choice', displayed: true }, expected_revision: 1,
  }), /ask_player_choice|cache event/);
  assert.throws(() => commitOpeningEvent({
    repository, session_uuid: SESSION, cache_uuid: cache.cache_uuid,
    event: shown(events[1]), expected_revision: 0,
  }), /revision mismatch/);

  createSession({
    repository, session_uuid: OTHER_SESSION, story_uuid: story.story_uuid,
    story_version_uuid: story.story_version_uuid, user_ref: 'u-2', role_id: 'stranger',
    model: 'test-model', prompt: 'fixed prompt', generation_profile: profile,
  });
  const firstEarlyOpening = commitOpeningEvent({
    repository, session_uuid: OTHER_SESSION, cache_uuid: cache.cache_uuid,
    event: shown(events[0]), expected_revision: 0,
  });
  assert.equal(firstEarlyOpening.cursor, 1);
  const interruptedAfterFirstOpening = interruptWithPlayerInput({
    repository, session_uuid: OTHER_SESSION, text: '先打断', expected_revision: 1,
  });
  // Canonical cursor counts ALL committed canonical events (1 opening + 1
  // player_input), so it is 2, not 1; the opening playback position is the
  // separate internal opening_cursor (still 1 here).
  assert.equal(interruptedAfterFirstOpening.cursor, 2);
  assert.equal(interruptedAfterFirstOpening.opening_cursor, 1);
  assert.equal(interruptedAfterFirstOpening.revision, 2);
  assert.equal(interruptedAfterFirstOpening.event.event_seq, 2);
  assert.equal(interruptedAfterFirstOpening.event.prev_event_seq, 1);
  assert.equal(interruptedAfterFirstOpening.event.client_request_id, null);
  assert.match(interruptedAfterFirstOpening.event.created_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(recoverSession({ repository, session_uuid: OTHER_SESSION }).history.length, 2);

  const immediateInterruptSession = '00000000-0000-4000-8000-000000000105';
  createSession({
    repository, session_uuid: immediateInterruptSession, story_uuid: story.story_uuid,
    story_version_uuid: story.story_version_uuid, user_ref: 'u-3', role_id: 'stranger',
    model: 'test-model', prompt: 'fixed prompt', generation_profile: profile,
  });
  const immediateInterrupt = interruptWithPlayerInput({
    repository, session_uuid: immediateInterruptSession, text: '立即打断', expected_revision: 0,
  });
  assert.equal(immediateInterrupt.cursor, 1);
  assert.equal(immediateInterrupt.opening_cursor, 0);
  assert.equal(immediateInterrupt.revision, 1);
  assert.equal(immediateInterrupt.event.event_seq, 1);
  assert.equal(immediateInterrupt.event.prev_event_seq, null);
  assert.equal(immediateInterrupt.event.client_request_id, null);

  let revision = first.revision;
  for (let i = 1; i < events.length; i += 1) {
    const out = commitOpeningEvent({ repository, session_uuid: SESSION, cache_uuid: cache.cache_uuid, event: shown(events[i]), expected_revision: revision });
    revision = out.revision;
    if (i === events.length - 1) assert.equal(out.state, 'awaiting_first_choice');
  }
  assert.equal(getSession({ repository, session_uuid: SESSION }).state, 'awaiting_first_choice');
  assert.equal(listSessionEvents({ repository, session_uuid: SESSION }).length, events.length);
  assert.throws(() => commitOpeningEvent({ repository, session_uuid: SESSION, cache_uuid: cache.cache_uuid, event: shown(events[0]), expected_revision: revision }), /not in opening/);

  const beforeInterrupt = recoverSession({ repository, session_uuid: SESSION });
  const interrupted = interruptWithPlayerInput({ repository, session_uuid: SESSION, text: '我等一个答案', client_request_id: 'input-1', expected_revision: revision });
  assert.equal(interrupted.state, 'realtime');
  assert.match(interrupted.event.event_id, UUID_PATTERN);
  assert.equal(interrupted.event.event_type, 'player_input');
  assert.equal(interrupted.event.origin, 'user');
  assert.equal(interrupted.event.source, 'player');
  // Canonical cursor equals the committed event count: the player_input
  // event_seq equals the post-interrupt cursor exactly.
  assert.equal(interrupted.event.event_seq, interrupted.cursor);
  // player source_sequence is the per-(session, source) counter: this is
  // the FIRST player event of this session, so it is 0 (it never mirrors
  // event_seq / opening count).
  assert.equal(interrupted.event.source_sequence, 0);
  assert.equal(interrupted.event.prev_event_seq, interrupted.event.event_seq - 1);
  assert.equal(interrupted.event.client_request_id, 'input-1');
  assert.match(interrupted.event.created_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(interrupted.event.hash, canonicalSha256({
    event_id: interrupted.event.event_id,
    event_seq: interrupted.event.event_seq,
    prev_event_seq: interrupted.event.prev_event_seq,
    event_type: interrupted.event.event_type,
    origin: interrupted.event.origin,
    source: interrupted.event.source,
    source_sequence: interrupted.event.source_sequence,
    payload: interrupted.event.payload,
    occurred_at: interrupted.event.occurred_at,
    client_request_id: interrupted.event.client_request_id,
  }));
  assert.deepEqual(interruptWithPlayerInput({ repository, session_uuid: SESSION, text: '我等一个答案', client_request_id: 'input-1', expected_revision: 0 }), interrupted);
  assert.throws(() => interruptWithPlayerInput({ repository, session_uuid: SESSION, text: '不同', client_request_id: 'input-1' }), /different request/);
  assert.equal(repository.findOpeningCacheByUuid(cache.cache_uuid).status, 'valid');
  assert.equal(beforeInterrupt.history.length + 1, recoverSession({ repository, session_uuid: SESSION }).history.length);
  // ClickUp 08 P2.6: a realtime session IS interruptible again — the second
  // interrupt stays realtime and appends another player_input (source_sequence
  // 1, the per-(session, source) counter).
  const reInterrupt = interruptWithPlayerInput({ repository, session_uuid: SESSION, text: 'again' });
  assert.equal(reInterrupt.state, 'realtime');
  assert.equal(reInterrupt.event.event_type, 'player_input');
  assert.equal(reInterrupt.event.source_sequence, 1);
  assert.equal(reInterrupt.revision, beforeInterrupt.revision + 2);

  const recovered = recoverSession({ repository, session_uuid: SESSION });
  assert.equal(recovered.cursor, reInterrupt.cursor);
  assert.equal(recovered.revision, reInterrupt.revision);
  assert.deepEqual(recovered.history, listSessionEvents({ repository, session_uuid: SESSION }));
  assert.equal(recovered.generation_profile.cache_uuid, cache.cache_uuid);
  assert.equal(repository.findOpeningCacheByUuid(cache.cache_uuid).status, 'valid');
  console.log('sessionService tests: ok');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
