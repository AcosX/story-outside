import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheHash, writeAICache } from '../src/agent/aiCache.mjs';
import { createPreparedStoryProvider } from '../src/agent/storyPreparation.mjs';
import { canonicalStoryContent, canonicalStoryHash } from '../src/stories/canonicalHash.mjs';
import { generateOpeningCache } from '../src/stories/openingGenerator.mjs';
import { defaultGenerationProfile } from '../src/stories/storyService.mjs';

const SOURCE_TEXT = '我推开诊室的门，雨水顺着衣角滴落。林医生正在桌后整理病历。他抬头问我哪里不舒服。我没有回答，只把信放在桌沿。信封上写着请交林医生亲启。走廊里忽然响起脚步声。门缝下露出一截黑色衣摆。林医生停下笔，看了看我，又看了看信。';

// Build a fetch stub that answers the two preparation call kinds: the work
// analysis (save_story_analysis) and one per-role perspective track
// (save_role_opening). Responses ride the legacy message-content JSON shape —
// channels that ignore `tools` must keep working.
function preparationStub({ analysis, tracks, onCall }) {
  let calls = 0;
  const seenTools = [];
  const fetchImpl = async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    const tool = body.tool_choice?.function?.name ?? 'none';
    seenTools.push(tool);
    if (onCall) onCall(calls, body, tool);
    if (tool === 'save_role_opening') {
      const target = body.messages[1].content;
      const roleMatch = /"target_role":\{"id":"([a-z0-9-]+)"/.exec(target);
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ texts: tracks[roleMatch[1]] }) } }] }) };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(analysis) } }] }) };
  };
  return { fetchImpl, calls: () => calls, seenTools };
}

const cacheDir = await mkdtemp(join(tmpdir(), 'story-preparation-'));
try {
  let calls = 0;
  const source = { id: 'one', title: '原作', hook: '原作简介', roles: [{ id: 'author', label: '作者', mood: '' }], beats: [{ index: 0, text: SOURCE_TEXT }] };
  const config = { apiKey: 'test', baseURL: 'https://example.invalid/v1', model: 'test', timeoutMs: 1000, cacheDir };
  // Every superseded preparation version must be ignored, otherwise a stale
  // pre-perspective-track opening would be served without per-role tracks.
  for (const version of ['story-preparation-v1', 'story-preparation-v2', 'story-preparation-v3', 'story-preparation-v4', 'story-preparation-v5']) {
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
  const tracks = {
    traveler: [
      { index: 0, text: '我推开诊室的门，雨水顺着衣角往下滴。' },
      { index: 1, text: '我把信放在桌沿，看见林医生停下笔看向信封。' },
    ],
    doctor: [
      { index: 0, text: '你听见诊室的门被推开，雨气涌了进来。' },
      { index: 1, text: '你放下笔，看见来人把一封信放在桌沿。' },
    ],
  };
  let analysisPromptSeen = '';
  let perspectivePromptSeen = '';
  const stub = preparationStub({
    analysis,
    tracks,
    onCall: (_call, body, tool) => {
      if (tool === 'save_story_analysis') analysisPromptSeen = body.messages[0].content;
      if (tool === 'save_role_opening') perspectivePromptSeen = body.messages[0].content;
    },
  });
  const provider = { name: 'real', getStory: async () => source };
  const prepared = createPreparedStoryProvider(provider, config, { fetchImpl: stub.fetchImpl });
  const [a, b] = await Promise.all([prepared.getStory('one'), prepared.getStory('one')]);
  const c = await createPreparedStoryProvider(provider, config, { fetchImpl: stub.fetchImpl }).getStory('one');
  // One analysis call plus one perspective-track call per role, all deduped
  // by the work-level cache across repeated imports.
  assert.equal(stub.calls(), 3);
  assert.deepEqual(a, b); assert.deepEqual(b, c);
  assert.equal(a.first_person_role_id, 'traveler'); assert.equal(a.default_role_id, 'traveler'); assert.equal(a.role_selection_required, false);

  // Prompt contracts: the analysis stays a neutral shared base, and the
  // per-role calls must focalise on the target role only.
  assert.match(analysisPromptSeen, /中立第三人称/);
  assert.match(analysisPromptSeen, /speaker必须指向实际说话者/);
  assert.match(analysisPromptSeen, /共享开场只能写所有可选玩家角色都安全的外部可观察事实/);
  assert.match(analysisPromptSeen, /不得提及任何角色私有的秘密、叮嘱、记忆、认知或内心/);
  assert.match(analysisPromptSeen, /严禁使用“主角”“男主”“女主”“叙述者”“那位旅人”这类代称/);
  assert.match(analysisPromptSeen, /opening_source_sentence_count/);
  assert.match(perspectivePromptSeen, /第二人称“你”指代 target_role/);
  assert.match(perspectivePromptSeen, /第一人称“我”的口吻/);
  assert.match(perspectivePromptSeen, /不得引入此阶段不存在的关键事件/);
  assert.match(perspectivePromptSeen, /不得提及任何角色私有的秘密、叮嘱、记忆、认知或内心/);
  assert.match(perspectivePromptSeen, /dialogue 条目由系统原样保留/);

  // Per-role tracks: the original narrator reads a first-person generated
  // opening, everyone else a second-person one, all on the same beats.
  const narration = a.ai_opening_events.filter((event) => event.type !== 'ask_player_choice');
  assert.equal(narration.length, 2);
  assert.equal(narration[0].text_by_role.traveler, tracks.traveler[0].text);
  assert.equal(narration[0].text_by_role.doctor, tracks.doctor[0].text);
  assert.ok(tracks.traveler.every((entry) => entry.text.includes('我') && !entry.text.includes('你')), 'narrator track keeps the first-person voice');
  assert.ok(tracks.doctor.every((entry) => entry.text.includes('你') && !entry.text.includes('我')), 'other-role track is focalised on the chosen role');
  assert.ok(narration.some((event) => event.text.includes('陈远')), 'neutral track addresses the protagonist by name');

  const canonical = canonicalStoryContent(a);
  assert.equal(canonical.first_person_role_id, 'traveler');
  assert.deepEqual(canonical.beats, source.beats);
  assert.equal(canonical.ai_opening_events.length, 3);
  // The per-role tracks are content, so they must survive canonicalisation
  // and participate in the content hash.
  assert.deepEqual(canonical.ai_opening_events[0].text_by_role, narration[0].text_by_role);
  assert.notEqual(
    canonicalStoryHash(a),
    canonicalStoryHash({
      ...a,
      ai_opening_events: a.ai_opening_events.map((event, index) => (
        index === 0 ? { ...event, text_by_role: { ...event.text_by_role, traveler: '改写过的第一人称。' } } : event
      )),
    }),
  );
  assert.notEqual(canonicalStoryHash(a), canonicalStoryHash({ ...a, ai_opening_events: [{ index: 0, text: '新开场' }] }));

  const opening = generateOpeningCache({ story_uuid: '11111111-1111-4111-8111-111111111111', story_version_uuid: '22222222-2222-4222-8222-222222222222', opening_key: 'default', profile: defaultGenerationProfile(), story: canonical });
  assert.equal(opening.event_count, 2);
  assert.equal(opening.events[0].text, '陈远推开诊室的门，雨水顺着衣角滴落。');
  assert.equal(opening.events[0].text_by_role.traveler, narration[0].text_by_role.traveler);
  assert.equal(opening.events[0].story_progress, 0.03);
  assert.equal(opening.boundary, 'truncated_before_first_choice');
  console.log('Story preparation: roles, per-role perspective tracks, canonical hash and first-choice boundary passed');
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

// An invalid opening boundary is rejected. Without this the scene reference
// handed to the per-role calls would cover the whole novel and invite spoilers.
{
  const cacheDir4 = await mkdtemp(join(tmpdir(), 'story-preparation-boundary-'));
  try {
    const source = { id: 'four', title: '原作四', hook: '简介', roles: [], beats: [{ index: 0, text: SOURCE_TEXT }] };
    const config = { apiKey: 'test', baseURL: 'https://example.invalid/v1', model: 'test', timeoutMs: 1000, cacheDir: cacheDir4 };
    const withBoundary = (count) => ({
      roles: [{ id: 'traveler', label: '陈远', mood: '旅人' }],
      first_person_role_id: 'traveler',
      protagonist_display_name: '陈远',
      ...(count === undefined ? {} : { opening_source_sentence_count: count }),
      opening_events: [{ type: 'narration', text: '陈远推开诊室的门，雨水顺着衣角滴落。' }],
    });
    for (const bad of [undefined, 0, -1, 1000]) {
      const fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(withBoundary(bad)) } }] }) });
      const prepared = createPreparedStoryProvider({ name: 'real', getStory: async () => source }, { ...config, cacheDir: undefined }, { fetchImpl });
      await assert.rejects(() => prepared.getStory('four'), /invalid story analysis/, `boundary ${String(bad)} must be rejected`);
    }
    console.log('Story preparation: an invalid opening boundary is rejected');
  } finally { await rm(cacheDir4, { recursive: true, force: true }); }
}

// A rejected analysis sample is retried rather than failing the whole import.
{
  const cacheDir5 = await mkdtemp(join(tmpdir(), 'story-preparation-retry-'));
  try {
    const source = { id: 'five', title: '原作五', hook: '简介', roles: [], beats: [{ index: 0, text: SOURCE_TEXT }] };
    const config = { apiKey: 'test', baseURL: 'https://example.invalid/v1', model: 'test', timeoutMs: 1000, cacheDir: cacheDir5 };
    const bad = {
      roles: [{ id: 'traveler', label: '陈远', mood: '旅人' }],
      first_person_role_id: 'traveler',
      protagonist_display_name: '主角',
      opening_source_sentence_count: 4,
      opening_events: [{ type: 'narration', text: '主角推开了房门。' }],
    };
    const good = {
      roles: [{ id: 'traveler', label: '陈远', mood: '旅人' }],
      first_person_role_id: 'traveler',
      protagonist_display_name: '陈远',
      opening_source_sentence_count: 4,
      opening_events: [{ type: 'narration', text: '陈远推开诊室的门，雨水顺着衣角滴落。' }],
    };
    const tracks = { traveler: [{ index: 0, text: '我推开诊室的门，雨水顺着衣角滴落。' }] };
    let analysisCalls = 0;
    const stub = preparationStub({
      analysis: good,
      tracks,
      onCall: (_call, _body, tool) => {
        if (tool === 'save_story_analysis') analysisCalls += 1;
      },
    });
    let calls = 0;
    const fetchImpl = async (url, options) => {
      calls += 1;
      // First analysis attempt violates the naming validator; the retry and
      // every later call are served by the standard stub.
      if (calls === 1) return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(bad) } }] }) };
      return stub.fetchImpl(url, options);
    };
    const prepared = createPreparedStoryProvider({ name: 'real', getStory: async () => source }, config, { fetchImpl });
    const story = await prepared.getStory('five');
    assert.equal(calls, 3, 'one rejected analysis + one analysis retry + one role track call');
    assert.equal(analysisCalls, 1);
    assert.equal(story.ai_opening_events[0].text_by_role.traveler, tracks.traveler[0].text);
    console.log('Story preparation: a rejected analysis sample is retried instead of failing the import');
  } finally { await rm(cacheDir5, { recursive: true, force: true }); }
}

// Perspective-track validators: voice violations are retried, and a track
// that keeps violating falls back to the neutral base instead of poisoning
// the cache — the import itself still succeeds.
{
  const cacheDir7 = await mkdtemp(join(tmpdir(), 'story-preparation-track-'));
  try {
    const source = { id: 'seven', title: '原作七', hook: '简介', roles: [], beats: [{ index: 0, text: SOURCE_TEXT }] };
    const config = { apiKey: 'test', baseURL: 'https://example.invalid/v1', model: 'test', timeoutMs: 1000, cacheDir: cacheDir7 };
    const analysis = {
      roles: [{ id: 'traveler', label: '陈远', mood: '旅人' }, { id: 'doctor', label: '林医生', mood: '医生' }],
      first_person_role_id: 'traveler',
      protagonist_display_name: '陈远',
      opening_source_sentence_count: 4,
      opening_events: [{ type: 'narration', text: '陈远推开诊室的门，雨水顺着衣角滴落。' }],
    };
    // The doctor track keeps narrating as 我 (the original narrator's voice):
    // exactly the regression this feature exists to prevent. Calls are keyed
    // per role because the per-role generations run in parallel.
    const leaking = [{ index: 0, text: '你抬头时，我推开了诊室的门。' }];
    const valid = {
      traveler: [{ index: 0, text: '我推开诊室的门，雨水顺着衣角滴落。' }],
      doctor: [{ index: 0, text: '你抬起头，看见门被推开，雨气涌了进来。' }],
    };
    const roleCallCounts = {};
    const stub = preparationStub({ analysis, tracks: valid });
    const baseImpl = stub.fetchImpl;
    const fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body);
      if (body.tool_choice?.function?.name === 'save_role_opening') {
        const roleId = /"target_role":\{"id":"([a-z0-9-]+)"/.exec(body.messages[1].content)[1];
        roleCallCounts[roleId] = (roleCallCounts[roleId] ?? 0) + 1;
        const payload = roleId === 'doctor' && roleCallCounts.doctor <= 2 ? leaking : valid[roleId];
        return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ texts: payload }) } }] }) };
      }
      return baseImpl(url, options);
    };
    const prepared = createPreparedStoryProvider({ name: 'real', getStory: async () => source }, config, { fetchImpl });
    const story = await prepared.getStory('seven');
    assert.equal(roleCallCounts.doctor, 2, 'the leaking doctor track is retried once before falling back');
    assert.equal(roleCallCounts.traveler, 1);
    assert.equal(story.ai_opening_events[0].text_by_role.traveler, valid.traveler[0].text);
    assert.ok(!('doctor' in story.ai_opening_events[0].text_by_role), 'a track that keeps violating is omitted instead of cached');
    console.log('Story preparation: perspective tracks are voice-validated and fall back per role');
  } finally { await rm(cacheDir7, { recursive: true, force: true }); }
}

// Dialogue beats are spoken lines: they must not be re-focalised, so the
// system copies them verbatim into every perspective track.
{
  const cacheDir6 = await mkdtemp(join(tmpdir(), 'story-preparation-dialogue-'));
  try {
    const source = { id: 'six', title: '原作六', hook: '简介', roles: [], beats: [{ index: 0, text: SOURCE_TEXT }] };
    const config = { apiKey: 'test', baseURL: 'https://example.invalid/v1', model: 'test', timeoutMs: 1000, cacheDir: cacheDir6 };
    const analysis = {
      roles: [{ id: 'traveler', label: '陈远', mood: '旅人' }, { id: 'doctor', label: '林医生', mood: '医生' }],
      first_person_role_id: 'traveler',
      protagonist_display_name: '陈远',
      opening_source_sentence_count: 4,
      opening_events: [
        { type: 'narration', text: '陈远推开诊室的门，雨水顺着衣角滴落。' },
        { type: 'dialogue', speaker: 'doctor', text: '哪里不舒服？' },
      ],
    };
    const tracks = {
      traveler: [{ index: 0, text: '我推开诊室的门，雨水顺着衣角往下滴。' }],
      doctor: [{ index: 0, text: '你听见门被推开，抬起头看向来人。' }],
    };
    const stub = preparationStub({ analysis, tracks });
    const prepared = createPreparedStoryProvider({ name: 'real', getStory: async () => source }, config, { fetchImpl: stub.fetchImpl });
    const story = await prepared.getStory('six');
    const dialogue = story.ai_opening_events.find((event) => event.type === 'dialogue');
    assert.equal(dialogue.text_by_role.traveler, '哪里不舒服？', 'the spoken line is copied verbatim into every track');
    assert.equal(dialogue.text_by_role.doctor, '哪里不舒服？');
    assert.equal(dialogue.speaker, 'doctor');
    console.log('Story preparation: dialogue beats are copied verbatim into perspective tracks');
  } finally { await rm(cacheDir6, { recursive: true, force: true }); }
}

// A third-person source has no narrator role; every role gets its own
// second-person perspective track and the neutral base stays the fallback.
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
    const tracks = {
      traveler: [{ index: 0, text: '你推开房门，径直走了进来。' }],
      doctor: [{ index: 0, text: '你抬起头，看见陈远走进房间。' }],
    };
    const stub = preparationStub({ analysis, tracks });
    const prepared = createPreparedStoryProvider({ name: 'real', getStory: async () => source }, config, { fetchImpl: stub.fetchImpl });
    const story = await prepared.getStory('three');
    assert.equal(story.first_person_role_id, null);
    assert.equal(story.role_selection_required, true);
    assert.equal(story.ai_opening_events[0].text_by_role.traveler, tracks.traveler[0].text);
    assert.equal(story.ai_opening_events[0].text_by_role.doctor, tracks.doctor[0].text);
    console.log('Story preparation: third-person sources give every role a perspective track');
  } finally { await rm(cacheDir3, { recursive: true, force: true }); }
}

// PR46 review — the opening boundary feeds the per-role scene reference on
// EVERY source now, so a third-person analysis without a usable boundary must
// be rejected instead of silently slicing the whole book into the prompt.
{
  const cacheDir8 = await mkdtemp(join(tmpdir(), 'story-preparation-boundary-'));
  try {
    const source = { id: 'eight', title: '原作八', hook: '简介', roles: [], beats: [{ index: 0, text: SOURCE_TEXT }] };
    const config = { apiKey: 'test', baseURL: 'https://example.invalid/v1', model: 'test', timeoutMs: 1000, cacheDir: cacheDir8 };
    const analysis = {
      roles: [{ id: 'traveler', label: '陈远', mood: '旅人' }, { id: 'doctor', label: '林医生', mood: '医生' }],
      first_person_role_id: null,
      protagonist_display_name: null,
      opening_source_sentence_count: 9999,
      opening_events: [
        { type: 'narration', text: '陈远走进房间，林医生抬起头。' },
        { type: 'narration', text: '雨声敲在窗上，屋里一时安静。' },
        { type: 'narration', text: '桌上的病历摊开着，没有人去动。' },
      ],
    };
    const tracks = {
      traveler: [{ index: 0, text: '你推开房门走了进来。' }, { index: 1, text: '你听见雨声敲窗。' }, { index: 2, text: '你看见摊开的病历。' }],
      doctor: [{ index: 0, text: '你抬起头，看见陈远。' }, { index: 1, text: '你听着窗外的雨。' }, { index: 2, text: '你没有去动那份病历。' }],
    };
    const stub = preparationStub({ analysis, tracks });
    const prepared = createPreparedStoryProvider({ name: 'real', getStory: async () => source }, config, { fetchImpl: stub.fetchImpl });
    await assert.rejects(
      () => prepared.getStory('eight'),
      'a third-person analysis with an absurd opening boundary must not be cached or served',
    );
    console.log('Story preparation: third-person sources also enforce the opening boundary');
  } finally { await rm(cacheDir8, { recursive: true, force: true }); }
}

// PR46 review — the voice validator must read NARRATION voice, not raw
// substrings: quoted speech and compounds like 我们 / 自我 are legitimate in a
// second-person track and must not silently degrade the role to the base.
{
  const cacheDir9 = await mkdtemp(join(tmpdir(), 'story-preparation-voice-'));
  try {
    const source = { id: 'nine', title: '原作九', hook: '简介', roles: [], beats: [{ index: 0, text: SOURCE_TEXT }] };
    const config = { apiKey: 'test', baseURL: 'https://example.invalid/v1', model: 'test', timeoutMs: 1000, cacheDir: cacheDir9 };
    const analysis = {
      roles: [{ id: 'traveler', label: '陈远', mood: '旅人' }, { id: 'doctor', label: '林医生', mood: '医生' }],
      first_person_role_id: 'traveler',
      protagonist_display_name: '陈远',
      opening_source_sentence_count: 4,
      opening_events: [
        { type: 'narration', text: '陈远推开诊室的门，雨水顺着衣角滴落。' },
        { type: 'narration', text: '林医生在桌后整理病历，屋里只有纸页声。' },
        { type: 'narration', text: '走廊尽头忽然响起脚步声。' },
      ],
    };
    const tracks = {
      // Second person, but carrying quoted 我 and the compound 我们 / 自我.
      doctor: [
        { index: 0, text: '你抬起头，听见陈远在门口低声说：“我来晚了。”' },
        { index: 1, text: '你压下心底的自我怀疑，继续整理手里的病历。' },
        { index: 2, text: '你和陈远之间的沉默被脚步声打断，我们这一层本该没有别人。' },
      ],
      // First person, but quoting someone addressing 你.
      traveler: [
        { index: 0, text: '我推开诊室的门，雨水顺着衣角滴落下来。' },
        { index: 1, text: '我看着林医生整理病历，没有开口。' },
        { index: 2, text: '我听见他问：“你怎么才来？”走廊尽头有脚步声。' },
      ],
    };
    const stub = preparationStub({ analysis, tracks });
    const prepared = createPreparedStoryProvider({ name: 'real', getStory: async () => source }, config, { fetchImpl: stub.fetchImpl });
    const story = await prepared.getStory('nine');
    const byRole = story.ai_opening_events.map((event) => event.text_by_role ?? {});
    assert.equal(byRole[0].doctor, tracks.doctor[0].text, 'quoted 我 must not reject a second-person track');
    assert.equal(byRole[1].doctor, tracks.doctor[1].text, '自我 must not reject a second-person track');
    assert.equal(byRole[2].doctor, tracks.doctor[2].text, '我们 must not reject a second-person track');
    assert.equal(byRole[2].traveler, tracks.traveler[2].text, 'quoted 你 must not reject a first-person track');
    console.log('Story preparation: quoted speech and pronoun compounds pass the voice validator');
  } finally { await rm(cacheDir9, { recursive: true, force: true }); }
}
