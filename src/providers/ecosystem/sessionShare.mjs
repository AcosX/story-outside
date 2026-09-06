// src/providers/ecosystem/sessionShare.mjs — ClickUp 16.3 session.share 状态机。
//
// 把"用户是否愿意让自己的世界线参与好友对比"建模为显式状态：
//
//   private ──shareSessionTimeline()──→ shared
//   shared  ──unshareSessionTimeline()─→ private
//
// 默认 private；**绝不**因关注关系自动公开。share 状态由用户**主动**调用触发。
//
// 本文件只操作 session 仓库的 session 字段；不改 16.1/16.2 既有 schema。

import {
  isTimelineShareable,
  shareSessionTimeline as _shareFn,
  unshareSessionTimeline as _unshareFn,
} from './following.mjs';
import { repositoryState } from '../../stories/sessionService.mjs';

/**
 * @typedef {import('../../stories/repository.mjs').StoryRepository} StoryRepository
 */

/**
 * @typedef {Object} ShareResult
 * @property {string} session_uuid
 * @property {boolean} shared
 * @property {string|null} shared_at
 * @property {boolean} changed
 * @property {string} state   'shared' | 'private' | 'not_found'.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(label, value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`ecosystem.sessionShare: ${label} must be a UUID`);
  }
}

/**
 * 不抛错的 session 查找：直接访问 canonical session map。
 * canonical session 是 mutation 的唯一真实载体（publicSession 返回 clone）。
 *
 * @param {StoryRepository} repository
 * @param {string} session_uuid
 * @returns {object | null}
 */
function findCanonicalSession(repository, session_uuid) {
  const state = repositoryState(repository);
  return state.sessions.get(session_uuid) || null;
}

/**
 * 把 session 切到 shared 状态（用户主动）。
 * 默认 private；切换时改写 session.shared=true + session.shared_at=now。
 *
 * @param {object} input
 * @param {StoryRepository} input.repository
 * @param {string} input.session_uuid
 * @returns {ShareResult}
 */
export function shareSessionTimeline({ repository, session_uuid }) {
  if (!repository) throw new Error('shareSessionTimeline: repository required');
  assertUuid('session_uuid', session_uuid);
  const session = findCanonicalSession(repository, session_uuid);
  if (!session) {
    return {
      session_uuid,
      shared: false,
      shared_at: null,
      changed: false,
      state: 'not_found',
    };
  }
  const result = _shareFn(session);
  session.shared = result.shared;
  session.shared_at = result.shared_at;
  return {
    session_uuid,
    shared: result.shared,
    shared_at: result.shared_at,
    changed: result.changed,
    state: 'shared',
  };
}

/**
 * 把 session 从 shared 切回 private。
 *
 * @param {object} input
 * @param {StoryRepository} input.repository
 * @param {string} input.session_uuid
 * @returns {ShareResult}
 */
export function unshareSessionTimeline({ repository, session_uuid }) {
  if (!repository) throw new Error('unshareSessionTimeline: repository required');
  assertUuid('session_uuid', session_uuid);
  const session = findCanonicalSession(repository, session_uuid);
  if (!session) {
    return {
      session_uuid,
      shared: false,
      shared_at: null,
      changed: false,
      state: 'not_found',
    };
  }
  const result = _unshareFn(session);
  session.shared = result.shared;
  // 保留历史 shared_at，便于审计；但 present state 是 private。
  return {
    session_uuid,
    shared: result.shared,
    shared_at: typeof session.shared_at === 'string' ? session.shared_at : null,
    changed: result.changed,
    state: 'private',
  };
}

/**
 * 读出当前 share 状态。
 *
 * @param {object} input
 * @param {StoryRepository} input.repository
 * @param {string} input.session_uuid
 * @returns {{ session_uuid: string, shared: boolean, state: 'shared' | 'private' | 'not_found', shared_at: string|null }}
 */
export function getSessionShareState({ repository, session_uuid }) {
  if (!repository) throw new Error('getSessionShareState: repository required');
  assertUuid('session_uuid', session_uuid);
  const session = findCanonicalSession(repository, session_uuid);
  if (!session) {
    return {
      session_uuid,
      shared: false,
      state: 'not_found',
      shared_at: null,
    };
  }
  const shared = isTimelineShareable(session);
  return {
    session_uuid,
    shared,
    state: shared ? 'shared' : 'private',
    shared_at: typeof session.shared_at === 'string' ? session.shared_at : null,
  };
}

void _shareFn;
void _unshareFn;