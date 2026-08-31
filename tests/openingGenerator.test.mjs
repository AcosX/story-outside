// tests/openingGenerator.test.mjs — generator contract: per-sentence events,
// no ask_player_choice, deterministic across reruns.

import assert from 'node:assert/strict';

import { generateOpeningCache } from '../src/stories/openingGenerator.mjs';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`    ${err && err.message ? err.message : err}`);
  }
}

const STORY = {
  id: 'cafe-rain',
  title: '雨夜咖啡馆',
  hook: '凌晨的咖啡馆只剩你和她。',
  roles: [
    { id: 'stranger', label: '陌生人', mood: '疏离' },
    { id: 'old-friend', label: '旧友', mood: '怀念' },
  ],
  beats: [
    '雨声裹着玻璃窗，咖啡机嗡地停了。',
    '她把杯沿推向你的方向。',
    '你想起一个还没问出口的问题。',
  ],
};

const PROFILE = {
  identifier: 'opening-default',
  rules_version: 'opening-rules/1',
  locale: 'zh-CN',
};

console.log('Opening cache generator');

check('emits per-sentence events with contiguous sequence', () => {
  const out = generateOpeningCache({
    story_uuid: 's-1',
    story_version_uuid: 'v-1',
    story: STORY,
    profile: PROFILE,
  });
  assert.ok(Array.isArray(out.events));
  for (let i = 0; i < out.events.length; i += 1) {
    assert.equal(out.events[i].sequence, i);
  }
  assert.equal(out.event_count, out.events.length);
});

check('every event has a type and text', () => {
  const out = generateOpeningCache({
    story_uuid: 's-1',
    story_version_uuid: 'v-1',
    story: STORY,
    profile: PROFILE,
  });
  for (const ev of out.events) {
    assert.ok(['narration', 'dialogue', 'action', 'beat'].includes(ev.type));
    assert.equal(typeof ev.text, 'string');
    assert.ok(ev.text.length > 0);
  }
});

check('events do NOT include ask_player_choice type', () => {
  const out = generateOpeningCache({
    story_uuid: 's-1',
    story_version_uuid: 'v-1',
    story: STORY,
    profile: PROFILE,
  });
  for (const ev of out.events) {
    assert.notEqual(ev.type, 'ask_player_choice');
  }
  // No event carries an ask_player_choice marker anywhere on it.
  assert.ok(!out.events.some((e) => /ask_player_choice/.test(JSON.stringify(e))));
});

check('structured ask_player_choice truncates and never enters the cache', () => {
  const STORY_WITH_STRUCTURED_CHOICE = {
    ...STORY,
    beats: [
      '雨声裹着玻璃窗。',
      { type: 'dialogue', speaker: 'old-friend', text: '「旧友」你在等人吗？' },
      { type: 'action', text: '她替你把冷掉的咖啡换成了热的。' },
      { type: 'ask_player_choice', text: '你要怎么回答她？' },
      '这一句不应该出现',
    ],
  };
  const out = generateOpeningCache({
    story_uuid: 's-1',
    story_version_uuid: 'v-1',
    story: STORY_WITH_STRUCTURED_CHOICE,
    profile: PROFILE,
  });
  assert.equal(out.boundary, 'truncated_before_first_choice');
  assert.equal(out.event_count, 3);
  assert.equal(out.events[0].type, 'narration');
  assert.equal(out.events[1].type, 'dialogue');
  assert.equal(out.events[1].speaker, 'old-friend');
  assert.equal(out.events[2].type, 'action');
  assert.ok(!JSON.stringify(out.events).includes('ask_player_choice'));
  assert.ok(!JSON.stringify(out.events).includes('你要怎么回答她？'));
  assert.ok(!JSON.stringify(out.events).includes('这一句不应该出现'));
});

check('structured speaker wins and unknown structured speaker is rejected', () => {
  const ok = generateOpeningCache({
    story_uuid: 's-1',
    story_version_uuid: 'v-1',
    story: {
      ...STORY,
      beats: [{ type: 'dialogue', speaker: 'old-friend', text: '她说话了。' }],
    },
    profile: PROFILE,
  });
  assert.equal(ok.events[0].type, 'dialogue');
  assert.equal(ok.events[0].speaker, 'old-friend');
  assert.throws(
    () =>
      generateOpeningCache({
        story_uuid: 's-1',
        story_version_uuid: 'v-1',
        story: {
          ...STORY,
          beats: [{ type: 'dialogue', speaker: 'ghost', text: '她说话了。' }],
        },
        profile: PROFILE,
      }),
    /not a known role/,
  );
});

check('truncates BEFORE the first choice marker in beats', () => {
  const STORY_WITH_CHOICE = {
    ...STORY,
    beats: [
      '雨声裹着玻璃窗。',
      '她看着你。',
      '【选择】你要说什么？',
      '这一句不应该出现',
    ],
  };
  const out = generateOpeningCache({
    story_uuid: 's-1',
    story_version_uuid: 'v-1',
    story: STORY_WITH_CHOICE,
    profile: PROFILE,
  });
  assert.equal(out.boundary, 'truncated_before_first_choice');
  assert.equal(out.event_count, 2);
  // No event leaks the choice text.
  for (const ev of out.events) {
    assert.ok(!ev.text.includes('【选择】'));
  }
});

check('dialogue events carry a stable speaker', () => {
  const out = generateOpeningCache({
    story_uuid: 's-1',
    story_version_uuid: 'v-1',
    story: {
      ...STORY,
      beats: [
        '「陌生人」雨声裹着玻璃窗，咖啡机嗡地停了。',
        '她把杯沿推向你的方向。',
      ],
    },
    profile: PROFILE,
  });
  assert.equal(out.events[0].type, 'dialogue');
  assert.equal(out.events[0].speaker, 'stranger');
  assert.equal(out.events[1].type, 'narration');
  assert.equal(out.events[1].speaker, undefined);
});

check('generator is deterministic', () => {
  const a = generateOpeningCache({
    story_uuid: 's-1',
    story_version_uuid: 'v-1',
    story: STORY,
    profile: PROFILE,
  });
  const b = generateOpeningCache({
    story_uuid: 's-1',
    story_version_uuid: 'v-1',
    story: STORY,
    profile: PROFILE,
  });
  assert.deepEqual(a.events, b.events);
  assert.equal(a.hash.content_hash, b.hash.content_hash);
  assert.equal(a.hash.generation_hash, b.hash.generation_hash);
});

check('content_hash depends on events but not profile', () => {
  const a = generateOpeningCache({
    story_uuid: 's-1',
    story_version_uuid: 'v-1',
    story: STORY,
    profile: PROFILE,
  });
  const b = generateOpeningCache({
    story_uuid: 's-1',
    story_version_uuid: 'v-1',
    story: STORY,
    profile: { ...PROFILE, locale: 'en-US' },
  });
  // Same events → same content_hash, but generation profile change flips
  // the generation_hash, which is how the repository keys the cache.
  assert.equal(a.hash.content_hash, b.hash.content_hash);
  assert.notEqual(a.hash.generation_hash, b.hash.generation_hash);
});

check('empty story reports empty_story boundary', () => {
  const out = generateOpeningCache({
    story_uuid: 's-1',
    story_version_uuid: 'v-1',
    story: { ...STORY, beats: [] },
    profile: PROFILE,
  });
  assert.equal(out.event_count, 0);
  assert.equal(out.boundary, 'empty_story');
});

check('rejects bad input', () => {
  assert.throws(() => generateOpeningCache(null), /input required/);
  assert.throws(() => generateOpeningCache({ story: null, profile: PROFILE }), /story required/);
});

if (failures > 0) {
  console.error(`\n${failures} opening-generator check(s) failed`);
  process.exit(1);
}
console.log(`\nall opening-generator checks passed`);