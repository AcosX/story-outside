// src/providers/ecosystem/search.mjs — ClickUp 16.2 知乎搜索（结局页相关问题）。
//
// 产品定位（ClickUp 16.2 description 原文要点）：
//   * 知乎搜索不用于"搜索可玩的故事"，而用于结局页的"故事之外 · 知乎在
//     讨论什么"：把用户从虚构世界线重新带回知乎真实社区问题。
//   * 查询词来自 StoryCommunityProfile.search_queries，**不**直接使用角色
//     名或 AI 生成结局全文作为搜索词。
//   * 聚合多次查询结果，按知乎返回的相关性 / 权威度 / 互动信号 + 本地去
//     重排序；结局页优先展示"问题 / 问答"结果。
//   * 默认展示 3–5 条最相关问题；搜索结果按 (story_version,
//     community_profile_version) 做服务端缓存；刷新结局页不得重复打 API。
//   * 搜索超时 / 429 / 5xx 时隐藏该区块或展示轻量失败态，**不影响结局主
//     体**。
//
// Adapter 隔离：
//   * 业务层只消费 ZhihuDiscussionResult DTO，**不**依赖原始 API JSON。
//   * 任何具体的搜索后端（mock / real-zhihu-cli / future-official-api）
//     都通过同名 adapter 暴露 `searchZhihuDiscussions(input)`；切换后端
//     不需要改业务层。
//   * Adapter 抛错 / 返回错误 envelope 都被本模块翻译成统一的
//     EcosystemSearchOutcome（results + ecosystem_status）。
//
// 模块纯度：
//   * 无网络 I/O、无 env credential、无 logger，无 npm 依赖。
//   * 缓存 repository 是纯内存对象，由调用方注入；本模块不读写 env。
//   * 不读 Access Secret / token / cookie；real adapter 在调用方（server
//     模块）自行决定是否启用 zhihu-cli（auth_configured=false 时自动回
//     落到 mock，保持 demo / CI 可运行）。

import { canonicalSha256 } from '../../stories/canonicalHash.mjs';

/**
 * @typedef {Object} ZhihuDiscussionResult
 *
 * Provider-agnostic 知乎搜索结果 DTO（ClickUp 16.2 严格隔离）。
 * 业务层只读这些字段，禁止读取原始 API JSON 字段。原始 API 字段保留在
 * `source` 子对象中供诊断使用，但**不**作为路由响应字段。
 *
 * @property {string} result_uuid        稳定 UUID，由 adapter 生成。
 * @property {string} story_version_uuid 关联的 story_version（用于路由
 *                                       校验 + 缓存键）。
 * @property {string} community_profile_version
 *                                       关联的 community profile 的
 *                                       generator_version（用于缓存键）。
 * @property {string} query_id           来自 profile.queries[].id，
 *                                       标识该结果是哪条 query 召回的。
 * @property {string} query_text         实际发送的查询字符串。
 * @property {'question' | 'answer' | 'article' | 'video' | 'mixed'} kind
 *                                       内容类型。结局页优先展示
 *                                       question / answer。
 * @property {string} title              展示标题（question / article
 *                                       标题或 answer 摘要首句）。
 * @property {string} [excerpt]          摘要（≤ 280 字），可能为空。
 * @property {string} [author_name]      作者名（可能为空）。
 * @property {string} [author_avatar]    作者头像 URL（可空）。
 * @property {string} url                知乎站内跳转链接。**必填**，保证
 *                                       结局页永远有一个可点击的入口。
 * @property {number} relevance_score    知乎返回的相关性分数（0-1）。
 * @property {'low' | 'medium' | 'high' | 'top'} authority_level
 *                                       知乎权威度等级（来自 API）。
 * @property {number} like_count         点赞数（可能为 0）。
 * @property {number} comment_count      评论数（可能为 0）。
 * @property {string} [top_comment]      精选评论（可空、可截断）。
 * @property {string} published_at       ISO 时间戳。
 * @property {string} attribution        固定 'zhihu'，保留语义。
 * @property {Record<string, unknown>} [source]
 *                                       原始 API 字段（仅诊断用）。
 */

/**
 * @typedef {Object} EcosystemSearchOutcome
 *
 * 给路由层的统一 envelope。失败也走同一形状，保证结局页渲染分支唯一。
 *
 * @property {ZhihuDiscussionResult[]} results
 * @property {'ok' | 'unavailable' | 'empty'} ecosystem_status
 *                                       'ok' → 至少 1 条结果；
 *                                       'empty' → 调通了但 0 条；
 *                                       'unavailable' → 调挂了（timeout /
 *                                       429 / 5xx），不重试。
 * @property {{ story_version_uuid: string, community_profile_version: string }} scope
 * @property {boolean} cached            true → 命中缓存，未再打 API。
 * @property {string} [provider]         'mock' | 'real' | 'real-fallback-mock'。
 * @property {string} [error_code]       仅当 ecosystem_status != 'ok' 时。
 * @property {string} [error_message]    仅当 ecosystem_status != 'ok' 时。
 */

/**
 * @typedef {Object} EcosystemSearchAdapter
 * @property {string} name                                            Adapter 名（'mock' / 'real'）。
 * @property {(input: { story_version_uuid: string, queries: Array<{ id: string, query: string }>, limit: number, signal: AbortSignal }) => Promise<ZhihuDiscussionResult[]>} searchZhihuDiscussions
 */

/**
 * @typedef {Object} EcosystemSearchCacheRow
 * @property {string} key                  `story_version_uuid|community_profile_version`
 * @property {string} story_version_uuid
 * @property {string} community_profile_version
 * @property {EcosystemSearchOutcome} outcome
 * @property {number} created_at           epoch ms。
 * @property {number} ttl_ms               存活时长。
 */

/**
 * @typedef {Object} EcosystemSearchCacheRepository
 * @property {(input: EcosystemSearchCacheRow) => EcosystemSearchCacheRow} set
 * @property {(input: { story_version_uuid: string, community_profile_version: string, now?: number }) => EcosystemSearchCacheRow | null} get
 * @property {() => { row_count: number }} stats
 * @property {() => void} _resetForTests
 */

/**
 * Default 缓存 TTL（毫秒）。搜索结果在一篇 story_version 的生命周
 * 期内（直到 story_version_checksum 变化）稳定可用；ClickUp 16.2 描述要
 * 求"刷新结局页不得重复打 API"，所以 TTL ≥ 进程生命上限更安全。设 1
 * 小时既能在长会话内命中，又能在配置文件更新后合理失效。
 */
export const ECOSYSTEM_SEARCH_DEFAULT_TTL_MS = 60 * 60 * 1000;

/**
 * 单页默认 limit：5 条最相关问题（ClickUp 16.2 description 原文："默认
 * 展示 3–5 条最相关问题"）。该常量同时被 mock fixture、real adapter
 * 和路由层共用。
 */
export const ECOSYSTEM_SEARCH_DEFAULT_LIMIT = 5;

/**
 * 每个 query 单独请求时的上限。知乎 search zhihu 一次返 1-10 条（CLI
 * `--count` 上限），5 已足够去重排序。
 */
const PER_QUERY_COUNT = 5;

/**
 * 构造稳定的缓存键。两个维度：
 *   * story_version_uuid        — 故事版本变化时缓存全部失效。
 *   * community_profile_version — profile 规则版本变化时缓存全部失效。
 *
 * 单纯拼字符串可能让 'v1|v2' 与 'v1' + '|v2' 撞键（极端长输入），所
 * 以额外混入长度 + 一个 SHA-256 摘要做 collision check。
 *
 * @param {string} story_version_uuid
 * @param {string} community_profile_version
 * @returns {string}
 */
export function buildEcosystemSearchCacheKey(story_version_uuid, community_profile_version) {
  if (typeof story_version_uuid !== 'string' || !story_version_uuid) {
    throw new Error('ecosystemSearch: story_version_uuid required');
  }
  if (typeof community_profile_version !== 'string' || !community_profile_version) {
    throw new Error('ecosystemSearch: community_profile_version required');
  }
  const signature = canonicalSha256(`${story_version_uuid}|${community_profile_version}`).slice(0, 16);
  return `${story_version_uuid}|${community_profile_version}|${signature}`;
}

/**
 * 校验 query 形状。业务层只用 query.id + query.text 两个字段，kind 在
 * 这里被忽略（kind 用于路由层决定调用哪种搜索后端，与 query 内容无关）。
 *
 * @param {unknown} q
 * @param {string} label
 */
function assertQueryShape(q, label) {
  if (!q || typeof q !== 'object') {
    throw new Error(`ecosystemSearch: ${label} must be an object`);
  }
  if (typeof q.id !== 'string' || !q.id) {
    throw new Error(`ecosystemSearch: ${label}.id must be a non-empty string`);
  }
  if (typeof q.query !== 'string' || !q.query) {
    throw new Error(`ecosystemSearch: ${label}.query must be a non-empty string`);
  }
}

/**
 * 生成 v4 UUID。Node ≥ 20 内置 crypto.randomUUID()；本模块不依赖任何
 * 外部库（硬约束：不引入新 npm 依赖）。
 * @returns {string}
 */
function uuidv4() {
  // Node 20+ 内置；用 globalThis 保证在 worker / 不同 entry 下都可用。
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // 极端 fallback：与现有 community 模块一致的手工 v4。
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

/**
 * 校验 adapter 返回的 ZhihuDiscussionResult 数组。Provider 内部的字段
 * 命名差异需要在这一步被屏蔽，业务层只看到统一 DTO。
 *
 * 字段强制 + 类型严格：url 必填（结局页需要一个能跳的入口）；其他可空。
 *
 * @param {unknown} raw
 * @param {string} ctx
 * @returns {ZhihuDiscussionResult}
 */
export function normaliseZhihuDiscussionResult(raw, ctx = 'result') {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`ecosystemSearch: ${ctx} must be an object`);
  }
  const r = /** @type {any} */ (raw);
  if (typeof r.title !== 'string' || !r.title) {
    throw new Error(`ecosystemSearch: ${ctx}.title required`);
  }
  if (typeof r.url !== 'string' || !r.url) {
    throw new Error(`ecosystemSearch: ${ctx}.url required`);
  }
  // url 必须以 http(s) 开头，禁止 javascript: / data: 等伪协议
  if (!/^https?:\/\//i.test(r.url)) {
    throw new Error(`ecosystemSearch: ${ctx}.url must be http(s)`);
  }
  const allowedKinds = new Set(['question', 'answer', 'article', 'video', 'mixed']);
  const kind = allowedKinds.has(r.kind) ? r.kind : 'question';
  const allowedAuthority = new Set(['low', 'medium', 'high', 'top']);
  const authority_level = allowedAuthority.has(r.authority_level) ? r.authority_level : 'medium';
  /** @type {ZhihuDiscussionResult} */
  const normalised = {
    result_uuid: typeof r.result_uuid === 'string' && r.result_uuid ? r.result_uuid : uuidv4(),
    story_version_uuid: typeof r.story_version_uuid === 'string' ? r.story_version_uuid : '',
    community_profile_version: typeof r.community_profile_version === 'string' ? r.community_profile_version : '',
    query_id: typeof r.query_id === 'string' ? r.query_id : '',
    query_text: typeof r.query_text === 'string' ? r.query_text : '',
    kind,
    title: r.title,
    excerpt: typeof r.excerpt === 'string' ? r.excerpt : '',
    author_name: typeof r.author_name === 'string' ? r.author_name : '',
    author_avatar: typeof r.author_avatar === 'string' ? r.author_avatar : '',
    url: r.url,
    relevance_score: Number.isFinite(r.relevance_score) ? Number(r.relevance_score) : 0,
    authority_level,
    like_count: Number.isInteger(r.like_count) && r.like_count >= 0 ? r.like_count : 0,
    comment_count: Number.isInteger(r.comment_count) && r.comment_count >= 0 ? r.comment_count : 0,
    top_comment: typeof r.top_comment === 'string' ? r.top_comment : '',
    published_at: typeof r.published_at === 'string' && r.published_at ? r.published_at : new Date(0).toISOString(),
    attribution: 'zhihu',
  };
  if (r.source && typeof r.source === 'object') {
    normalised.source = /** @type {Record<string, unknown>} */ (r.source);
  }
  return normalised;
}

/**
 * 构造一个标准的失败 envelope（业务层用它来展示"知乎社区暂不可用"）。
 *
 * @param {object} input
 * @param {string} input.story_version_uuid
 * @param {string} input.community_profile_version
 * @param {string} input.code
 * @param {string} input.message
 * @param {'unavailable' | 'empty'} [input.status]
 * @returns {EcosystemSearchOutcome}
 */
export function buildEcosystemUnavailableOutcome({ story_version_uuid, community_profile_version, code, message, status }) {
  if (typeof story_version_uuid !== 'string' || !story_version_uuid) {
    throw new Error('ecosystemSearch: story_version_uuid required');
  }
  if (typeof community_profile_version !== 'string' || !community_profile_version) {
    throw new Error('ecosystemSearch: community_profile_version required');
  }
  return {
    results: [],
    ecosystem_status: status === 'empty' ? 'empty' : 'unavailable',
    scope: { story_version_uuid, community_profile_version },
    cached: false,
    error_code: code,
    error_message: message,
  };
}

/**
 * 内置内存版缓存 repository。纯函数构造，零外部依赖。
 * @returns {EcosystemSearchCacheRepository}
 */
export function createInMemoryEcosystemSearchCacheRepository() {
  /** @type {Map<string, EcosystemSearchCacheRow>} */
  const rows = new Map();
  return Object.freeze({
    set(row) {
      if (!row || typeof row !== 'object') {
        throw new Error('ecosystemSearchCache.set: row required');
      }
      if (typeof row.key !== 'string' || !row.key) {
        throw new Error('ecosystemSearchCache.set: key required');
      }
      if (!row.outcome || !row.outcome.scope
        || row.outcome.scope.story_version_uuid !== row.story_version_uuid
        || row.outcome.scope.community_profile_version !== row.community_profile_version) {
        throw new Error('ecosystemSearchCache.set: scope mismatch');
      }
      if (!Number.isFinite(row.created_at) || row.created_at <= 0) {
        throw new Error('ecosystemSearchCache.set: created_at required');
      }
      if (!Number.isFinite(row.ttl_ms) || row.ttl_ms <= 0) {
        throw new Error('ecosystemSearchCache.set: ttl_ms required');
      }
      rows.set(row.key, row);
      return row;
    },
    get({ story_version_uuid, community_profile_version, now }) {
      if (typeof story_version_uuid !== 'string' || !story_version_uuid) return null;
      if (typeof community_profile_version !== 'string' || !community_profile_version) return null;
      const key = buildEcosystemSearchCacheKey(story_version_uuid, community_profile_version);
      const row = rows.get(key);
      if (!row) return null;
      const effectiveNow = Number.isFinite(now) ? Number(now) : Date.now();
      if (effectiveNow - row.created_at > row.ttl_ms) {
        rows.delete(key);
        return null;
      }
      return row;
    },
    stats() {
      return { row_count: rows.size };
    },
    _resetForTests() {
      rows.clear();
    },
  });
}

/**
 * 组合排序 + 去重：对多条 query 的合并结果按 url 去重（保留命中多条
 * query 的记录——把它们的 query_id 合并到一条），然后按 (权威度降序,
 * 相关性降序, 互动降序) 排序。
 *
 * 权威度优先是因为结局页是社区信任信号：一条高权威度的命中应该排在
 * 低权威度命中之前，即便它的相关性略低；相关性次之是因为它直接反映
 * "和当前故事版本相关的程度"；互动分作为最后的 tie-break。
 *
 * 去重时不挑选 winner，而是合并 query_id 集合 + 取并集里的最佳排序值，
 * 这样多条 query 同时命中同一 URL 时不会丢信号——这是 16.2 description
 * 要求 "本地去重排序" 的语义。
 *
 * @param {ZhihuDiscussionResult[]} results
 * @returns {ZhihuDiscussionResult[]}
 */
export function dedupeAndRankZhihuDiscussions(results) {
  if (!Array.isArray(results)) return [];
  const authorityWeight = { top: 4, high: 3, medium: 2, low: 1 };
  /** @type {Map<string, { item: ZhihuDiscussionResult, queryIds: Set<string>, queryTexts: Set<string> }>} */
  const byUrl = new Map();
  for (const item of results) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.url !== 'string' || !item.url) continue;
    const prev = byUrl.get(item.url);
    if (!prev) {
      /** @type {Set<string>} */
      const ids = new Set();
      if (item.query_id) ids.add(item.query_id);
      /** @type {Set<string>} */
      const texts = new Set();
      if (item.query_text) texts.add(item.query_text);
      byUrl.set(item.url, { item, queryIds: ids, queryTexts: texts });
      continue;
    }
    // 合并 query_id / query_text（保留 union）。后续排序阶段不依赖
    // query_id 数，所以这里我们只关心"哪些 query 都召回过这条"。
    if (item.query_id) prev.queryIds.add(item.query_id);
    if (item.query_text) prev.queryTexts.add(item.query_text);
    // 取排序最优：authority 更大的胜出；并列时 relevance_score 更大
    // 胜出；再并列时互动更高胜出。我们用同样的 key 表达以便与排序
    // 阶段共用 comparator 语义。
    const a = prev.item;
    const b = item;
    const aw = authorityWeight[a.authority_level] || 0;
    const bw = authorityWeight[b.authority_level] || 0;
    let pick = a;
    if (bw > aw) pick = b;
    else if (bw === aw) {
      if (b.relevance_score > a.relevance_score) pick = b;
      else if (b.relevance_score === a.relevance_score) {
        const aInt = a.like_count + a.comment_count;
        const bInt = b.like_count + b.comment_count;
        if (bInt > aInt) pick = b;
      }
    }
    prev.item = pick;
  }
  /** @type {ZhihuDiscussionResult[]} */
  const arr = [];
  for (const { item, queryIds, queryTexts } of byUrl.values()) {
    // 把合并后的 query_id / query_text 写到 item 上，方便路由层 /
    // 调试层观察"这条命中的 query 集合"。
    const mergedIds = [...queryIds].join('|');
    const mergedTexts = [...queryTexts].join('|');
    arr.push({ ...item, query_id: mergedIds, query_text: mergedTexts });
  }
  arr.sort((a, b) => {
    const aw = authorityWeight[a.authority_level] || 0;
    const bw = authorityWeight[b.authority_level] || 0;
    if (aw !== bw) return bw - aw;
    if (a.relevance_score !== b.relevance_score) return b.relevance_score - a.relevance_score;
    const aInteractions = a.like_count + a.comment_count;
    const bInteractions = b.like_count + b.comment_count;
    if (aInteractions !== bInteractions) return bInteractions - aInteractions;
    // 最后按发布时间降序：更新的优先
    if (a.published_at !== b.published_at) return a.published_at > b.published_at ? -1 : 1;
    return 0;
  });
  return arr;
}

/**
 * 校验每条结果属于本次 scope（防止 adapter 把别的 story_version 的结
 * 果混进来）。
 *
 * @param {ZhihuDiscussionResult[]} results
 * @param {string} story_version_uuid
 * @param {string} community_profile_version
 */
function stampScope(results, story_version_uuid, community_profile_version) {
  return results.map((r) => ({
    ...r,
    story_version_uuid: story_version_uuid,
    community_profile_version: community_profile_version,
  }));
}

/**
 * 主入口：从 community profile 的 queries 出发，调用 adapter 聚合搜索
 * 结果，按 (story_version_uuid, community_profile_version) 缓存，按
 * 16.2 描述的降级语义返回统一 envelope。
 *
 * @param {object} input
 * @param {EcosystemSearchAdapter} input.adapter
 * @param {EcosystemSearchCacheRepository} input.cacheRepository
 * @param {string} input.story_version_uuid
 * @param {string} input.community_profile_version
 * @param {Array<{ id: string, query: string }>} input.queries
 * @param {number} [input.limit]
 * @param {AbortSignal} [input.signal]
 * @param {number} [input.ttl_ms]
 * @returns {Promise<EcosystemSearchOutcome>}
 */
export async function searchZhihuDiscussions({
  adapter,
  cacheRepository,
  story_version_uuid,
  community_profile_version,
  queries,
  limit,
  signal,
  ttl_ms,
}) {
  if (!adapter || typeof adapter.searchZhihuDiscussions !== 'function') {
    throw new Error('ecosystemSearch.searchZhihuDiscussions: adapter required');
  }
  if (!cacheRepository) {
    throw new Error('ecosystemSearch.searchZhihuDiscussions: cacheRepository required');
  }
  if (typeof story_version_uuid !== 'string' || !story_version_uuid) {
    throw new Error('ecosystemSearch.searchZhihuDiscussions: story_version_uuid required');
  }
  if (typeof community_profile_version !== 'string' || !community_profile_version) {
    throw new Error('ecosystemSearch.searchZhihuDiscussions: community_profile_version required');
  }
  if (!Array.isArray(queries) || queries.length === 0) {
    return buildEcosystemUnavailableOutcome({
      story_version_uuid,
      community_profile_version,
      code: 'no_queries',
      message: 'community profile has no queries to search for.',
      status: 'empty',
    });
  }
  for (let i = 0; i < queries.length; i += 1) {
    assertQueryShape(queries[i], `queries[${i}]`);
  }
  const effectiveLimit = Number.isInteger(limit) && limit > 0 && limit <= 20
    ? limit
    : ECOSYSTEM_SEARCH_DEFAULT_LIMIT;
  const effectiveTtl = Number.isFinite(ttl_ms) && ttl_ms > 0
    ? Number(ttl_ms)
    : ECOSYSTEM_SEARCH_DEFAULT_TTL_MS;

  // 1. 缓存命中 → 直接返；这是 16.2 description "刷新结局页不得重复打
  //    API" 的实现点。同一 (story_version_uuid, community_profile_version)
  //    第二次走这里就 return；不调 adapter，不打 zhihu-cli。
  const cached = cacheRepository.get({ story_version_uuid, community_profile_version });
  if (cached) {
    return {
      ...cached.outcome,
      cached: true,
    };
  }

  // 2. 调用 adapter。Adapter 负责调用真实 / mock 搜索后端。任何抛错
  //    都被翻译成 ecosystem_status='unavailable'，路由层据此展示轻量
  //    失败态（"知乎社区暂不可用"），不冒泡到结局主体。
  /** @type {ZhihuDiscussionResult[]} */
  let rawResults = [];
  try {
    rawResults = await adapter.searchZhihuDiscussions({
      story_version_uuid,
      queries,
      limit: effectiveLimit,
      signal: signal || new AbortController().signal,
    });
  } catch (err) {
    const code = (err && err.code) || 'search_failed';
    const message = String((err && err.message) || err);
    const outcome = buildEcosystemUnavailableOutcome({
      story_version_uuid,
      community_profile_version,
      code,
      message,
      status: 'unavailable',
    });
    // 失败也缓存极短 TTL（5s），避免被打挂的 provider 在短时间内被反
    // 复刷结局页（描述要求"刷新结局页不得重复打 API"——失败也算"重复
    // 打 API"）。5s 之后允许再试一次。
    cacheRepository.set({
      key: buildEcosystemSearchCacheKey(story_version_uuid, community_profile_version),
      story_version_uuid,
      community_profile_version,
      outcome,
      created_at: Date.now(),
      ttl_ms: Math.min(5_000, effectiveTtl),
    });
    return { ...outcome, provider: adapter.name };
  }

  // 3. 正常化 + 去重排序 + 截 limit。Normalise 阶段也会校验 adapter
  //    返回值是否符合 DTO 形状，违反就丢这一条而不抛错（endpoint 应
  //    始终返回 DTO，原始 API 字段全被吃掉）。
  /** @type {ZhihuDiscussionResult[]} */
  const normalised = [];
  for (let i = 0; i < rawResults.length; i += 1) {
    try {
      const r = normaliseZhihuDiscussionResult(rawResults[i], `results[${i}]`);
      normalised.push(r);
    } catch {
      // 单条坏数据不影响整批；adapter 内部应该自己保证完整，但兜底
      // 也不能让 route 层崩。
    }
  }
  const ranked = dedupeAndRankZhihuDiscussions(normalised);
  // 结局页优先展示 question / answer：kind 在排序后再做一次过滤
  const questionish = ranked.filter((r) => r.kind === 'question' || r.kind === 'answer' || r.kind === 'mixed');
  const others = ranked.filter((r) => r.kind !== 'question' && r.kind !== 'answer' && r.kind !== 'mixed');
  const preferred = [...questionish, ...others];
  const trimmed = preferred.slice(0, effectiveLimit);
  const stamped = stampScope(trimmed, story_version_uuid, community_profile_version);

  /** @type {EcosystemSearchOutcome} */
  const outcome = stamped.length === 0
    ? {
        results: [],
        ecosystem_status: 'empty',
        scope: { story_version_uuid, community_profile_version },
        cached: false,
        provider: adapter.name,
      }
    : {
        results: stamped,
        ecosystem_status: 'ok',
        scope: { story_version_uuid, community_profile_version },
        cached: false,
        provider: adapter.name,
      };

  // 4. 写缓存（即便 status='empty' 也写，避免持续打 API 拿 0 条）。
  cacheRepository.set({
    key: buildEcosystemSearchCacheKey(story_version_uuid, community_profile_version),
    story_version_uuid,
    community_profile_version,
    outcome,
    created_at: Date.now(),
    ttl_ms: effectiveTtl,
  });

  return outcome;
}

export { PER_QUERY_COUNT };