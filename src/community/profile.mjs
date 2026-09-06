// src/community/profile.mjs — story_version-scoped community-profile model.
//
// ClickUp 16.1 contract (作品社区画像与生态层公共基础):
//   * One community profile per (story_version) so the four ecology
//     capabilities (Zhihu search, hot-list matching, Zhihu Knowledge,
//     ending-page search) share a single, stable, version-bound set
//     of topics / queries / hot keywords without re-running the
//     understanding pass per request / per user.
//   * Profile is versioned via `generator_version` + `story_version_checksum`
//     so a rule change OR a story_version change produces a NEW profile
//     row, never an in-place overwrite. Old rows are kept so a future
//     regression can re-pin a session to a previous profile by uuid.
//   * Profile carries ZERO session-specific / user-specific / model-output
//     fields. Every field describes the original story itself; doing
//     otherwise would (a) leak cross-user data and (b) make the profile
//     un-cacheable across sessions (different sessions would see
//     different search results for the same query).
//   * Profile is intended to be generated ONCE at story import / story_version
//     creation; later reads are pure lookups by story_version_uuid.
//
// ClickUp 16.5 P1.v1-3 fix (2026-09-07 owner review): the handler
// identity uses a DERIVED `external community_profile_version` of the
// shape `<generator_version>-<content_hash_short>` (first 8 hex chars
// of the profile's `hash.content_hash`). The internal schema keeps
// `generator_version` as the raw rule-version string; the external
// derivation lives next to it (`deriveExternalCommunityProfileVersion`)
// and is the ONLY string the route layer / browser treats as the
// canonical identity. Same generator_version + different content →
// two different external versions → two preserved rows that an
// old-session regression can resolve independently.
//
// This module is intentionally pure: it does not call the network,
// does not touch secrets, and does not read env vars that look like
// credentials. The four ecology callers read via getCommunityProfile()
// and never re-run the understanding pass.

import { canonicalSha256 } from '../stories/canonicalHash.mjs';

/**
 * @typedef {Object} CommunityProfileTopic
 * @property {string} id         Stable, slug-style identifier inside this profile.
 * @property {string} label      Short human-readable topic name (zh-CN).
 * @property {string} summary    One-sentence description of the topic as
 *                               it relates to the original story itself.
 */

/**
 * @typedef {Object} CommunityProfileQuery
 * @property {string} id         Stable identifier inside this profile.
 * @property {string} query      The Zhihu search query to issue.
 * @property {'web' | 'knowledge' | 'hot' | 'mixed'} kind
 *                               What the query is intended to feed.
 *                               'web' → 结局页搜索; 'knowledge' → 知乎知识;
 *                               'hot' → 首页热榜匹配; 'mixed' → multi-use.
 */

/**
 * @typedef {Object} CommunityProfileHotKeyword
 * @property {string} id         Stable identifier inside this profile.
 * @property {string} keyword    The keyword to match against the hot list.
 * @property {string} rationale  One-sentence reason this keyword is
 *                               associated with the original story.
 */

/**
 * @typedef {Object} StoryCommunityProfile
 * @property {string} profile_uuid
 * @property {string} story_uuid
 * @property {string} story_version_uuid
 * @property {string} story_version_checksum        Pin to the original story.
 * @property {string} generator_version             Rule version that produced this profile.
 * @property {string} generated_at                  ISO timestamp (UTC).
 * @property {string} source                        'mock-fixture' | 'mock-generated' | 'real-generated' | 'manual'.
 * @property {string} locale                        BCP-47 / language tag.
 * @property {CommunityProfileTopic[]} topics       3-5 discussion topics about the original story.
 * @property {CommunityProfileQuery[]} queries      3-5 Zhihu search queries about the original story.
 * @property {CommunityProfileQuery[]} knowledge_queries
 *                                                2-4 Zhihu Knowledge queries about the original story.
 * @property {CommunityProfileHotKeyword[]} hot_keywords
 *                                                Several hot-list match keywords.
 * @property {{ content_hash: string }} hash        Content hash of the profile (used to
 *                                                  dedupe identical profiles across regenerations).
 */

/**
 * Current rule version. Bump this string when the prompt / generation
 * logic changes; older rows keep their old `generator_version` so the
 * history of profile generations is auditable.
 */
export const COMMUNITY_PROFILE_GENERATOR_VERSION = Object.freeze({
  identifier: 'community-profile',
  rules_version: 'community-profile-rules/1',
});

/**
 * Hard caps taken from the ClickUp 16.1 description. The mock fixture
 * AND any real-provider path MUST stay inside these bounds; the test
 * suite enforces them.
 */
export const COMMUNITY_PROFILE_BOUNDS = Object.freeze({
  topics_min: 3,
  topics_max: 5,
  queries_min: 3,
  queries_max: 5,
  knowledge_min: 2,
  knowledge_max: 4,
  hot_keywords_min: 2,
  hot_keywords_max: 8,
});

/**
 * ClickUp 16.1 P1.2 fix (2026-09-06): exact-allowlist of every
 * known field on a StoryCommunityProfile (and on each nested
 * sub-record). `assertCommunityProfileShape` rejects any unknown
 * key at any depth so a session-derived dimension
 * (e.g. `topics[0].private_context` carrying
 * `account_hint: 'session-derived'`) cannot leak into a shared
 * community profile. The black-list approach (`FORBIDDEN_PROFILE_KEYS`
 * in repository.mjs) is no longer the only defence — unknown keys at
 * any depth are now rejected by the shape validator.
 */
export const PROFILE_TOP_LEVEL_KEYS = Object.freeze([
  'profile_uuid',
  'story_uuid',
  'story_version_uuid',
  'story_version_checksum',
  'generator_version',
  'generated_at',
  'source',
  'locale',
  'topics',
  'queries',
  'knowledge_queries',
  'hot_keywords',
  'hash',
]);
export const PROFILE_TOPIC_KEYS = Object.freeze(['id', 'label', 'summary']);
export const PROFILE_QUERY_KEYS = Object.freeze(['id', 'query', 'kind']);
export const PROFILE_KNOWLEDGE_QUERY_KEYS = Object.freeze(['id', 'query', 'kind']);
export const PROFILE_HOT_KEYWORD_KEYS = Object.freeze(['id', 'keyword', 'rationale']);
export const PROFILE_HASH_KEYS = Object.freeze(['content_hash']);
export const PROFILE_SOURCES = Object.freeze([
  'mock-fixture',
  'mock-generated',
  'real-generated',
  'manual',
]);

/**
 * Strict-allowlist helper. Compares the keys actually present on an
 * object against an exact-allowlist (a frozen array of permitted
 * property names). When an unknown key is found, throws a
 * `ValidationError` with the path so the bug is reproducible.
 *
 * @param {string} path                  Human-readable path (e.g. 'topics[0]').
 * @param {string[]} seen                Object.keys() output.
 * @param {readonly string[]} allowed    Frozen allow-list.
 */
export function assertRecordAllowlist(path, seen, allowed) {
  const allowedSet = new Set(allowed);
  for (const key of seen) {
    if (!allowedSet.has(key)) {
      throw new Error(
        `communityProfile: unknown key at ${path || '$'} → ${JSON.stringify(key)} `
        + `(allowed: ${JSON.stringify(allowed)})`,
      );
    }
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * @param {string} label
 * @param {string} value
 */
function assertUuid(label, value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`communityProfile: ${label} must be a UUID`);
  }
}

/**
 * @param {string} label
 * @param {unknown} value
 */
function assertNonEmptyString(label, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`communityProfile: ${label} must be a non-empty string`);
  }
}

/**
 * Strict shape validation for the topic / query / hot-keyword records.
 * Keeps a single set of invariants in one place so the four ecology
 * callers can rely on the field shape without re-validating.
 *
 * The `requireId` flag exists because `buildCommunityProfileFromSeed`
 * derives ids deterministically from the seed record's stable label /
 * query / keyword; the seed itself does not carry an `id`. The
 * finalised record always does, so callers that already produced the
 * record pass `requireId: true` (default) and seed builders pass
 * `requireId: false`.
 *
 * @param {CommunityProfileTopic} topic
 * @param {string} label
 * @param {{ requireId?: boolean }} [opts]
 */
function assertTopicShape(topic, label, opts) {
  if (!topic || typeof topic !== 'object') {
    throw new Error(`communityProfile: ${label} must be an object`);
  }
  const requireId = !opts || opts.requireId !== false;
  if (requireId) assertNonEmptyString(`${label}.id`, topic.id);
  assertNonEmptyString(`${label}.label`, topic.label);
  assertNonEmptyString(`${label}.summary`, topic.summary);
}

/**
 * @param {CommunityProfileQuery} q
 * @param {string} label
 * @param {{ requireId?: boolean }} [opts]
 */
function assertQueryShape(q, label, opts) {
  if (!q || typeof q !== 'object') {
    throw new Error(`communityProfile: ${label} must be an object`);
  }
  const requireId = !opts || opts.requireId !== false;
  if (requireId) assertNonEmptyString(`${label}.id`, q.id);
  assertNonEmptyString(`${label}.query`, q.query);
  if (q.kind !== 'web' && q.kind !== 'knowledge' && q.kind !== 'hot' && q.kind !== 'mixed') {
    throw new Error(`communityProfile: ${label}.kind must be web|knowledge|hot|mixed`);
  }
}

/**
 * @param {CommunityProfileHotKeyword} k
 * @param {string} label
 * @param {{ requireId?: boolean }} [opts]
 */
function assertHotKeywordShape(k, label, opts) {
  if (!k || typeof k !== 'object') {
    throw new Error(`communityProfile: ${label} must be an object`);
  }
  const requireId = !opts || opts.requireId !== false;
  if (requireId) assertNonEmptyString(`${label}.id`, k.id);
  assertNonEmptyString(`${label}.keyword`, k.keyword);
  assertNonEmptyString(`${label}.rationale`, k.rationale);
}

/**
 * Validate a StoryCommunityProfile record against the public shape
 * contract. The four ecology callers can call this defensively; the
 * repository stores nothing else but this is the safety net.
 *
 * @param {unknown} profile
 * @returns {StoryCommunityProfile}
 */
export function assertCommunityProfileShape(profile) {
  if (!profile || typeof profile !== 'object') {
    throw new Error('communityProfile: profile must be an object');
  }
  const p = /** @type {any} */ (profile);
  // ClickUp 16.1 P1.2 fix (2026-09-06): strict top-level allowlist
  // BEFORE the per-field checks. Unknown keys at any depth are now
  // rejected so session-derived dimensions cannot leak in.
  assertRecordAllowlist('$', Object.keys(p), PROFILE_TOP_LEVEL_KEYS);
  assertUuid('profile_uuid', p.profile_uuid);
  assertUuid('story_uuid', p.story_uuid);
  assertUuid('story_version_uuid', p.story_version_uuid);
  assertNonEmptyString('story_version_checksum', p.story_version_checksum);
  assertNonEmptyString('generator_version', p.generator_version);
  assertNonEmptyString('generated_at', p.generated_at);
  assertNonEmptyString('source', p.source);
  if (!PROFILE_SOURCES.includes(p.source)) {
    throw new Error(
      `communityProfile: source '${p.source}' is not in PROFILE_SOURCES `
      + `(allowed: ${JSON.stringify(PROFILE_SOURCES)})`,
    );
  }
  assertNonEmptyString('locale', p.locale);
  if (!Array.isArray(p.topics)) throw new Error('communityProfile: topics must be an array');
  if (!Array.isArray(p.queries)) throw new Error('communityProfile: queries must be an array');
  if (!Array.isArray(p.knowledge_queries)) {
    throw new Error('communityProfile: knowledge_queries must be an array');
  }
  if (!Array.isArray(p.hot_keywords)) {
    throw new Error('communityProfile: hot_keywords must be an array');
  }
  // ClickUp 16.1 P1.2 fix (2026-09-06): per-sub-record shape +
  // strict allowlist. assertTopicShape / assertQueryShape /
  // assertHotKeywordShape still run, but the allowlist is the new
  // hard guarantee.
  for (let i = 0; i < p.topics.length; i += 1) {
    assertTopicShape(p.topics[i], `topics[${i}]`);
    assertRecordAllowlist(`topics[${i}]`, Object.keys(p.topics[i]), PROFILE_TOPIC_KEYS);
  }
  for (let i = 0; i < p.queries.length; i += 1) {
    assertQueryShape(p.queries[i], `queries[${i}]`);
    assertRecordAllowlist(`queries[${i}]`, Object.keys(p.queries[i]), PROFILE_QUERY_KEYS);
  }
  for (let i = 0; i < p.knowledge_queries.length; i += 1) {
    assertQueryShape(p.knowledge_queries[i], `knowledge_queries[${i}]`);
    assertRecordAllowlist(
      `knowledge_queries[${i}]`,
      Object.keys(p.knowledge_queries[i]),
      PROFILE_KNOWLEDGE_QUERY_KEYS,
    );
  }
  for (let i = 0; i < p.hot_keywords.length; i += 1) {
    assertHotKeywordShape(p.hot_keywords[i], `hot_keywords[${i}]`);
    assertRecordAllowlist(
      `hot_keywords[${i}]`,
      Object.keys(p.hot_keywords[i]),
      PROFILE_HOT_KEYWORD_KEYS,
    );
  }
  if (!p.hash || typeof p.hash !== 'object' || typeof p.hash.content_hash !== 'string') {
    throw new Error('communityProfile: hash.content_hash required');
  }
  assertRecordAllowlist('hash', Object.keys(p.hash), PROFILE_HASH_KEYS);
  return /** @type {StoryCommunityProfile} */ (p);
}

/**
 * Sanity-check the topic / query / knowledge / hot-keyword counts.
 * Returns the list of violations (empty list when valid). The bounds
 * come from the ClickUp 16.1 description and from the bounds module
 * exposed above.
 *
 * @param {StoryCommunityProfile} profile
 * @returns {string[]}
 */
export function findCommunityProfileBoundsViolations(profile) {
  const violations = [];
  const b = COMMUNITY_PROFILE_BOUNDS;
  if (profile.topics.length < b.topics_min || profile.topics.length > b.topics_max) {
    violations.push(
      `topics count ${profile.topics.length} is outside [${b.topics_min},${b.topics_max}]`,
    );
  }
  if (profile.queries.length < b.queries_min || profile.queries.length > b.queries_max) {
    violations.push(
      `queries count ${profile.queries.length} is outside [${b.queries_min},${b.queries_max}]`,
    );
  }
  if (
    profile.knowledge_queries.length < b.knowledge_min
    || profile.knowledge_queries.length > b.knowledge_max
  ) {
    violations.push(
      `knowledge_queries count ${profile.knowledge_queries.length} is outside [${b.knowledge_min},${b.knowledge_max}]`,
    );
  }
  if (
    profile.hot_keywords.length < b.hot_keywords_min
    || profile.hot_keywords.length > b.hot_keywords_max
  ) {
    violations.push(
      `hot_keywords count ${profile.hot_keywords.length} is outside [${b.hot_keywords_min},${b.hot_keywords_max}]`,
    );
  }
  return violations;
}

/**
 * ClickUp 16.5 P1.v1-3 — derive the external `community_profile_version`
 * from a profile (or any object carrying `generator_version` +
 * `hash.content_hash`). The shape is the canonical
 * `<generator_version>-<content_hash_short>` where `content_hash_short`
 * is the first 8 hex chars of the `hash.content_hash`. This external
 * derivation is what the handler / browser carries in
 * `community_profile_version`; the raw `generator_version` stays in
 * the schema for diagnostic / upgrade purposes and MUST NOT be used
 * directly by the route layer.
 *
 * Two profiles with the same `generator_version` but a different
 * `hash.content_hash` (e.g. a content-curated fixture edit) yield two
 * DIFFERENT external versions, so an old-session regression that
 * pinned the old external version still resolves to its original row.
 *
 * Pure function. Throws when the inputs are malformed.
 *
 * @param {{
 *   generator_version: string,
 *   hash: { content_hash: string },
 * }} profile
 * @returns {string} `<generator_version>-<content_hash_short>`
 */
export function deriveExternalCommunityProfileVersion(profile) {
  if (!profile || typeof profile !== 'object') {
    throw new Error('communityProfile.deriveExternalCommunityProfileVersion: profile required');
  }
  if (typeof profile.generator_version !== 'string' || !profile.generator_version) {
    throw new Error(
      'communityProfile.deriveExternalCommunityProfileVersion: generator_version required',
    );
  }
  const hash = profile.hash;
  if (!hash || typeof hash !== 'object' || typeof hash.content_hash !== 'string' || !hash.content_hash) {
    throw new Error(
      'communityProfile.deriveExternalCommunityProfileVersion: hash.content_hash required',
    );
  }
  return `${profile.generator_version}-${hash.content_hash.slice(0, 8)}`;
}

/**
 * Stable, deterministic id prefix for a sub-record inside a profile.
 * The id is derived from the parent story_version_checksum so two
 * regenerations produce identical ids for the same logical topic /
 * query / keyword. This is what makes the profile regression-test
 * stable: the mock fixture can pin ids by slug.
 *
 * @param {string} kind            'topic' | 'query' | 'knowledge' | 'hot'.
 * @param {string} story_version_checksum
 * @param {string} slug            Human-readable slug.
 * @returns {string}
 */
function stableSubId(kind, story_version_checksum, slug) {
  return `${kind}:${canonicalSha256(`${kind}|${story_version_checksum}|${slug}`).slice(0, 12)}`;
}

/**
 * Build a deterministic profile from a pre-baked seed. The seed is
 * typically a hand-curated fixture for the mock catalog (so CI can
 * pin every string and assert them) OR a deterministic extraction
 * from a real-provider story detail. The function is pure: same seed
 * → same profile; no random ids.
 *
 * @param {object} input
 * @param {string} input.story_uuid
 * @param {string} input.story_version_uuid
 * @param {string} input.story_version_checksum
 * @param {string} [input.locale]                Default 'zh-CN'.
 * @param {string} [input.source]                Default 'mock-fixture'.
 * @param {string} [input.generator_version]     Override the rule version.
 * @param {Array<{id?: string, label: string, summary: string}>} input.topics
 * @param {Array<{id?: string, query: string, kind: 'web' | 'knowledge' | 'hot' | 'mixed'}>} input.queries
 * @param {Array<{id?: string, query: string, kind: 'web' | 'knowledge' | 'hot' | 'mixed'}>} input.knowledge_queries
 * @param {Array<{id?: string, keyword: string, rationale: string}>} input.hot_keywords
 * @returns {StoryCommunityProfile}
 */
export function buildCommunityProfileFromSeed(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('communityProfile.buildCommunityProfileFromSeed: input required');
  }
  assertUuid('story_uuid', input.story_uuid);
  assertUuid('story_version_uuid', input.story_version_uuid);
  assertNonEmptyString('story_version_checksum', input.story_version_checksum);
  if (!Array.isArray(input.topics)
    && !(input.seed && Array.isArray(input.seed.topics))) {
    throw new Error('communityProfile.buildCommunityProfileFromSeed: topics[] required');
  }
  if (!Array.isArray(input.queries)
    && !(input.seed && Array.isArray(input.seed.queries))) {
    throw new Error('communityProfile.buildCommunityProfileFromSeed: queries[] required');
  }
  if (!Array.isArray(input.knowledge_queries)
    && !(input.seed && Array.isArray(input.seed.knowledge_queries))) {
    throw new Error('communityProfile.buildCommunityProfileFromSeed: knowledge_queries[] required');
  }
  if (!Array.isArray(input.hot_keywords)
    && !(input.seed && Array.isArray(input.seed.hot_keywords))) {
    throw new Error('communityProfile.buildCommunityProfileFromSeed: hot_keywords[] required');
  }
  const topicsInput = Array.isArray(input.topics) ? input.topics : input.seed.topics;
  const queriesInput = Array.isArray(input.queries) ? input.queries : input.seed.queries;
  const knowledgeQueriesInput = Array.isArray(input.knowledge_queries)
    ? input.knowledge_queries
    : input.seed.knowledge_queries;
  const hotKeywordsInput = Array.isArray(input.hot_keywords)
    ? input.hot_keywords
    : input.seed.hot_keywords;
  const generator_version =
    input.generator_version
    || `${COMMUNITY_PROFILE_GENERATOR_VERSION.identifier}@${COMMUNITY_PROFILE_GENERATOR_VERSION.rules_version}`;
  const locale = typeof input.locale === 'string' && input.locale ? input.locale : 'zh-CN';
  const source = typeof input.source === 'string' && input.source ? input.source : 'mock-fixture';
  /** @type {CommunityProfileTopic[]} */
  const topics = topicsInput.map((t, i) => {
    const label = `topics[${i}]`;
    assertTopicShape(t, label, { requireId: false });
    return {
      id: typeof t.id === 'string' && t.id
        ? t.id
        : stableSubId('topic', input.story_version_checksum, t.label),
      label: t.label,
      summary: t.summary,
    };
  });
  /** @type {CommunityProfileQuery[]} */
  const queries = queriesInput.map((q, i) => {
    const label = `queries[${i}]`;
    assertQueryShape(q, label, { requireId: false });
    return {
      id: typeof q.id === 'string' && q.id
        ? q.id
        : stableSubId('query', input.story_version_checksum, q.query),
      query: q.query,
      kind: q.kind,
    };
  });
  /** @type {CommunityProfileQuery[]} */
  const knowledge_queries = knowledgeQueriesInput.map((q, i) => {
    const label = `knowledge_queries[${i}]`;
    assertQueryShape(q, label, { requireId: false });
    return {
      id: typeof q.id === 'string' && q.id
        ? q.id
        : stableSubId('knowledge', input.story_version_checksum, q.query),
      query: q.query,
      kind: q.kind,
    };
  });
  /** @type {CommunityProfileHotKeyword[]} */
  const hot_keywords = hotKeywordsInput.map((k, i) => {
    const label = `hot_keywords[${i}]`;
    assertHotKeywordShape(k, label, { requireId: false });
    return {
      id: typeof k.id === 'string' && k.id
        ? k.id
        : stableSubId('hot', input.story_version_checksum, k.keyword),
      keyword: k.keyword,
      rationale: k.rationale,
    };
  });
  /** @type {StoryCommunityProfile} */
  const profile = {
    profile_uuid: uuidv4(),
    story_uuid: input.story_uuid,
    story_version_uuid: input.story_version_uuid,
    story_version_checksum: input.story_version_checksum,
    generator_version,
    generated_at: '1970-01-01T00:00:00.000Z', // overwritten below when not pinned
    source,
    locale,
    topics,
    queries,
    knowledge_queries,
    hot_keywords,
  };
  profile.generated_at = nowIso();
  /** @type {StoryCommunityProfile} */
  const withHash = {
    ...profile,
    hash: {
      content_hash: canonicalSha256({
        story_uuid: profile.story_uuid,
        story_version_uuid: profile.story_version_uuid,
        story_version_checksum: profile.story_version_checksum,
        generator_version: profile.generator_version,
        topics: profile.topics,
        queries: profile.queries,
        knowledge_queries: profile.knowledge_queries,
        hot_keywords: profile.hot_keywords,
      }),
    },
  };
  return assertCommunityProfileShape(withHash);
}

/**
 * Pure helper: derive a placeholder community profile from a story
 * detail when no curated fixture is available (e.g. real-provider path
 * without a network call). The placeholders describe the story itself
 * — its title and hook — so they remain cache-stable across sessions
 * and never reference any session-specific dimension. The placeholders
 * are explicitly tagged as "stub" in `source` so callers know not to
 * ship them as production-quality profiles.
 *
 * @param {object} input
 * @param {string} input.story_uuid
 * @param {string} input.story_version_uuid
 * @param {string} input.story_version_checksum
 * @param {{ id: string, title: string, hook: string }} input.story
 * @param {string} [input.generator_version]      Override the rule version.
 * @param {string} [input.locale]                 Default 'zh-CN'.
 * @returns {StoryCommunityProfile}
 */
export function buildStubCommunityProfile({ story_uuid, story_version_uuid, story_version_checksum, story, generator_version, locale, source }) {
  assertUuid('story_uuid', story_uuid);
  assertUuid('story_version_uuid', story_version_uuid);
  assertNonEmptyString('story_version_checksum', story_version_checksum);
  if (!story || typeof story !== 'object') {
    throw new Error('communityProfile.buildStubCommunityProfile: story required');
  }
  // ClickUp 16.1 P2 fix (2026-09-06): resolve + validate the provenance
  // tag before we use it. The downstream `assertCommunityProfileShape`
  // also checks this, but we want a clear error here at the seam.
  const resolvedSource = typeof source === 'string' && source ? source : 'mock-generated';
  if (!PROFILE_SOURCES.includes(resolvedSource)) {
    throw new Error(
      `communityProfile.buildStubCommunityProfile: source '${resolvedSource}' is not in PROFILE_SOURCES `
      + `(allowed: ${JSON.stringify(PROFILE_SOURCES)})`,
    );
  }
  const title = typeof story.title === 'string' && story.title ? story.title : '本作';
  const hook = typeof story.hook === 'string' && story.hook ? story.hook : '';
  const topics = [
    { label: `${title} 的故事解读`, summary: `围绕原作《${title}》的情节与主题展开的解读型讨论。` },
    { label: `${title} 的角色关系`, summary: `原作中角色之间的关系、立场与张力。` },
    { label: `${title} 的创作背景`, summary: `原作的创作背景与作者在公开访谈中分享的语境。` },
  ];
  const queries = [
    { query: `${title} 故事解读`, kind: 'web' },
    { query: `${title} 角色分析`, kind: 'web' },
    { query: `${title} 创作背景`, kind: 'mixed' },
  ];
  const knowledge_queries = [
    { query: `${title} 设定 百科`, kind: 'knowledge' },
    { query: `${title} 主题 释义`, kind: 'knowledge' },
  ];
  const hot_keywords = [
    { keyword: title, rationale: '原作标题本身是热榜匹配最直接的关键词。' },
    { keyword: hook.split(/[，。；,.;\s]+/)[0] || title, rationale: '原作 hook 切出的核心名词。' },
  ];
  return buildCommunityProfileFromSeed({
    story_uuid,
    story_version_uuid,
    story_version_checksum,
    source: resolvedSource,
    locale: typeof locale === 'string' && locale ? locale : 'zh-CN',
    generator_version,
    topics,
    queries,
    knowledge_queries,
    hot_keywords,
  });
}
