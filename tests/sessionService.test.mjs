import assert from 'node:assert/strict';
import {
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
  assert.deepEqual(Object.keys(first.event).sort(), ['event_id', 'event_seq', 'event_type', 'origin', 'occurred_at', 'payload', 'source', 'source_sequence'].sort());
  assert.equal(first.event.origin, 'cache');
  assert.equal(first.event.source, cache.cache_uuid);
  assert.equal(first.event.event_seq, 0);
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
  assert.equal(interrupted.event.event_type, 'player_input');
  assert.deepEqual(interruptWithPlayerInput({ repository, session_uuid: SESSION, text: '我等一个答案', client_request_id: 'input-1', expected_revision: 0 }), interrupted);
  assert.throws(() => interruptWithPlayerInput({ repository, session_uuid: SESSION, text: '不同', client_request_id: 'input-1' }), /different request/);
  assert.equal(repository.findOpeningCacheByUuid(cache.cache_uuid).status, 'valid');
  assert.equal(beforeInterrupt.history.length + 1, recoverSession({ repository, session_uuid: SESSION }).history.length);
  assert.throws(() => interruptWithPlayerInput({ repository, session_uuid: SESSION, text: 'again' }), /not interruptible/);

  const recovered = recoverSession({ repository, session_uuid: SESSION });
  assert.equal(recovered.cursor, interrupted.cursor);
  assert.equal(recovered.revision, interrupted.revision);
  assert.deepEqual(recovered.history, listSessionEvents({ repository, session_uuid: SESSION }));
  assert.equal(recovered.generation_profile.cache_uuid, cache.cache_uuid);
  assert.equal(repository.findOpeningCacheByUuid(cache.cache_uuid).status, 'valid');
  console.log('sessionService tests: ok');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
