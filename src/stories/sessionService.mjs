// src/stories/sessionService.mjs — session-local story opening playback state.
//
// This service keeps per-repository session state in a WeakMap and never
// mutates repository internals. It pins a story/version/opening-cache tuple
// for a session, commits opening events only on explicit calls, and keeps
// optimistic revision control at the session boundary.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const repoState = new WeakMap();

function getRepoState(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new Error('sessionService: repository required');
  }
  let state = repoState.get(repository);
  if (!state) {
    state = { sessions: new Map() };
    repoState.set(repository, state);
  }
  return state;
}

function assertUuid(label, value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`sessionService: ${label} must be a UUID`);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureSession(repository, session_uuid) {
  const state = getRepoState(repository);
  const session = state.sessions.get(session_uuid);
  if (!session) {
    throw new Error(`sessionService: unknown session '${session_uuid}'`);
  }
  return session;
}

function validateRevision(session, expected_revision) {
  if (expected_revision === undefined || expected_revision === null) return;
  if (!Number.isInteger(expected_revision)) {
    throw new Error('sessionService: expected_revision must be an integer');
  }
  if (expected_revision !== session.revision) {
    throw new Error(
      `sessionService: revision mismatch, expected ${expected_revision} but current is ${session.revision}`,
    );
  }
}

function validateClientRequestId(client_request_id) {
  if (client_request_id === undefined || client_request_id === null) return null;
  if (typeof client_request_id !== 'string' || !client_request_id) {
    throw new Error('sessionService: client_request_id must be a non-empty string');
  }
  return client_request_id;
}

function getVersion(repository, story_version_uuid, story_uuid) {
  const version = repository.findVersion(story_version_uuid);
  if (!version) throw new Error('sessionService: unknown story_version');
  if (version.story_uuid !== story_uuid) {
    throw new Error('sessionService: story_uuid does not match story_version');
  }
  return version;
}

function getRole(version, role_id) {
  const roles = Array.isArray(version.roles_payload) ? version.roles_payload : [];
  if (!roles.some((role) => role && role.id === role_id)) {
    throw new Error(`sessionService: role_id '${role_id}' is not present in pinned version`);
  }
}

function validateGenerationProfile(generation_profile, story_uuid, story_version_uuid, cache) {
  if (generation_profile.story_uuid && generation_profile.story_uuid !== story_uuid) {
    throw new Error('sessionService: generation_profile story_uuid mismatch');
  }
  if (generation_profile.story_version_uuid && generation_profile.story_version_uuid !== story_version_uuid) {
    throw new Error('sessionService: generation_profile story_version_uuid mismatch');
  }
  if (generation_profile.cache_uuid && generation_profile.cache_uuid !== cache.cache_uuid) {
    throw new Error('sessionService: generation_profile cache_uuid mismatch');
  }
  if (generation_profile.generation_hash && cache.generation_hash !== generation_profile.generation_hash) {
    throw new Error('sessionService: generation_profile hash mismatch');
  }
}

function appendEvent(session, event) {
  const next = { ...event, sequence: session.cursor };
  session.history.push(next);
  session.cursor += 1;
  session.revision += 1;
  return next;
}

export function createSession({ repository, session_uuid, story_uuid, story_version_uuid, user_ref, role_id, model, prompt, generation_profile }) {
  if (!repository) throw new Error('createSession: repository required');
  assertUuid('session_uuid', session_uuid);
  assertUuid('story_uuid', story_uuid);
  assertUuid('story_version_uuid', story_version_uuid);
  if (typeof user_ref !== 'string' || !user_ref) throw new Error('createSession: user_ref required');
  if (typeof role_id !== 'string' || !role_id) throw new Error('createSession: role_id required');
  if (typeof model !== 'string' || !model) throw new Error('createSession: model required');
  if (typeof prompt !== 'string') throw new Error('createSession: prompt required');
  if (!generation_profile || typeof generation_profile !== 'object') {
    throw new Error('createSession: generation_profile required');
  }

  const version = getVersion(repository, story_version_uuid, story_uuid);
  getRole(version, role_id);
  const cache = repository.findOpeningCacheByUuid(generation_profile.cache_uuid);
  if (!cache) throw new Error('createSession: pinned cache not found');
  if (cache.story_uuid !== story_uuid || cache.story_version_uuid !== story_version_uuid) {
    throw new Error('createSession: cache does not match pinned story/version');
  }
  validateGenerationProfile(generation_profile, story_uuid, story_version_uuid, cache);

  const state = getRepoState(repository);
  if (state.sessions.has(session_uuid)) {
    throw new Error('createSession: session already exists');
  }

  const session = {
    session_uuid,
    story_uuid,
    story_version_uuid,
    story_version_checksum: version.checksum,
    user_ref,
    role_id,
    model,
    prompt,
    generation_profile: clone(generation_profile),
    cache_uuid: cache.cache_uuid,
    opening_cache_status: cache.status,
    state: cache.status === 'valid' ? 'opening' : 'realtime',
    cursor: 0,
    revision: 0,
    history: [],
    requestIds: new Map(),
  };
  state.sessions.set(session_uuid, session);
  return {
    session_uuid: session.session_uuid,
    story_uuid: session.story_uuid,
    story_version_uuid: session.story_version_uuid,
    story_version_checksum: session.story_version_checksum,
    cache_uuid: session.cache_uuid,
    opening_cache_status: session.opening_cache_status,
    state: session.state,
    cursor: session.cursor,
    revision: session.revision,
  };
}

export function commitOpeningEvent({ repository, session_uuid, cache_uuid, event, client_request_id, expected_revision }) {
  if (!repository) throw new Error('commitOpeningEvent: repository required');
  assertUuid('session_uuid', session_uuid);
  assertUuid('cache_uuid', cache_uuid);
  const session = ensureSession(repository, session_uuid);
  if (session.cache_uuid !== cache_uuid) {
    throw new Error('commitOpeningEvent: cache_uuid does not match session cache');
  }
  const request_id = validateClientRequestId(client_request_id);
  if (request_id && session.requestIds.has(request_id)) {
    return clone(session.requestIds.get(request_id).result);
  }
  validateRevision(session, expected_revision);
  if (!event || typeof event !== 'object') throw new Error('commitOpeningEvent: event required');
  if (!Number.isInteger(event.sequence)) throw new Error('commitOpeningEvent: event.sequence must be an integer');
  if (event.sequence !== session.cursor) {
    throw new Error(`commitOpeningEvent: event.sequence must equal cursor ${session.cursor}`);
  }
  if (event.type === 'ask_player_choice') {
    throw new Error('commitOpeningEvent: ask_player_choice events are not allowed in canonical history');
  }

  const committed = appendEvent(session, {
    type: event.type,
    sequence: event.sequence,
    text: event.text,
    speaker: event.speaker,
    actor: event.actor,
    meta: event.meta,
    created_at: nowIso(),
  });
  session.state = 'opening';
  const result = { session_uuid, cache_uuid, event: committed, cursor: session.cursor, revision: session.revision, state: session.state };
  if (request_id) session.requestIds.set(request_id, { revision: session.revision, result });
  return clone(result);
}

export function interruptWithPlayerInput({ repository, session_uuid, text, client_request_id, expected_revision }) {
  if (!repository) throw new Error('interruptWithPlayerInput: repository required');
  assertUuid('session_uuid', session_uuid);
  const session = ensureSession(repository, session_uuid);
  const request_id = validateClientRequestId(client_request_id);
  if (request_id && session.requestIds.has(request_id)) {
    return clone(session.requestIds.get(request_id).result);
  }
  validateRevision(session, expected_revision);
  if (typeof text !== 'string' || !text) throw new Error('interruptWithPlayerInput: text required');
  const committed = appendEvent(session, {
    type: 'player_input',
    sequence: session.cursor,
    text,
    created_at: nowIso(),
  });
  session.state = 'realtime';
  const result = { session_uuid, cache_uuid: session.cache_uuid, event: committed, cursor: session.cursor, revision: session.revision, state: session.state };
  if (request_id) session.requestIds.set(request_id, { revision: session.revision, result });
  return clone(result);
}

export function recoverSession({ repository, session_uuid }) {
  if (!repository) throw new Error('recoverSession: repository required');
  assertUuid('session_uuid', session_uuid);
  const session = ensureSession(repository, session_uuid);
  return {
    session_uuid: session.session_uuid,
    story_uuid: session.story_uuid,
    story_version_uuid: session.story_version_uuid,
    cache_uuid: session.cache_uuid,
    state: session.state,
    cursor: session.cursor,
    revision: session.revision,
    history: clone(session.history),
  };
}
