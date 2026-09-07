// src/providers/ecosystem/mockZhihuHotSource.mjs — ClickUp 16.4 mock fixture
// for the home-page 知乎热榜 module.
//
// Contract (ClickUp 16.4 P1 fix, 2026-09-07):
//   * Pure in-memory fixture; no network, no env var, no clock.
//   * Stable UUIDs and titles so regression tests can pin every row.
//   * Categories clamp to KNOWN_CATEGORIES so the query string cannot
//     smuggle anything into the upstream URL.
//   * The titles intentionally overlap with the community profile's
//     `hot_keywords` for at least one story (cafe-rain / 雨夜咖啡馆)
//     so the "相关才关联" matcher has at least one positive case in
//     the regression suite without depending on a curated seed.
//
// Reuses nothing from `ee5217b` (PR #20). ClickUp 16.4 P1 fix rebuilds
// the fixture on top of the current main `44343b2` from the public
// shape contract; the fixture here is hand-curated for the new test
// surface (relevant_to_story scoring).

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
 * regression suite can pin every field. Some titles intentionally
 * overlap with the cafe-rain fixture's hot_keywords ("雨夜咖啡馆",
 * "凌晨 咖啡馆", "旧友 陌生人") so the "相关才关联" matcher has at
 * least one positive case to assert against. Most titles are
 * deliberately off-topic so the negative case is also represented.
 *
 * @type {ReadonlyArray<MockZhihuHotTopic>}
 */
export const MOCK_HOT_TOPICS_RAW = Object.freeze([
  // 1. Strong overlap with cafe-rain "雨夜咖啡馆" — title itself.
  Object.freeze({
    id: '11111111-1111-4111-8111-111111111101',
    title: '雨夜咖啡馆：原作两个角色究竟是谁',
    url: 'https://www.zhihu.com/question/rain-cafe-01',
    hotness: 9_873,
    excerpt: '知乎用户讨论雨夜咖啡馆原作的双线解读与潜文本。',
    answer_count: 412,
    question_id: 'rain-cafe-01',
    tags: Object.freeze(['雨夜咖啡馆', '故事解读', '潜文本']),
    category: 'total',
    rank: 1,
  }),
  // 2. Medium overlap — "凌晨 咖啡馆".
  Object.freeze({
    id: '11111111-1111-4111-8111-111111111102',
    title: '凌晨咖啡馆里的两份订单',
    url: 'https://www.zhihu.com/question/rain-cafe-02',
    hotness: 8_412,
    excerpt: '凌晨咖啡馆里的两份订单，与原作设定的对照。',
    answer_count: 287,
    question_id: 'rain-cafe-02',
    tags: Object.freeze(['凌晨 咖啡馆', '故事']),
    category: 'total',
    rank: 2,
  }),
  // 3. Loose overlap — "旧友 陌生人".
  Object.freeze({
    id: '11111111-1111-4111-8111-111111111103',
    title: '旧友与陌生人的双向叙事：六部代表作',
    url: 'https://www.zhihu.com/question/rain-cafe-03',
    hotness: 7_955,
    excerpt: '盘点旧友与陌生人双向叙事的代表作，附原作链接。',
    answer_count: 198,
    question_id: 'rain-cafe-03',
    tags: Object.freeze(['旧友 陌生人', '双向叙事']),
    category: 'entertainment',
    rank: 3,
  }),
  // 4. Theme overlap — "故事解读" topic label.
  Object.freeze({
    id: '11111111-1111-4111-8111-111111111104',
    title: '2026 年度最值得讨论的短篇故事解读 TOP 10',
    url: 'https://www.zhihu.com/question/story-pick-04',
    hotness: 7_440,
    excerpt: '编辑挑选 2026 年短篇故事解读 Top 10，附讨论入口。',
    answer_count: 156,
    question_id: 'story-pick-04',
    tags: Object.freeze(['故事解读', '短篇', '盘点']),
    category: 'total',
    rank: 4,
  }),
  // 5. Theme overlap — "角色关系" topic.
  Object.freeze({
    id: '11111111-1111-4111-8111-111111111105',
    title: '知乎热议：当文学作品里出现两条角色关系线',
    url: 'https://www.zhihu.com/question/role-05',
    hotness: 6_812,
    excerpt: '读者盘点 2026 年文学作品中两条角色关系线的代表作。',
    answer_count: 132,
    question_id: 'role-05',
    tags: Object.freeze(['角色关系', '文学作品']),
    category: 'entertainment',
    rank: 5,
  }),
  // 6. Off-topic — finance.
  Object.freeze({
    id: '11111111-1111-4111-8111-111111111106',
    title: '2026 Q3 美股财报前瞻：七只明星股',
    url: 'https://www.zhihu.com/question/finance-06',
    hotness: 9_511,
    excerpt: '七只明星股 2026 Q3 财报前瞻，重点关注增速与毛利率。',
    answer_count: 318,
    question_id: 'finance-06',
    tags: Object.freeze(['美股', '财报', '前瞻']),
    category: 'finance',
    rank: 6,
  }),
  // 7. Off-topic — tech.
  Object.freeze({
    id: '11111111-1111-4111-8111-111111111107',
    title: 'Apple M5 MacBook Pro 深度评测：性价比如何',
    url: 'https://www.zhihu.com/question/tech-07',
    hotness: 8_977,
    excerpt: 'Apple M5 MacBook Pro 深度评测：性能、续航与性价比。',
    answer_count: 254,
    question_id: 'tech-07',
    tags: Object.freeze(['Apple', 'MacBook', '评测']),
    category: 'tech',
    rank: 7,
  }),
  // 8. Off-topic — sports.
  Object.freeze({
    id: '11111111-1111-4111-8111-111111111108',
    title: '世界杯亚洲区预选赛 国足 1:1 战平澳大利亚',
    url: 'https://www.zhihu.com/question/sports-08',
    hotness: 9_122,
    excerpt: '世界杯亚洲区预选赛，国足客场 1:1 战平澳大利亚。',
    answer_count: 401,
    question_id: 'sports-08',
    tags: Object.freeze(['世界杯', '国足', '亚洲区预选赛']),
    category: 'sports',
    rank: 8,
  }),
  // 9. Off-topic — digital.
  Object.freeze({
    id: '11111111-1111-4111-8111-111111111109',
    title: 'Steam 秋季特卖：十款值得关注的小众独立游戏',
    url: 'https://www.zhihu.com/question/digital-09',
    hotness: 6_355,
    excerpt: 'Steam 秋季特卖盘点十款小众独立游戏，含中文支持。',
    answer_count: 142,
    question_id: 'digital-09',
    tags: Object.freeze(['Steam', '独立游戏', '特卖']),
    category: 'digital',
    rank: 9,
  }),
  // 10. Theme overlap — "极简对话" topic.
  Object.freeze({
    id: '11111111-1111-4111-8111-111111111110',
    title: '极简对话与潜文本：当代短篇小说的七个手法',
    url: 'https://www.zhihu.com/question/style-10',
    hotness: 5_812,
    excerpt: '当代短篇小说常用的极简对话与潜文本手法盘点。',
    answer_count: 109,
    question_id: 'style-10',
    tags: Object.freeze(['极简对话', '潜文本', '短篇小说']),
    category: 'entertainment',
    rank: 10,
  }),
  // 11. Off-topic — finance.
  Object.freeze({
    id: '11111111-1111-4111-8111-111111111111',
    title: '2026 年人民币汇率走势：四季度展望',
    url: 'https://www.zhihu.com/question/finance-11',
    hotness: 7_104,
    excerpt: '人民币汇率 2026 年四季度展望，关注美联储决议。',
    answer_count: 188,
    question_id: 'finance-11',
    tags: Object.freeze(['汇率', '人民币']),
    category: 'finance',
    rank: 11,
  }),
  // 12. Off-topic — tech.
  Object.freeze({
    id: '11111111-1111-4111-8111-111111111112',
    title: 'GPT-6 编程能力实测：在十个真实项目上的表现',
    url: 'https://www.zhihu.com/question/tech-12',
    hotness: 8_566,
    excerpt: 'GPT-6 编程能力实测，含十个真实项目案例。',
    answer_count: 277,
    question_id: 'tech-12',
    tags: Object.freeze(['GPT-6', '编程', '实测']),
    category: 'tech',
    rank: 12,
  }),
  // 13. Strong overlap with night-shift "凌晨便利店".
  Object.freeze({
    id: '11111111-1111-4111-8111-111111111113',
    title: '凌晨便利店的悬疑氛围：原作设定细读',
    url: 'https://www.zhihu.com/question/night-13',
    hotness: 4_822,
    excerpt: '凌晨便利店原作设定细读，闪灯、卷帘门、不属于今天的饮料。',
    answer_count: 88,
    question_id: 'night-13',
    tags: Object.freeze(['凌晨便利店', '悬疑', '设定']),
    category: 'entertainment',
    rank: 13,
  }),
  // 14. Medium overlap — "夜班 便利店".
  Object.freeze({
    id: '11111111-1111-4111-8111-111111111114',
    title: '夜班便利店与城市夜班叙事',
    url: 'https://www.zhihu.com/question/night-14',
    hotness: 4_510,
    excerpt: '夜班便利店与城市夜班叙事流派下的代表短篇。',
    answer_count: 71,
    question_id: 'night-14',
    tags: Object.freeze(['夜班 便利店', '城市夜班']),
    category: 'entertainment',
    rank: 14,
  }),
  // 15. Off-topic — sports.
  Object.freeze({
    id: '11111111-1111-4111-8111-111111111115',
    title: 'NBA 揭幕战湖人 vs 勇士：四大看点',
    url: 'https://www.zhihu.com/question/sports-15',
    hotness: 7_788,
    excerpt: 'NBA 揭幕战湖人 vs 勇士四大看点，附首发名单。',
    answer_count: 232,
    question_id: 'sports-15',
    tags: Object.freeze(['NBA', '湖人', '勇士']),
    category: 'sports',
    rank: 15,
  }),
  // 16. Off-topic — digital.
  Object.freeze({
    id: '11111111-1111-4111-8111-111111111116',
    title: 'Switch 2 首批护航游戏盘点：八款值得入手',
    url: 'https://www.zhihu.com/question/digital-16',
    hotness: 5_211,
    excerpt: 'Switch 2 首批护航游戏盘点，八款值得入手。',
    answer_count: 96,
    question_id: 'digital-16',
    tags: Object.freeze(['Switch 2', '护航游戏']),
    category: 'digital',
    rank: 16,
  }),
  // 17. Off-topic — finance.
  Object.freeze({
    id: '11111111-1111-4111-8111-111111111117',
    title: '黄金价格 2026 年还会涨吗',
    url: 'https://www.zhihu.com/question/finance-17',
    hotness: 6_544,
    excerpt: '黄金价格 2026 年下半年走势分析与机构观点。',
    answer_count: 174,
    question_id: 'finance-17',
    tags: Object.freeze(['黄金', '投资']),
    category: 'finance',
    rank: 17,
  }),
  // 18. Loose overlap — theme "故事解读".
  Object.freeze({
    id: '11111111-1111-4111-8111-111111111118',
    title: '2026 年最被低估的十本短篇小说集',
    url: 'https://www.zhihu.com/question/books-18',
    hotness: 4_321,
    excerpt: '编辑挑选 2026 年最被低估的十本短篇小说集。',
    answer_count: 64,
    question_id: 'books-18',
    tags: Object.freeze(['短篇小说', '书单', '故事解读']),
    category: 'entertainment',
    rank: 18,
  }),
  // 19. Off-topic — tech.
  Object.freeze({
    id: '11111111-1111-4111-8111-111111111119',
    title: 'Rust 1.90 异步运行时新特性解读',
    url: 'https://www.zhihu.com/question/tech-19',
    hotness: 5_876,
    excerpt: 'Rust 1.90 异步运行时新特性解读，含迁移指南。',
    answer_count: 121,
    question_id: 'tech-19',
    tags: Object.freeze(['Rust', '异步']),
    category: 'tech',
    rank: 19,
  }),
  // 20. Off-topic — sports.
  Object.freeze({
    id: '11111111-1111-4111-8111-111111111120',
    title: '欧冠小组赛首轮 皇马 3:1 击败国米',
    url: 'https://www.zhihu.com/question/sports-20',
    hotness: 8_044,
    excerpt: '欧冠小组赛首轮皇马主场 3:1 击败国米。',
    answer_count: 263,
    question_id: 'sports-20',
    tags: Object.freeze(['欧冠', '皇马', '国米']),
    category: 'sports',
    rank: 20,
  }),
]);

/**
 * Filter the mock fixture by category. `total` returns the entire list
 * preserving the rank order. Anything outside KNOWN_CATEGORIES clamps
 * to `total` so the query string cannot smuggle a fresh category.
 *
 * @param {{ category?: string }} [input]
 * @returns {ReadonlyArray<MockZhihuHotTopic>}
 */
export function filterMockHotByCategory(input) {
  const raw = input && typeof input.category === 'string' ? input.category.trim() : '';
  const category = raw && KNOWN_CATEGORIES.includes(raw) ? raw : 'total';
  if (category === 'total') return MOCK_HOT_TOPICS_RAW;
  return MOCK_HOT_TOPICS_RAW.filter((row) => row.category === category);
}

/**
 * Public surface used by the orchestrator. Returns the category-filtered
 * list with `category` echoed per row so the orchestrator's pair-key
 * cache can distinguish `total` from a category-filtered read.
 *
 * @param {{ category?: string }} [input]
 * @returns {ReadonlyArray<MockZhihuHotTopic>}
 */
export function fetchMockHotList(input) {
  return filterMockHotByCategory(input || {});
}

void assertUuid; // keep import-style usage symmetric with sibling modules