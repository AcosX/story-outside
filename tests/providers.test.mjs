// tests/providers.test.mjs — unit tests for the provider layer.
// Narrow and real: covers DTO normalisation, Mock catalog, advance math,
// input validation, unknown-story errors, and the provider selector seam
// (default mock; explicit "real" throws). Runs without binding any port.

import assert from 'node:assert/strict';

import {
  __resetStoryProviderForTests,
  createMockStoryProvider,
  getStoryProvider,
  ProviderError,
  readProviderEnv,
  StoryNotFoundError,
  ValidationError,
  normaliseStoryDetail,
  normaliseStorySummary,
} from '../src/providers/index.mjs';

let failures = 0;
function check(name, fn) {
  try {
    const detail = fn();
    if (detail && typeof detail === 'object' && detail.skip) {
      console.log(`  skip ${name}${detail.reason ? ` (${detail.reason})` : ''}`);
      return;
    }
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`    ${err && err.message ? err.message : err}`);
  }
}

// ---------------------------------------------------------------------------
// DTO normalisation
// ---------------------------------------------------------------------------
console.log('DTO normalisation');

check('summary strips unknown fields', () => {
  const summary = normaliseStorySummary({
    id: 'x',
    title: 'X',
    hook: 'h',
    roles: [{ id: 'r', label: 'R', mood: 'm', extra: 1 }],
    secret: 'leak',
  });
  assert.equal(summary.id, 'x');
  assert.equal(summary.roles[0].extra, undefined);
});

check('summary rejects missing id', () => {
  assert.throws(() => normaliseStorySummary({ title: 't', hook: 'h', roles: [] }), ValidationError);
});

check('detail requires beats array', () => {
  assert.throws(
    () => normaliseStoryDetail({ id: 'x', title: 't', hook: 'h', roles: [] }),
    ValidationError,
  );
});

check('detail accepts string beats', () => {
  const detail = normaliseStoryDetail({
    id: 'x',
    title: 't',
    hook: 'h',
    roles: [{ id: 'r', label: 'R' }],
    beats: ['one', 'two'],
  });
  assert.equal(detail.beats.length, 2);
  assert.equal(detail.beats[0].text, 'one');
  assert.equal(detail.beats[0].index, 0);
});

check('detail preserves structured beat type and speaker', () => {
  const detail = normaliseStoryDetail({
    id: 'x',
    title: 't',
    hook: 'h',
    roles: [{ id: 'r', label: 'R' }],
    beats: [
      { text: 'r says hi', index: 0, type: 'dialogue', speaker: 'r' },
      { text: 'she acts', index: 1, type: 'action', extra: 'stripped' },
      { text: 'choose now', index: 2, type: 'ask_player_choice' },
    ],
  });
  assert.equal(detail.beats[0].type, 'dialogue');
  assert.equal(detail.beats[0].speaker, 'r');
  assert.equal(detail.beats[1].type, 'action');
  assert.equal(detail.beats[1].extra, undefined);
  assert.equal(detail.beats[2].type, 'ask_player_choice');
});

// ---------------------------------------------------------------------------
// Mock provider — happy path
// ---------------------------------------------------------------------------
console.log('\nMock provider');

const provider = createMockStoryProvider();

check('provider has stable name', () => {
  assert.equal(provider.name, 'mock');
});

check('listStories returns summaries with no beats leak', async () => {
  const list = await provider.listStories();
  assert.ok(list.length >= 2);
  for (const s of list) {
    assert.ok(typeof s.id === 'string');
    assert.ok(typeof s.title === 'string');
    assert.ok(Array.isArray(s.roles));
    assert.equal(s.beats, undefined);
  }
});

check('listStories includes known ids', async () => {
  const list = await provider.listStories();
  const ids = list.map((s) => s.id);
  assert.ok(ids.includes('cafe-rain'));
  assert.ok(ids.includes('night-shift'));
});

check('getStory returns detail with beats', async () => {
  const story = await provider.getStory('cafe-rain');
  assert.equal(story.id, 'cafe-rain');
  assert.ok(Array.isArray(story.beats));
  assert.ok(story.beats.length >= 1);
  assert.equal(typeof story.beats[0].text, 'string');
});

check('mock catalog contains a structured first-choice boundary', async () => {
  const story = await provider.getStory('cafe-rain');
  const choice = story.beats.find((b) => b.type === 'ask_player_choice');
  assert.ok(choice, 'cafe-rain should expose a structured ask_player_choice beat');
  assert.equal(typeof choice.text, 'string');
  const dialogue = story.beats.find((b) => b.type === 'dialogue');
  assert.ok(dialogue && typeof dialogue.speaker === 'string');
});

check('getStory returns defensive copies', async () => {
  const a = await provider.getStory('cafe-rain');
  a.title = 'mutated';
  const b = await provider.getStory('cafe-rain');
  assert.notEqual(b.title, 'mutated');
});

check('advanceStory increments index and returns beat', async () => {
  const r = await provider.advanceStory({ storyId: 'cafe-rain', roleId: 'stranger', index: 0 });
  assert.equal(r.storyId, 'cafe-rain');
  assert.equal(r.roleId, 'stranger');
  assert.equal(r.index, 1);
  assert.equal(r.finished, false);
  assert.equal(typeof r.beat, 'string');
});

check('advanceStory signals finished at end', async () => {
  const story = await provider.getStory('cafe-rain');
  const r = await provider.advanceStory({ storyId: 'cafe-rain', index: story.beats.length - 1 });
  assert.equal(r.finished, true);
  assert.equal(r.beat, null);
});

check('advanceStory caps index at beats.length', async () => {
  const r = await provider.advanceStory({ storyId: 'cafe-rain', index: 9999 });
  assert.equal(r.finished, true);
  assert.equal(r.beat, null);
});

// ---------------------------------------------------------------------------
// Mock provider — error paths
// ---------------------------------------------------------------------------
console.log('\nMock provider errors');

check('getStory throws StoryNotFoundError for unknown id', async () => {
  await assert.rejects(
    () => provider.getStory('does-not-exist'),
    (err) => err instanceof StoryNotFoundError && err.code === 'story_not_found' && err.details.storyId === 'does-not-exist',
  );
});

check('getStory rejects empty id', async () => {
  await assert.rejects(() => provider.getStory(''), ValidationError);
});

check('getStory rejects id with bad chars', async () => {
  await assert.rejects(() => provider.getStory('../etc/passwd'), ValidationError);
  await assert.rejects(() => provider.getStory('with space'), ValidationError);
});

check('advanceStory throws StoryNotFoundError for unknown id', async () => {
  await assert.rejects(
    () => provider.advanceStory({ storyId: 'nope', index: 0 }),
    StoryNotFoundError,
  );
});

check('advanceStory rejects non-integer negative index', async () => {
  await assert.rejects(
    () => provider.advanceStory({ storyId: 'cafe-rain', index: -1 }),
    ValidationError,
  );
});

check('advanceStory rejects null input', async () => {
  await assert.rejects(() => provider.advanceStory(null), ValidationError);
});

check('ProviderError carries code + details', () => {
  const err = new ProviderError('boom', 'Boom!', { a: 1 });
  assert.equal(err.code, 'boom');
  assert.equal(err.details.a, 1);
  assert.equal(err.message, 'Boom!');
});

// ---------------------------------------------------------------------------
// Provider selector seam
// ---------------------------------------------------------------------------
console.log('\nProvider selector');

check('default provider is the Mock', () => {
  __resetStoryProviderForTests();
  delete process.env.STORY_OUTSIDE_PROVIDER;
  const p = getStoryProvider();
  assert.equal(p.name, 'mock');
});

check('STORY_OUTSIDE_PROVIDER=mock selects Mock', () => {
  __resetStoryProviderForTests();
  process.env.STORY_OUTSIDE_PROVIDER = 'mock';
  try {
    const p = getStoryProvider();
    assert.equal(p.name, 'mock');
  } finally {
    delete process.env.STORY_OUTSIDE_PROVIDER;
    __resetStoryProviderForTests();
  }
});

check('STORY_OUTSIDE_PROVIDER=real selects the Zhihu real provider', () => {
  __resetStoryProviderForTests();
  process.env.STORY_OUTSIDE_PROVIDER = 'real';
  try {
    const p = getStoryProvider();
    assert.equal(p.name, 'real');
    assert.equal(typeof p.listStories, 'function');
    assert.equal(typeof p.getStory, 'function');
    assert.equal(typeof p.advanceStory, 'function');
  } finally {
    delete process.env.STORY_OUTSIDE_PROVIDER;
    __resetStoryProviderForTests();
  }
});

check('STORY_OUTSIDE_PROVIDER=unknown throws at startup', () => {
  __resetStoryProviderForTests();
  process.env.STORY_OUTSIDE_PROVIDER = 'whatever';
  try {
    assert.throws(() => getStoryProvider(), /Unknown provider value="whatever"/);
  } finally {
    delete process.env.STORY_OUTSIDE_PROVIDER;
    __resetStoryProviderForTests();
  }
});

check('ZHIHU_PROVIDER=real selects the Zhihu real provider', () => {
  __resetStoryProviderForTests();
  delete process.env.STORY_OUTSIDE_PROVIDER;
  process.env.ZHIHU_PROVIDER = 'real';
  try {
    const p = getStoryProvider();
    assert.equal(p.name, 'real');
  } finally {
    delete process.env.ZHIHU_PROVIDER;
    __resetStoryProviderForTests();
  }
});

check('ZHIHU_PROVIDER=mock selects the Mock', () => {
  __resetStoryProviderForTests();
  delete process.env.STORY_OUTSIDE_PROVIDER;
  process.env.ZHIHU_PROVIDER = 'mock';
  try {
    const p = getStoryProvider();
    assert.equal(p.name, 'mock');
  } finally {
    delete process.env.ZHIHU_PROVIDER;
    __resetStoryProviderForTests();
  }
});

check('STORY_OUTSIDE_PROVIDER wins over ZHIHU_PROVIDER', () => {
  __resetStoryProviderForTests();
  process.env.STORY_OUTSIDE_PROVIDER = 'mock';
  process.env.ZHIHU_PROVIDER = 'real';
  try {
    const p = getStoryProvider();
    assert.equal(p.name, 'mock');
  } finally {
    delete process.env.STORY_OUTSIDE_PROVIDER;
    delete process.env.ZHIHU_PROVIDER;
    __resetStoryProviderForTests();
  }
});

check('empty ZHIHU_PROVIDER falls back to default mock', () => {
  __resetStoryProviderForTests();
  delete process.env.STORY_OUTSIDE_PROVIDER;
  process.env.ZHIHU_PROVIDER = '   ';
  try {
    const p = getStoryProvider();
    assert.equal(p.name, 'mock');
  } finally {
    delete process.env.ZHIHU_PROVIDER;
    __resetStoryProviderForTests();
  }
});

check('ZHIHU_PROVIDER=unknown throws with the resolved value', () => {
  __resetStoryProviderForTests();
  delete process.env.STORY_OUTSIDE_PROVIDER;
  process.env.ZHIHU_PROVIDER = 'gibberish';
  try {
    assert.throws(() => getStoryProvider(), /Unknown provider value="gibberish"/);
  } finally {
    delete process.env.ZHIHU_PROVIDER;
    __resetStoryProviderForTests();
  }
});

check('readProviderEnv reports the winning env key', () => {
  __resetStoryProviderForTests();
  delete process.env.STORY_OUTSIDE_PROVIDER;
  delete process.env.ZHIHU_PROVIDER;
  process.env.ZHIHU_PROVIDER = 'real';
  try {
    const info = readProviderEnv();
    assert.equal(info.key, 'ZHIHU_PROVIDER');
    assert.equal(info.value, 'real');
  } finally {
    delete process.env.ZHIHU_PROVIDER;
    __resetStoryProviderForTests();
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n${failures} provider check(s) failed`);
  process.exit(1);
}
console.log(`\nall provider checks passed`);