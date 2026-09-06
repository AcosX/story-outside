// src/providers/ecosystem/mockZhihuSearchSource.mjs — ClickUp 16.2 P1.v2
// mock 知乎搜索 source（默认 fallback）。
//
// 行为契约 (ClickUp 16.2 P1.v2 — 2026-09-07 ChatGPT review):
//   * 永远可用：不读网络、不读 env、不读 secrets。
//   * 决定性输出：相同 (query, community_profile_version,
//     story_version_uuid) 在同一进程内多次调用得到完全相同的结果，
//     便于 cache 测试。
//   * fixture key 按 `(query, community_profile_version,
//     story_version_uuid)` 缓存，**不**跨 pair 共享 row。
//   * 当 STORY_OUTSIDE_ECOSYSTEM_SEARCH=real 但 zhihuSearchSource 不可用时，
//     server.mjs 会自动降级到此 mock 并把 response.source 标为 'mock'。
//   * 永远接受的是 `query` 字符串；adapter 层**不**关心 client 是
//     怎么得到这条 query 的 — handler 在更上一层已经从 canonical
//     profile 解析出来了。
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
  // Generate 3 * limit candidate rows; the dedupe+rank step in
  // dto.mjs collapses them into a stable list of ≤ limit.
  const total = Math.max(3, Math.min(limit * 3, 24));
  for (let i = 0; i < total; i += 1) {
    const variant = stableHash(`${seed}::${i}`) % 7;
    const urlVariant = (seed + i * 31) >>> 0;
    const url = `${base}&variant=${urlVariant.toString(16)}`;
    const titles = [
      `知乎讨论：${query} 热门观点 #${i + 1}`,
      `关于「${query}」的几个解读`,
      `${query}：读者普遍认为……`,
      `${query} 解读系列（${i + 1}）`,
      `《${query}》读后感与延伸`,
    ];
    const title = titles[variant % titles.length];
    const score = 100 - i * 7 - ((seed + i) % 5);
    out.push({
      id: (seed + i).toString(16),
      url,
      title,
      excerpt: `${query} 的关键讨论片段 ${i + 1}。`,
      score,
      source: 'zhihu-mock',
      fetched_at: new Date(0).toISOString(),
    });
  }
  return dedupeAndRankZhihuDiscussions(out).slice(0, limit);
}

/**
 * Create a mock Zhihu search source adapter. Implements the
 * `.search({ query, kind, story_uuid, story_version_uuid,
 * community_profile_version, limit })` contract used by
 * search.mjs's orchestrator.
 */
export function createMockZhihuSearchSource() {
  return Object.freeze({
    name: 'mock-zhihu-search-source',
    /**
     * @param {object} input
     * @returns {Promise<{ discussions: object[], source: 'mock' }>}
     */
    async search(input) {
      const list = buildMockDiscussions({
        query: input && input.query,
        community_profile_version: input && input.community_profile_version,
        story_version_uuid: input && input.story_version_uuid,
        limit: input && input.limit,
      });
      return {
        discussions: clampDiscussions(list, input && input.limit),
        source: 'mock',
      };
    },
  });
}
