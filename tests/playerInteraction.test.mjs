import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { playerInteraction } from '../src/agent/playerInteraction.mjs';

const events = (count, start = 1) => Array.from({ length: count }, (_, index) => ({
  event_seq: start + index,
  event_type: 'narrative_beat',
  payload: { text: `雨仍在下 ${start + index}。` },
}));

for (const count of [0, 1, 2, 3, 4, 5, 11]) {
  const policy = playerInteraction(events(count));
  assert.equal(policy.choice_recommended, count >= 2);
  assert.equal(policy.choice_required, count >= 2);
}
assert.equal(playerInteraction([...events(8), { event_type: 'player_input' }, ...events(2)]).narratives_since_input, 2);
assert.equal(playerInteraction([...events(3), { event_type: 'narrative_beat', status: 'pending' }]).choice_required, true);
assert.equal(playerInteraction([{ event_type: 'story_opening' }, ...events(2)]).narratives_since_input, 2);
assert.equal(playerInteraction([...events(5), { event_type: 'player_input' }]).choice_required, false);

process.env.STORY_OUTSIDE_PROVIDER = 'mock';
process.env.STORY_OUTSIDE_AI_PROVIDER = 'mock';
const { server, storyRepo, storyFixtures } = await import('../src/server.mjs');
const {
  createSession,
  stageNarrativeBatch,
  commitNarrativeEvent,
} = await import('../src/stories/sessionService.mjs');
const { ensureOpeningCache } = await import('../src/stories/storyService.mjs');
const fixture = storyFixtures.find(x => x.slug === 'cafe-rain');
const { cache } = await ensureOpeningCache({ repository: storyRepo, story_version_uuid: fixture.story_version_uuid });
const sessionUuid = randomUUID();
const generationProfile = { ...cache.generation_profile, cache_uuid: cache.cache_uuid };
createSession({
  repository: storyRepo,
  session_uuid: sessionUuid,
  story_uuid: fixture.story_uuid,
  story_version_uuid: fixture.story_version_uuid,
  user_ref: 'choice-test',
  role_id: 'stranger',
  model: 'choice-test',
  prompt: 'test',
  generation_profile: generationProfile,
});

Object.assign(process.env, {
  STORY_OUTSIDE_AI_PROVIDER: 'real',
  STORY_OUTSIDE_AI_API_KEY: 'fake-test',
  STORY_OUTSIDE_AI_MODEL: 'choice-test',
  STORY_OUTSIDE_AI_BASE_URL: 'https://choice-test.invalid/v1',
  STORY_OUTSIDE_AI_SECRET_FILE: '/nonexistent-choice-test',
  STORY_OUTSIDE_AI_MAX_RETRIES: '1',
});

const nativeFetch = globalThis.fetch;
const requests = [];
const choice = {
  name: 'ask_player_choice',
  arguments: {
    question: '接下来，你想怎么做？',
    options: [{ id: 'open', label: '询问来意' }, { id: 'wait', label: '继续等候' }],
  },
};
const plannedBatches = [
  { count: 3, tool_call: null },
  { count: 2, tool_call: choice },
  { count: 4, tool_call: null },
  { count: 1, tool_call: choice },
  { count: 5, tool_call: null }, // rejected: reaches the boundary without a choice
  { count: 5, tool_call: choice },
];

globalThis.fetch = async (url, options) => {
  if (!String(url).startsWith('https://choice-test.invalid')) return nativeFetch(url, options);
  const body = JSON.parse(options.body);
  const payload = JSON.parse(body.messages[1].content);
  const interaction = payload.player_interaction;
  const itemSchema = body.tools[0].function.parameters.properties.items;
  requests.push({ body, payload });
  const plan = plannedBatches[Math.min(requests.length - 1, plannedBatches.length - 1)];
  assert.equal(itemSchema.minItems, interaction.choice_required ? 1 : 3);
  assert.equal(
    itemSchema.maxItems,
    interaction.choice_required
      ? Math.max(1, 5 - interaction.narratives_since_input)
      : 5,
  );
  assert.equal(
    body.tools[0].function.parameters.required.includes('tool_call'),
    interaction.choice_required,
  );
  const items = Array.from({ length: plan.count }, (_, index) => ({
    type: 'narration',
    text: `批次 ${requests.length} 的第 ${index + 1} 条。`,
  }));
  return Response.json({
    choices: [{
      message: {
        content: JSON.stringify({ arc_status: 'ongoing', items, ...(plan.tool_call ? { tool_call: plan.tool_call } : {}) }),
      },
      finish_reason: 'stop',
    }],
  });
};

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/sessions/${sessionUuid}`;
const post = async (path, body) => {
  const response = await nativeFetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', prefer: 'respond-async, persist-async' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, `${path} should succeed`);
  return response.json();
};

async function commitBatch(turn, revision, label) {
  assert.ok(turn.events.length >= 1 && turn.events.length <= 5);
  for (let sequence = 0; sequence < turn.events.length; sequence += 1) {
    const committed = await post('/narrative-events', {
      pending_id: turn.pending_id,
      sequence,
      expected_revision: revision,
      client_request_id: `${label}-${sequence}`,
    });
    revision = committed.revision;
    if (sequence === turn.events.length - 1) {
      assert.equal(Boolean(committed.pending_tool_call), Boolean(turn.tool_call));
    } else {
      assert.equal(committed.pending_tool_call, null);
    }
  }
  return revision;
}

try {
  let revision = 0;
  let turn = await post('/generate', {
    request_id: 'turn-3', expected_revision: revision, input: { kind: 'continue', text: '继续' },
  });
  assert.equal(turn.events.length, 3);
  assert.equal(turn.tool_call, null);
  revision = await commitBatch(turn, revision, 'batch-3');

  turn = await post('/generate', {
    request_id: 'turn-boundary-2', expected_revision: revision, input: { kind: 'continue', text: '继续' },
  });
  assert.equal(turn.events.length, 2);
  assert.equal(turn.tool_call.name, 'ask_player_choice');
  revision = await commitBatch(turn, revision, 'batch-boundary-2');
  const interrupt = await post('/interrupt', {
    text: '继续等候', expected_revision: revision, client_request_id: 'choice-reset-1',
  });
  revision = interrupt.revision;

  turn = await post('/generate', {
    request_id: 'turn-4', expected_revision: revision, input: { kind: 'continue', text: '继续' },
  });
  assert.equal(turn.events.length, 4);
  revision = await commitBatch(turn, revision, 'batch-4');
  turn = await post('/generate', {
    request_id: 'turn-boundary-1', expected_revision: revision, input: { kind: 'continue', text: '继续' },
  });
  assert.equal(turn.events.length, 1);
  assert.equal(turn.tool_call.name, 'ask_player_choice');
  revision = await commitBatch(turn, revision, 'batch-boundary-1');
  const secondInterrupt = await post('/interrupt', {
    text: '换个方向', expected_revision: revision, client_request_id: 'choice-reset-2',
  });
  revision = secondInterrupt.revision;

  turn = await post('/generate', {
    request_id: 'turn-invalid-5', expected_revision: revision, input: { kind: 'continue', text: '继续' },
  });
  assert.equal(turn.events.length, 5);
  assert.equal(turn.tool_call.name, 'ask_player_choice');
  revision = await commitBatch(turn, revision, 'batch-5');
  const thirdInterrupt = await post('/interrupt', {
    text: '从这里继续', expected_revision: revision, client_request_id: 'choice-reset-3',
  });
  revision = thirdInterrupt.revision;

  assert.equal(requests.length, 6, 'the invalid five-line no-choice candidate is retried once');
  assert.equal(requests[4].payload.player_interaction.narratives_since_input, 0);
  assert.equal(requests[5].payload.player_interaction.narratives_since_input, 0);
  assert.match(requests[5].body.messages.at(-1).content, /交互上限/);

  const boundarySession = randomUUID();
  createSession({
    repository: storyRepo,
    session_uuid: boundarySession,
    story_uuid: fixture.story_uuid,
    story_version_uuid: fixture.story_version_uuid,
    user_ref: 'boundary-test',
    role_id: 'stranger',
    model: 'choice-test',
    prompt: 'test',
    generation_profile: generationProfile,
  });
  assert.throws(() => stageNarrativeBatch({
    repository: storyRepo, session_uuid: boundarySession,
    items: Array.from({ length: 5 }, (_, index) => ({ type: 'narration', text: `首批 ${index}` })),
    expected_revision: 0,
  }), /choice_required/);
  const firstFour = stageNarrativeBatch({
    repository: storyRepo, session_uuid: boundarySession,
    items: Array.from({ length: 4 }, (_, index) => ({ type: 'narration', text: `四条 ${index}` })),
    expected_revision: 0,
  });
  let boundaryRevision = 0;
  for (let sequence = 0; sequence < 4; sequence += 1) {
    boundaryRevision = commitNarrativeEvent({
      repository: storyRepo, session_uuid: boundarySession,
      pending_id: firstFour.pending_id, sequence, expected_revision: boundaryRevision,
    }).revision;
  }
  assert.throws(() => stageNarrativeBatch({
    repository: storyRepo, session_uuid: boundarySession,
    items: [{ type: 'narration', text: '越界' }, { type: 'narration', text: '越界二' }],
    tool_call: choice,
    expected_revision: boundaryRevision,
  }), /exceeds/);
  const boundaryTail = stageNarrativeBatch({
    repository: storyRepo, session_uuid: boundarySession,
    items: [{ type: 'narration', text: '边界尾句' }],
    tool_call: choice,
    expected_revision: boundaryRevision,
  });
  const recoveryRevision = commitNarrativeEvent({
    repository: storyRepo, session_uuid: boundarySession,
    pending_id: boundaryTail.pending_id, sequence: 0, expected_revision: boundaryRevision,
  }).revision;
  assert.equal(recoveryRevision, 5);
  assert.doesNotThrow(() => stageNarrativeBatch({
    repository: storyRepo, session_uuid: boundarySession,
    items: [{ type: 'narration', text: '旧会话恢复尾句' }],
    tool_call: choice,
    expected_revision: recoveryRevision,
  }));
  console.log('Player interaction: 3/4/5 batches, boundary choices, reset, invalid retry, and server hard limits PASS');
} finally {
  globalThis.fetch = nativeFetch;
  await new Promise(resolve => server.close(resolve));
}
