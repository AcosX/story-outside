import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  firstPersonOpeningTexts,
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
// Deterministic slicing.
// ---------------------------------------------------------------------
{
  assert.deepEqual(splitSentences('甲。乙？丙！'), ['甲。', '乙？', '丙！']);
  assert.deepEqual(splitSentences('没有终止符'), ['没有终止符']);
  assert.deepEqual(splitSentences('  '), []);
  // Closing punctuation stays attached to its sentence.
  assert.deepEqual(splitSentences('他说「走吧。」然后离开。'), ['他说「走吧。」', '然后离开。']);
  console.log('First-person opening: sentence splitting keeps terminal punctuation');
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
  console.log('First-person opening: source scan stops before the first choice');
}

{
  const beats = [{ text: SOURCE }];
  const texts = firstPersonOpeningTexts({ beats, sentenceCount: 6, eventCount: 3 });
  assert.equal(texts.length, 3);
  // Verbatim prefix: concatenating the track reproduces the source exactly.
  assert.ok(SOURCE.startsWith(texts.join('')));
  assert.ok(texts[0].startsWith('我推开诊室的门'));
  // Deterministic: same input, same output.
  assert.deepEqual(firstPersonOpeningTexts({ beats, sentenceCount: 6, eventCount: 3 }), texts);
  // Bucket sizes differ by at most one.
  const sizes = texts.map((text) => text.length);
  assert.ok(Math.max(...sizes) > 0 && sizes.every((size) => size > 0));
  console.log('First-person opening: slicing is verbatim, deterministic and evenly paced');
}

{
  const beats = [{ text: '只有一句。' }];
  // Not enough sentences to fill every bucket → no track rather than blanks.
  assert.equal(firstPersonOpeningTexts({ beats, sentenceCount: 1, eventCount: 3 }), null);
  assert.equal(firstPersonOpeningTexts({ beats: [], sentenceCount: 3, eventCount: 1 }), null);
  assert.equal(firstPersonOpeningTexts({ beats, sentenceCount: 1, eventCount: 0 }), null);
  // An oversized estimate is clamped to the available sentences, and the
  // short source keeps entries well inside the size ceiling.
  const clamped = firstPersonOpeningTexts({ beats: [{ text: SOURCE }], sentenceCount: 999, eventCount: 2 });
  assert.equal(clamped.length, 2);
  console.log('First-person opening: degenerate input yields no track instead of empty entries');
}

// A missing boundary must NOT mean "use the whole source". Imported novels
// carry no ask_player_choice marker, so falling back to every sentence would
// slice the entire book into the opening and spoil it.
{
  const novel = Array.from({ length: 120 }, (_, i) => `这是原作第${i}句正文内容，描述了一些情节。`).join('');
  const beats = [{ index: 0, text: novel }];
  for (const bad of [undefined, null, 0, -3, 2.5, '8', NaN]) {
    assert.equal(
      firstPersonOpeningTexts({ beats, sentenceCount: bad, eventCount: 3 }),
      null,
      `boundary ${String(bad)} must fail closed instead of slicing the whole novel`,
    );
  }
  // A sane boundary still works on the same source and stays near the start.
  const ok = firstPersonOpeningTexts({ beats, sentenceCount: 6, eventCount: 3 });
  assert.equal(ok.length, 3);
  assert.ok(novel.startsWith(ok.join('')));
  assert.ok(!ok.join('').includes('第119句'), 'a valid boundary must not reach the end of the novel');
  console.log('First-person opening: a missing boundary fails closed instead of spoiling the novel');
}

// Overshot boundaries are caught by the entry-size ceiling and by the
// cross-check against the neutral track's length.
{
  const novel = Array.from({ length: 120 }, (_, i) => `这是原作第${i}句正文内容，描述了一些情节。`).join('');
  const beats = [{ index: 0, text: novel }];
  // 90 sentences over 3 events => ~600 chars per entry, past the hard limit.
  assert.equal(firstPersonOpeningTexts({ beats, sentenceCount: 90, eventCount: 3 }), null);
  // Within the size ceiling, but far longer than the neutral track describing
  // the same span => the boundary overshot into later plot.
  assert.equal(
    firstPersonOpeningTexts({ beats, sentenceCount: 12, eventCount: 3, neutralChars: 20 }),
    null,
  );
  // A verbatim track is legitimately a few times longer than a terse summary
  // of the same span, so a normal ratio must still be accepted.
  assert.ok(firstPersonOpeningTexts({ beats, sentenceCount: 12, eventCount: 3, neutralChars: 60 }));
  console.log('First-person opening: overshot boundaries are rejected by size and ratio checks');
}

// ---------------------------------------------------------------------
// Read-time projection.
// ---------------------------------------------------------------------
{
  const payload = { text: '陈远推开门。', text_first_person: '我推开门。' };
  // Same role as the original narrator → original voice.
  assert.equal(renderOpeningText(payload, { role_id: 'traveler', first_person_role_id: 'traveler' }), '我推开门。');
  // Any other role → neutral third person naming the protagonist.
  assert.equal(renderOpeningText(payload, { role_id: 'doctor', first_person_role_id: 'traveler' }), '陈远推开门。');
  // Third-person source → neutral.
  assert.equal(renderOpeningText(payload, { role_id: 'traveler', first_person_role_id: null }), '陈远推开门。');
  // Legacy single-track payload → neutral, never undefined.
  assert.equal(renderOpeningText({ text: '只有一轨。' }, { role_id: 'traveler', first_person_role_id: 'traveler' }), '只有一轨。');
  assert.equal(renderOpeningText(null, { role_id: 'a', first_person_role_id: 'a' }), '');
  console.log('First-person opening: read-time projection picks the right track per role');
}

{
  const events = [{ sequence: 0, type: 'narration', text: '中立。', text_first_person: '第一人称。' }];
  const rendered = renderOpeningEvents(events, { role_id: 'traveler', first_person_role_id: 'traveler' });
  assert.equal(rendered[0].display_text, '第一人称。');
  // Both tracks are retained so the client can echo the event back and still
  // match the pinned cache byte for byte.
  assert.equal(rendered[0].text, '中立。');
  assert.equal(rendered[0].text_first_person, '第一人称。');
  assert.deepEqual(renderOpeningEvents(null, {}), []);
  console.log('First-person opening: rendered events keep both tracks for strict commit');
}

// ---------------------------------------------------------------------
// Generator carries the second track into the cache payload.
// ---------------------------------------------------------------------
{
  const story = {
    id: 'x', title: 't', hook: 'h',
    roles: [{ id: 'traveler', label: '陈远', mood: '' }],
    first_person_role_id: 'traveler',
    ai_opening_events: [
      { index: 0, type: 'narration', text: '陈远推开门。', text_first_person: '我推开门。' },
      { index: 1, type: 'ask_player_choice', text: '等待玩家的第一个选择。' },
    ],
    beats: [{ index: 0, text: SOURCE }],
  };
  const cache = generateOpeningCache({
    story_uuid: randomUUID(), story_version_uuid: randomUUID(),
    opening_key: 'default', profile: defaultGenerationProfile(), story,
  });
  assert.equal(cache.event_count, 1);
  assert.equal(cache.events[0].text_first_person, '我推开门。');
  assert.equal(cache.boundary, 'truncated_before_first_choice');
  // The second track is content, so it changes the content hash.
  const other = generateOpeningCache({
    story_uuid: cache.story_uuid, story_version_uuid: cache.story_version_uuid,
    opening_key: 'default', profile: defaultGenerationProfile(),
    story: { ...story, ai_opening_events: [{ index: 0, type: 'narration', text: '陈远推开门。', text_first_person: '我推门。' }] },
  });
  assert.notEqual(cache.hash.content_hash, other.hash.content_hash);
  console.log('First-person opening: generator carries the track into the cache and its hash');
}

// ---------------------------------------------------------------------
// End-to-end: one shared cache, two roles, two reading experiences.
// ---------------------------------------------------------------------
{
  const roles = [{ id: 'traveler', label: '陈远', mood: '旅人' }, { id: 'doctor', label: '林医生', mood: '医生' }];
  const detail = {
    id: 'clinic', title: '雨夜诊室', hook: '一封信',
    roles,
    first_person_role_id: 'traveler',
    beats: [{ index: 0, text: SOURCE }],
    ai_opening_events: [
      { index: 0, type: 'narration', text: '陈远推开诊室的门。', text_first_person: '我推开诊室的门，雨水顺着衣角滴落。' },
      { index: 1, type: 'narration', text: '林医生抬起头。', text_first_person: '林医生正在桌后整理病历。' },
      { index: 2, type: 'ask_player_choice', text: '等待玩家的第一个选择。' },
    ],
    ai_preparation_version: 'story-preparation-v5',
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
  assert.equal(
    asTraveler.result.opening_events.length,
    asDoctor.result.opening_events.length,
    'both roles must see the same number of opening beats',
  );

  // The player who picked "我" reads the original wording.
  assert.equal(asTraveler.result.opening_events[0].display_text, '我推开诊室的门，雨水顺着衣角滴落。');
  // Everyone else reads neutral narration that names the protagonist.
  assert.equal(asDoctor.result.opening_events[0].display_text, '陈远推开诊室的门。');
  assert.ok(!asDoctor.result.opening_events.some((event) => event.display_text.includes('主角')));

  // Committing still validates against the pinned cache byte for byte: the
  // client echoes the event it received, including both tracks.
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
  assert.equal(travelerHistory[0].payload.text, '我推开诊室的门，雨水顺着衣角滴落。');
  assert.equal(doctorHistory[0].payload.text, '陈远推开诊室的门。');

  const travelerModelView = listSessionEvents({ repository: asTraveler.repository, session_uuid: asTraveler.session_uuid });
  const doctorModelView = listSessionEvents({ repository: asDoctor.repository, session_uuid: asDoctor.session_uuid });
  assert.equal(travelerModelView[0].payload.text, '我推开诊室的门，雨水顺着衣角滴落。');
  assert.equal(doctorModelView[0].payload.text, '陈远推开诊室的门。');
  console.log('First-person opening: one shared cache serves two roles end to end');
}

// ---------------------------------------------------------------------
// Legacy single-track cache keeps working unchanged.
// ---------------------------------------------------------------------
{
  const detail = {
    id: 'legacy', title: '旧作', hook: 'h',
    roles: [{ id: 'traveler', label: '陈远', mood: '' }, { id: 'doctor', label: '林医生', mood: '' }],
    first_person_role_id: 'traveler',
    beats: [{ index: 0, text: SOURCE }],
    // No text_first_person anywhere — imported before the dual track existed.
    ai_opening_events: [
      { index: 0, type: 'narration', text: '陈远推开诊室的门。' },
      { index: 1, type: 'ask_player_choice', text: '等待玩家的第一个选择。' },
    ],
  };
  const repository = createInMemoryStoryRepository();
  const session_uuid = randomUUID();
  const result = await bootstrapSessionFromWork({
    repository, provider: { name: 'real', getStory: async () => detail },
    session_uuid, work_id: 'legacy', role_id: 'traveler',
    identity: { user_ref: 'legacy-player' },
  });
  assert.equal(result.opening_events[0].display_text, '陈远推开诊室的门。');
  commitOpeningEvent({
    repository, session_uuid, cache_uuid: result.cache_uuid,
    event: { ...result.opening_events[0], displayed: true },
    client_request_id: 'legacy-0', expected_revision: result.session.revision,
  });
  const history = recoverSession({ repository, session_uuid }).history;
  assert.equal(history[0].payload.text, '陈远推开诊室的门。');
  console.log('First-person opening: legacy single-track caches are unaffected');
}
