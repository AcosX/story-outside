// src/providers/ecosystem/mockSearchAdapter.mjs — mock adapter for
// ClickUp 16.2 知乎搜索。
//
// Mock 行为（与 ClickUp 16.2 description 一致）：
//   * 每个测试故事在 fixture 里固定一组（≥5 条）相关问题。
//   * 多 query 合并时按 url 去重，rank 步骤交给 search.mjs。
//   * 测试可以注入 failNext = true 让 adapter 在下一次调用时抛错，用于
//     "降级" 测试。
//   * 不调用 zhihu-cli，不读 env，不依赖 auth_configured。
//
// Adapter 暴露面（与 search.mjs 中 EcosystemSearchAdapter 对齐）：
//   searchZhihuDiscussions({ story_version_uuid, queries, limit, signal })

import { PER_QUERY_COUNT } from './search.mjs';

/**
 * @typedef {Object} MockSearchFixtureEntry
 * @property {string} story_slug
 * @property {Array<{
 *   title: string,
 *   url: string,
 *   kind?: 'question' | 'answer' | 'article' | 'video' | 'mixed',
 *   excerpt?: string,
 *   author_name?: string,
 *   author_avatar?: string,
 *   relevance_score?: number,
 *   authority_level?: 'low' | 'medium' | 'high' | 'top',
 *   like_count?: number,
 *   comment_count?: number,
 *   top_comment?: string,
 *   published_at?: string,
 * }>} results
 */

/**
 * 固定 5 条相关问题（ClickUp 16.2 description 要求"默认展示 3–5 条最
 * 相关问题"；这里 5 条用于覆盖排序边界 + 去重）。
 *
 * Mock fixtures 复用现有 mock 故事的 slug（'cafe-rain' 与 'night-shift'）
 * 并通过固定的知乎站内 URL 模式（mock.zhihu.com /question/{id}）保
 * 证 mock 输出不会泄露任何真实知乎资源。
 */
export const ECOSYSTEM_SEARCH_MOCK_FIXTURES = Object.freeze({
  'cafe-rain': Object.freeze([
    Object.freeze({
      title: '雨夜咖啡馆这种"一间密闭空间、两个陌生人"的写法有什么经典套路？',
      url: 'https://mock.zhihu.com/question/330000000000000001',
      kind: 'question',
      excerpt: '讨论密闭空间双人叙事的传统：从萨特《禁闭》到当代短篇的极简对白手法。',
      author_name: '知乎答主 · 文学分析',
      author_avatar: '',
      relevance_score: 0.92,
      authority_level: 'high',
      like_count: 482,
      comment_count: 56,
      top_comment: '极简对白 + 道具（咖啡）= 让读者自己填补情感。',
      published_at: '2026-04-12T08:30:00.000Z',
    }),
    Object.freeze({
      title: '短篇小说如何在 1000 字内写出"陌生 vs 旧识"的双线张力？',
      url: 'https://mock.zhihu.com/question/330000000000000002',
      kind: 'question',
      excerpt: '读者讨论短篇双线叙事的常用技巧：身份切换、道具线索、潜文本。',
      author_name: '短篇作者',
      author_avatar: '',
      relevance_score: 0.88,
      authority_level: 'top',
      like_count: 1290,
      comment_count: 188,
      top_comment: '关键是让两个身份差异在"换一杯咖啡"这种小动作里可见。',
      published_at: '2026-05-03T14:00:00.000Z',
    }),
    Object.freeze({
      title: '关于"凌晨的咖啡馆"意象的文学来源',
      url: 'https://mock.zhihu.com/question/330000000000000003',
      kind: 'answer',
      excerpt: '从村上春树到国产短篇的"深夜咖啡馆"主题源流。',
      author_name: '文学系研究生',
      author_avatar: '',
      relevance_score: 0.81,
      authority_level: 'medium',
      like_count: 215,
      comment_count: 34,
      top_comment: '咖啡馆本身就是都市孤独的视觉符号。',
      published_at: '2026-03-20T11:15:00.000Z',
    }),
    Object.freeze({
      title: '雨声作为叙事道具在短篇里有什么讲究？',
      url: 'https://mock.zhihu.com/question/330000000000000004',
      kind: 'question',
      excerpt: '讨论声音在短篇里的叙事作用，特别是"雨声 + 玻璃窗"。',
      author_name: '写作课讲师',
      author_avatar: '',
      relevance_score: 0.74,
      authority_level: 'medium',
      like_count: 156,
      comment_count: 19,
      top_comment: '雨声同时是节拍器 + 隔绝器。',
      published_at: '2026-02-14T20:00:00.000Z',
    }),
    Object.freeze({
      title: '极简对白中如何用潜文本让读者读出"没说出口"的内容？',
      url: 'https://mock.zhihu.com/question/330000000000000005',
      kind: 'question',
      excerpt: '短篇写作技巧：让"换一杯热咖啡"这种动作承担潜文本。',
      author_name: '知乎答主 · 写作技巧',
      author_avatar: '',
      relevance_score: 0.69,
      authority_level: 'low',
      like_count: 78,
      comment_count: 12,
      top_comment: '潜文本的关键是动作与台词的"不一致"。',
      published_at: '2026-01-30T09:45:00.000Z',
    }),
  ]),
  'night-shift': Object.freeze([
    Object.freeze({
      title: '城市夜班叙事中的孤独感是怎么写出来的？',
      url: 'https://mock.zhihu.com/question/330000000000000101',
      kind: 'question',
      excerpt: '讨论"夜班 + 城市"叙事流派：从便利店、医院到深夜出租。',
      author_name: '夜班文学研究者',
      author_avatar: '',
      relevance_score: 0.93,
      authority_level: 'top',
      like_count: 1053,
      comment_count: 142,
      top_comment: '夜班的孤独感来自"时间差"——你醒着的时候世界睡了。',
      published_at: '2026-04-22T22:00:00.000Z',
    }),
    Object.freeze({
      title: '为什么很多短篇喜欢用"便利店"作为故事场景？',
      url: 'https://mock.zhihu.com/question/330000000000000102',
      kind: 'question',
      excerpt: '便利店作为城市夜班叙事的标志性场景：日光灯、卷帘门、商品。',
      author_name: '都市文学编辑',
      author_avatar: '',
      relevance_score: 0.87,
      authority_level: 'high',
      like_count: 642,
      comment_count: 73,
      top_comment: '便利店是城市夜班最具符号感的容器。',
      published_at: '2026-05-10T15:30:00.000Z',
    }),
    Object.freeze({
      title: '"零钱推过来"这种克制的动作描写有什么讲究？',
      url: 'https://mock.zhihu.com/question/330000000000000103',
      kind: 'answer',
      excerpt: '用小动作承担人物关系的写法：从短篇到剧本。',
      author_name: '编剧',
      author_avatar: '',
      relevance_score: 0.79,
      authority_level: 'medium',
      like_count: 234,
      comment_count: 28,
      top_comment: '克制的动作 > 直白的对白。',
      published_at: '2026-03-05T10:20:00.000Z',
    }),
    Object.freeze({
      title: '悬疑氛围怎么用"闪灯 + 卷帘门 + 没人"建立？',
      url: 'https://mock.zhihu.com/question/330000000000000104',
      kind: 'question',
      excerpt: '悬疑短篇常用的环境暗示写法：物件 + 灯光 + 空间。',
      author_name: '悬疑作者',
      author_avatar: '',
      relevance_score: 0.71,
      authority_level: 'medium',
      like_count: 198,
      comment_count: 24,
      top_comment: '悬疑感来自"不该有的信号"。',
      published_at: '2026-02-08T18:40:00.000Z',
    }),
    Object.freeze({
      title: '夜行人 + 店员的张力怎么写？',
      url: 'https://mock.zhihu.com/question/330000000000000105',
      kind: 'question',
      excerpt: '两个匿名角色在同一货架两端建立无声张力的方法。',
      author_name: '短篇作者',
      author_avatar: '',
      relevance_score: 0.66,
      authority_level: 'low',
      like_count: 102,
      comment_count: 18,
      top_comment: '张力来自"不说话的默契"。',
      published_at: '2026-01-15T07:50:00.000Z',
    }),
  ]),
});

/**
 * 通过 story_slug 反查 fixture。test helper 内部使用，路由层不直接
 * 调。slug → story_version_uuid 的关系由调用方提供。
 *
 * @param {string} slug
 */
function fixtureForSlug(slug) {
  const fx = ECOSYSTEM_SEARCH_MOCK_FIXTURES[slug];
  if (!fx) {
    throw new Error(`mockSearchAdapter: unknown fixture slug '${slug}'`);
  }
  return fx;
}

/**
 * 构造一个 mock adapter。`slugResolver` 是 (story_version_uuid) →
 * story_slug 的反查函数，由调用方注入（demo 模式下用 FIXTURE_UUIDS，
 * 测试可以直接 inline）。
 *
 * @param {object} [opts]
 * @param {(story_version_uuid: string) => string} [opts.slugResolver]
 * @param {() => boolean} [opts.failNext]   当返回 true 时下一次调用
 *                                           抛 search_failed 错误；
 *                                           用于"错误降级"测试。
 * @param {Error} [opts.failError]          自定义错误；缺省时抛
 *                                           ProviderError-like。
 * @returns {import('./search.mjs').EcosystemSearchAdapter}
 */
export function createMockSearchAdapter(opts = {}) {
  const slugResolver = opts.slugResolver
    || ((sv) => {
      // 默认映射：已知 FIXTURE_UUIDS；未知 story_version → 空 fixture。
      // 这种 fallback 让测试能精确控制未知 story_version 的行为。
      for (const [slug, ids] of Object.entries(DEFAULT_FIXTURE_UUIDS)) {
        if (ids.story_version_uuid === sv) return slug;
      }
      return null;
    });
  let failNext = !!opts.failNext;
  const failError = opts.failError || null;
  return Object.freeze({
    name: 'mock',
    async searchZhihuDiscussions({ story_version_uuid, queries, limit, signal }) {
      if (failNext) {
        failNext = false;
        if (failError) throw failError;
        const err = new Error('mock: simulated search failure');
        err.code = 'search_failed';
        throw err;
      }
      const slug = slugResolver(story_version_uuid);
      // 未知 story_version：返 [] + status=empty（不抛）。
      if (!slug) return [];
      const fixture = fixtureForSlug(slug);
      // 多 query 合并：返回该 fixture 中的每条记录一次，query_id /
      // query_text 用第一条 query 标注（mock 简化：所有 fixture 结果都
      // 视为同一次搜索召回；真实 adapter 应按 query 拆开打）。
      const queryLabel = Array.isArray(queries) && queries[0]
        ? { query_id: queries[0].id, query_text: queries[0].query }
        : { query_id: '', query_text: '' };
      /** @type {import('./search.mjs').ZhihuDiscussionResult[]} */
      const out = [];
      for (let i = 0; i < fixture.length && out.length < (limit || PER_QUERY_COUNT); i += 1) {
        const f = fixture[i];
        out.push({
          result_uuid: '',
          story_version_uuid,
          community_profile_version: '',
          ...queryLabel,
          kind: f.kind || 'question',
          title: f.title,
          excerpt: f.excerpt || '',
          author_name: f.author_name || '',
          author_avatar: f.author_avatar || '',
          url: f.url,
          relevance_score: typeof f.relevance_score === 'number' ? f.relevance_score : 0,
          authority_level: f.authority_level || 'medium',
          like_count: typeof f.like_count === 'number' ? f.like_count : 0,
          comment_count: typeof f.comment_count === 'number' ? f.comment_count : 0,
          top_comment: f.top_comment || '',
          published_at: f.published_at || '2026-01-01T00:00:00.000Z',
          attribution: 'zhihu',
        });
      }
      // respect AbortSignal so test can short-circuit
      if (signal && signal.aborted) {
        const err = new Error('mock: aborted');
        err.code = 'search_failed';
        throw err;
      }
      return out;
    },
  });
}

const DEFAULT_FIXTURE_UUIDS = Object.freeze({
  'cafe-rain': Object.freeze({ story_version_uuid: '21111111-1111-4111-8111-111111111111' }),
  'night-shift': Object.freeze({ story_version_uuid: '21111111-1111-4111-8111-222222222222' }),
});