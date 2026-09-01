import assert from 'node:assert/strict';
import {
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  ToolValidationError,
  createToolRegistry,
  executeToolCall,
  validateAskPlayerChoice,
  validateFinishStory,
} from '../src/agent/index.mjs';

function test(name, fn) {
  return Promise.resolve().then(fn).then(() => console.log(`ok - ${name}`));
}

await test('exports are stable and frozen', async () => {
  assert.deepEqual(TOOL_NAMES, ['ask_player_choice', 'finish_story']);
  assert.equal(Object.isFrozen(TOOL_NAMES), true);
  assert.equal(Object.isFrozen(TOOL_DEFINITIONS), true);
  assert.equal(Object.isFrozen(TOOL_DEFINITIONS[0]), true);
});

await test('ask_player_choice normalizes free text and choice_id', async () => {
  const normalized = validateAskPlayerChoice({
    question: '选一个',
    options: [
      { id: 'a', label: 'A', description: 'first' },
      { id: 'b', text: 'B' },
    ],
    choice_id: 'choice-1',
  });
  assert.deepEqual(normalized, {
    question: '选一个',
    options: [{ id: 'a', label: 'A', description: 'first' }, { id: 'b', label: 'B', text: 'B' }],
    allow_free_text: true,
    choice_id: 'choice-1',
  });
});

await test('ask_player_choice rejects bad fields and duplicate ids', async () => {
  assert.throws(() => validateAskPlayerChoice(null), (error) => error instanceof ToolValidationError && error.code === 'invalid_input');
  assert.throws(() => validateAskPlayerChoice({ question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }), (error) => error instanceof ToolValidationError && error.code === 'invalid_tool_call');
  assert.throws(() => validateAskPlayerChoice({ question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], extra: 1 }), (error) => error instanceof ToolValidationError && error.code === 'invalid_tool_call');
  assert.throws(() => validateAskPlayerChoice({ question: 'q', options: [{ id: 'a', label: 'A', secret: 'x' }, { id: 'b', label: 'B' }] }), (error) => error instanceof ToolValidationError && error.code === 'invalid_input');
  assert.throws(() => validateAskPlayerChoice({ question: 'q', options: [{ id: 'a', label: '' }, { id: 'b', label: 'B' }] }), (error) => error instanceof ToolValidationError && error.code === 'invalid_tool_call');
  assert.throws(() => validateAskPlayerChoice({ question: 'q', options: [{ id: 'a', text: '' }, { id: 'b', label: 'B' }] }), (error) => error instanceof ToolValidationError && error.code === 'invalid_tool_call');
});

await test('finish_story validates required fields and deep clones', async () => {
  const input = {
    summary: 'done',
    ending: 'ending',
    original_difference: 'diff',
    key_choices: ['one'],
    character_outcomes: [{ character: 'A', fate: 'safe', change: 'grew' }],
    ending_key: 'final',
  };
  const normalized = validateFinishStory(input);
  assert.deepEqual(normalized, input);
  input.character_outcomes[0].change = 'mutated';
  assert.equal(normalized.character_outcomes[0].change, 'grew');
});

await test('finish_story rejects unknown and empty fields', async () => {
  assert.throws(() => validateFinishStory({ summary: 'done', ending: 'ending', original_difference: 'diff', key_choices: ['x'], character_outcomes: [{ character: 'A', fate: 'B' }], extra: true }), (error) => error instanceof ToolValidationError && error.code === 'invalid_tool_call');
  assert.throws(() => validateFinishStory({ summary: 'done', ending: 'ending', original_difference: 'diff', key_choices: [], character_outcomes: [{ character: 'A', fate: 'B' }] }), (error) => error instanceof ToolValidationError && error.code === 'invalid_tool_call');
  assert.throws(() => validateFinishStory({ summary: 'done', ending: 'ending', original_difference: 'diff', key_choices: ['x'], character_outcomes: [{ character: 'A', fate: 'B', change: '' }] }), (error) => error instanceof ToolValidationError && error.code === 'invalid_tool_call');
});

await test('executeToolCall returns choice_required and story_finished envelopes', async () => {
  const choice = executeToolCall({ name: 'ask_player_choice', arguments: { question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }, session_uuid: '11111111-1111-4111-8111-111111111111', turn_id: '22222222-2222-4222-8222-222222222222', base_revision: 3, tool_call_id: 'tool-1' });
  assert.equal(choice.kind, 'choice_required');
  assert.equal(choice.requires_player, true);
  assert.equal(choice.terminal, false);
  assert.equal(choice.tool_call_id, 'tool-1');
  const finish = executeToolCall({ name: 'finish_story', arguments: { summary: 'done', ending: 'ending', original_difference: 'diff', key_choices: ['x'], character_outcomes: [{ character: 'A', fate: 'B' }] }, tool_call_id: 'tool-2' });
  assert.equal(finish.kind, 'story_finished');
  assert.equal(finish.terminal, true);
  assert.equal(finish.requires_player, false);
});

await test('executeToolCall validates UUIDs, id alias, and finite JSON', async () => {
  assert.throws(() => executeToolCall({ name: 'ask_player_choice', arguments: { question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }, session_uuid: 'not-a-uuid', tool_call_id: 'tool-1' }), (error) => error instanceof ToolValidationError && error.code === 'invalid_input');
  assert.throws(() => executeToolCall({ name: 'ask_player_choice', arguments: { question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], value: Number.NaN }, tool_call_id: 'tool-1' }), (error) => error instanceof ToolValidationError && error.code === 'invalid_input');
  assert.throws(() => executeToolCall({ name: 'ask_player_choice', arguments: { question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], loop: null }, id: 'alias-1' }), (error) => error instanceof ToolValidationError && error.code === 'invalid_tool_call');
  const alias = executeToolCall({ name: 'finish_story', arguments: { summary: 'done', ending: 'ending', original_difference: 'diff', key_choices: ['x'], character_outcomes: [{ character: 'A', fate: 'B' }] }, id: 'tool-alias' });
  assert.equal(alias.tool_call_id, 'tool-alias');
});

await test('createToolRegistry returns isolated definitions', async () => {
  const registry = createToolRegistry();
  assert.deepEqual(registry.definitions, TOOL_DEFINITIONS);
  registry.definitions[0].function.name = 'mutated';
  assert.equal(TOOL_DEFINITIONS[0].function.name, 'ask_player_choice');
});
