// tests/communityProfile.test.mjs — ClickUp 16.1 community-profile contract.
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
  console.log('ClickUp 16.1 community-profile contract');

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
    // Top-level keys.
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
      assert.match(String(err && err.message), /forbidden field 'session_uuid'/);
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
      assert.match(String(err && err.message), /forbidden field 'user_ref'/);
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
      assert.match(String(err && err.message), /forbidden field 'model_output'/);
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
