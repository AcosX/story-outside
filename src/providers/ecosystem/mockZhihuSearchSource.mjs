// src/providers/ecosystem/mockZhihuSearchSource.mjs — ClickUp 16.2 mock
// 知乎搜索 source（默认 fallback）。
//
// 行为契约:
//   * 永远可用：不读网络、不读 env、不读 secrets。
//   * 决定性输出：相同 (query, community_profile_version, story_version_uuid)
//     在同一进程内多次调用得到完全相同的结果，便于 cache 测试。
//   * fixture key 按 `(query, community_profile_version, story_version_uuid)` 缓存，
//     永远不会跨 pair 共享 row。
//   * 当 STORY_OUTSIDE_PROVIDER=real 但 zhihuSearchSource 不可用时，
//     server.mjs 会自动降级到此 mock 并把 response.source 标为 'mock'。
//
// 返回 shape 与真知乎搜索 source 完全一致（见 dto.mjs），便于上层
// 不关心当前是 mock 还是 real。

import { clampDiscussions, dedupeAndRankZhihuDiscussions, isDiscussionShape } from './dto.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Build a stable 32-bit FNV-style hash of a string.
 * Used for deterministic scoring + fixture routing in the mock.
 */
function stableHash(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Compute a deterministic list of discussion DTOs for the given pair
 * + query. The list is content-derived (NOT random) so multiple calls
 * in the same process produce identical fixtures.
 */
export function buildMockDiscussions(input) {
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  const profileVersion = typeof input.community_profile_version === 'string'
    ? input.community_profile_version : '';
  const storyVersion = isUuid(input.story_version_uuid) ? input.story_version_uuid : '';
  const limit = Number.isInteger(input.limit) && input.limit > 0 ? input.limit : 8;
  if (!query) return [];
  const seed = stableHash(`${query}::${profileVersion}::${storyVersion}`);
  const base = `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(query)}`;
  const out = [];
  const count = Math.min(limit, 8);
  for (let i = 0; i < count; i += 1) {
    const s = stableHash(`${seed}::${i}`);
    const threadUuid = formatUuid(s);
    const title = `关于 "${query}" 的社区讨论 #${i + 1}`;
    const snippet = makeSnippet(query, profileVersion, s);
    const url = `${base}&mock_idx=${i}`;
    const score = 100 - i * 7 + (s % 13);
    out.push({
      thread_uuid: threadUuid,
      title,
      snippet,
      url,
      score,
      source: 'mock',
    });
  }
  return dedupeAndRankZhihuDiscussions(out);
}

function formatUuid(seed) {
  // Compose a deterministic UUID shape from the seed. Mock-only.
  const hex = (seed >>> 0).toString(16).padStart(8, '0');
  const tail = (((seed * 0x9E3779B1) >>> 0).toString(16).padStart(8, '0')) +
    (((seed * 0x85EBCA77) >>> 0).toString(16).padStart(8, '0')) +
    (((seed * 0xC2B2AE3D) >>> 0).toString(16).padStart(8, '0'));
  return `${hex}-0000-4000-8000-${tail.slice(0, 12)}`;
}

function makeSnippet(query, profileVersion, seed) {
  const tags = [];
  if (profileVersion) tags.push(`profile=${profileVersion}`);
  if (query.length > 4) tags.push(`keyword=${query.slice(0, 4)}`);
  const tail = (seed >>> 0).toString(16).padStart(4, '0');
  return `来自 community_profile ${tags.join(',')} 的 mock fixture · ${query.slice(0, 24)} · ${tail}`;
}

/**
 * Mock adapter factory. Returns an object with a stable `.name`,
 * `.source`, and `.search(input)` async function matching the real
 * adapter contract. `.search` always resolves; it never rejects with
 * ProviderError-like shapes (graceful degradation is a no-op for mock).
 */
export function createMockZhihuSearchSource() {
  return Object.freeze({
    name: 'mock-zhihu-search',
    source: 'mock',
    isReal: false,
    /**
     * @param {object} input
     * @param {string} input.query
     * @param {string} [input.story_uuid]
     * @param {string} [input.story_version_uuid]
     * @param {string} [input.community_profile_version]
     * @param {number} [input.limit]
     * @returns {Promise<{ discussions: object[], source: 'mock' }>}
     */
    async search(input) {
      const limit = Number.isInteger(input && input.limit) && input.limit > 0 ? input.limit : 8;
      const discussions = clampDiscussions(buildMockDiscussions({
        query: input && input.query,
        community_profile_version: input && input.community_profile_version,
        story_version_uuid: input && input.story_version_uuid,
        limit,
      }), limit);
      return { discussions, source: 'mock' };
    },
  });
}

export const MOCK_FIXTURE_TAGS = Object.freeze({
  deterministic: true,
  network: false,
  envRead: false,
});
