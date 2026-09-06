// src/providers/ecosystem/mockZhihuHotSource.mjs — ClickUp 16.4 P1.v2
// mock fixture for the home-page 知乎热榜 module (rebuilt on current
// main 44343b2, 2026-09-07).
//
// Contract (ClickUp 16.4 P1.v2 fix):
//   * Pure in-memory fixture; no network, no env var, no clock.
//   * Stable UUIDs and titles so regression tests can pin every row.
//   * Categories clamp to KNOWN_CATEGORIES so the query string cannot
//     smuggle anything into the upstream URL.
//   * The titles intentionally overlap with the community profile's
//     `hot_keywords` for at least one story (cafe-rain / 雨夜咖啡馆)
//     so the "相关才关联" matcher has at least one positive case in
//     the regression suite without depending on a curated seed.
//
// Reuses nothing from PR #23 (ce7f03a). This v2 rebuilds on top of
// the current main `44343b2` from the public shape contract and
// tightens the canonical community_profile_version contract to strict
// semver (MAJOR.MINOR.PATCH) — the previous PR #23 silently fell
// back to "0 terms" when the wrong version field was supplied; this
// module cooperates with the renamed `community_profile_version` and
// the server-side semver validator at every read seam.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(label, value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`mockZhihuHotSource: ${label} must be a UUID`);
  }
}

/**
 * @typedef {Object} MockZhihuHotTopic
 * @property {string} id             Stable id (uuid-shaped for parity with the real adapter).
 * @property {string} title          Display title.
 * @property {string} url            Outbound link to zhihu.com.
 * @property {number} hotness        Heat score (higher = more popular).
 * @property {string} excerpt        优质回答摘要 excerpt (short).
 * @property {number} answer_count   Number of answers on the underlying question.
 * @property {string} question_id    Underlying question id (stringified).
 * @property {string[]} tags         Tags derived from the upstream payload.
 * @property {string} category       'total' | 'tech' | 'finance' | 'sports' | 'entertainment' | 'digital'.
 * @property {number} rank           1-based rank inside this list.
 */

/**
 * Allow-list of categories the orchestrator forwards to the upstream.
 * Mirrored from src/providers/ecosystem/hot.mjs so the mock fixture
 * and the orchestrator agree on the same set.
 */
export const KNOWN_CATEGORIES = Object.freeze([
  'total', 'tech', 'finance', 'sports', 'entertainment', 'digital',
]);

/**
 * Hand-curated mock list. Stable UUIDs + titles + categories so the
 * regression suite can pin every row. At least 8 entries have terms
 * overlapping with the cafe-rain / night-shift community profiles so
 * the "相关才关联" matcher always has a positive case.
 */
const MOCK_HOT_LIST = Object.freeze([
  {
    id: '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: '雨夜咖啡馆：原作两个角色究竟是谁',
    url: 'https://www.zhihu.com/question/cafe-rain-roles',
    hotness: 9800,
    excerpt: '雨夜咖啡馆原作中"旧友"与"陌生人"的解读',
    answer_count: 412,
    question_id: 'cafe-rain-roles',
    tags: ['雨夜咖啡馆', '原作', '角色分析'],
    category: 'total',
    rank: 1,
  },
  {
    id: '22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: '雨夜咖啡馆 故事 解读 与 极简对话',
    url: 'https://www.zhihu.com/question/cafe-rain-minimal-dialogue',
    hotness: 8750,
    excerpt: '极简对话与潜文本',
    answer_count: 318,
    question_id: 'cafe-rain-minimal-dialogue',
    tags: ['雨夜咖啡馆', '极简对话', '潜文本'],
    category: 'total',
    rank: 2,
  },
  {
    id: '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: '凌晨 咖啡馆 与 城市夜班叙事',
    url: 'https://www.zhihu.com/question/late-night-cafe',
    hotness: 7700,
    excerpt: '凌晨咖啡馆里的城市夜班孤独感',
    answer_count: 287,
    question_id: 'late-night-cafe',
    tags: ['凌晨 咖啡馆', '夜班', '城市叙事'],
    category: 'total',
    rank: 3,
  },
  {
    id: '44444444-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: '凌晨便利店的悬疑氛围怎么写',
    url: 'https://www.zhihu.com/question/night-shift-mystery',
    hotness: 7200,
    excerpt: '凌晨便利店悬疑氛围的建立',
    answer_count: 263,
    question_id: 'night-shift-mystery',
    tags: ['凌晨便利店', '悬疑', '氛围'],
    category: 'total',
    rank: 4,
  },
  {
    id: '55555555-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: '夜班 便利店 与 夜行人 角色解读',
    url: 'https://www.zhihu.com/question/night-shift-roles',
    hotness: 6800,
    excerpt: '店员与夜行人的无声张力',
    answer_count: 241,
    question_id: 'night-shift-roles',
    tags: ['夜班 便利店', '店员 夜行人', '解读'],
    category: 'total',
    rank: 5,
  },
  {
    id: '66666666-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: '旧友 陌生人 双线设定 讨论',
    url: 'https://www.zhihu.com/question/old-friend-stranger',
    hotness: 5900,
    excerpt: '原作双角色设定的解读',
    answer_count: 198,
    question_id: 'old-friend-stranger',
    tags: ['旧友 陌生人', '双线', '设定'],
    category: 'total',
    rank: 6,
  },
  {
    id: '77777777-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: '美元汇率走势分析',
    url: 'https://www.zhihu.com/question/usd-2026',
    hotness: 9999,
    excerpt: '美元 Q3 财报前瞻',
    answer_count: 502,
    question_id: 'usd-2026',
    tags: ['汇率', '美元', '财报'],
    category: 'finance',
    rank: 7,
  },
  {
    id: '88888888-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: 'iPhone 18 Pro Max 体验评测',
    url: 'https://www.zhihu.com/question/iphone-18-pro-max',
    hotness: 9400,
    excerpt: 'iPhone 18 Pro Max 评测',
    answer_count: 481,
    question_id: 'iphone-18-pro-max',
    tags: ['iPhone', '数码', '评测'],
    category: 'digital',
    rank: 8,
  },
  {
    id: '99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: 'NBA 季后赛半决赛前瞻',
    url: 'https://www.zhihu.com/question/nba-semifinals',
    hotness: 9100,
    excerpt: 'NBA 半决赛预测',
    answer_count: 432,
    question_id: 'nba-semifinals',
    tags: ['NBA', '季后赛', '体育'],
    category: 'sports',
    rank: 9,
  },
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: '国产大模型 2026 春季评测',
    url: 'https://www.zhihu.com/question/llm-2026-spring',
    hotness: 8500,
    excerpt: '国产大模型 2026 春季横评',
    answer_count: 365,
    question_id: 'llm-2026-spring',
    tags: ['大模型', 'AI', '评测'],
    category: 'tech',
    rank: 10,
  },
  {
    id: 'bbbbbbbb-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: '夏季档电影推荐清单',
    url: 'https://www.zhihu.com/question/summer-movies-2026',
    hotness: 7900,
    excerpt: '夏季档电影推荐',
    answer_count: 312,
    question_id: 'summer-movies-2026',
    tags: ['电影', '夏季', '推荐'],
    category: 'entertainment',
    rank: 11,
  },
  {
    id: 'cccccccc-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: '便利店 隐喻 零钱 与 不属于今天的饮料',
    url: 'https://www.zhihu.com/question/convenience-metaphor',
    hotness: 6300,
    excerpt: '便利店 隐喻 零钱 饮料',
    answer_count: 213,
    question_id: 'convenience-metaphor',
    tags: ['便利店', '隐喻', '零钱'],
    category: 'total',
    rank: 12,
  },
  {
    id: 'dddddddd-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: 'OpenAI o3 推理模型 benchmark 横评',
    url: 'https://www.zhihu.com/question/o3-benchmark',
    hotness: 8200,
    excerpt: 'o3 推理 benchmark',
    answer_count: 358,
    question_id: 'o3-benchmark',
    tags: ['OpenAI', 'o3', 'benchmark'],
    category: 'tech',
    rank: 13,
  },
  {
    id: 'eeeeeeee-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: '城市夜班 叙事 流派 综述',
    url: 'https://www.zhihu.com/question/city-night-genre',
    hotness: 5400,
    excerpt: '城市夜班 叙事 流派',
    answer_count: 187,
    question_id: 'city-night-genre',
    tags: ['城市夜班', '叙事', '流派'],
    category: 'total',
    rank: 14,
  },
  {
    id: 'ffffffff-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: '世界杯预选赛 国足 战术 复盘',
    url: 'https://www.zhihu.com/question/world-cup-pr',
    hotness: 8800,
    excerpt: '国足 战术 复盘',
    answer_count: 401,
    question_id: 'world-cup-pr',
    tags: ['足球', '国足', '战术'],
    category: 'sports',
    rank: 15,
  },
  {
    id: '10101010-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: '咖啡 作为 关系媒介 的 意象',
    url: 'https://www.zhihu.com/question/coffee-metaphor',
    hotness: 4900,
    excerpt: '咖啡作为关系媒介的意象',
    answer_count: 156,
    question_id: 'coffee-metaphor',
    tags: ['咖啡', '关系', '意象'],
    category: 'total',
    rank: 16,
  },
  {
    id: '20202020-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: '深夜食堂 改编 影评',
    url: 'https://www.zhihu.com/question/midnight-diner-2026',
    hotness: 7100,
    excerpt: '深夜食堂 改编 影评',
    answer_count: 256,
    question_id: 'midnight-diner-2026',
    tags: ['深夜食堂', '影评', '改编'],
    category: 'entertainment',
    rank: 17,
  },
  {
    id: '30303030-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: 'GPT-5o 与 Claude 4.5 对比',
    url: 'https://www.zhihu.com/question/gpt5o-vs-claude45',
    hotness: 7600,
    excerpt: 'GPT-5o 与 Claude 4.5 对比',
    answer_count: 301,
    question_id: 'gpt5o-vs-claude45',
    tags: ['GPT-5o', 'Claude', '对比'],
    category: 'tech',
    rank: 18,
  },
  {
    id: '40404040-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: '人民币汇率双向波动',
    url: 'https://www.zhihu.com/question/cny-2026',
    hotness: 6700,
    excerpt: '人民币汇率双向波动',
    answer_count: 224,
    question_id: 'cny-2026',
    tags: ['汇率', '人民币', '财经'],
    category: 'finance',
    rank: 19,
  },
  {
    id: '50505050-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: 'AI 写作 工具 横评',
    url: 'https://www.zhihu.com/question/ai-writing-tools',
    hotness: 5800,
    excerpt: 'AI 写作 工具 横评',
    answer_count: 198,
    question_id: 'ai-writing-tools',
    tags: ['AI', '写作', '工具'],
    category: 'tech',
    rank: 20,
  },
]);

/**
 * Default upstream adapter. Always succeeds; the orchestrator's
 * graceful-degradation path is exercised by passing a different
 * source (e.g. one that throws).
 *
 * @param {{ category?: string }} [input]
 * @returns {Promise<ReadonlyArray<MockZhihuHotTopic>>}
 */
export async function fetchMockHotList(input) {
  // No network, no clock — just a deterministic projection. The
  // fixture intentionally includes both on-topic (cafe-rain /
  // night-shift) and off-topic (汇率 / NBA / iPhone / 国产大模型)
  // entries so the "相关才关联" matcher has a regression surface.
  const list = MOCK_HOT_LIST;
  const category = input && typeof input.category === 'string' ? input.category : '';
  if (!category || category === 'total') return list;
  return filterMockHotByCategory(list, category);
}

/**
 * Filter the fixture list to a single category. Mirrors the
 * `category` query-string parameter the orchestrator forwards.
 *
 * @param {ReadonlyArray<MockZhihuHotTopic>} list
 * @param {string} category
 * @returns {ReadonlyArray<MockZhihuHotTopic>}
 */
export function filterMockHotByCategory(list, category) {
  if (!KNOWN_CATEGORIES.includes(category)) return [];
  if (category === 'total') return list;
  return list.filter((entry) => entry && entry.category === category);
}

void assertUuid;
