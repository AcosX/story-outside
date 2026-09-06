// tests/clickup16-1-integration.test.mjs
//
// ClickUp 16.1 P1.1 + P1.2 + P2 integration tests (2026-09-06).
// These are the regression tests for the three review findings
// ChatGPT raised in the 2026-09-06 code review of PR #11.
//
//   P1.1: `importStoryAndEnsureCache` must auto-ensure a community
//          profile when the caller supplies a profileRepository —
//          real-provider imports are no longer profile-less.
//   P1.2: `assertCommunityProfileShape` must reject unknown keys at
//          any depth (exact allowlist per record), so session-derived
//          dimensions (e.g. `topics[0].private_context`) cannot leak
//          into a shared community profile.
//   P2:    `buildStubCommunityProfile` must honour the caller's
//          `options.source` (defaulting to 'mock-generated' only when
//          the caller explicitly leaves it out). A real-provider
//          import surfaces as `source: 'real-generated'`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';

import { createSeededRepository } from '../src/stories/fixture.mjs';
import { createInMemoryStoryRepository } from '../src/stories/repository.mjs';
import { createMockStoryProvider } from '../src/providers/mockProvider.mjs';
import { importStoryAndEnsureCache, importStory } from '../src/stories/storyService.mjs';
import {
  createInMemoryCommunityProfileRepository,
} from '../src/community/repository.mjs';
import {
  ensureCommunityProfile,
  getCommunityProfile,
} from '../src/community/service.mjs';
import {
  assertCommunityProfileShape,
  buildStubCommunityProfile,
  buildCommunityProfileFromSeed,
} from '../src/community/profile.mjs';

function makeRepositoryAndProfileRepo() {
  const repository = createInMemoryStoryRepository();
  const profileRepository = createInMemoryCommunityProfileRepository();
  return { repository, profileRepository };
}

// ClickUp 16.1 tests pass a real UUID-shaped `story_uuid` because
// StoryRepository.upsertStory requires it (the real-provider path
// auto-generates one; the mock fixture happens to expose slugs that
// already have a valid UUID in the catalog).
const CAFE_RAIN_STORY_UUID = '00000000-0000-4000-8000-000000000001';

async function importCafeRainFirstTime(repository, profileRepository) {
  // Step 1: do a baseline import so the repository has a
  // story_version for cafe-rain (otherwise upsertStory refuses to
  // register a slug that is already in the mockProvider catalog
  // with a different story_uuid). Step 2: now `importStoryAndEnsureCache`
  // can be re-run on the same slug+story_uuid to exercise the
  // P1.1 auto-ensure path on a non-first import.
  const provider = createMockStoryProvider();
  await importStoryAndEnsureCache({
    repository,
    provider,
    slug: 'cafe-rain',
    story_uuid: CAFE_RAIN_STORY_UUID,
    profileRepository,
  });
  const stories = repository.listStories();
  const cafe = stories.find((s) => s.slug === 'cafe-rain');
  if (!cafe) throw new Error('fixture must contain cafe-rain after import');
  return repository.listVersionsByStory(cafe.story_uuid)[0];
}

test('P1.1: importStoryAndEnsureCache with profileRepository auto-ensures a profile', async () => {
  const { repository, profileRepository } = makeRepositoryAndProfileRepo();
  const provider = createMockStoryProvider();

  // Wire the new optional arg; no curated seed, so the stub path runs.
  await importStoryAndEnsureCache({
    repository,
    provider,
    slug: 'cafe-rain',
    story_uuid: CAFE_RAIN_STORY_UUID,
    profileRepository,
  });

  const stories = repository.listStories();
  const cafe = stories.find((s) => s.slug === 'cafe-rain');
  assert.ok(cafe, 'fixture must contain cafe-rain after import');
  const version = repository.listVersionsByStory(cafe.story_uuid)[0];
  const profile = profileRepository.findActiveByStoryVersion(version.version_uuid);
  assert.ok(profile, 'a profile must exist for the imported story_version');
  assert.equal(
    profile.story_version_uuid,
    version.version_uuid,
    'profile must be tied to the imported story_version',
  );
  // P2 contract: the default P1.1 path must NOT silently rewrite an
  // existing profile to a different source. (Real-provider switch is
  // ClickUp 16.7+.)
  assert.equal(profile.source, 'mock-generated');
});

test('P1.1: importStoryAndEnsureCache without profileRepository is unchanged (silent no-op)', async () => {
  const { repository } = makeRepositoryAndProfileRepo();
  const provider = createMockStoryProvider();
  // No profileRepository → import path stays legacy; no profile created
  // by the storyService layer. (seedCommunityProfiles from importHook
  // would be a separate, explicit call.)
  const result = await importStoryAndEnsureCache({
    repository,
    provider,
    slug: 'cafe-rain',
    story_uuid: CAFE_RAIN_STORY_UUID,
  });
  assert.ok(result.opening_cache_uuid, 'opening cache must still be created');
});

test('P1.2: assertCommunityProfileShape rejects unknown top-level keys', async () => {
  const { repository, profileRepository } = makeRepositoryAndProfileRepo();
  const version = await importCafeRainFirstTime(repository, profileRepository);
  // Build a valid profile first so we can mutate it.
  const profile = ensureCommunityProfile({
    repository,
    profileRepository,
    story_version_uuid: version.version_uuid,
    story: { id: 'cafe-rain', title: 'Cafe Rain', hook: 'A cafe in the rain' },
    options: { source: 'mock-generated' },
  });
  const tampered = { ...profile, private_session_blob: 'session-derived' };
  assert.throws(
    () => assertCommunityProfileShape(tampered),
    /unknown key at \$/,
  );
});

test('P1.2: assertCommunityProfileShape rejects unknown nested keys (e.g. topics[0].private_context)', async () => {
  const { repository, profileRepository } = makeRepositoryAndProfileRepo();
  const version = await importCafeRainFirstTime(repository, profileRepository);
  const profile = ensureCommunityProfile({
    repository,
    profileRepository,
    story_version_uuid: version.version_uuid,
    story: { id: 'cafe-rain', title: 'Cafe Rain', hook: 'A cafe in the rain' },
    options: { source: 'mock-generated' },
  });
  const tampered = {
    ...profile,
    topics: [
      { ...profile.topics[0], private_context: { account_hint: 'session-derived' } },
      ...profile.topics.slice(1),
    ],
  };
  assert.throws(
    () => assertCommunityProfileShape(tampered),
    /unknown key at topics\[0\]/,
  );
});

test('P1.2: assertCommunityProfileShape rejects unknown nested keys on hash', async () => {
  const { repository, profileRepository } = makeRepositoryAndProfileRepo();
  const version = await importCafeRainFirstTime(repository, profileRepository);
  const profile = ensureCommunityProfile({
    repository,
    profileRepository,
    story_version_uuid: version.version_uuid,
    story: { id: 'cafe-rain', title: 'Cafe Rain', hook: 'A cafe in the rain' },
    options: { source: 'mock-generated' },
  });
  const tampered = { ...profile, hash: { ...profile.hash, session_signature: 'x' } };
  assert.throws(
    () => assertCommunityProfileShape(tampered),
    /unknown key at hash/,
  );
});

test('P1.2: assertCommunityProfileShape rejects unknown source', async () => {
  const { repository, profileRepository } = makeRepositoryAndProfileRepo();
  const version = await importCafeRainFirstTime(repository, profileRepository);
  const profile = ensureCommunityProfile({
    repository,
    profileRepository,
    story_version_uuid: version.version_uuid,
    story: { id: 'cafe-rain', title: 'Cafe Rain', hook: 'A cafe in the rain' },
    options: { source: 'mock-generated' },
  });
  const tampered = { ...profile, source: 'session-leaked' };
  assert.throws(
    () => assertCommunityProfileShape(tampered),
    /source 'session-leaked' is not in PROFILE_SOURCES/,
  );
});

test('P1.2: assertCommunityProfileShape accepts the well-known shape (no regression)', async () => {
  const { repository, profileRepository } = makeRepositoryAndProfileRepo();
  const version = await importCafeRainFirstTime(repository, profileRepository);
  const profile = ensureCommunityProfile({
    repository,
    profileRepository,
    story_version_uuid: version.version_uuid,
    story: { id: 'cafe-rain', title: 'Cafe Rain', hook: 'A cafe in the rain' },
    options: { source: 'mock-generated' },
  });
  // Must not throw.
  const validated = assertCommunityProfileShape(profile);
  assert.equal(validated.profile_uuid, profile.profile_uuid);
});

test('P2: buildStubCommunityProfile honours caller-supplied source', () => {
  const story = { id: 't', title: 'T', hook: 'h' };
  const profile = buildStubCommunityProfile({
    story_uuid: randomUUID(),
    story_version_uuid: randomUUID(),
    story_version_checksum: 'sha256:test',
    story,
    source: 'real-generated',
  });
  assert.equal(profile.source, 'real-generated');
});

test('P2: buildStubCommunityProfile defaults to mock-generated when no source', () => {
  const story = { id: 't', title: 'T', hook: 'h' };
  const profile = buildStubCommunityProfile({
    story_uuid: randomUUID(),
    story_version_uuid: randomUUID(),
    story_version_checksum: 'sha256:test',
    story,
  });
  assert.equal(profile.source, 'mock-generated');
});

test('P2: buildStubCommunityProfile rejects unknown source', () => {
  const story = { id: 't', title: 'T', hook: 'h' };
  assert.throws(
    () => buildStubCommunityProfile({
      story_uuid: randomUUID(),
      story_version_uuid: randomUUID(),
      story_version_checksum: 'sha256:test',
      story,
      source: 'forged-source',
    }),
    /source 'forged-source' is not in PROFILE_SOURCES/,
  );
});

test('P2: ensureCommunityProfile stub path propagates options.source to the profile', async () => {
  // Use a brand-new repo pair so no prior import has populated the
  // profile — the idempotent return would otherwise short-circuit
  // before the new source is honoured.
  const { repository, profileRepository } = makeRepositoryAndProfileRepo();
  // Pre-create the story_version in the repository so
  // ensureCommunityProfile can find it, but DO NOT call
  // ensureCommunityProfile (so no profile is yet on disk).
  const provider = createMockStoryProvider();
  await importStoryAndEnsureCache({
    repository,
    provider,
    slug: 'cafe-rain',
    story_uuid: CAFE_RAIN_STORY_UUID,
    // Intentionally no profileRepository here — we want to test the
    // service-layer P2 contract in isolation from the P1.1 hook.
  });
  const stories = repository.listStories();
  const cafe = stories.find((s) => s.slug === 'cafe-rain');
  const version = repository.listVersionsByStory(cafe.story_uuid)[0];
  const story = { id: 'cafe-rain', title: 'Cafe Rain', hook: 'A cafe in the rain' };
  const profile = ensureCommunityProfile({
    repository,
    profileRepository,
    story_version_uuid: version.version_uuid,
    story,
    options: { source: 'real-generated' },
  });
  assert.equal(profile.source, 'real-generated');
});

test('P1.1 + P2 together: importStoryAndEnsureCache with profileRepository produces a mock-generated profile (default)', async () => {
  const { repository, profileRepository } = makeRepositoryAndProfileRepo();
  const version = await importCafeRainFirstTime(repository, profileRepository);
  // No `profileOptions` is supplied → the hook falls back to the
  // historical default `source: 'mock-generated'`. This preserves
  // backwards compatibility for callers that have not been migrated
  // to the new wiring (admin/dev import routes in server.mjs).
  const profile = getCommunityProfile({
    profileRepository,
    story_version_uuid: version.version_uuid,
  });
  assert.ok(profile, 'profile must be readable after import');
  assert.equal(
    profile.source,
    'mock-generated',
    `profile.source must be the historical default when caller omits profileOptions (got '${profile.source}')`,
  );
});

test('P1.1 + P2 wiring: importStoryAndEnsureCache honours profileOptions.source (real-generated)', async () => {
  // ClickUp 16.1 server.mjs wiring fix (2026-09-06): when the caller
  // passes `profileOptions: { source: 'real-generated' }`, the
  // freshly built profile must be tagged with that provenance instead
  // of being silently downgraded to `mock-generated`.
  const { repository, profileRepository } = makeRepositoryAndProfileRepo();
  const provider = createMockStoryProvider();
  const ensured = await importStoryAndEnsureCache({
    repository,
    provider,
    slug: 'cafe-rain',
    story_uuid: CAFE_RAIN_STORY_UUID,
    profileRepository,
    profileOptions: { source: 'real-generated' },
  });
  const profile = getCommunityProfile({
    profileRepository,
    story_version_uuid: ensured.story_version_uuid,
  });
  assert.ok(profile, 'profile must be readable after import');
  assert.equal(
    profile.source,
    'real-generated',
    `profile.source must follow profileOptions.source (got '${profile.source}')`,
  );
});

test('P1.1 + P2 wiring: importStoryAndEnsureCache rejects unknown profileOptions.source', async () => {
  const { repository, profileRepository } = makeRepositoryAndProfileRepo();
  const provider = createMockStoryProvider();
  await assert.rejects(
    () => importStoryAndEnsureCache({
      repository,
      provider,
      slug: 'cafe-rain',
      story_uuid: CAFE_RAIN_STORY_UUID,
      profileRepository,
      profileOptions: { source: 'forged-source' },
    }),
    /source 'forged-source' is not in PROFILE_SOURCES/,
    'unknown source must be rejected at the seam',
  );
});
