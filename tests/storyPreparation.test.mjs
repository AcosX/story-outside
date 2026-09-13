import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheHash, writeAICache } from '../src/agent/aiCache.mjs';
import { createPreparedStoryProvider } from '../src/agent/storyPreparation.mjs';
import { canonicalStoryContent, canonicalStoryHash } from '../src/stories/canonicalHash.mjs';
import { generateOpeningCache } from '../src/stories/openingGenerator.mjs';
import { defaultGenerationProfile } from '../src/stories/storyService.mjs';

// Source text is first person and long enough that the deterministic
// first-person slicer has real sentences to work with.
const SOURCE_TEXT = '我推开诊室的门，雨水顺着衣角滴落。林医生正在桌后整理病历。他抬头问我哪里不舒服。我没有回答，只把信放在桌沿。信封上写着请交林医生亲启。走廊里忽然响起脚步声。门缝下露出一截黑色衣摆。林医生停下笔，看了看我，又看了看信。';

const cacheDir = await mkdtemp(join(tmpdir(), 'story-preparation-'));
try {
  let calls = 0;
  const source = { id: 'one', title: '原作', hook: '原作简介', roles: [{ id: 'author', label: '作者', mood: '' }], beats: [{ index: 0, text: SOURCE_TEXT }] };
  const config = { apiKey: 'test', baseURL: 'https://example.invalid/v1', model: 'test', timeoutMs: 1000, cacheDir };
  // Every superseded preparation version must be ignored, otherwise a stale
  // single-track opening would be served without a first-person track.
  for (const version of ['story-preparation-v1', 'story-preparation-v2', 'story-preparation-v3', 'story-preparation-v4']) {
    await writeAICache(config, 'story-' + cacheHash({ version, model: config.model, id: source.id, title: source.title, beats: source.beats }), { roles: [{ id: 'traveler', label: '陈远', mood: '旅人' }], first_person_role_id: 'traveler', opening_events: [{ type: 'narration', text: '旅人走进了房间。' }] });
  }
  const analysis = {
    roles: [{ id: 'traveler', label: '陈远', mood: '旅人' }, { id: 'doctor', label: '林医生', mood: '值班医生' }],
    first_person_role_id: 'traveler',
    protagonist_display_name: '陈远',
    opening_source_sentence_count: 8,
    opening_events: [
      { type: 'narration', text: '陈远推开诊室的门，雨水顺着衣角滴落。', story_progress: 0.03 },
      { type: 'narration', text: '林医生停下笔，看了看桌沿的信封。', story_progress: 0.08 },
    ],
  };
  const fetchImpl = async (_url, options) => {
    calls++;
    const prompt = JSON.parse(options.body).messages[0].content;
    assert.match(prompt, /中立第三人称/);
    assert.match(prompt, /speaker必须指向实际说话者/);
    assert.match(prompt, /共享开场只能写所有可选玩家角色都安全的外部可观察事实/);
    assert.match(prompt, /不得提及任何角色私有的秘密、叮嘱、记忆、认知或内心/);
    assert.match(prompt, /严禁使用“主角”“男主”“女主”“叙述者”“那位旅人”这类代称/);
    assert.match(prompt, /opening_source_sentence_count/);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(analysis) } }] }) };
  };
  const provider = { name: 'real', getStory: async () => source };
  const prepared = createPreparedStoryProvider(provider, config, { fetchImpl });
  const [a, b] = await Promise.all([prepared.getStory('one'), prepared.getStory('one')]);
  const c = await createPreparedStoryProvider(provider, config, { fetchImpl }).getStory('one');
  assert.equal(calls, 1);
  assert.deepEqual(a, b); assert.deepEqual(b, c);
  assert.equal(a.first_person_role_id, 'traveler'); assert.equal(a.default_role_id, 'traveler'); assert.equal(a.role_selection_required, false);

  // Dual track: neutral third person keeps the AI text, first person is a
  // verbatim prefix of the source, and both tracks have the same length.
  const narration = a.ai_opening_events.filter((event) => event.type !== 'ask_player_choice');
  assert.equal(narration.length, 2);
  assert.ok(narration.every((event) => typeof event.text_first_person === 'string' && event.text_first_person));
  const firstPersonJoined = narration.map((event) => event.text_first_person).join('');
  assert.ok(SOURCE_TEXT.startsWith(firstPersonJoined), 'first-person track must be a verbatim prefix of the source');
  assert.ok(firstPersonJoined.includes('我推开诊室的门'), 'first-person track keeps the original narration voice');
  assert.ok(!narration.some((event) => event.text.includes('主角')), 'neutral track must not use a generic protagonist stand-in');
  assert.ok(narration.some((event) => event.text.includes('陈远')), 'neutral track addresses the protagonist by name');

  const canonical = canonicalStoryContent(a);
  assert.equal(canonical.first_person_role_id, 'traveler');
  assert.deepEqual(canonical.beats, source.beats);
  assert.equal(canonical.ai_opening_events.length, 3);
  // The first-person track is content, so it must survive canonicalisation
  // and participate in the content hash.
  assert.equal(canonical.ai_opening_events[0].text_first_person, narration[0].text_first_person);
  assert.notEqual(
    canonicalStoryHash(a),
    canonicalStoryHash({
      ...a,
      ai_opening_events: a.ai_opening_events.map((event, index) => (
        index === 0 ? { ...event, text_first_person: '改写过的第一人称。' } : event
      )),
    }),
  );
  assert.notEqual(canonicalStoryHash(a), canonicalStoryHash({ ...a, ai_opening_events: [{ index: 0, text: '新开场' }] }));

  const opening = generateOpeningCache({ story_uuid: '11111111-1111-4111-8111-111111111111', story_version_uuid: '22222222-2222-4222-8222-222222222222', opening_key: 'default', profile: defaultGenerationProfile(), story: canonical });
  assert.equal(opening.event_count, 2);
  assert.equal(opening.events[0].text, '陈远推开诊室的门，雨水顺着衣角滴落。');
  assert.equal(opening.events[0].text_first_person, narration[0].text_first_person);
  assert.equal(opening.events[0].story_progress, 0.03);
  assert.equal(opening.boundary, 'truncated_before_first_choice');
  console.log('Story preparation: roles, dual-track opening, canonical hash and first-choice boundary passed');
} finally { await rm(cacheDir, { recursive: true, force: true }); }

// Protagonist naming is enforced deterministically: a generic stand-in is
// rejected as an invalid analysis rather than being cached and served.
{
  const cacheDir2 = await mkdtemp(join(tmpdir(), 'story-preparation-naming-'));
  try {
    const source = { id: 'two', title: '原作二', hook: '简介', roles: [], beats: [{ index: 0, text: '我走进房间。他抬头看我。我把信放下。' }] };
    const config = { apiKey: 'test', baseURL: 'https://example.invalid/v1', model: 'test', timeoutMs: 1000, cacheDir: cacheDir2 };
    const bad = {
      roles: [{ id: 'traveler', label: '陈远', mood: '旅人' }],
      first_person_role_id: 'traveler',
      protagonist_display_name: '主角',
      opening_source_sentence_count: 3,
      opening_events: [{ type: 'narration', text: '主角推开了房门，屋里很安静。' }],
    };
    const fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(bad) } }] }) });
    const prepared = createPreparedStoryProvider({ name: 'real', getStory: async () => source }, config, { fetchImpl });
    await assert.rejects(() => prepared.getStory('two'), /invalid story analysis/);
    console.log('Story preparation: generic protagonist stand-in is rejected');
  } finally { await rm(cacheDir2, { recursive: true, force: true }); }
}

// A third-person source has no first-person track at all, and keeps working.
{
  const cacheDir3 = await mkdtemp(join(tmpdir(), 'story-preparation-third-'));
  try {
    const source = { id: 'three', title: '原作三', hook: '简介', roles: [], beats: [{ index: 0, text: '陈远走进房间。林医生抬头。' }] };
    const config = { apiKey: 'test', baseURL: 'https://example.invalid/v1', model: 'test', timeoutMs: 1000, cacheDir: cacheDir3 };
    const analysis = {
      roles: [{ id: 'traveler', label: '陈远', mood: '旅人' }, { id: 'doctor', label: '林医生', mood: '医生' }],
      first_person_role_id: null,
      protagonist_display_name: null,
      opening_source_sentence_count: 2,
      opening_events: [{ type: 'narration', text: '陈远走进房间，林医生抬起头。' }],
    };
    const fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(analysis) } }] }) });
    const prepared = createPreparedStoryProvider({ name: 'real', getStory: async () => source }, config, { fetchImpl });
    const story = await prepared.getStory('three');
    assert.equal(story.first_person_role_id, null);
    assert.equal(story.role_selection_required, true);
    assert.ok(!story.ai_opening_events.some((event) => 'text_first_person' in event), 'third-person sources must not get a first-person track');
    console.log('Story preparation: third-person source keeps a single neutral track');
  } finally { await rm(cacheDir3, { recursive: true, force: true }); }
}
