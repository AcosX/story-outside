// tests/communityProfile.test.mjs — Story 16.1 community-profile contract.
//
// The test asserts:
//   * A pre-baked fixture story produces a community profile that
//     contains 3-5 topics, 3-5 search queries, 2-4 knowledge queries,
//     and several hot keywords.
//   * The profile is bound to story_version and is reused across
//     multiple reads (no regeneration on the second call).
//   * The profile carries ZERO session-specific / user-specific /
//     model-output fields — every field describes the original story
//     itself.
//   * The forbidden-key surface (session_uuid, user_ref, …) is rejected
//     by the repository so a buggy caller cannot smuggle session
//     data into a supposedly public profile.
//   * A story_version_checksum change OR a generator_version change
//     creates a NEW profile row without overwriting the old one.
//   * Stub profiles (for stories without a curated seed) are
//     deterministic given the same story detail.

import assert from 'node:assert/strict';

import {
  COMMUNITY_PROFILE_BOUNDS,
  _forbiddenCommunityProfileDimensions,
  createInMemoryCommunityProfileRepository,
  ensureCommunityProfile,
  getCommunityProfile,
  getCommunityFixtureSeed,
  buildStubCommunityProfile,
  buildCommunityProfileFromSeed,
  buildCanonicalCommunityProfileVersion,
  listCommunityFixtureSlugs,
  seedCommunityProfiles,
  setCommunityProfile,
} from '../src/community/index.mjs';
import {
  createSeededRepository,
  FIXTURE_UUIDS,
} from '../src/stories/fixture.mjs';
import { canonicalStoryHash } from '../src/stories/canonicalHash.mjs';
import { MOCK_DETAILS_FOR_COMMUNITY } from './_communityMockDetails.mjs';

let failures = 0;
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => console.log(`  ok   ${name}`),
        (err) => {
          failures += 1;
          console.log(`  FAIL ${name}`);
          console.log(`    ${err && err.message ? err.message : err}`);
        },
      );
    }
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`    ${err && err.message ? err.message : err}`);
  }
}

function uuidv4() {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

async function runChecks() {
  console.log('Story 16.1 community-profile contract');

  // ----- shape ---------------------------------------------------------

  await check('fixture slug list is non-empty and matches FIXTURE_UUIDS', () => {
    const slugs = listCommunityFixtureSlugs();
    assert.ok(Array.isArray(slugs));
    assert.ok(slugs.length > 0, 'fixture list must not be empty');
    for (const slug of slugs) {
      assert.ok(FIXTURE_UUIDS[slug], `slug '${slug}' must map to FIXTURE_UUIDS`);
    }
  });

  await check('mock-fixture community profile has 3-5 topics / 3-5 queries / 2-4 knowledge / 2+ hot keywords', () => {
    const { repository, fixtures } = createSeededRepository();
    const profileRepo = createInMemoryCommunityProfileRepository();
    const result = seedCommunityProfiles(repository, profileRepo);
    assert.ok(result.generated.length > 0, 'seedCommunityProfiles must generate at least one profile');
    const profile = getCommunityProfile({
      profileRepository: profileRepo,
      story_version_uuid: FIXTURE_UUIDS['cafe-rain'].story_version_uuid,
    });
    assert.ok(profile, 'profile must exist after seeding');
    const b = COMMUNITY_PROFILE_BOUNDS;
    assert.ok(profile.topics.length >= b.topics_min && profile.topics.length <= b.topics_max,
      `topics.length=${profile.topics.length} outside [${b.topics_min},${b.topics_max}]`);
    assert.ok(profile.queries.length >= b.queries_min && profile.queries.length <= b.queries_max,
      `queries.length=${profile.queries.length} outside [${b.queries_min},${b.queries_max}]`);
    assert.ok(
      profile.knowledge_queries.length >= b.knowledge_min
        && profile.knowledge_queries.length <= b.knowledge_max,
      `knowledge_queries.length=${profile.knowledge_queries.length} outside [${b.knowledge_min},${b.knowledge_max}]`,
    );
    assert.ok(
      profile.hot_keywords.length >= b.hot_keywords_min
        && profile.hot_keywords.length <= b.hot_keywords_max,
      `hot_keywords.length=${profile.hot_keywords.length} outside [${b.hot_keywords_min},${b.hot_keywords_max}]`,
    );
    assert.equal(profile.story_version_uuid, FIXTURE_UUIDS['cafe-rain'].story_version_uuid);
    assert.equal(profile.story_uuid, FIXTURE_UUIDS['cafe-rain'].story_uuid);
    assert.ok(typeof profile.story_version_checksum === 'string');
    assert.ok(profile.story_version_checksum.length === 64);
    assert.ok(typeof profile.hash.content_hash === 'string');
    assert.ok(profile.hash.content_hash.length === 64);
    void fixtures;
  });

  // ----- idempotency / cache ------------------------------------------

  await check('second ensureCommunityProfile on the same story_version returns the same instance', () => {
    const { repository } = createSeededRepository();
    const profileRepo = createInMemoryCommunityProfileRepository();
    seedCommunityProfiles(repository, profileRepo);
    const sv = FIXTURE_UUIDS['cafe-rain'].story_version_uuid;
    const a = ensureCommunityProfile({
      repository,
      profileRepository: profileRepo,
      story_version_uuid: sv,
      story: MOCK_DETAILS_FOR_COMMUNITY['cafe-rain'],
      options: { source: 'mock-fixture', seed: getCommunityFixtureSeed('cafe-rain') },
    });
    const b = ensureCommunityProfile({
      repository,
      profileRepository: profileRepo,
      story_version_uuid: sv,
      story: MOCK_DETAILS_FOR_COMMUNITY['cafe-rain'],
      options: { source: 'mock-fixture', seed: getCommunityFixtureSeed('cafe-rain') },
    });
    assert.equal(a.profile_uuid, b.profile_uuid);
    assert.equal(a.hash.content_hash, b.hash.content_hash);
    // Two seed stories → two active profiles overall. Re-call must NOT
    // add a third one for cafe-rain.
    const allForCafe = profileRepo.listByStoryVersion({ story_version_uuid: sv });
    assert.equal(allForCafe.length, 1);
    assert.equal(profileRepo.stats().profile_count, 2);
  });

  await check('multiple reads via getCommunityProfile return the same instance', () => {
    const { repository } = createSeededRepository();
    const profileRepo = createInMemoryCommunityProfileRepository();
    seedCommunityProfiles(repository, profileRepo);
    const a = getCommunityProfile({
      profileRepository: profileRepo,
      story_version_uuid: FIXTURE_UUIDS['night-shift'].story_version_uuid,
    });
    const b = getCommunityProfile({
      profileRepository: profileRepo,
      story_version_uuid: FIXTURE_UUIDS['night-shift'].story_version_uuid,
    });
    assert.ok(a, 'first read must return a profile');
    assert.equal(a.profile_uuid, b.profile_uuid);
    // Same object identity (returned row, not a copy).
    assert.equal(a, b);
  });

  await check('different story_version_uuids get separate profiles', () => {
    const { repository } = createSeededRepository();
    const profileRepo = createInMemoryCommunityProfileRepository();
    seedCommunityProfiles(repository, profileRepo);
    const cafe = getCommunityProfile({
      profileRepository: profileRepo,
      story_version_uuid: FIXTURE_UUIDS['cafe-rain'].story_version_uuid,
    });
    const night = getCommunityProfile({
      profileRepository: profileRepo,
      story_version_uuid: FIXTURE_UUIDS['night-shift'].story_version_uuid,
    });
    assert.ok(cafe && night);
    assert.notEqual(cafe.profile_uuid, night.profile_uuid);
    assert.notEqual(cafe.hash.content_hash, night.hash.content_hash);
  });

  // ----- versioning ----------------------------------------------------

  await check('generator_version change creates a NEW profile row, keeps the old one', () => {
    const { repository } = createSeededRepository();
    const profileRepo = createInMemoryCommunityProfileRepository();
    seedCommunityProfiles(repository, profileRepo);
    const sv = FIXTURE_UUIDS['cafe-rain'].story_version_uuid;
    const v1 = getCommunityProfile({
      profileRepository: profileRepo,
      story_version_uuid: sv,
      generator_version: 'community-profile@community-profile-rules/1',
    });
    const v2 = ensureCommunityProfile({
      repository,
      profileRepository: profileRepo,
      story_version_uuid: sv,
      story: MOCK_DETAILS_FOR_COMMUNITY['cafe-rain'],
      options: {
        generator_version: 'community-profile-rules/2',
        source: 'mock-generated',
      },
    });
    assert.ok(v1 && v2);
    assert.notEqual(v1.profile_uuid, v2.profile_uuid);
    assert.notEqual(v1.generator_version, v2.generator_version);
    // listByStoryVersion returns both rows for this story_version.
    const all = profileRepo.listByStoryVersion({ story_version_uuid: sv });
    assert.equal(all.length, 2);
    // v2 wins as the latest active when no generator_version filter is given.
    const latest = getCommunityProfile({ profileRepository: profileRepo, story_version_uuid: sv });
    assert.equal(latest.profile_uuid, v2.profile_uuid);
  });

  await check('content_hash change (different seed content) creates a new active profile', () => {
    const { repository } = createSeededRepository();
    const profileRepo = createInMemoryCommunityProfileRepository();
    seedCommunityProfiles(repository, profileRepo);
    const story_version_uuid = FIXTURE_UUIDS['cafe-rain'].story_version_uuid;
    const a = getCommunityProfile({ profileRepository: profileRepo, story_version_uuid });
    const checksum = a.story_version_checksum;
    const differentSeed = {
      topics: [
        { label: '完全不同的主题 A', summary: '与原 profile 完全不同的种子，用于触发新 hash。' },
        { label: '完全不同的主题 B', summary: '第二条完全不同的种子。' },
        { label: '完全不同的主题 C', summary: '第三条完全不同的种子。' },
      ],
      queries: [
        { query: '全新查询 A', kind: 'web' },
        { query: '全新查询 B', kind: 'web' },
        { query: '全新查询 C', kind: 'mixed' },
      ],
      knowledge_queries: [
        { query: '新知识查询 A', kind: 'knowledge' },
        { query: '新知识查询 B', kind: 'knowledge' },
      ],
      hot_keywords: [
        { keyword: '新热词 A', rationale: '新理由 A。' },
        { keyword: '新热词 B', rationale: '新理由 B。' },
      ],
    };
    const b = ensureCommunityProfile({
      repository,
      profileRepository: profileRepo,
      story_version_uuid,
      story: MOCK_DETAILS_FOR_COMMUNITY['cafe-rain'],
      options: { source: 'mock-fixture', seed: differentSeed },
    });
    assert.notEqual(a.profile_uuid, b.profile_uuid);
    assert.notEqual(a.hash.content_hash, b.hash.content_hash);
    assert.equal(b.story_version_checksum, checksum);
  });

  // ----- session-freeness ---------------------------------------------

  await check('mock-fixture profile carries ZERO session/user/model-output fields', () => {
    const { repository } = createSeededRepository();
    const profileRepo = createInMemoryCommunityProfileRepository();
    seedCommunityProfiles(repository, profileRepo);
    const profile = getCommunityProfile({
      profileRepository: profileRepo,
      story_version_uuid: FIXTURE_UUIDS['cafe-rain'].story_version_uuid,
    });
    assert.ok(profile);
    // Top-level keys. Story 16.2 P1.v1-5 (2026-09-07): the
    // previous v1-4 surface stamped `insert_seq` onto every row
    // (turning the canonical 13-field schema into 14 fields). v1-5
    // reverts the schema. `insert_seq` is NOT a row field; the
    // allowed set is exactly the 13 fields Story 16.1 / main ship.
    const allowed = new Set([
      'profile_uuid', 'story_uuid', 'story_version_uuid',
      'story_version_checksum', 'generator_version', 'generated_at',
      'source', 'locale', 'topics', 'queries', 'knowledge_queries',
      'hot_keywords', 'hash',
    ]);
    for (const k of Object.keys(profile)) {
      assert.ok(allowed.has(k), `unexpected top-level key '${k}'`);
    }
    // No forbidden key anywhere in the payload (walk manually).
    const forbidden = _forbiddenCommunityProfileDimensions();
    const seen = new Set();
    /** @param {unknown} v */
    function walk(v) {
      if (v === null || typeof v !== 'object') return;
      if (Array.isArray(v)) { for (const e of v) walk(e); return; }
      for (const k of Object.keys(/** @type {object} */ (v))) {
        seen.add(k);
        if (forbidden.has(k)) {
          throw new Error(`forbidden key '${k}' present in profile`);
        }
        walk((/** @type {Record<string, unknown>} */ (v))[k]);
      }
    }
    walk(profile);
    // The "no session_uuid / no user_ref / no model output" contract is
    // exactly what `forbidden` encodes, so a clean walk = clean profile.
    assert.ok(true);
  });

  await check('repository rejects a profile that smuggles a session_uuid field', () => {
    const { repository } = createSeededRepository();
    const profileRepo = createInMemoryCommunityProfileRepository();
    seedCommunityProfiles(repository, profileRepo);
    const base = getCommunityProfile({
      profileRepository: profileRepo,
      story_version_uuid: FIXTURE_UUIDS['cafe-rain'].story_version_uuid,
    });
    assert.ok(base);
    const bad = /** @type {any} */ ({
      ...base,
      topics: [
        ...base.topics,
        { id: 'evil', label: 'evil', summary: 'evil', session_uuid: 'evil' },
      ],
    });
    let threw = false;
    try {
      setCommunityProfile({ profileRepository: profileRepo, profile: bad });
    } catch (err) {
      threw = true;
      // Story 16.1 P1.2 fix (2026-09-06): strict allowlist now
      // rejects unknown nested keys with this message. The legacy
      // black-list path is also still active as a defence-in-depth
      // check, so the message contains the offending key.
      assert.match(String(err && err.message), /session_uuid/);
    }
    assert.ok(threw, 'setCommunityProfile must throw on forbidden field');
    // Also try user_ref on a query and model_output on a hot_keyword.
    const bad2 = /** @type {any} */ ({
      ...base,
      profile_uuid: uuidv4(),
      queries: [
        ...base.queries,
        { id: 'evil', query: 'evil', kind: 'web', user_ref: 'evil' },
      ],
    });
    threw = false;
    try {
      setCommunityProfile({ profileRepository: profileRepo, profile: bad2 });
    } catch (err) {
      threw = true;
      assert.match(String(err && err.message), /user_ref/);
    }
    assert.ok(threw, 'setCommunityProfile must throw on forbidden field');
    const bad3 = /** @type {any} */ ({
      ...base,
      profile_uuid: uuidv4(),
      hot_keywords: [
        ...base.hot_keywords,
        { id: 'evil', keyword: 'evil', rationale: 'evil', model_output: 'evil' },
      ],
    });
    threw = false;
    try {
      setCommunityProfile({ profileRepository: profileRepo, profile: bad3 });
    } catch (err) {
      threw = true;
      // Story 16.1 P1.2 fix (2026-09-06): see note above — the
      // strict allowlist now produces a 'unknown key at hot_keywords[N]'
      // message that still contains the offending field name.
      assert.match(String(err && err.message), /model_output/);
    }
    assert.ok(threw, 'setCommunityProfile must throw on forbidden field');
  });

  await check('stub profile (no curated seed) is deterministic given the same story', () => {
    const story_uuid = uuidv4();
    const story_version_uuid = uuidv4();
    const detail = {
      id: 'demo-stub',
      title: 'Demo Stub Story',
      hook: 'A deterministic stub for tests.',
      roles: [],
      beats: [],
    };
    const checksum = canonicalStoryHash(detail);
    const a = buildStubCommunityProfile({
      story_uuid,
      story_version_uuid,
      story_version_checksum: checksum,
      story: detail,
    });
    const b = buildStubCommunityProfile({
      story_uuid,
      story_version_uuid,
      story_version_checksum: checksum,
      story: detail,
    });
    // profile_uuid is random, but content_hash and ids must match.
    assert.notEqual(a.profile_uuid, b.profile_uuid);
    assert.equal(a.hash.content_hash, b.hash.content_hash);
    assert.deepEqual(a.topics, b.topics);
    assert.deepEqual(a.queries, b.queries);
    assert.deepEqual(a.knowledge_queries, b.knowledge_queries);
    assert.deepEqual(a.hot_keywords, b.hot_keywords);
    // Stub bounds still hold.
    assert.ok(a.topics.length >= COMMUNITY_PROFILE_BOUNDS.topics_min);
    assert.ok(a.queries.length >= COMMUNITY_PROFILE_BOUNDS.queries_min);
    assert.ok(a.knowledge_queries.length >= COMMUNITY_PROFILE_BOUNDS.knowledge_min);
    assert.ok(a.hot_keywords.length >= COMMUNITY_PROFILE_BOUNDS.hot_keywords_min);
  });

  await check('buildCommunityProfileFromSeed is deterministic and idempotent in the repository', () => {
    const story_uuid = uuidv4();
    const story_version_uuid = uuidv4();
    const detail = {
      id: 'demo-seed',
      title: 'Demo Seed Story',
      hook: 'A deterministic seed for tests.',
      roles: [{ id: 'r1', label: '角色一', mood: '' }],
      beats: ['第一句', '第二句'],
    };
    const checksum = canonicalStoryHash(detail);
    const profileRepo = createInMemoryCommunityProfileRepository();
    const seed = {
      topics: [
        { label: '种子主题 A', summary: '种子 A 的描述。' },
        { label: '种子主题 B', summary: '种子 B 的描述。' },
        { label: '种子主题 C', summary: '种子 C 的描述。' },
      ],
      queries: [
        { query: '种子查询 A', kind: 'web' },
        { query: '种子查询 B', kind: 'mixed' },
        { query: '种子查询 C', kind: 'hot' },
      ],
      knowledge_queries: [
        { query: '种子知识 A', kind: 'knowledge' },
        { query: '种子知识 B', kind: 'knowledge' },
      ],
      hot_keywords: [
        { keyword: '种子热词 A', rationale: '种子 A 理由。' },
        { keyword: '种子热词 B', rationale: '种子 B 理由。' },
      ],
    };
    const a = buildCommunityProfileFromSeed({
      story_uuid,
      story_version_uuid,
      story_version_checksum: checksum,
      seed,
    });
    const b = buildCommunityProfileFromSeed({
      story_uuid,
      story_version_uuid,
      story_version_checksum: checksum,
      seed,
    });
    assert.equal(a.hash.content_hash, b.hash.content_hash);
    const storedA = setCommunityProfile({ profileRepository: profileRepo, profile: a });
    const storedB = setCommunityProfile({ profileRepository: profileRepo, profile: b });
    // Same content_hash → same active row (no duplicate insert).
    assert.equal(storedA.profile_uuid, storedB.profile_uuid);
    assert.equal(profileRepo.stats().profile_count, 1);
  });

  // ----- Story 16.2 P1.v1-3 / P1.v1-4 --------------------------
  //
  // Regression guards for the active-row deterministic-order fix.
  // P1.v1-2 closed the immutable-lookup bug (findCanonicalByIdentity
  // walks every row by story_version_uuid and matches the version
  // string byte-for-byte). P1.v1-3 closed a related active-row
  // tie-break bug: when two distinct rows under the same
  // story_version_uuid share the SAME `generated_at` millisecond
  // (Date#toISOString only has ms resolution), the choice of
  // "active" row MUST be deterministic AND MUST NOT depend on the
  // caller-supplied `generator_version` string. v1-3 used
  // `profile_uuid` (lexicographic UUID v4 comparison) as the
  // tie-break. code review independently re-ran `communityProfile.test`
  // consecutively and found that v1-3 still flakes on the second
  // consecutive run because UUID v4 comparison is a total order
  // UNCORRELATED with insertion order.
  //
  // P1.v1-5 replaces the row-stamped `insert_seq` of v1-4 with a
  // PRIVATE repository state (`latestByStoryVersion:
  // Map<story_version_uuid, profile_uuid>`) that is updated on
  // every NEW insert and only on new inserts (idempotent retries
  // do not move it). The active row for a `story_version_uuid`
  // is the `profile_uuid` recorded in the latest pointer. The
  // canonical 13-field profile schema is preserved end-to-end;
  // no `insert_seq` lives on the row surface. This makes the
  // contract:
  //   "The second new insert under the same story_version wins
  //    the active slot, regardless of `generated_at` collisions
  //    or caller-supplied randomness in `profile_uuid` /
  //    `generator_version`."
  // Stable, repeatable, independent of caller-supplied strings.

  function _buildRowWithFixedTimestamp({
    story_uuid,
    story_version_uuid,
    story_version_checksum,
    generator_version,
    generated_at,
    content_marker,
  }) {
    const profile = buildCommunityProfileFromSeed({
      story_uuid,
      story_version_uuid,
      story_version_checksum,
      generator_version,
      source: 'mock-fixture',
      topics: [
        { label: `topic-${content_marker}-A`, summary: `summary-${content_marker}-A` },
        { label: `topic-${content_marker}-B`, summary: `summary-${content_marker}-B` },
        { label: `topic-${content_marker}-C`, summary: `summary-${content_marker}-C` },
      ],
      queries: [
        { query: `query-${content_marker}-A`, kind: 'web' },
        { query: `query-${content_marker}-B`, kind: 'web' },
        { query: `query-${content_marker}-C`, kind: 'mixed' },
      ],
      knowledge_queries: [
        { query: `knowledge-${content_marker}-A`, kind: 'knowledge' },
        { query: `knowledge-${content_marker}-B`, kind: 'knowledge' },
      ],
      hot_keywords: [
        { keyword: `hot-${content_marker}-A`, rationale: `rationale-${content_marker}-A` },
        { keyword: `hot-${content_marker}-B`, rationale: `rationale-${content_marker}-B` },
      ],
    });
    // Pin generated_at to a caller-controlled millisecond so we can
    // exercise the same-timestamp path deterministically.
    profile.generated_at = generated_at;
    return profile;
  }

  // Pull the canonical story_version_checksum off the seed-built
  // profile so the P1.v1-3 fixtures match the same
  // (story_uuid, story_version_uuid, story_version_checksum) triple
  // the rest of the test suite uses.
  function _seedChecksum(profileRepo, story_version_uuid) {
    const seeded = getCommunityProfile({ profileRepository: profileRepo, story_version_uuid });
    assert.ok(seeded, 'seed profile must exist');
    return seeded.story_version_checksum;
  }

  await check('same-timestamp rows under one story_version resolve to a deterministic active row (P1.v1-3 / v1-5)', () => {
    // Two rows under the SAME story_version_uuid, produced in the
    // SAME millisecond, with DIFFERENT generator_version strings.
    //
    // v1-3 fixed the case where the active-row decision depended on
    // lexicographic comparison of caller-supplied `generator_version`.
    // v1-4 closes the residual flake code review caught on the SECOND
    // consecutive run: v1-3 used `profile_uuid` (random UUID v4) as
    // the tie-break, which is a total order but UNCORRELATED with
    // insertion order — two runs can produce different UUID v4
    // values for "row B" and flip the winner.
    //
    // v1-4 contract: active row = the row with the LARGEST
    // `insert_seq` within the `story_version_uuid`. The counter is
    // monotonic in insertion order, so under the same `generated_at`
    // millisecond, the SECOND-INSERTED row always wins — regardless
    // of UUID v4 randomness or `generator_version` content. This
    // test pins the v1-4 contract on top of the v1-3 fixture.
    const { repository } = createSeededRepository();
    const profileRepo = createInMemoryCommunityProfileRepository();
    seedCommunityProfiles(repository, profileRepo);
    const { story_uuid, story_version_uuid } = FIXTURE_UUIDS['cafe-rain'];
    const story_version_checksum = _seedChecksum(profileRepo, story_version_uuid);

    const fixed_ts = '2026-09-07T01:02:03.456Z';
    const row_a = _buildRowWithFixedTimestamp({
      story_uuid,
      story_version_uuid,
      story_version_checksum,
      generator_version: 'community-profile@community-profile-rules/a',
      generated_at: fixed_ts,
      content_marker: 'A',
    });
    const row_b = _buildRowWithFixedTimestamp({
      story_uuid,
      story_version_uuid,
      story_version_checksum,
      generator_version: 'community-profile@community-profile-rules/b',
      generated_at: fixed_ts,
      content_marker: 'B',
    });
    const stored_a = setCommunityProfile({ profileRepository: profileRepo, profile: row_a });
    const stored_b = setCommunityProfile({ profileRepository: profileRepo, profile: row_b });
    assert.notEqual(stored_a.profile_uuid, stored_b.profile_uuid);
    assert.equal(stored_a.generated_at, fixed_ts);
    assert.equal(stored_b.generated_at, fixed_ts);

    // P1.v1-5 invariant: the SECOND new insert always wins under the
    // same `generated_at`. The repository moves its PRIVATE
    // `latestByStoryVersion` pointer on every NEW insert (and only
    // on new inserts; idempotent hits do NOT move the pointer), so
    // the second call's row is the active row regardless of
    // `generated_at` ties, UUID v4 randomness, or
    // `generator_version` content.
    //
    // v1-5 deliberately does NOT carry `insert_seq` on the row:
    // canonical schema must stay at 13 fields. We assert the
    // absence of `insert_seq` here to lock the schema invariant.
    assert.equal(
      Object.prototype.hasOwnProperty.call(stored_a, 'insert_seq'), false,
      'row A must NOT carry `insert_seq` on its surface (canonical 13-field schema)',
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(stored_b, 'insert_seq'), false,
      'row B must NOT carry `insert_seq` on its surface (canonical 13-field schema)',
    );
    // The shape validator must reject a caller that smuggles an
    // `insert_seq` field into a payload — strict 13-field allowlist.
    assert.throws(
      () => setCommunityProfile({
        profileRepository: profileRepo,
        profile: { ...row_a, insert_seq: 1 },
      }),
      /unknown key/,
      'smuggling `insert_seq` into the payload MUST be rejected by the strict top-level allowlist',
    );

    // Run the active-row selection many times; the answer MUST be
    // identical every call (deterministic) and MUST NOT depend on
    // UUID v4 randomness or generator_version lexicographic order.
    // The expected winner is row B by the v1-4 contract.
    const expected_uuid = stored_b.profile_uuid;
    const active1 = getCommunityProfile({ profileRepository: profileRepo, story_version_uuid });
    const active2 = getCommunityProfile({ profileRepository: profileRepo, story_version_uuid });
    const active3 = getCommunityProfile({ profileRepository: profileRepo, story_version_uuid });
    assert.equal(active1.profile_uuid, expected_uuid);
    assert.equal(active2.profile_uuid, expected_uuid);
    assert.equal(active3.profile_uuid, expected_uuid);

    // listByStoryVersion must return at least the seed row + our two
    // same-timestamp fixtures, all sharing the same story_version_uuid.
    const all = profileRepo.listByStoryVersion({ story_version_uuid });
    assert.ok(all.length >= 3,
      `expected at least 3 rows for the cafe-rain story_version, got ${all.length}`);
    const fixtureUuids = new Set([stored_a.profile_uuid, stored_b.profile_uuid]);
    for (const row of all) {
      assert.ok(
        row.story_version_uuid === story_version_uuid,
        'every listed row must share the same story_version_uuid',
      );
    }
    // Both fixture rows must be present in the listing (idempotency
    // does not collapse them: different generator_version strings,
    // different content_hash).
    let fixtureRowsSeen = 0;
    for (const row of all) {
      if (fixtureUuids.has(row.profile_uuid)) fixtureRowsSeen += 1;
    }
    assert.equal(fixtureRowsSeen, 2, 'both fixture rows must appear in listByStoryVersion');
  });

  await check('different-timestamp rows pick the newer generated_at as active (P1.v1-3)', () => {
    const { repository } = createSeededRepository();
    const profileRepo = createInMemoryCommunityProfileRepository();
    seedCommunityProfiles(repository, profileRepo);
    const { story_uuid, story_version_uuid } = FIXTURE_UUIDS['cafe-rain'];
    const story_version_checksum = _seedChecksum(profileRepo, story_version_uuid);

    // Older row first, then newer row.
    const old_ts = '2026-09-07T01:00:00.000Z';
    const new_ts = '2026-09-07T02:00:00.000Z';
    const old_row = _buildRowWithFixedTimestamp({
      story_uuid,
      story_version_uuid,
      story_version_checksum,
      generator_version: 'community-profile@community-profile-rules/old',
      generated_at: old_ts,
      content_marker: 'old',
    });
    const new_row = _buildRowWithFixedTimestamp({
      story_uuid,
      story_version_uuid,
      story_version_checksum,
      generator_version: 'community-profile@community-profile-rules/new',
      generated_at: new_ts,
      content_marker: 'new',
    });
    setCommunityProfile({ profileRepository: profileRepo, profile: old_row });
    setCommunityProfile({ profileRepository: profileRepo, profile: new_row });
    const active = getCommunityProfile({ profileRepository: profileRepo, story_version_uuid });
    assert.ok(active, 'active row must resolve');
    assert.equal(active.profile_uuid, new_row.profile_uuid,
      'active row must be the one with the newer generated_at, regardless of insertion order');
    assert.equal(active.generated_at, new_ts);
  });

  await check('community_profile_version exact lookup hits the requested row even when an older active row exists (P1.v1-3)', () => {
    // Regression for the immutable-lookup contract from P1.v1-2:
    // even when `findActiveByStoryVersion` would resolve to the
    // newest row, a client that pins a `community_profile_version`
    // string built from an OLDER row must still get THAT older row
    // back. This pairs with the active-row fix above to make sure
    // the two mechanisms do not interfere.
    const { repository } = createSeededRepository();
    const profileRepo = createInMemoryCommunityProfileRepository();
    seedCommunityProfiles(repository, profileRepo);
    const { story_uuid, story_version_uuid } = FIXTURE_UUIDS['cafe-rain'];
    const story_version_checksum = _seedChecksum(profileRepo, story_version_uuid);

    const old_ts = '2026-09-07T01:00:00.000Z';
    const new_ts = '2026-09-07T02:00:00.000Z';
    const old_row = _buildRowWithFixedTimestamp({
      story_uuid,
      story_version_uuid,
      story_version_checksum,
      generator_version: 'community-profile@community-profile-rules/old',
      generated_at: old_ts,
      content_marker: 'exact-old',
    });
    const new_row = _buildRowWithFixedTimestamp({
      story_uuid,
      story_version_uuid,
      story_version_checksum,
      generator_version: 'community-profile@community-profile-rules/new',
      generated_at: new_ts,
      content_marker: 'exact-new',
    });
    setCommunityProfile({ profileRepository: profileRepo, profile: old_row });
    setCommunityProfile({ profileRepository: profileRepo, profile: new_row });

    // Active is the newer row.
    const active = getCommunityProfile({ profileRepository: profileRepo, story_version_uuid });
    assert.equal(active.profile_uuid, new_row.profile_uuid);

    // Exact cpv lookup against the OLD row's version string MUST
    // return the OLD row, not the active row.
    const old_cpv = buildCanonicalCommunityProfileVersion(old_row);
    assert.ok(old_cpv);
    const exact = profileRepo.findCanonicalByIdentity({
      story_uuid,
      story_version_uuid,
      community_profile_version: old_cpv,
    });
    assert.equal(exact.ok, true);
    assert.equal(exact.profile.profile_uuid, old_row.profile_uuid);
    assert.equal(exact.profile.generated_at, old_ts);
  });

  // ----- Story 16.2 P1.v1-4 specific fixtures ---------------------

  // helper: build a fresh profile whose only difference from a
  // fixture row is the `generator_version` string + the content
  // marker (so the `content_hash` differs but the millisecond is
  // shared). Used by the same-timestamp "second new insert wins"
  // fixture.
  function _buildInsertSeqFixtureRow({
    story_uuid,
    story_version_uuid,
    story_version_checksum,
    generator_version,
    generated_at,
    content_marker,
  }) {
    return _buildRowWithFixedTimestamp({
      story_uuid,
      story_version_uuid,
      story_version_checksum,
      generator_version,
      generated_at,
      content_marker,
    });
  }

  await check('same-timestamp: SECOND new insert wins under identical generated_at (P1.v1-5)', () => {
    // P1.v1-5 core regression: when two distinct rows share the SAME
    // millisecond `generated_at`, the row inserted SECOND must win
    // the active slot, regardless of:
    //   - the lexicographic order of `profile_uuid` (UUID v4 randomness)
    //   - the content of `generator_version`
    //   - the millisecond resolution of `generated_at`
    //
    // v1-5 contract: the repository's PRIVATE
    // `latestByStoryVersion: Map<story_version_uuid, profile_uuid>`
    // is moved on every NEW insert (and ONLY on new inserts;
    // idempotent re-inserts do not move it). The canonical
    // `profile_uuid` of the most-recently-inserted row for the
    // `story_version_uuid` is the active row. The map is private
    // (no public API exposes it); we observe the contract through
    // `findActiveByStoryVersion` / `getCommunityProfile`.
    //
    // v1-5 explicitly REMOVES `insert_seq` from the row surface so
    // the canonical 13-field schema is preserved. This test asserts
    // the row carries NO `insert_seq` field.
    //
    // Fixture: same story_uuid + story_version_uuid + checksum +
    // generated_at; different generator_version so the two rows
    // occupy different `activeByStoryVersion` slots and are NOT
    // collapsed by the existing same-content-hash idempotency path.
    const { repository } = createSeededRepository();
    const profileRepo = createInMemoryCommunityProfileRepository();
    seedCommunityProfiles(repository, profileRepo);
    const { story_uuid, story_version_uuid } = FIXTURE_UUIDS['cafe-rain'];
    const story_version_checksum = _seedChecksum(profileRepo, story_version_uuid);

    const fixed_ts = '2026-09-07T00:00:00.000Z';
    const row_a = _buildInsertSeqFixtureRow({
      story_uuid,
      story_version_uuid,
      story_version_checksum,
      generator_version: 'community-profile@community-profile-rules/v1-5-a',
      generated_at: fixed_ts,
      content_marker: 'v1-5-A',
    });
    const row_b = _buildInsertSeqFixtureRow({
      story_uuid,
      story_version_uuid,
      story_version_checksum,
      generator_version: 'community-profile@community-profile-rules/v1-5-b',
      generated_at: fixed_ts,
      content_marker: 'v1-5-B',
    });

    // Insert row A FIRST. Assert it is the active row at this point.
    const stored_a = setCommunityProfile({ profileRepository: profileRepo, profile: row_a });
    const active_after_a = getCommunityProfile({ profileRepository: profileRepo, story_version_uuid });
    assert.equal(active_after_a.profile_uuid, stored_a.profile_uuid,
      'after inserting row A, row A must be the active row');
    // v1-5 schema invariant: NO `insert_seq` on the row surface.
    assert.equal(Object.prototype.hasOwnProperty.call(stored_a, 'insert_seq'), false,
      'row A must NOT carry `insert_seq` (canonical 13-field schema)');
    assert.equal(Object.keys(stored_a).length, 13,
      `row A must carry exactly the 13 canonical fields; got ${Object.keys(stored_a).length}`);

    // Insert row B with the SAME `generated_at` millisecond.
    // Assert row B is now the active row, even though the
    // millisecond is shared.
    const stored_b = setCommunityProfile({ profileRepository: profileRepo, profile: row_b });
    assert.equal(stored_b.generated_at, stored_a.generated_at,
      'row B and row A must share the same generated_at millisecond for this fixture to exercise the bug');
    assert.equal(Object.prototype.hasOwnProperty.call(stored_b, 'insert_seq'), false,
      'row B must NOT carry `insert_seq` (canonical 13-field schema)');
    assert.equal(Object.keys(stored_b).length, 13,
      `row B must carry exactly the 13 canonical fields; got ${Object.keys(stored_b).length}`);

    const active_after_b = getCommunityProfile({ profileRepository: profileRepo, story_version_uuid });
    assert.equal(active_after_b.profile_uuid, stored_b.profile_uuid,
      'after inserting row B (same timestamp), row B must be the active row \u2014 second new insert wins (P1.v1-5)');
    assert.notEqual(active_after_b.profile_uuid, stored_a.profile_uuid,
      'row A must NOT remain the active row after row B is inserted');
  });

  await check('idempotent findOrCreate against the existing active row does NOT move the active pointer (P1.v1-5)', () => {
    // P1.v1-5 invariant: when a caller re-invokes
    // `setCommunityProfile` with a payload that the idempotency
    // contract recognises as identical to the existing active row
    // (same content_hash), the repository MUST return the existing
    // row AS-IS and MUST NOT move the PRIVATE
    // `latestByStoryVersion` pointer. If the pointer were moved on
    // every retry, the "second-new-insert-wins" guarantee would be
    // undone by any caller that retries `findOrCreate` against the
    // already-active row.
    //
    // v1-5 schema invariant: rows carry NO `insert_seq` field. We
    // assert the active-pointer semantics by reading the active row
    // through the public `findActiveByStoryVersion` API.
    const profileRepo = createInMemoryCommunityProfileRepository();
    const { story_uuid, story_version_uuid } = FIXTURE_UUIDS['cafe-rain'];
    const story_version_checksum =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const fixed_ts = '2026-09-07T00:00:00.000Z';
    const row_a = _buildInsertSeqFixtureRow({
      story_uuid,
      story_version_uuid,
      story_version_checksum,
      generator_version: 'community-profile@community-profile-rules/idemp',
      generated_at: fixed_ts,
      content_marker: 'idemp-A',
    });
    const stored_first = setCommunityProfile({ profileRepository: profileRepo, profile: row_a });
    assert.equal(Object.prototype.hasOwnProperty.call(stored_first, 'insert_seq'), false,
      'stored_first must NOT carry `insert_seq` (canonical 13-field schema)');
    const active_after_first = profileRepo.findActiveByStoryVersion(story_version_uuid);
    assert.ok(active_after_first, 'active row must resolve after first insert');
    const active_uuid_after_first = active_after_first.profile_uuid;
    assert.equal(active_uuid_after_first, stored_first.profile_uuid,
      'after first insert, the active row must be stored_first');

    // Idempotent retry with the SAME payload. The repository
    // recognises this as an idempotency hit (same
    // story_version_uuid + generator_version + content_hash) and
    // returns the existing row without moving the latest pointer.
    const stored_second = setCommunityProfile({ profileRepository: profileRepo, profile: row_a });
    assert.equal(stored_second.profile_uuid, stored_first.profile_uuid,
      'idempotent hit must return the SAME profile_uuid');
    assert.equal(Object.prototype.hasOwnProperty.call(stored_second, 'insert_seq'), false,
      'stored_second must NOT carry `insert_seq` (canonical 13-field schema)');

    // Critical: the active pointer MUST still point at stored_first
    // after the idempotent retry. The second invocation was a
    // no-op for active selection.
    const active_after_retry = profileRepo.findActiveByStoryVersion(story_version_uuid);
    assert.equal(active_after_retry.profile_uuid, active_uuid_after_first,
      'idempotent hit MUST NOT move the active pointer; it must remain on stored_first');
    assert.equal(active_after_retry.profile_uuid, stored_first.profile_uuid,
      'active row must still be stored_first after the idempotent retry');

    // Now insert a fresh row under a DIFFERENT generator_version so
    // it does NOT collapse on the existing active row's idempotency
    // path. The new row's `profile_uuid` MUST become the active
    // row (the private latest pointer moves).
    const row_b = _buildInsertSeqFixtureRow({
      story_uuid,
      story_version_uuid,
      story_version_checksum,
      generator_version: 'community-profile@community-profile-rules/idemp-next',
      generated_at: fixed_ts,
      content_marker: 'idemp-B',
    });
    const stored_third = setCommunityProfile({ profileRepository: profileRepo, profile: row_b });
    assert.equal(Object.prototype.hasOwnProperty.call(stored_third, 'insert_seq'), false,
      'stored_third must NOT carry `insert_seq` (canonical 13-field schema)');
    const active_after_third = profileRepo.findActiveByStoryVersion(story_version_uuid);
    assert.equal(active_after_third.profile_uuid, stored_third.profile_uuid,
      'fresh insert MUST move the active pointer to stored_third; idempotent retry MUST NOT have moved it');
    assert.notEqual(active_after_third.profile_uuid, stored_first.profile_uuid,
      'stored_first must NOT remain the active row after a fresh insert under a different generator_version');
  });

  await check('repeat-run stability: same-timestamp active row is identical across 5 consecutive iterations (P1.v1-5)', () => {
    // code review independently re-ran `communityProfile.test`
    // consecutively and found that v1-3 still flakes on the second
    // consecutive run. v1-4 must NOT flake.
    //
    // The harness runs the same fixture in a fresh profileRepo 5
    // times in the SAME process and asserts the active row's
    // `generator_version` content marker is identical every time.
    // UUID v4 is freshly minted per row in each iteration, so a
    // UUID-based tie-break would produce DIFFERENT active rows on
    // different iterations. `insert_seq` does not depend on UUID
    // randomness and must produce the SAME insertion order every
    // iteration, so the active row's content marker is stable.
    const iterationCount = 5;
    const activeGeneratorVersions = [];
    for (let iter = 0; iter < iterationCount; iter += 1) {
      const { repository } = createSeededRepository();
      const profileRepo = createInMemoryCommunityProfileRepository();
      seedCommunityProfiles(repository, profileRepo);
      const { story_uuid, story_version_uuid } = FIXTURE_UUIDS['cafe-rain'];
      const story_version_checksum = _seedChecksum(profileRepo, story_version_uuid);
      const fixed_ts = '2026-09-07T03:00:00.000Z';
      const row_a = _buildInsertSeqFixtureRow({
        story_uuid,
        story_version_uuid,
        story_version_checksum,
        generator_version: `community-profile@community-profile-rules/stab-${iter}-a`,
        generated_at: fixed_ts,
        content_marker: `v1-4-stab-A-${iter}`,
      });
      const row_b = _buildInsertSeqFixtureRow({
        story_uuid,
        story_version_uuid,
        story_version_checksum,
        generator_version: `community-profile@community-profile-rules/stab-${iter}-b`,
        generated_at: fixed_ts,
        content_marker: `v1-4-stab-B-${iter}`,
      });
      setCommunityProfile({ profileRepository: profileRepo, profile: row_a });
      setCommunityProfile({ profileRepository: profileRepo, profile: row_b });
      const active = getCommunityProfile({ profileRepository: profileRepo, story_version_uuid });
      assert.ok(active, 'active row must resolve');
      // The active row must always be the second-inserted row by
      // content marker (suffix `-b`).
      assert.ok(active.generator_version.endsWith(`-${iter}-b`),
        `iteration ${iter}: active row must be the second-inserted row; got generator_version='${active.generator_version}'`);
      activeGeneratorVersions.push(active.generator_version);
    }
    // Every iteration's active row must end with `-b`. This is the
    // deterministic, repeatable contract.
    for (let i = 0; i < activeGeneratorVersions.length; i += 1) {
      assert.ok(activeGeneratorVersions[i].endsWith(`-${i}-b`),
        `iteration ${i} active row must end with -${i}-b; got ${activeGeneratorVersions[i]}`);
    }
  });

  await check('ensureCommunityProfile throws on unknown story_version', () => {
    const { repository } = createSeededRepository();
    const profileRepo = createInMemoryCommunityProfileRepository();
    let threw = false;
    try {
      ensureCommunityProfile({
        repository,
        profileRepository: profileRepo,
        story_version_uuid: uuidv4(),
        story: MOCK_DETAILS_FOR_COMMUNITY['cafe-rain'],
        options: { source: 'mock-fixture', seed: getCommunityFixtureSeed('cafe-rain') },
      });
    } catch (err) {
      threw = true;
      assert.match(String(err && err.message), /unknown story_version/);
    }
    assert.ok(threw, 'must throw on unknown story_version');
  });
}

runChecks().then(
  () => {
    if (failures > 0) {
      console.log(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log('\nAll community-profile checks passed.');
  },
  (err) => {
    console.log('\ncommunity-profile checks crashed:');
    console.log(err && err.stack ? err.stack : err);
    process.exit(1);
  },
);
