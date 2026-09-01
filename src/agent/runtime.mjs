import { canonicalJsonStringify } from '../stories/canonicalHash.mjs';
import { getSession, listSessionEvents, stageNarrativeBatch } from '../stories/sessionService.mjs';
import { randomUUID } from 'node:crypto';
import { executeToolCall, ToolValidationError } from './tools.mjs';

const RUNTIME_STATE = Symbol('agentRuntimeState');
const SENSITIVE_KEY_PATTERN = /^(password|token|access[_-]?token|secret|api[_-]?key|app[_-]?key|authorization|cookie|headers?)$/i;
const ERROR_CODES = new Set(['pin_mismatch', 'invalid_input', 'provider_failure', 'unknown_tool', 'invalid_tool_call', 'revision_mismatch', 'duplicate_request']);

// ClickUp 08 contract: a provider turn MAY return 1..4 ordered narrative
// items and OPTIONALLY a single tool call as the FINAL item. The runtime
// normalises both shapes into one canonical stage.
const MIN_NARRATIVE = 1;
const MAX_NARRATIVE = 4;

class AgentRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentRuntimeError';
    this.code = code;
  }
}

function fail(code, message) {
  if (!ERROR_CODES.has(code)) throw new Error(`agent/runtime: unknown error code '${code}'`);
  throw new AgentRuntimeError(code, message);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function assertFiniteJson(value, label) {
  try {
    return JSON.parse(canonicalJsonStringify(value));
  } catch {
    fail('invalid_input', `${label} must be finite JSON`);
  }
}

function assertObjectArray(value, label) {
  if (!Array.isArray(value) || !value.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
    fail('invalid_input', `${label} must be an array of objects`);
  }
  return value;
}

function runtimeState(runtime) {
  if (!runtime || typeof runtime !== 'object' || !runtime[RUNTIME_STATE]) fail('invalid_input', 'runtime required');
  return runtime[RUNTIME_STATE];
}

function fingerprint(input, revision, request_id) {
  return canonicalJsonStringify({ input, revision, request_id: request_id ?? null });
}

function isSensitiveKey(key) {
  const normalized = key.replace(/[-_\s]/g, '').toLowerCase();
  return SENSITIVE_KEY_PATTERN.test(key) || ['password', 'token', 'accesstoken', 'secret', 'apikey', 'appkey', 'authorization', 'cookie', 'headers', 'header'].includes(normalized);
}

function scanSensitiveKeys(value, path = 'value') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanSensitiveKeys(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key)) fail('invalid_input', `sensitive key rejected at ${path}.${key}`);
    scanSensitiveKeys(child, `${path}.${key}`);
  }
}

function sanitizeFiniteJson(value, label) {
  const json = assertFiniteJson(value, label);
  scanSensitiveKeys(json, label);
  return json;
}

/**
 * Normalise a provider result into the ClickUp 08 shape:
 *   * items    : array of 1..4 narrative items in order
 *   * tool_call: optional normalised tool call (the FINAL item)
 *
 * The provider can express this either as:
 *   { messages: [...], tool_calls: [<one>] }
 * where messages are 1..4 ordered narrative beats, OR
 *   { items: [...], tool_call: {...} }
 * for explicit ClickUp 08 shape. Mixed messages+tool_calls without an
 * items array is rejected so the application layer never has to guess
 * whether tool_calls rides along with the narrative batch.
 */
function normalizeProviderResult(result) {
  if (!result || typeof result !== 'object') fail('provider_failure', 'provider result must be an object');
  const hasMessages = result.messages !== undefined;
  const hasToolCalls = result.tool_calls !== undefined;
  const hasItems = result.items !== undefined;
  const hasExplicitTool = result.tool_call !== undefined;
  if (hasItems) {
    if (hasMessages || hasToolCalls) fail('invalid_tool_call', 'items cannot be combined with messages/tool_calls');
    assertObjectArray(result.items, 'items');
    if (result.items.length < MIN_NARRATIVE || result.items.length > MAX_NARRATIVE) {
      fail('invalid_tool_call', `items must contain ${MIN_NARRATIVE} to ${MAX_NARRATIVE} narrative items`);
    }
    const normalisedItems = result.items.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) fail('invalid_tool_call', `items[${index}] must be an object`);
      const role = item.role;
      const text = typeof item.text === 'string' ? item.text : (typeof item.content === 'string' ? item.content : null);
      if (role !== undefined && role !== 'assistant') fail('invalid_tool_call', `items[${index}].role must be 'assistant' or omitted`);
      if (text === null || !text.trim()) fail('invalid_tool_call', `items[${index}].text must be a non-empty string`);
      const out = { role: 'assistant', text };
      if (item.type !== undefined) out.type = item.type;
      if (item.speaker !== undefined) out.speaker = item.speaker;
      if (item.sequence !== undefined && item.sequence !== index) fail('invalid_tool_call', `items[${index}].sequence must equal ${index}`);
      return out;
    });
    let normalisedTool = null;
    if (hasExplicitTool && result.tool_call !== null) {
      if (!result.tool_call || typeof result.tool_call !== 'object' || Array.isArray(result.tool_call)) fail('invalid_tool_call', 'tool_call must be an object');
      try {
        normalisedTool = executeToolCall({
          name: result.tool_call.name,
          arguments: result.tool_call.arguments,
          tool_call_id: result.tool_call.tool_call_id ?? result.tool_call.id,
          id: result.tool_call.id,
        });
      } catch (error) {
        if (error instanceof ToolValidationError) fail('invalid_tool_call', error.message);
        throw error;
      }
    }
    return { items: normalisedItems, tool_call: normalisedTool };
  }
  // Legacy shape: { messages, tool_calls }.
  if (hasMessages && hasToolCalls) fail('invalid_tool_call', 'messages and tool_calls cannot be mixed');
  if (!hasMessages && !hasToolCalls) fail('provider_failure', 'provider result must include messages, items, or tool_calls');
  if (hasMessages) {
    assertObjectArray(result.messages, 'messages');
    if (result.messages.length < MIN_NARRATIVE || result.messages.length > MAX_NARRATIVE) {
      fail('invalid_tool_call', `messages must contain ${MIN_NARRATIVE} to ${MAX_NARRATIVE} narrative items`);
    }
    const normalisedItems = result.messages.map((msg, index) => {
      if (msg.role !== 'assistant' || typeof msg.content !== 'string' || !msg.content.trim()) fail('invalid_tool_call', `messages[${index}] must be an assistant message with non-empty string content`);
      const out = { role: 'assistant', text: msg.content };
      if (msg.type !== undefined) out.type = msg.type;
      if (msg.speaker !== undefined) out.speaker = msg.speaker;
      if (msg.sequence !== undefined && msg.sequence !== index) fail('invalid_tool_call', `messages[${index}].sequence must equal ${index}`);
      return out;
    });
    return { items: normalisedItems, tool_call: null };
  }
  // messages absent, tool_calls present: single tool call with no narrative items.
  assertObjectArray(result.tool_calls, 'tool_calls');
  if (result.tool_calls.length !== 1) fail('invalid_tool_call', 'provider must return exactly one tool_call when messages are absent');
  let normalisedTool;
  try {
    normalisedTool = executeToolCall({
      name: result.tool_calls[0].name,
      arguments: result.tool_calls[0].arguments,
      tool_call_id: result.tool_calls[0].tool_call_id ?? result.tool_calls[0].id,
      id: result.tool_calls[0].id,
    });
  } catch (error) {
    if (error instanceof ToolValidationError) fail('invalid_tool_call', error.message);
    throw error;
  }
  return { items: [], tool_call: normalisedTool };
}

export function createMockAgentProvider({ responses = [], handler, failure } = {}) {
  let index = 0;
  return {
    callCount: 0,
    async complete(request) {
      this.callCount += 1;
      if (typeof handler === 'function') return handler(request);
      if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
      if (index >= responses.length) throw new AgentRuntimeError('provider_failure', 'mock provider exhausted');
      const response = responses[index];
      index += 1;
      if (response instanceof Error) throw response;
      if (response && response.failure) throw new AgentRuntimeError('provider_failure', response.failure);
      return clone(response);
    },
  };
}

export function createAgentRuntime({ repository, session_uuid, provider, system_prompt, tool_definitions, expected_story_version_uuid, expected_story_version_checksum, expected_model, expected_generation_profile }) {
  if (!provider || typeof provider.complete !== 'function') fail('invalid_input', 'provider.complete required');
  const session = getSession({ repository, session_uuid });
  if (session.story_version_uuid !== expected_story_version_uuid || session.story_version_checksum !== expected_story_version_checksum || session.model !== expected_model) fail('pin_mismatch', 'session pin mismatch');
  const normalizedExpectedProfile = assertFiniteJson(expected_generation_profile, 'expected_generation_profile');
  if (canonicalJsonStringify(session.generation_profile) !== canonicalJsonStringify(normalizedExpectedProfile)) fail('pin_mismatch', 'generation_profile pin mismatch');
  const runtime = { repository };
  Object.defineProperty(runtime, RUNTIME_STATE, {
    value: {
      repository,
      session_uuid,
      provider,
      pinned: clone({ story_uuid: session.story_uuid, story_version_uuid: session.story_version_uuid, story_version_checksum: session.story_version_checksum, role_id: session.role_id, model: session.model, generation_profile: session.generation_profile }),
      system_prompt: clone(sanitizeFiniteJson(system_prompt, 'system_prompt')),
      tool_definitions: clone(assertObjectArray(sanitizeFiniteJson(tool_definitions, 'tool_definitions'), 'tool_definitions')),
      base_revision: session.revision,
      base_cursor: session.cursor,
      successful_turns: [],
      staged: null,
      requestIndex: new Map(),
    },
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return runtime;
}

function buildRequest(state, inputJson) {
  return {
    session: { session_uuid: state.session_uuid, revision: state.base_revision, cursor: state.base_cursor },
    pinned: clone(state.pinned),
    canonical_history: clone(listSessionEvents({ repository: state.repository, session_uuid: state.session_uuid })),
    input: inputJson,
    system_prompt: clone(state.system_prompt),
    tool_definitions: clone(state.tool_definitions),
  };
}

function buildToolCallEnvelope(toolCall, session_uuid, turn_id, base_revision) {
  if (!toolCall) return null;
  return {
    ...clone(toolCall),
    session_uuid,
    turn_id,
    base_revision,
    kind: toolCall.kind,
    requires_player: toolCall.requires_player,
    terminal: toolCall.terminal,
  };
}

export async function runTurn(runtime, { request_id, input, expected_revision } = {}) {
  const state = runtimeState(runtime);
  const session = getSession({ repository: state.repository, session_uuid: state.session_uuid });
  const inputJson = assertFiniteJson(input, 'input');
  scanSensitiveKeys(inputJson, 'input');
  if (request_id !== undefined && !(typeof request_id === 'string' && request_id.length > 0)) fail('invalid_input', 'request_id must be a non-empty string');
  const key = typeof request_id === 'string' && request_id.length > 0 ? request_id : null;
  if (!Number.isInteger(expected_revision)) fail('invalid_input', 'expected_revision must be an integer');
  const fp = fingerprint(inputJson, expected_revision, key);
  const existing = key && state.requestIndex.get(key);
  if (existing) {
    if (existing.fingerprint !== fp) fail('duplicate_request', 'request_id already used for a different request');
    return clone(existing.result);
  }
  if (expected_revision !== state.base_revision) fail('revision_mismatch', 'revision mismatch');
  if (session.revision !== state.base_revision) fail('revision_mismatch', 'revision mismatch');
  let rawResult;
  let turn_id;
  try {
    turn_id = randomUUID();
    state.turn_id = turn_id;
    rawResult = await state.provider.complete(buildRequest(state, inputJson));
  } catch {
    fail('provider_failure', 'agent provider failed');
  }
  const providerResult = normalizeProviderResult(rawResult);
  // ClickUp 08 contract: the runtime STAGES the provider result on the
  // canonical session pending slot. There is exactly one active pending
  // per session. The runtime does NOT keep a separate pending record.
  let staged;
  try {
    staged = stageNarrativeBatch({
      repository: state.repository,
      session_uuid: state.session_uuid,
      items: providerResult.items.map((it) => ({
        type: it.type || 'narration',
        text: it.text,
        ...(it.speaker !== undefined ? { speaker: it.speaker } : {}),
      })),
      tool_call: providerResult.tool_call ? {
        tool_call_id: providerResult.tool_call.tool_call_id,
        name: providerResult.tool_call.name,
        payload: providerResult.tool_call.payload,
        kind: providerResult.tool_call.kind,
        requires_player: providerResult.tool_call.requires_player,
        terminal: providerResult.tool_call.terminal,
      } : undefined,
      source: 'runtime',
      expected_revision: state.base_revision,
      client_request_id: key ? `${key}:stage` : undefined,
    });
  } catch (error) {
    fail('invalid_tool_call', error && error.message ? error.message : String(error));
  }
  state.staged = staged;
  // The "items" we hand back to callers mirror the staged order so the
  // HTTP route layer can stream them one by one. tool_call rides along as
  // the optional final item but is never written to canonical history.
  const result = {
    turn_id,
    request_id: key,
    base_revision: state.base_revision,
    base_cursor: state.base_cursor,
    kind: providerResult.tool_call ? 'tool_call' : 'narrative',
    items: providerResult.items.map((it) => ({
      type: it.type || 'narration',
      text: it.text,
      ...(it.speaker !== undefined ? { speaker: it.speaker } : {}),
    })),
    pending_id: staged.pending_id,
    pending_committed_count: staged.committed_count,
    pending_total: staged.events.length,
    state: staged.state,
    session_uuid: state.session_uuid,
    base_revision: state.base_revision,
    tool_call: providerResult.tool_call ? buildToolCallEnvelope(providerResult.tool_call, state.session_uuid, turn_id, state.base_revision) : null,
    tool_envelope: providerResult.tool_call ? buildToolCallEnvelope(providerResult.tool_call, state.session_uuid, turn_id, state.base_revision) : null,
    tool_result: providerResult.tool_call ? {
      kind: providerResult.tool_call.kind,
      requires_player: providerResult.tool_call.requires_player,
      terminal: providerResult.tool_call.terminal,
      payload: clone(providerResult.tool_call.payload),
      session_uuid: state.session_uuid,
      turn_id,
      base_revision: state.base_revision,
    } : null,
    pending: !!providerResult.tool_call,
  };
  state.successful_turns.push(clone(result));
  if (key) state.requestIndex.set(key, { fingerprint: fp, result: clone(result) });
  return clone(result);
}

export async function resumeTurn(runtime, args = {}) {
  if (!args || typeof args !== 'object' || Object.keys(args).length === 0) return recoverRuntime(runtime);
  if (!('input' in args) && !('request_id' in args)) return recoverRuntime(runtime);
  return runTurn(runtime, args);
}

export function recoverRuntime(runtime) {
  const state = runtimeState(runtime);
  return clone({
    session_uuid: state.session_uuid,
    pinned: state.pinned,
    base_revision: state.base_revision,
    base_cursor: state.base_cursor,
    canonical_history: listSessionEvents({ repository: state.repository, session_uuid: state.session_uuid }),
    successful_turns: state.successful_turns,
    staged: state.staged,
  });
}

export { AgentRuntimeError };