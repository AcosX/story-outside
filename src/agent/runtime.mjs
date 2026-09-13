import { progressMetadata } from '../stories/plotProgress.mjs';
import { canonicalJsonStringify } from '../stories/canonicalHash.mjs';
import { getSession, getSessionCompact, recordCompact, recordCompactFailure, listSessionEvents, lookupTurnRequest, registerTurnRequest, stageNarrativeBatch } from '../stories/sessionService.mjs';
import { buildSessionContext, selectCompactWindow } from './contextBuilder.mjs';
import { randomUUID } from 'node:crypto';
import { executeToolCall, ToolValidationError } from './tools.mjs';

const RUNTIME_STATE = Symbol('agentRuntimeState');
const SENSITIVE_KEY_PATTERN = /^(password|token|access[_-]?token|secret|api[_-]?key|app[_-]?key|authorization|cookie|headers?)$/i;
const ERROR_CODES = new Set(['pin_mismatch', 'invalid_input', 'provider_failure', 'unknown_tool', 'invalid_tool_call', 'pending_conflict', 'revision_mismatch', 'duplicate_request']);

// ClickUp 08 contract: a provider turn MAY return 1..4 ordered narrative
// items and OPTIONALLY a single tool call as the FINAL item. The runtime
// normalises both shapes into one canonical stage.
const MIN_NARRATIVE = 1;
const MAX_NARRATIVE = 4;

class AgentRuntimeError extends Error {
  constructor(code, message, { retryable = code === 'provider_failure' } = {}) {
    super(message);
    this.name = 'AgentRuntimeError';
    this.code = code;
    this.retryable = retryable === true;
  }
}

function fail(code, message, options) {
  if (!ERROR_CODES.has(code)) throw new Error(`agent/runtime: unknown error code '${code}'`);
  throw new AgentRuntimeError(code, message, options);
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
 *   { messages: [...], tool_calls: [<exactly one>] }  (legacy OpenAI-ish)
 * where messages are 1..4 ordered narrative beats and the single
 * tool_calls entry rides the batch as the optional FINAL tool, OR
 *   { items: [...], tool_call: {...} }                (explicit 08 shape)
 *
 * Both shapes normalise to the same { items, tool_call } pair so the
 * application layer never has to guess whether the tool rides along.
 * Everything else fails closed:
 *   * tool-only batches (tool_calls without any narrative)
 *   * empty batches (0 narrative items)
 *   * >4 narrative items
 *   * more than one tool_call in the legacy array (multi-tool)
 *   * a tool that is not final (a tool-like entry inside items, or a
 *     non-assistant message)
 *   * illegal tool payloads (unknown name / bad arguments / missing id)
 * A normalised tool call never becomes a canonical event.
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
      const out = { role: 'assistant', text, ...progressMetadata(item) };
      if (item.type !== undefined) {
        // A tool may never hide inside the narrative items: type must be a
        // narrative beat kind, never 'tool_call' or anything else.
        if (!['narration', 'dialogue', 'action', 'beat'].includes(item.type)) {
          fail('invalid_tool_call', `items[${index}].type must be a narrative beat type`);
        }
        out.type = item.type;
      }
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
  // Legacy shape: { messages } and/or { tool_calls }.
  if (!hasMessages && !hasToolCalls) fail('provider_failure', 'provider result must include messages, items, or tool_calls');
  if (!hasMessages) {
    // tool_calls without messages (or items): a "tool-only" batch. ClickUp 08
    // forbids this shape — a tool call must ride on a batch that already
    // carries at least one narrative item. Allowing a tool-only batch would
    // park an un-committable pending slot (no event_seq to commit) and leak
    // the tool surface into canonical history through some future code
    // path. Reject it explicitly so a misbehaving provider fails closed.
    fail('invalid_tool_call', 'provider must return at least one narrative item; tool-only batches are not allowed');
  }
  assertObjectArray(result.messages, 'messages');
  if (result.messages.length < MIN_NARRATIVE || result.messages.length > MAX_NARRATIVE) {
    fail('invalid_tool_call', `messages must contain ${MIN_NARRATIVE} to ${MAX_NARRATIVE} narrative items`);
  }
  const normalisedItems = result.messages.map((msg, index) => {
    if (msg.role !== 'assistant' || typeof msg.content !== 'string' || !msg.content.trim()) fail('invalid_tool_call', `messages[${index}] must be an assistant message with non-empty string content`);
    const out = { role: 'assistant', text: msg.content, ...progressMetadata(msg) };
    if (msg.type !== undefined) {
      if (!['narration', 'dialogue', 'action', 'beat'].includes(msg.type)) {
        fail('invalid_tool_call', `messages[${index}].type must be a narrative beat type`);
      }
      out.type = msg.type;
    }
    if (msg.speaker !== undefined) out.speaker = msg.speaker;
    if (msg.sequence !== undefined && msg.sequence !== index) fail('invalid_tool_call', `messages[${index}].sequence must equal ${index}`);
    return out;
  });
  if (hasToolCalls) {
    // Legacy combined shape: { messages: 1..4, tool_calls: [<one>] }.
    // Unambiguous: messages are the ordered narrative items and the single
    // tool call is the optional FINAL item. Multi-tool arrays and empty
    // arrays are rejected; a tool-only batch (no messages at all) was
    // already rejected above.
    if (!Array.isArray(result.tool_calls) || result.tool_calls.length !== 1) {
      fail('invalid_tool_call', 'legacy tool_calls must contain exactly one tool call');
    }
    const toolCall = result.tool_calls[0];
    if (!toolCall || typeof toolCall !== 'object' || Array.isArray(toolCall)) fail('invalid_tool_call', 'tool_calls[0] must be an object');
    let normalisedTool = null;
    try {
      normalisedTool = executeToolCall({
        name: toolCall.name,
        arguments: toolCall.arguments,
        tool_call_id: toolCall.tool_call_id ?? toolCall.id,
        id: toolCall.id,
      });
    } catch (error) {
      if (error instanceof ToolValidationError) fail('invalid_tool_call', error.message);
      throw error;
    }
    return { items: normalisedItems, tool_call: normalisedTool };
  }
  return { items: normalisedItems, tool_call: null };
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
    },
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return runtime;
}

async function buildRequest(state, inputJson) {
  const request = {
    session: { session_uuid: state.session_uuid, revision: state.base_revision, cursor: state.base_cursor },
    pinned: clone(state.pinned),
    canonical_history: clone(listSessionEvents({ repository: state.repository, session_uuid: state.session_uuid })),
    input: inputJson,
    system_prompt: clone(state.system_prompt),
    tool_definitions: clone(state.tool_definitions),
  };
  state.provider.validateRequest?.(request);
  const identity = { repository: state.repository, session_uuid: state.session_uuid };
  const previous = getSessionCompact(identity);
  request.context = buildSessionContext(request.canonical_history, previous);
  const policy = state.provider.contextPolicy;
  if (!policy || typeof state.provider.summarize !== 'function') return request;
  const measured = policy.measure(request);
  const estimate = policy.estimator.estimate(measured);
  if (estimate <= policy.estimator.compactThreshold()
    && JSON.stringify(measured).length <= policy.contextChars) return request;
  const window = selectCompactWindow(request.canonical_history, {
    compacted_through_seq: request.context.compact_through_seq,
    kept_recent: policy.keptRecent,
    fold_player_inputs: true,
  });
  // Keep the previous paid summary until a meaningful new prefix is ready.
  if (!window.selected.length || (request.context.compact_text && window.selected.length < policy.keptRecent)) return request;
  const assertCurrent = () => {
    const latest = getSession(identity);
    const compact = getSessionCompact(identity);
    if (latest.revision !== state.base_revision
      || compact.compacted_through_seq !== previous.compacted_through_seq
      || compact.context_compact_text !== previous.context_compact_text) {
      fail('revision_mismatch', 'compact generation was superseded by a newer player action');
    }
  };
  let summary;
  try {
    summary = await state.provider.summarize({
      previous_summary: request.context.compact_text,
      new_committed_events: clone(window.selected),
    });
    if (typeof summary !== 'string' || !summary.trim()) throw new Error('invalid compact summary');
  } catch (error) {
    assertCurrent();
    // Never store upstream messages, credentials, or response bodies in audit.
    recordCompactFailure({ ...identity, error_code: 'compact_generation_failed',
      error_message: 'Session compact generation failed', token_estimate: estimate,
      context_window: policy.estimator.contextWindow() });
    throw error;
  }
  assertCurrent();
  const next = { ...previous, context_compact_text: summary, compacted_through_seq: window.next_through_seq };
  request.context = buildSessionContext(request.canonical_history, next);
  const budget = policy.estimator.describe();
  recordCompact({ ...identity, summary_text: summary,
    summary_payload: { schema_version: 1, summary },
    through_seq: window.next_through_seq,
    folded_event_seqs: window.selected.map(event => event.event_seq),
    skipped_protected: window.skipped_protected,
    token_estimate: policy.estimator.estimate(policy.measure(request)),
    context_window: budget.window, safety_ratio: budget.safetyRatio,
    reserved_completion_tokens: budget.reservedCompletionTokens,
    schema_version: 1, prompt_version: 1,
  });
  return request;
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

// Repository-scoped single-flight protects paid generation across the fresh
// runtime instances constructed by concurrent HTTP requests.
const IN_FLIGHT_TURNS = new WeakMap();
export async function runTurn(runtime, args = {}) {
  const state = runtimeState(runtime);
  const fp = fingerprint(assertFiniteJson(args.input, 'input'), args.expected_revision ?? null, args.request_id);
  let sessions = IN_FLIGHT_TURNS.get(state.repository);
  if (!sessions) { sessions = new Map(); IN_FLIGHT_TURNS.set(state.repository, sessions); }
  const active = sessions.get(state.session_uuid);
  if (active) {
    if (active.fingerprint === fp) return clone(await active.promise);
    const current = getSession({ repository: state.repository, session_uuid: state.session_uuid });
    if (args.expected_revision !== current.revision) fail('revision_mismatch', 'generation was superseded by a newer player action');
    // An interrupt advances canonical revision. Its new turn must not wait
    // for old speculation; completion of the old promise cannot clear the
    // new lock because the finally block checks promise identity.
    if (!(args.expected_revision > active.revision)) fail('pending_conflict', 'another generation is in progress for this session');
  }
  const promise = runTurnOnce(runtime, args);
  sessions.set(state.session_uuid, { fingerprint: fp, revision: args.expected_revision, promise });
  try { return clone(await promise); }
  finally { if (sessions.get(state.session_uuid)?.promise === promise) sessions.delete(state.session_uuid); }
}

async function runTurnOnce(runtime, { request_id, input, expected_revision } = {}) {
  const state = runtimeState(runtime);
  const session = getSession({ repository: state.repository, session_uuid: state.session_uuid });
  const inputJson = assertFiniteJson(input, 'input');
  scanSensitiveKeys(inputJson, 'input');
  if (request_id !== undefined && !(typeof request_id === 'string' && request_id.length > 0)) fail('invalid_input', 'request_id must be a non-empty string');
  const key = typeof request_id === 'string' && request_id.length > 0 ? request_id : null;
  if (!Number.isInteger(expected_revision)) fail('invalid_input', 'expected_revision must be an integer');
  const fp = fingerprint(inputJson, expected_revision, key);
  // Turn-level idempotency is owned by the SESSION (session.turnRequests),
  // not by this runtime instance: the HTTP layer builds a fresh runtime per
  // request, so a same request_id + input + revision across requests must
  // replay the exact prior result (turn_id / items / tool / pending_id)
  // without calling the provider again (ClickUp 08 P1.5 cross-request
  // idempotency).
  if (key) {
    const existing = lookupTurnRequest({
      repository: state.repository,
      session_uuid: state.session_uuid,
      request_id: key,
    });
    if (existing) {
      if (existing.fingerprint !== fp) fail('duplicate_request', 'request_id already used for a different request');
      return existing.result;
    }
  }
  if (expected_revision !== state.base_revision) fail('revision_mismatch', 'revision mismatch');
  if (session.revision !== state.base_revision) fail('revision_mismatch', 'revision mismatch');
  let rawResult;
  let turn_id;
  try {
    turn_id = randomUUID();
    state.turn_id = turn_id;
    const request = await buildRequest(state, inputJson);
    if (getSession({ repository: state.repository, session_uuid: state.session_uuid }).revision !== state.base_revision) {
      fail('revision_mismatch', 'generation was superseded by a newer player action');
    }
    rawResult = await state.provider.complete(request);
  } catch (error) {
    if (error instanceof AgentRuntimeError) throw error;
    // Compact projection may have advanced, but canonical events have not.
    // A transient network,
    // upstream, or model response failure can therefore be retried safely by
    // the idempotent HTTP client without replaying a committed event.
    // Surface the underlying error class (e.g. invalid_response) in the
    // message so player-facing toasts and support reports are not a black
    // box; the stable machine code remains provider_failure.
    const detail = error && typeof error.code === 'string' && error.code ? ` (${error.code})` : '';
    fail('provider_failure', `agent provider failed${detail}`, {
      retryable: error && typeof error.retryable === 'boolean' ? error.retryable : true,
    });
  }
  const latest = getSession({ repository: state.repository, session_uuid: state.session_uuid });
  if (latest.revision !== state.base_revision) fail('revision_mismatch', 'generation was superseded by a newer player action');
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
        ...progressMetadata(it),
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
    const message = error && error.message ? error.message : String(error);
    // An active-pending conflict is NOT a malformed provider payload: the
    // provider result normalised fine, but the session still holds an
    // unconsumed pending batch that this stage would have to overwrite.
    // Map it to the dedicated pending_conflict code so HTTP clients can
    // distinguish "commit / interrupt / discard the pending batch first"
    // from "fix your provider output". The message text is unchanged —
    // callers and tests match on /unconsumed pending/. Every other stage
    // failure stays invalid_tool_call.
    if (message.includes('unconsumed pending')) fail('pending_conflict', message);
    fail('invalid_tool_call', message);
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
      ...progressMetadata(it),
      ...(it.speaker !== undefined ? { speaker: it.speaker } : {}),
    })),
    pending_id: staged.pending_id,
    pending_committed_count: staged.committed_count,
    pending_total: staged.events.length,
    state: staged.state,
    session_uuid: state.session_uuid,
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
  if (key) {
    registerTurnRequest({
      repository: state.repository,
      session_uuid: state.session_uuid,
      request_id: key,
      fingerprint: fp,
      result,
    });
  }
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
