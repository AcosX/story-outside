import { canonicalJsonStringify } from '../stories/canonicalHash.mjs';
import { getSession, listSessionEvents } from '../stories/sessionService.mjs';
import { randomUUID } from 'node:crypto';
import { executeToolCall, ToolValidationError } from './tools.mjs';

const RUNTIME_STATE = Symbol('agentRuntimeState');
const SENSITIVE_KEY_PATTERN = /^(password|token|access[_-]?token|secret|api[_-]?key|app[_-]?key|authorization|cookie|headers?)$/i;
const ERROR_CODES = new Set(['pin_mismatch', 'invalid_input', 'provider_failure', 'unknown_tool', 'invalid_tool_call', 'revision_mismatch', 'duplicate_request']);

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

function normalizeProviderResult(result) {
  if (!result || typeof result !== 'object') fail('provider_failure', 'provider result must be an object');
  const hasMessages = result.messages !== undefined;
  const hasToolCalls = result.tool_calls !== undefined;
  if (hasMessages && hasToolCalls) fail('invalid_tool_call', 'messages and tool_calls cannot be mixed');
  const messages = hasMessages ? assertObjectArray(result.messages, 'messages').map((msg) => {
    if (msg.role !== 'assistant' || typeof msg.content !== 'string' || !msg.content.trim()) fail('invalid_tool_call', 'assistant messages must contain non-empty string content');
    return { role: 'assistant', content: msg.content };
  }) : undefined;
  if (messages && messages.length === 0) fail('provider_failure', 'provider result must include messages or tool_calls');
  const tool_calls = hasToolCalls ? assertObjectArray(result.tool_calls, 'tool_calls').map((call) => {
    if (!call || typeof call !== 'object') fail('invalid_tool_call', 'tool call must be an object');
    const payload = { name: call.name, arguments: call.arguments, tool_call_id: call.tool_call_id ?? call.id };
    try {
      const normalized = executeToolCall(payload);
      return { ...normalized, arguments: clone(normalized.payload), tool_envelope: clone(normalized) };
    } catch (error) {
      if (error instanceof ToolValidationError) fail('invalid_tool_call', error.message);
      throw error;
    }
  }) : undefined;
  if (tool_calls && tool_calls.length !== 1) fail('invalid_tool_call', 'provider must return exactly one tool_call');
  if (!messages && !tool_calls) fail('provider_failure', 'provider result must include messages or tool_calls');
  return { messages: messages ?? [], tool_calls: tool_calls ?? [] };
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
      pending: null,
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
  try {
    rawResult = await state.provider.complete(buildRequest(state, inputJson));
  } catch {
    fail('provider_failure', 'agent provider failed');
  }
  const providerResult = normalizeProviderResult(rawResult);
  const turn_id = randomUUID();
  const result = { turn_id, request_id: key, base_revision: state.base_revision, base_cursor: state.base_cursor, kind: providerResult.tool_calls.length ? 'tool_call' : 'narrative', messages: providerResult.messages, tool_calls: providerResult.tool_calls, tool_result: providerResult.tool_calls[0] ? clone(providerResult.tool_calls[0].tool_envelope) : null, tool_envelope: providerResult.tool_calls[0] ? clone(providerResult.tool_calls[0].tool_envelope) : null, pending: providerResult.tool_calls.length > 0 };
  state.pending = clone(result);
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
  return clone({ session_uuid: state.session_uuid, pinned: state.pinned, base_revision: state.base_revision, base_cursor: state.base_cursor, canonical_history: listSessionEvents({ repository: state.repository, session_uuid: state.session_uuid }), successful_turns: state.successful_turns, pending: state.pending });
}

export { AgentRuntimeError };
