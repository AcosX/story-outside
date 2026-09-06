// src/providers/ecosystem/following.mjs — ClickUp 16.3: 关注流/关注关系 DTO 层
// （社区世界线）。
//
// 产品定位：
//   * 利用知乎真实关注关系，把《故事之外》中用户主动公开的世界线连接成社区体验
//   * 不把知乎关注关系直接等同于本产品的隐私授权
//   * 默认私人（private）；只有用户主动 share=true 后才进入社交展示
//   * 不读对方原始 Session 历史；只读**对方主动公开**的世界线关键分歧点 + 结局
//
// 官方能力依据（ClickUp 16.3 描述）：
//   * GET /openapi/feed/following              关注人动态
//   * GET /openapi/user/following              关注列表
//   * GET /openapi/user/followers              粉丝列表
//   * 在 zhihu-hackathon 环境通过 `zhihu-cli me followees` / `me favorites`
//     取得同样的最小数据集。
//
// 硬规则（来自 ClickUp 16.3 描述）：
//   * adapter 隔离：DTO 不依赖原始 API JSON
//   * 默认 private：session 默认私人；**绝不**因关注关系自动公开
//   * 降级：故障不影响主链；`getFriendTimelines` 在 provider 不可用时返回空
//   * 关注关系缓存采用短 TTL（5 min）；不永久复制完整知乎社交图
//   * 只查询主动**公开**的已完成世界线 → 不读对方私人 Session 原始历史
//
// 本模块只导出纯函数 / DTO 类型 / adapter；不调用网络、不读
// 环境变量中形如凭证的值。

/**
 * 关注流条目：来自"我关注的人最近在知乎做了什么"——首页社区语境模块的输入。
 * 与 FriendTimeline（世界线对比）的关键区别：
 *   * FollowingFeedItem 描述的是**对方在知乎公开空间的近况**，
 *   * FriendTimeline 描述的是**对方在本产品主动公开的世界线**。
 * 两者必须分开 DTO，避免误用。
 *
 * @typedef {Object} FollowingFeedItem
 * @property {string} item_uuid                  稳定 UUID（adapter 内部生成）。
 * @property {string} identity_id                对应 FollowIdentity.id。
 * @property {string} source                     'zhihu-following-feed'（约束值）。
 * @property {'follow_user' | 'create_answer' | 'create_article' | 'create_question' | 'endorse_answer' | 'favorite' | 'other'} kind
 *                                              关注人行为类型。
 * @property {string} title                      行为标题（zh-CN）。
 * @property {string} [snippet]                  行为摘要（截断后的纯文本，可选）。
 * @property {string} url                        知乎 URL。
 * @property {string} occurred_at                ISO timestamp (UTC)。
 * @property {number} ttl_ms                     缓存短 TTL 毫秒数（默认 5 * 60 * 1000）。
 */

/**
 * 关注身份：本地用户表里保存的 provider identity 映射。
 * "本地已绑定知乎身份" = 本地 user_ref ↔ 知乎 identity_id 的稳定映射。
 * 在 16.3 阶段，若正式认证链路不能获得稳定知乎用户标识，
 * 该集合可能为空；此时 getFollowing() 仍返回知乎真实关注列表（供语境模块），
 * 但 getFriendTimelines() 的交集为空（不进入社交展示）。
 *
 * @typedef {Object} FollowIdentity
 * @property {string} identity_id                知乎用户标识（URL token 或 hex id）。
 * @property {string} user_ref                   本地 user_ref。
 * @property {string} [name]                     显示名（仅用于去重/UI）。
 * @property {string} [avatar_url]
 * @property {string} [bio]                      简介。
 * @property {number} followers_count            粉丝数（≥ 0）。
 * @property {string} linked_at                  ISO timestamp（绑定时间）。
 * @property {string} source                     'zhihu-following' | 'mock-fixture' | 'manual'。
 */

/**
 * 社区世界线对比条目："好友世界线"的单条记录。**只**包含：
 *   * 对方 identity 引用（identity_id + 可选 name）
 *   * 公开状态（必须为 'shared'）
 *   * story_version_uuid 引用（版本，不含原始 Session 内容）
 *   * 结局锚点 + 关键分歧点（不含原始 history）
 *
 * **绝对不**携带：
 *   * private_history（任何历史 turn / event 原文）
 *   * 对方 session_uuid（隐私）
 *   * user_ref 反向映射（隐私）
 *
 * @typedef {Object} FriendTimeline
 * @property {string} timeline_uuid              稳定 UUID。
 * @property {string} identity_id                FollowIdentity.id（对方）。
 * @property {string} [identity_name]           显示名（仅 UI）。
 * @property {'private' | 'shared'} shared_state 必须是 'shared' 才能出现在 social 视图。
 * @property {string} story_version_uuid
 * @property {string} ending_anchor              结局锚点（公开字段）。
 * @property {string[]} choice_anchors           关键分歧点描述（不含原文 turn）。
 * @property {string} completed_at               ISO timestamp。
 * @property {string} source                     'mock-fixture' | 'real-derived' | 'manual'。
 */

/**
 * 关注列表条目（following list）。
 * 与 FollowIdentity 的差异：
 *   * FollowingListItem 是 provider 原始数据（zhihu followees），
 *   * FollowIdentity 是本地映射（含 user_ref 绑定）。
 *
 * @typedef {Object} FollowingListItem
 * @property {string} identity_id                知乎用户标识。
 * @property {string} [name]
 * @property {string} [avatar_url]
 * @property {string} [bio]
 * @property {number} followers_count
 * @property {string} followed_at                ISO timestamp（关注时间）。
 * @property {string} url
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_KINDS = new Set([
  'follow_user', 'create_answer', 'create_article',
  'create_question', 'endorse_answer', 'favorite', 'other',
]);
const ALLOWED_SHARED_STATE = new Set(['private', 'shared']);
const ALLOWED_SOURCES_IDENTITY = new Set(['zhihu-following', 'mock-fixture', 'manual']);
const ALLOWED_SOURCES_TIMELINE = new Set(['mock-fixture', 'real-derived', 'manual']);

/** 默认短 TTL：5 分钟。ClickUp 16.3 描述："关注关系缓存采用短 TTL"。 */
export const FOLLOWING_DEFAULT_TTL_MS = 5 * 60 * 1000;

/** TTL 下界：30 秒。给调用方一个最短过期窗口。 */
export const FOLLOWING_MIN_TTL_MS = 30 * 1000;

/** TTL 上界：30 分钟。不允许把社交图永久缓存在进程内。 */
export const FOLLOWING_MAX_TTL_MS = 30 * 60 * 1000;

/** FollowingFeedItem.source 的约束值。 */
export const FOLLOWING_FEED_SOURCE = 'zhihu-following-feed';

/** 错误码：原语校验失败。 */
export const ECOSYSTEM_ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'ecosystem_invalid_input',
  PROVIDER_UNAVAILABLE: 'ecosystem_provider_unavailable',
  DECODE_FAILED: 'ecosystem_decode_failed',
});

function uuidv4() {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function assertUuid(label, value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`ecosystem.following: ${label} must be a UUID`);
  }
}

function assertNonEmptyString(label, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`ecosystem.following: ${label} must be a non-empty string`);
  }
}

function assertBoundedTtl(label, ttlMs) {
  if (!Number.isInteger(ttlMs)) {
    throw new Error(`ecosystem.following: ${label} must be an integer (got ${typeof ttlMs})`);
  }
  if (ttlMs < FOLLOWING_MIN_TTL_MS || ttlMs > FOLLOWING_MAX_TTL_MS) {
    throw new Error(
      `ecosystem.following: ${label} ${ttlMs}ms outside [${FOLLOWING_MIN_TTL_MS},${FOLLOWING_MAX_TTL_MS}]`,
    );
  }
}

function isHttpUrl(raw) {
  if (typeof raw !== 'string') return false;
  if (raw.length === 0 || raw.length > 2048) return false;
  if (!raw.startsWith('http://') && !raw.startsWith('https://')) return false;
  return true;
}

/**
 * 规范化 / 校验一条 FollowingFeedItem。返回深拷贝后的合规对象。
 * DTO 适配层：只接受白名单字段；丢弃任何未知字段以保持 DTO 不依赖原始 API JSON。
 *
 * @param {unknown} raw
 * @param {{ now?: string, defaultTtlMs?: number }} [opts]
 * @returns {FollowingFeedItem}
 */
export function normaliseFollowingFeedItem(raw, opts = undefined) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${ECOSYSTEM_ERROR_CODES.INVALID_INPUT}: feed item must be an object`);
  }
  const r = /** @type {any} */ (raw);
  assertNonEmptyString('feed.identity_id', r.identity_id);
  assertNonEmptyString('feed.title', r.title);
  if (!isHttpUrl(r.url)) {
    throw new Error(`${ECOSYSTEM_ERROR_CODES.INVALID_INPUT}: feed.url must be http(s)`);
  }
  assertNonEmptyString('feed.occurred_at', r.occurred_at);
  const kind = typeof r.kind === 'string' ? r.kind : 'other';
  if (!ALLOWED_KINDS.has(kind)) {
    throw new Error(`${ECOSYSTEM_ERROR_CODES.INVALID_INPUT}: feed.kind '${kind}' not allowed`);
  }
  const ttlMs = typeof r.ttl_ms === 'number'
    ? r.ttl_ms
    : (opts && Number.isInteger(opts.defaultTtlMs) ? opts.defaultTtlMs : FOLLOWING_DEFAULT_TTL_MS);
  assertBoundedTtl('feed.ttl_ms', ttlMs);
  const snippet = typeof r.snippet === 'string' ? r.snippet : undefined;
  return {
    item_uuid: typeof r.item_uuid === 'string' && r.item_uuid
      ? r.item_uuid
      : uuidv4(),
    identity_id: r.identity_id,
    source: FOLLOWING_FEED_SOURCE,
    kind,
    title: r.title,
    snippet: snippet && snippet.length > 0 ? snippet.slice(0, 240) : undefined,
    url: r.url,
    occurred_at: r.occurred_at,
    ttl_ms: ttlMs,
  };
}

/**
 * 规范化一条 FollowIdentity（本地 user_ref ↔ 知乎身份映射）。
 *
 * @param {unknown} raw
 * @returns {FollowIdentity}
 */
export function normaliseFollowIdentity(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${ECOSYSTEM_ERROR_CODES.INVALID_INPUT}: identity must be an object`);
  }
  const r = /** @type {any} */ (raw);
  assertNonEmptyString('identity.identity_id', r.identity_id);
  assertNonEmptyString('identity.user_ref', r.user_ref);
  const source = typeof r.source === 'string' ? r.source : 'manual';
  if (!ALLOWED_SOURCES_IDENTITY.has(source)) {
    throw new Error(`${ECOSYSTEM_ERROR_CODES.INVALID_INPUT}: identity.source '${source}' not allowed`);
  }
  if (typeof r.followers_count !== 'number' || r.followers_count < 0 || !Number.isFinite(r.followers_count)) {
    throw new Error(`${ECOSYSTEM_ERROR_CODES.INVALID_INPUT}: identity.followers_count must be ≥ 0 finite`);
  }
  return {
    identity_id: r.identity_id,
    user_ref: r.user_ref,
    name: typeof r.name === 'string' && r.name ? r.name : undefined,
    avatar_url: isHttpUrl(r.avatar_url) ? r.avatar_url : undefined,
    bio: typeof r.bio === 'string' && r.bio ? r.bio.slice(0, 200) : undefined,
    followers_count: Math.trunc(r.followers_count),
    linked_at: typeof r.linked_at === 'string' && r.linked_at
      ? r.linked_at
      : nowIso(),
    source,
  };
}

/**
 * 规范化一条 FriendTimeline（社区世界线对比条目）。
 *
 * **关键不变量**：返回对象上**绝不含** `private_history` / `session_uuid` /
 * 对方 `user_ref`。这些字段被显式丢弃。
 *
 * @param {unknown} raw
 * @returns {FriendTimeline}
 */
export function normaliseFriendTimeline(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${ECOSYSTEM_ERROR_CODES.INVALID_INPUT}: friend timeline must be an object`);
  }
  const r = /** @type {any} */ (raw);
  assertNonEmptyString('friend.identity_id', r.identity_id);
  assertUuid('friend.story_version_uuid', r.story_version_uuid);
  const sharedState = r.shared_state;
  if (!ALLOWED_SHARED_STATE.has(sharedState)) {
    throw new Error(`${ECOSYSTEM_ERROR_CODES.INVALID_INPUT}: friend.shared_state must be private|shared`);
  }
  if (sharedState !== 'shared') {
    // 隐私守门：若不是 'shared'，**绝不**进入社交视图——在源头拒绝。
    throw new Error(`${ECOSYSTEM_ERROR_CODES.INVALID_INPUT}: friend timeline must be shared=public; private timeline rejected`);
  }
  assertNonEmptyString('friend.ending_anchor', r.ending_anchor);
  if (!Array.isArray(r.choice_anchors)) {
    throw new Error(`${ECOSYSTEM_ERROR_CODES.INVALID_INPUT}: friend.choice_anchors must be array`);
  }
  for (let i = 0; i < r.choice_anchors.length; i += 1) {
    if (typeof r.choice_anchors[i] !== 'string' || !r.choice_anchors[i]) {
      throw new Error(`${ECOSYSTEM_ERROR_CODES.INVALID_INPUT}: friend.choice_anchors[${i}] must be non-empty string`);
    }
  }
  if (r.choice_anchors.length > 16) {
    throw new Error(`${ECOSYSTEM_ERROR_CODES.INVALID_INPUT}: friend.choice_anchors length > 16`);
  }
  const source = typeof r.source === 'string' ? r.source : 'manual';
  if (!ALLOWED_SOURCES_TIMELINE.has(source)) {
    throw new Error(`${ECOSYSTEM_ERROR_CODES.INVALID_INPUT}: friend.source '${source}' not allowed`);
  }
  return {
    timeline_uuid: typeof r.timeline_uuid === 'string' && r.timeline_uuid
      ? r.timeline_uuid
      : uuidv4(),
    identity_id: r.identity_id,
    identity_name: typeof r.identity_name === 'string' && r.identity_name
      ? r.identity_name
      : undefined,
    shared_state: 'shared',
    story_version_uuid: r.story_version_uuid,
    ending_anchor: r.ending_anchor,
    choice_anchors: r.choice_anchors.slice(0, 16),
    completed_at: typeof r.completed_at === 'string' && r.completed_at
      ? r.completed_at
      : nowIso(),
    source,
  };
}

/**
 * 规范化一条 FollowingListItem（provider 原始关注列表）。
 *
 * @param {unknown} raw
 * @returns {FollowingListItem}
 */
export function normaliseFollowingListItem(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${ECOSYSTEM_ERROR_CODES.INVALID_INPUT}: following list item must be an object`);
  }
  const r = /** @type {any} */ (raw);
  assertNonEmptyString('following.identity_id', r.identity_id);
  assertNonEmptyString('following.followed_at', r.followed_at);
  if (!isHttpUrl(r.url)) {
    throw new Error(`${ECOSYSTEM_ERROR_CODES.INVALID_INPUT}: following.url must be http(s)`);
  }
  if (typeof r.followers_count !== 'number' || r.followers_count < 0 || !Number.isFinite(r.followers_count)) {
    throw new Error(`${ECOSYSTEM_ERROR_CODES.INVALID_INPUT}: following.followers_count must be ≥ 0 finite`);
  }
  return {
    identity_id: r.identity_id,
    name: typeof r.name === 'string' && r.name ? r.name : undefined,
    avatar_url: isHttpUrl(r.avatar_url) ? r.avatar_url : undefined,
    bio: typeof r.bio === 'string' && r.bio ? r.bio.slice(0, 200) : undefined,
    followers_count: Math.trunc(r.followers_count),
    followed_at: r.followed_at,
    url: r.url,
  };
}

/**
 * Adapter: 原始 zhihu followees payload → 本地 DTO 数组。
 *
 * 输入期望结构（zhihu-cli me followees 的输出，由调用方传入）:
 *   { data: [{ url_token, name, avatar_url, headline, follower_count, url, ... }, ...] }
 *
 * 兼容变形：若顶层是数组，按数组处理；若顶层是 { items: [...] }，按 items 处理。
 * 其他结构抛 DECODE_FAILED。
 *
 * @param {unknown} payload
 * @returns {FollowingListItem[]}
 */
export function adaptZhihuFolloweesPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error(`${ECOSYSTEM_ERROR_CODES.DECODE_FAILED}: followees payload must be object`);
  }
  const p = /** @type {any} */ (payload);
  let rawList = null;
  if (Array.isArray(p.data)) {
    rawList = p.data;
  } else if (Array.isArray(p.items)) {
    rawList = p.items;
  } else if (Array.isArray(p)) {
    rawList = p;
  }
  if (!rawList) {
    throw new Error(`${ECOSYSTEM_ERROR_CODES.DECODE_FAILED}: followees payload missing data[]/items[]`);
  }
  const out = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const r = /** @type {any} */ (raw);
    const identityId = r.url_token || r.id || r.user_id || r.identity_id;
    if (!identityId) continue;
    const url = r.url
      || (typeof identityId === 'string'
        ? `https://www.zhihu.com/people/${encodeURIComponent(identityId)}`
        : '');
    if (!url) continue;
    out.push(normaliseFollowingListItem({
      identity_id: String(identityId),
      name: r.name,
      avatar_url: r.avatar_url || r.avatar,
      bio: r.headline || r.bio,
      followers_count: typeof r.follower_count === 'number'
        ? r.follower_count
        : (typeof r.followers_count === 'number' ? r.followers_count : 0),
      followed_at: typeof r.followed_at === 'string'
        ? r.followed_at
        : (r.created_at && typeof r.created_at === 'string' ? r.created_at : nowIso()),
      url,
    }));
  }
  return out;
}

/**
 * Adapter: 原始 zhihu following-feed payload → 本地 DTO 数组。
 * 输入结构（zhihu-cli me contents 的输出）:
 *   { data: [{ type, target: { id, title, excerpt, url }, actor: { id, url_token }, created_time, ... }] }
 *
 * @param {unknown} payload
 * @returns {FollowingFeedItem[]}
 */
export function adaptZhihuFollowingFeedPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error(`${ECOSYSTEM_ERROR_CODES.DECODE_FAILED}: following-feed payload must be object`);
  }
  const p = /** @type {any} */ (payload);
  let rawList = null;
  if (Array.isArray(p.data)) {
    rawList = p.data;
  } else if (Array.isArray(p.items)) {
    rawList = p.items;
  }
  if (!rawList) {
    throw new Error(`${ECOSYSTEM_ERROR_CODES.DECODE_FAILED}: following-feed payload missing data[]/items[]`);
  }
  const out = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const r = /** @type {any} */ (raw);
    const actor = r.actor || r.user || {};
    const identityId = actor.url_token || actor.id || actor.user_id;
    const target = r.target || r.content || {};
    const title = target.title || r.title;
    const url = target.url || r.url;
    if (!identityId || !title || !url) continue;
    let kind = 'other';
    const rawType = (r.type || '').toString().toLowerCase();
    if (rawType.includes('answer')) kind = 'create_answer';
    else if (rawType.includes('article')) kind = 'create_article';
    else if (rawType.includes('question')) kind = 'create_question';
    else if (rawType.includes('favorite')) kind = 'favorite';
    else if (rawType.includes('endorse')) kind = 'endorse_answer';
    else if (rawType.includes('follow')) kind = 'follow_user';
    out.push(normaliseFollowingFeedItem({
      item_uuid: r.id || r.item_uuid,
      identity_id: String(identityId),
      kind,
      title: String(title),
      snippet: target.excerpt || r.snippet,
      url: String(url),
      occurred_at: typeof r.created_time === 'number'
        ? new Date(r.created_time * 1000).toISOString()
        : (typeof r.occurred_at === 'string' ? r.occurred_at : nowIso()),
    }));
  }
  return out;
}

/**
 * 缓存条目（短 TTL）。保存适配后的 DTO + 到期时间戳。
 *
 * @typedef {Object} CacheEntry
 * @property {unknown} value
 * @property {number} expires_at               Unix ms。
 * @property {number} stored_at
 */

/**
 * 创建一个进程内 TTL 缓存。**仅**用于关注关系缓存；不适用于
 * 世界线/故事级缓存（那些由仓库层管）。
 *
 * ClickUp 16.3 描述要求短 TTL；本工厂默认 5 分钟、上限 30 分钟。
 * 缓存不上锁、不持久化；重启即丢。这是设计上的预期行为——
 * "不永久复制完整知乎社交图，仅保存满足产品需要的最小映射/缓存"。
 *
 * @param {{ defaultTtlMs?: number, name?: string, clock?: () => number }} [opts]
 */
export function createShortTtlCache(opts = undefined) {
  const defaultTtlMs = (opts && Number.isInteger(opts.defaultTtlMs))
    ? opts.defaultTtlMs
    : FOLLOWING_DEFAULT_TTL_MS;
  if (defaultTtlMs < FOLLOWING_MIN_TTL_MS || defaultTtlMs > FOLLOWING_MAX_TTL_MS) {
    throw new Error(
      `ecosystem.following: cache defaultTtlMs ${defaultTtlMs} outside [${FOLLOWING_MIN_TTL_MS},${FOLLOWING_MAX_TTL_MS}]`,
    );
  }
  const name = (opts && typeof opts.name === 'string' && opts.name) || 'following';
  const clock = (opts && typeof opts.clock === 'function') ? opts.clock : (() => Date.now());
  /** @type {Map<string, CacheEntry>} */
  const store = new Map();

  function isFresh(entry) {
    return entry && typeof entry.expires_at === 'number' && entry.expires_at > clock();
  }

  return Object.freeze({
    name,
    defaultTtlMs,
    /** @param {string} key @param {unknown} value @param {number} [ttlMs] */
    set(key, value, ttlMs) {
      if (typeof key !== 'string' || !key) {
        throw new Error(`${ECOSYSTEM_ERROR_CODES.INVALID_INPUT}: cache key required`);
      }
      const effectiveTtl = Number.isInteger(ttlMs) ? ttlMs : defaultTtlMs;
      assertBoundedTtl('cache.ttl', effectiveTtl);
      const now = clock();
      store.set(key, {
        value,
        stored_at: now,
        expires_at: now + effectiveTtl,
      });
    },
    /** @param {string} key @returns {unknown | undefined} */
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (!isFresh(entry)) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    /** @param {string} key @returns {boolean} */
    has(key) {
      const entry = store.get(key);
      if (!entry) return false;
      if (!isFresh(entry)) {
        store.delete(key);
        return false;
      }
      return true;
    },
    /** @param {string} key */
    delete(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
    /** @returns {number} */
    size() {
      let live = 0;
      for (const entry of store.values()) {
        if (isFresh(entry)) live += 1;
      }
      return live;
    },
    /** @returns {{ keys: string[], total: number, live: number }} */
    stats() {
      let live = 0;
      const keys = [];
      for (const [k, entry] of store.entries()) {
        if (isFresh(entry)) {
          live += 1;
          keys.push(k);
        }
      }
      return { keys, total: store.size, live };
    },
  });
}

/**
 * 求关注列表与本地已绑定身份集合的**交集**。
 * 只保留"既是真实关注、又有本地映射"的 identity_id；
 * 这样的 identity 才可进入 social 视图（FriendTimeline）。
 *
 * @param {FollowingListItem[]} followees     真实知乎关注列表。
 * @param {FollowIdentity[]} identities       本地 user_ref ↔ 知乎身份映射。
 * @returns {{ matched: FollowIdentity[], unmatched_zhihu: FollowingListItem[] }}
 */
export function intersectFollowingsWithLocalIdentities(followees, identities) {
  if (!Array.isArray(followees)) {
    throw new Error(`${ECOSYSTEM_ERROR_CODES.INVALID_INPUT}: followees must be array`);
  }
  if (!Array.isArray(identities)) {
    throw new Error(`${ECOSYSTEM_ERROR_CODES.INVALID_INPUT}: identities must be array`);
  }
  /** @type {Map<string, FollowIdentity>} */
  const byId = new Map();
  for (const ident of identities) {
    const normalised = normaliseFollowIdentity(ident);
    byId.set(normalised.identity_id, normalised);
  }
  const matched = [];
  const unmatchedZhihu = [];
  for (const item of followees) {
    const hit = byId.get(item.identity_id);
    if (hit) matched.push(hit);
    else unmatchedZhihu.push(item);
  }
  return { matched, unmatched_zhihu: unmatchedZhihu };
}

/**
 * 状态机：把"用户是否愿意让自己的世界线参与好友对比"建模为显式状态。
 *
 *   private  ──share()──→  shared
 *   shared   ──unshare()─→ private
 *
 * 默认 `private`。`shared` 必须由用户**主动**调用 shareSessionTimeline() 才进入。
 * 关注关系**绝不**触发状态切换。
 *
 * 实现上是一个纯函数；session 仓库负责持久化 `shared` 标志。
 *
 * @param {{ shared: boolean, session_uuid: string }} session
 * @returns {boolean}                          当前是否可进入社交展示。
 */
export function isTimelineShareable(session) {
  if (!session || typeof session !== 'object') return false;
  if (typeof session.session_uuid !== 'string') return false;
  return session.shared === true;
}

/**
 * 把 session 转换到 share 状态（仅当当前为 private）。
 * 已为 shared 时保持原状（幂等）。
 *
 * @param {{ shared: boolean, session_uuid: string }} session
 * @returns {{ shared: true, session_uuid: string, shared_at: string, changed: boolean }}
 */
export function shareSessionTimeline(session) {
  if (!session || typeof session !== 'object') {
    throw new Error(`${ECOSYSTEM_ERROR_CODES.INVALID_INPUT}: session required`);
  }
  if (typeof session.session_uuid !== 'string' || !session.session_uuid) {
    throw new Error(`${ECOSYSTEM_ERROR_CODES.INVALID_INPUT}: session.session_uuid required`);
  }
  if (session.shared === true) {
    return {
      shared: true,
      session_uuid: session.session_uuid,
      shared_at: typeof session.shared_at === 'string' ? session.shared_at : nowIso(),
      changed: false,
    };
  }
  return {
    shared: true,
    session_uuid: session.session_uuid,
    shared_at: nowIso(),
    changed: true,
  };
}

/**
 * 把 session 从 shared 切回 private（仅当当前为 shared）。
 *
 * @param {{ shared: boolean, session_uuid: string }} session
 * @returns {{ shared: false, session_uuid: string, unshared_at: string, changed: boolean }}
 */
export function unshareSessionTimeline(session) {
  if (!session || typeof session !== 'object') {
    throw new Error(`${ECOSYSTEM_ERROR_CODES.INVALID_INPUT}: session required`);
  }
  if (typeof session.session_uuid !== 'string' || !session.session_uuid) {
    throw new Error(`${ECOSYSTEM_ERROR_CODES.INVALID_INPUT}: session.session_uuid required`);
  }
  if (session.shared !== true) {
    return {
      shared: false,
      session_uuid: session.session_uuid,
      unshared_at: nowIso(),
      changed: false,
    };
  }
  return {
    shared: false,
    session_uuid: session.session_uuid,
    unshared_at: nowIso(),
    changed: true,
  };
}

void uuidv4;
void nowIso;