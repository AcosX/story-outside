import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  renderOpeningEvents,
  renderOpeningText,
  sourceSentences,
  splitSentences,
} from '../src/stories/openingFirstPerson.mjs';
import { generateOpeningCache } from '../src/stories/openingGenerator.mjs';
import { createInMemoryStoryRepository } from '../src/stories/repository.mjs';
import { bootstrapSessionFromWork, commitOpeningEvent, listSessionEvents, recoverSession } from '../src/stories/sessionService.mjs';
import { defaultGenerationProfile } from '../src/stories/storyService.mjs';

const SOURCE = '我推开诊室的门，雨水顺着衣角滴落。林医生正在桌后整理病历。他抬头问我哪里不舒服。我没有回答，只把信放在桌沿。走廊里忽然响起脚步声。门缝下露出一截黑色衣摆。';

// ---------------------------------------------------------------------
// Scene helpers shared with the per-role generation prompts.
// ---------------------------------------------------------------------
{
  assert.deepEqual(splitSentences('甲。乙？丙！'), ['甲。', '乙？', '丙！']);
  assert.deepEqual(splitSentences('没有终止符'), ['没有终止符']);
  assert.deepEqual(splitSentences('  '), []);
  // Closing punctuation stays attached to its sentence.
  assert.deepEqual(splitSentences('他说「走吧。」然后离开。'), ['他说「走吧。」', '然后离开。']);
  console.log('Opening tracks: sentence splitting keeps terminal punctuation');
}

{
  // The scan stops at the first choice; nothing at or beyond it is public.
  const beats = [
    { text: '甲。乙。' },
    { type: 'ask_player_choice', text: '你要怎么做？' },
    { text: '这句不该出现。' },
  ];
  assert.deepEqual(sourceSentences(beats), ['甲。', '乙。']);
  assert.deepEqual(sourceSentences([]), []);
  assert.deepEqual(sourceSentences(null), []);
  console.log('Opening tracks: source scan stops before the first choice');
}

// ---------------------------------------------------------------------
// Read-time projection: per-role track first, then legacy fallbacks.
// ---------------------------------------------------------------------
{
  const payload = {
    text: '陈远推开门。',
    text_by_role: { traveler: '我推开门。', doctor: '你擦着柜台，看见陈远推开门。' },
    text_first_person: '我推开门。',
  };
  // Generated per-role tracks win for every role that has one.
  assert.equal(renderOpeningText(payload, { role_id: 'traveler', first_person_role_id: 'traveler' }), '我推开门。');
  assert.equal(renderOpeningText(payload, { role_id: 'doctor', first_person_role_id: 'traveler' }), '你擦着柜台，看见陈远推开门。');
  // A role without a generated track falls back to the neutral base.
  assert.equal(renderOpeningText(payload, { role_id: 'nurse', first_person_role_id: 'traveler' }), '陈远推开门。');
  // Legacy verbatim rows keep serving the first-person slice to the narrator.
  assert.equal(
    renderOpeningText({ text: '陈远推开门。', text_first_person: '我推开门。' }, { role_id: 'traveler', first_person_role_id: 'traveler' }),
    '我推开门。',
  );
  assert.equal(
    renderOpeningText({ text: '陈远推开门。', text_first_person: '我推开门。' }, { role_id: 'doctor', first_person_role_id: 'traveler' }),
    '陈远推开门。',
  );
  // Degenerate inputs never yield undefined.
  assert.equal(renderOpeningText({ text: '只有一轨。' }, { role_id: 'traveler', first_person_role_id: 'traveler' }), '只有一轨。');
  assert.equal(renderOpeningText(null, { role_id: 'a', first_person_role_id: 'a' }), '');
  console.log('Opening tracks: read-time projection prefers text_by_role and falls back cleanly');
}

{
  const events = [{ sequence: 0, type: 'narration', text: '中立。', text_by_role: { traveler: '第一人称。' } }];
  const rendered = renderOpeningEvents(events, { role_id: 'traveler', first_person_role_id: 'traveler' });
  assert.equal(rendered[0].display_text, '第一人称。');
  // Both the base and the per-role tracks are retained so the client can echo
  // the event back and still match the pinned cache byte for byte.
  assert.equal(rendered[0].text, '中立。');
  assert.equal(rendered[0].text_by_role.traveler, '第一人称。');
  assert.deepEqual(renderOpeningEvents(null, {}), []);
  console.log('Opening tracks: rendered events keep all tracks for strict commit');
}

// ---------------------------------------------------------------------
// Generator carries the per-role tracks into the cache payload and hash.
// ---------------------------------------------------------------------
{
  const story = {
    id: 'x', title: 't', hook: 'h',
    roles: [{ id: 'traveler', label: '陈远', mood: '' }],
    first_person_role_id: 'traveler',
    ai_opening_events: [
      { index: 0, type: 'narration', text: '陈远推开门。', text_by_role: { traveler: '我推开门。' } },
      { index: 1, type: 'ask_player_choice', text: '等待玩家的第一个选择。' },
    ],
    beats: [{ index: 0, text: SOURCE }],
  };
  const cache = generateOpeningCache({
    story_uuid: randomUUID(), story_version_uuid: randomUUID(),
    opening_key: 'default', profile: defaultGenerationProfile(), story,
  });
  assert.equal(cache.event_count, 1);
  assert.equal(cache.events[0].text_by_role.traveler, '我推开门。');
  assert.equal(cache.boundary, 'truncated_before_first_choice');
  // The per-role tracks are content, so they change the content hash.
  const other = generateOpeningCache({
    story_uuid: cache.story_uuid, story_version_uuid: cache.story_version_uuid,
    opening_key: 'default', profile: defaultGenerationProfile(),
    story: { ...story, ai_opening_events: [{ index: 0, type: 'narration', text: '陈远推开门。', text_by_role: { traveler: '我推门。' } }] },
  });
  assert.notEqual(cache.hash.content_hash, other.hash.content_hash);
  console.log('Opening tracks: generator carries text_by_role into the cache and its hash');
}

// ---------------------------------------------------------------------
// End-to-end: one shared cache, per-role reading experiences, strict commit.
// ---------------------------------------------------------------------
{
  const roles = [{ id: 'traveler', label: '陈远', mood: '旅人' }, { id: 'doctor', label: '林医生', mood: '医生' }];
  const detail = {
    id: 'clinic', title: '雨夜诊室', hook: '一封信',
    roles,
    first_person_role_id: 'traveler',
    beats: [{ index: 0, text: SOURCE }],
    ai_opening_events: [
      {
        index: 0, type: 'narration', text: '陈远推开诊室的门。',
        text_by_role: {
          traveler: '我推开诊室的门，雨水顺着衣角滴落。',
          doctor: '你正在桌后整理病历，听见诊室的门被推开。',
        },
      },
      {
        index: 1, type: 'narration', text: '林医生抬起头。',
        text_by_role: {
          traveler: '林医生从病历上抬起头。',
          doctor: '你停下笔，抬起头看向来人。',
        },
      },
      { index: 2, type: 'ask_player_choice', text: '等待玩家的第一个选择。' },
    ],
    ai_preparation_version: 'story-preparation-v6',
  };
  const provider = { name: 'real', getStory: async () => detail };

  const bootstrapFor = async (role_id) => {
    const repository = createInMemoryStoryRepository();
    const session_uuid = randomUUID();
    const result = await bootstrapSessionFromWork({
      repository, provider, session_uuid, work_id: 'clinic', role_id,
      identity: { user_ref: `player-${role_id}` },
    });
    return { repository, session_uuid, result };
  };

  const asTraveler = await bootstrapFor('traveler');
  const asDoctor = await bootstrapFor('doctor');

  // Same work-level cache identity for both roles: role never splits the cache.
  assert.equal(asTraveler.result.cache_uuid !== null, true);
  assert.equal(asTraveler.result.opening_events.length, asDoctor.result.opening_events.length, 'both roles must see the same number of opening beats');

  // The player who picked "我" reads a first-person GENERATED opening.
  assert.equal(asTraveler.result.opening_events[0].display_text, '我推开诊室的门，雨水顺着衣角滴落。');
  // Everyone else reads their own second-person perspective track.
  assert.equal(asDoctor.result.opening_events[0].display_text, '你正在桌后整理病历，听见诊室的门被推开。');
  assert.ok(!asDoctor.result.opening_events.some((event) => event.display_text.includes('主角')));
  assert.ok(!asDoctor.result.opening_events.some((event) => event.display_text.includes('我')));

  // Committing still validates against the pinned cache byte for byte: the
  // client echoes the event it received, including all tracks.
  const commitAll = ({ repository, session_uuid, result }) => {
    let revision = result.session.revision;
    for (const event of result.opening_events) {
      const committed = commitOpeningEvent({
        repository,
        session_uuid,
        cache_uuid: result.cache_uuid,
        event: { ...event, displayed: true },
        client_request_id: `opening-${session_uuid}-${event.sequence}`,
        expected_revision: revision,
      });
      revision = committed.revision;
    }
    return revision;
  };
  commitAll(asTraveler);
  commitAll(asDoctor);

  // Recovery and the model-facing history both stay on the reader's track.
  const travelerHistory = recoverSession({ repository: asTraveler.repository, session_uuid: asTraveler.session_uuid }).history;
  const doctorHistory = recoverSession({ repository: asDoctor.repository, session_uuid: asDoctor.session_uuid }).history;
  assert.equal(travelerHistory[0].payload.text_by_role.traveler, '我推开诊室的门，雨水顺着衣角滴落。');
  assert.equal(travelerHistory[0].payload.text_by_role.doctor, '你正在桌后整理病历，听见诊室的门被推开。');

  const travelerModelView = listSessionEvents({ repository: asTraveler.repository, session_uuid: asTraveler.session_uuid });
  const doctorModelView = listSessionEvents({ repository: asDoctor.repository, session_uuid: asDoctor.session_uuid });
  assert.equal(travelerModelView[0].payload.text, '我推开诊室的门，雨水顺着衣角滴落。');
  assert.equal(doctorModelView[0].payload.text, '你正在桌后整理病历，听见诊室的门被推开。');
  console.log('Opening tracks: one shared cache serves per-role perspectives end to end');
}

// ---------------------------------------------------------------------
// Legacy opening-rules/2 verbatim rows and single-track rows keep working.
// ---------------------------------------------------------------------
{
  const detail = {
    id: 'legacy', title: '旧作', hook: 'h',
    roles: [{ id: 'traveler', label: '陈远', mood: '' }, { id: 'doctor', label: '林医生', mood: '' }],
    first_person_role_id: 'traveler',
    beats: [{ index: 0, text: SOURCE }],
    // opening-rules/2 shape: verbatim first-person slice, no text_by_role.
    ai_opening_events: [
      { index: 0, type: 'narration', text: '陈远推开诊室的门。', text_first_person: '我推开诊室的门。' },
      { index: 1, type: 'ask_player_choice', text: '等待玩家的第一个选择。' },
    ],
    ai_preparation_version: 'story-preparation-v5',
  };
  const repository = createInMemoryStoryRepository();
  const session_uuid = randomUUID();
  const result = await bootstrapSessionFromWork({
    repository, provider: { name: 'real', getStory: async () => detail },
    session_uuid, work_id: 'legacy', role_id: 'traveler',
    identity: { user_ref: 'legacy-player' },
  });
  assert.equal(result.opening_events[0].display_text, '我推开诊室的门。');
  commitOpeningEvent({
    repository, session_uuid, cache_uuid: result.cache_uuid,
    event: { ...result.opening_events[0], displayed: true },
    client_request_id: 'legacy-0', expected_revision: result.session.revision,
  });
  const history = recoverSession({ repository, session_uuid }).history;
  assert.equal(history[0].payload.text, '我推开诊室的门。');
  console.log('Opening tracks: legacy verbatim rows still render and commit');
}

// ---------------------------------------------------------------------
// PR46 review — a THIRD-PERSON source has no narrator role, but
// opening-rules/3 still gives every role a generated `text_by_role` track.
// Recovery and the model-facing history must stay on that track instead of
// falling back to the neutral base the moment `first_person_role_id` is null.
// ---------------------------------------------------------------------
{
  const roles = [
    { id: 'traveler', label: '陈远', mood: '旅人' },
    { id: 'doctor', label: '林医生', mood: '值班医生' },
  ];
  const detail = {
    id: 'clinic-third', title: '第三人称诊室', hook: '简介',
    roles,
    first_person_role_id: null,
    beats: [{ index: 0, text: '陈远推开诊室的门。林医生正在桌后整理病历。' }],
    ai_opening_events: [
      {
        index: 0, type: 'narration', text: '陈远推开诊室的门，雨水顺着衣角滴落。',
        text_by_role: {
          traveler: '你推开诊室的门，雨水顺着衣角滴落。',
          doctor: '你正在桌后整理病历，听见诊室的门被推开。',
        },
      },
      { index: 1, type: 'ask_player_choice', text: '等待玩家的第一个选择。' },
    ],
    ai_preparation_version: 'story-preparation-v6',
  };
  const provider = { name: 'real', getStory: async () => detail };

  const bootstrapFor = async (role_id) => {
    const repository = createInMemoryStoryRepository();
    const session_uuid = randomUUID();
    const result = await bootstrapSessionFromWork({
      repository, provider, session_uuid, work_id: 'clinic-third', role_id,
      identity: { user_ref: `player-${role_id}` },
    });
    let revision = result.session.revision;
    for (const event of result.opening_events) {
      const committed = commitOpeningEvent({
        repository, session_uuid, cache_uuid: result.cache_uuid,
        event: { ...event, displayed: true },
        client_request_id: `third-${session_uuid}-${event.sequence}`,
        expected_revision: revision,
      });
      revision = committed.revision;
    }
    return { repository, session_uuid, result };
  };

  const asTraveler = await bootstrapFor('traveler');
  const asDoctor = await bootstrapFor('doctor');

  // First read already projects per role even without a narrator role.
  assert.equal(asTraveler.result.opening_events[0].display_text, '你推开诊室的门，雨水顺着衣角滴落。');
  assert.equal(asDoctor.result.opening_events[0].display_text, '你正在桌后整理病历，听见诊室的门被推开。');

  // Recovery must NOT regress to the neutral base track.
  const travelerRecovered = recoverSession({ repository: asTraveler.repository, session_uuid: asTraveler.session_uuid }).history;
  const doctorRecovered = recoverSession({ repository: asDoctor.repository, session_uuid: asDoctor.session_uuid }).history;
  assert.equal(travelerRecovered[0].payload.text, '你推开诊室的门，雨水顺着衣角滴落。', 'third-person recovery must keep the role track');
  assert.equal(doctorRecovered[0].payload.text, '你正在桌后整理病历，听见诊室的门被推开。', 'third-person recovery must keep the role track');

  // The model must be fed the same opening the player actually read.
  const travelerModelView = listSessionEvents({ repository: asTraveler.repository, session_uuid: asTraveler.session_uuid });
  const doctorModelView = listSessionEvents({ repository: asDoctor.repository, session_uuid: asDoctor.session_uuid });
  assert.equal(travelerModelView[0].payload.text, '你推开诊室的门，雨水顺着衣角滴落。');
  assert.equal(doctorModelView[0].payload.text, '你正在桌后整理病历，听见诊室的门被推开。');
  assert.notEqual(travelerModelView[0].payload.text, doctorModelView[0].payload.text, 'two roles must not converge on one narration');

  console.log('Opening tracks: third-person sources keep per-role tracks through recovery');
}
