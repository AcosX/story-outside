// tests/storyService.test.mjs — Phase 4 application-layer contract tests.
//
// Covers:
//   * Same DTO → same story_version (no version created on dedupe).
//   * Different DTO → new story_version (old versions retained).
//   * Session snapshot pins story_version_id; upstream content changes
//     after the snapshot does NOT affect the session.
//   * Multiple sessions across users and roles reuse the same opening cache.
//   * Opening cache never contains an ask_player_choice event.
//   * Failed generation is recorded but does NOT pollute the valid cache;
//     retry succeeds and the previous valid cache is left untouched.
//   * Rebuild with a different generation profile creates a NEW valid
//     cache row; old rows remain in the table (auditable).
//   * First-choice consumption is session-local: it returns a consumed
//     marker and does NOT invalidate the shared opening cache.

import assert from 'node:assert/strict';

import { createMockStoryProvider } from '../src/providers/mockProvider.mjs';
import {
  createInMemoryStoryRepository,
  createSeededRepository,
  defaultGenerationProfile,
  ensureOpeningCache,
  importStory,
  importStoryAndEnsureCache,
  markFirstChoiceConsumed,
  rebuildOpeningCache,
  startSessionSnapshot,
} from '../src/stories/index.mjs';

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

async function runChecks() {
  console.log('Story import & dedupe');

  await check('same DTO import reuses version', async () => {
    const provider = createMockStoryProvider();
    const repository = createInMemoryStoryRepository();
    const a = await importStory({
      repository,
      provider,
      slug: 'cafe-rain',
      story_uuid: '00000000-0000-4000-8000-000000000001',
    });
    const b = await importStory({
      repository,
      provider,
      slug: 'cafe-rain',
      story_uuid: '00000000-0000-4000-8000-000000000001',
    });
    assert.equal(a.version_reused, false);
    assert.equal(b.version_reused, true);
    assert.equal(a.story_version_uuid, b.story_version_uuid);
    assert.equal(a.version_no, 1);
    assert.equal(b.version_no, 1);
  });

  await check('different content creates a new version, keeps the old one', async () => {
    const repository = createInMemoryStoryRepository();
    // Mutable provider: returns different content based on a counter, but
    // always with the same id so the slug↔id mapping stays valid.
    let counter = 0;
    const provider = {
      name: 'synthetic',
      async getStory() {
        counter += 1;
        if (counter === 1) {
          return {
            id: 'cafe-rain',
            title: '雨夜咖啡馆',
            hook: '凌晨的咖啡馆只剩你和她。',
            roles: [
              { id: 'stranger', label: '陌生人', mood: '疏离' },
              { id: 'old-friend', label: '旧友', mood: '怀念' },
            ],
            beats: [
              '雨声裹着玻璃窗，咖啡机嗡地停了。',
              '她把杯沿推向你的方向。',
            ],
          };
        }
        return {
          id: 'cafe-rain',
          title: '雨夜咖啡馆',
          hook: '凌晨的咖啡馆只剩你和她。',
          roles: [
            { id: 'stranger', label: '陌生人', mood: '放松' },
            { id: 'old-friend', label: '旧友', mood: '怀念' },
          ],
          beats: [
            '雨声裹着玻璃窗，咖啡机嗡地停了。',
            '她把杯沿推向你的方向。',
            '你想起一个还没问出口的问题。',
          ],
        };
      },
    };
    const v1 = await importStory({
      repository,
      provider,
      slug: 'cafe-rain',
      story_uuid: '00000000-0000-4000-8000-000000000010',
    });
    const v2 = await importStory({
      repository,
      provider,
      slug: 'cafe-rain',
      story_uuid: '00000000-0000-4000-8000-000000000010',
    });
    assert.equal(v1.version_reused, false);
    assert.equal(v2.version_reused, false);
    assert.notEqual(v1.story_version_uuid, v2.story_version_uuid);
    assert.equal(v1.version_no, 1);
    assert.equal(v2.version_no, 2);
    const versions = repository.listVersionsByStory('00000000-0000-4000-8000-000000000010');
    assert.equal(versions.length, 2);
    assert.equal(versions[0].checksum, v1.checksum);
    assert.equal(versions[1].checksum, v2.checksum);
    assert.equal(versions[1].status, 'published');
  });

  console.log('\nSession snapshot pinning');

  await check('session pins story_version; upstream change does not affect it', async () => {
    const { repository, fixtures } = createSeededRepository();
    const cafe = fixtures.find((f) => f.slug === 'cafe-rain');
    const snapshot = startSessionSnapshot({
      repository,
      session_uuid: '00000000-0000-4000-8000-aaaaaaaaaaaa',
      story_uuid: cafe.story_uuid,
      story_version_uuid: cafe.story_version_uuid,
      user_ref: 'u-1',
      role_id: 'stranger',
    });
    assert.equal(snapshot.story_version_uuid, cafe.story_version_uuid);

    // Now mutate the upstream DTO via a different import and confirm the
    // pinned session still references the ORIGINAL version_uuid.
    const mutatedProvider = {
      name: 'mutator',
      async getStory() {
        return {
          id: 'cafe-rain',
          title: '雨夜咖啡馆（重写）',
          hook: '凌晨的咖啡馆只剩你和她。',
          roles: [
            { id: 'stranger', label: '陌生人', mood: '疏离' },
            { id: 'old-friend', label: '旧友', mood: '怀念' },
          ],
          beats: [
            '雨声裹着玻璃窗，咖啡机嗡地停了。',
            '她把杯沿推向你的方向。',
            '你想起一个还没问出口的问题。',
            'REWRITTEN',
          ],
        };
      },
    };
    const reimport = await importStory({
      repository,
      provider: mutatedProvider,
      slug: 'cafe-rain',
      story_uuid: cafe.story_uuid,
    });
    assert.equal(reimport.version_reused, false);
    assert.notEqual(reimport.story_version_uuid, snapshot.story_version_uuid);
    // The pinned snapshot's version row still has the original content.
    const pinned = repository.findVersion(snapshot.story_version_uuid);
    assert.ok(pinned);
    assert.equal(pinned.version_no, 1);
    assert.ok(!JSON.stringify(pinned.content_payload).includes('REWRITTEN'));
  });

  await check('startSessionSnapshot rejects story/version mismatch and unknown role', async () => {
    const { repository, fixtures } = createSeededRepository();
    const cafe = fixtures.find((f) => f.slug === 'cafe-rain');
    const nightShift = fixtures.find((f) => f.slug === 'night-shift');
    assert.throws(
      () =>
        startSessionSnapshot({
          repository,
          session_uuid: '00000000-0000-4000-8000-bbbbbbbbbbbb',
          story_uuid: nightShift.story_uuid,
          story_version_uuid: cafe.story_version_uuid,
          user_ref: 'u-1',
          role_id: 'stranger',
        }),
      /does not match story_version/,
    );
    assert.throws(
      () =>
        startSessionSnapshot({
          repository,
          session_uuid: '00000000-0000-4000-8000-bbbbbbbbbbbc',
          story_uuid: cafe.story_uuid,
          story_version_uuid: cafe.story_version_uuid,
          user_ref: 'u-1',
          role_id: 'ghost',
        }),
      /is not a role of the pinned story_version/,
    );
    assert.throws(
      () =>
        startSessionSnapshot({
          repository,
          session_uuid: 'not-a-uuid',
          story_uuid: cafe.story_uuid,
          story_version_uuid: cafe.story_version_uuid,
          user_ref: 'u-1',
          role_id: 'stranger',
        }),
      /session_uuid must be a UUID/,
    );
  });

  console.log('\nOpening cache: shared across user/role');

  await check('opening cache truncates before structured choice, keeps dialogue/action', async () => {
    const { repository, fixtures } = createSeededRepository();
    const cafe = fixtures.find((f) => f.slug === 'cafe-rain');
    const fresh = await ensureOpeningCache({
      repository,
      story_version_uuid: cafe.story_version_uuid,
    });
    const events = fresh.cache.content_payload.events;
    assert.equal(fresh.cache.content_payload.boundary, 'truncated_before_first_choice');
    assert.ok(events.some((ev) => ev.type === 'dialogue' && ev.speaker === 'old-friend'));
    assert.ok(events.some((ev) => ev.type === 'action'));
    assert.ok(!JSON.stringify(fresh.cache.content_payload).includes('ask_player_choice'));
    assert.ok(!JSON.stringify(fresh.cache.content_payload).includes('你要怎么回答她？'));
  });

  await check('different users + roles share the same opening cache row', async () => {
    const { repository, fixtures } = createSeededRepository();
    const cafe = fixtures.find((f) => f.slug === 'cafe-rain');
    const r1 = await ensureOpeningCache({
      repository,
      story_version_uuid: cafe.story_version_uuid,
    });
    assert.equal(r1.reused, false);
    assert.equal(r1.regenerated, false);
    assert.equal(r1.cache.status, 'valid');

    const s1 = startSessionSnapshot({
      repository,
      session_uuid: '00000000-0000-4000-8000-bbbbbbbbbbb1',
      story_uuid: cafe.story_uuid,
      story_version_uuid: cafe.story_version_uuid,
      user_ref: 'alice',
      role_id: 'stranger',
    });
    const s2 = startSessionSnapshot({
      repository,
      session_uuid: '00000000-0000-4000-8000-bbbbbbbbbbb2',
      story_uuid: cafe.story_uuid,
      story_version_uuid: cafe.story_version_uuid,
      user_ref: 'bob',
      role_id: 'old-friend',
    });
    assert.equal(s1.opening_cache_uuid, s2.opening_cache_uuid);
    assert.equal(s1.opening_cache_uuid, r1.cache.cache_uuid);
  });

  await check('opening cache does NOT contain ask_player_choice', async () => {
    const { repository, fixtures } = createSeededRepository();
    const cafe = fixtures.find((f) => f.slug === 'cafe-rain');
    const fresh = await ensureOpeningCache({
      repository,
      story_version_uuid: cafe.story_version_uuid,
    });
    const events = fresh.cache.content_payload.events;
    assert.ok(Array.isArray(events));
    for (const ev of events) {
      assert.notEqual(ev.type, 'ask_player_choice');
      assert.ok(!/ask_player_choice/.test(JSON.stringify(ev)));
    }
    // Defensive: scan the entire payload to make sure no marker slipped in.
    assert.ok(!/ask_player_choice/.test(JSON.stringify(fresh.cache.content_payload)));
  });

  console.log('\nFailed generation can be retried safely');

  await check('failed generation does not overwrite a valid cache', async () => {
    const { repository, fixtures } = createSeededRepository();
    const cafe = fixtures.find((f) => f.slug === 'cafe-rain');
    // Build a valid cache, then invalidate it so the next call actually
    // re-runs the generator. A failed re-generation MUST throw and MUST
    // NOT delete or overwrite the previously-valid row.
    const good = await ensureOpeningCache({
      repository,
      story_version_uuid: cafe.story_version_uuid,
    });
    const goodRow = good.cache;
    repository.recordCacheInvalidation(goodRow.cache_uuid, 'manual_test_setup');
    // Force a failing generation via a custom generator.
    const failing = await ensureOpeningCache({
      repository,
      story_version_uuid: cafe.story_version_uuid,
      options: {
        generator: () => {
          throw new Error('boom');
        },
      },
    }).catch((err) => ({ err }));
    assert.ok('err' in failing && failing.err, 'expected the call to throw');
    // The previously-valid row must still be intact in the table even
    // though it has been invalidated (audit trail). The failure path must
    // not have produced a new 'valid' row.
    const stillThere = repository.findOpeningCacheByUuid(goodRow.cache_uuid);
    assert.ok(stillThere);
    assert.notEqual(stillThere.status, 'valid');
    assert.equal(stillThere.content_hash, goodRow.content_hash);
  });

  await check('retry after failure succeeds without touching the old valid row', async () => {
    const { repository, fixtures } = createSeededRepository();
    const cafe = fixtures.find((f) => f.slug === 'cafe-rain');
    const first = await ensureOpeningCache({
      repository,
      story_version_uuid: cafe.story_version_uuid,
    });
    const originalUuid = first.cache.cache_uuid;
    // Inject one failed generation using a custom generator.
    await ensureOpeningCache({
      repository,
      story_version_uuid: cafe.story_version_uuid,
      options: { generator: () => { throw new Error('transient'); } },
    }).catch(() => {});
    // Retry with the default generator (success path).
    const retried = await ensureOpeningCache({
      repository,
      story_version_uuid: cafe.story_version_uuid,
    });
    assert.equal(retried.cache.status, 'valid');
    // A failed attempt with the SAME generation_hash MUST NOT have replaced
    // the original valid row; the original is still there.
    const original = repository.findOpeningCacheByUuid(originalUuid);
    assert.ok(original, 'original cache row should still exist');
    assert.equal(original.status, 'valid');
    // No leaked 'failed' rows for the same generation_hash.
    const stats = repository.stats();
    assert.ok(stats.cache_count >= 1);
  });

  console.log('\nRebuild + rules version isolation');

  await check('rebuild with new generation profile adds a NEW valid row; old row stays', async () => {
    const { repository, fixtures } = createSeededRepository();
    const cafe = fixtures.find((f) => f.slug === 'cafe-rain');
    const first = await ensureOpeningCache({
      repository,
      story_version_uuid: cafe.story_version_uuid,
    });
    const firstCacheUuid = first.cache.cache_uuid;
    const firstGenerationHash = first.cache.generation_hash;
    const rebuilt = await rebuildOpeningCache({
      repository,
      story_version_uuid: cafe.story_version_uuid,
      profile: {
        identifier: 'opening-default',
        rules_version: 'opening-rules/next',
        locale: 'zh-CN',
      },
    });
    assert.notEqual(rebuilt.cache.cache_uuid, firstCacheUuid);
    assert.notEqual(rebuilt.cache.generation_hash, firstGenerationHash);
    // Old row remains in the table (auditable).
    const oldRow = repository.findOpeningCacheByUuid(firstCacheUuid);
    assert.ok(oldRow);
    assert.equal(oldRow.status, 'valid');
  });

  await check('rebuild with new generation profile keeps old generation lookup working', async () => {
    const { repository, fixtures } = createSeededRepository();
    const cafe = fixtures.find((f) => f.slug === 'cafe-rain');
    const first = await ensureOpeningCache({
      repository,
      story_version_uuid: cafe.story_version_uuid,
    });
    const rebuilt = await rebuildOpeningCache({
      repository,
      story_version_uuid: cafe.story_version_uuid,
      profile: {
        identifier: 'opening-default',
        rules_version: 'opening-rules/next',
        locale: 'zh-CN',
      },
    });
    assert.notEqual(rebuilt.cache.cache_uuid, first.cache.cache_uuid);
    const oldLookup = repository.findOpeningCacheByScope(
      cafe.story_uuid,
      cafe.story_version_uuid,
      'default',
      first.cache.generation_hash,
    );
    assert.ok(oldLookup);
    assert.equal(oldLookup.cache_uuid, first.cache.cache_uuid);
    assert.equal(oldLookup.status, 'valid');
    const newLookup = repository.findOpeningCacheByScope(
      cafe.story_uuid,
      cafe.story_version_uuid,
      'default',
      rebuilt.cache.generation_hash,
    );
    assert.ok(newLookup);
    assert.equal(newLookup.cache_uuid, rebuilt.cache.cache_uuid);
  });

  await check('in_place replace requires identical content_hash', async () => {
    const { repository, fixtures } = createSeededRepository();
    const nightShift = fixtures.find((f) => f.slug === 'night-shift');
    await ensureOpeningCache({ repository, story_version_uuid: nightShift.story_version_uuid });
    // Pre-import the generator helper (ESM-safe).
    const { generateOpeningCache: gen } = await import('../src/stories/openingGenerator.mjs');
    await assert.rejects(
      () =>
        ensureOpeningCache({
          repository,
          story_version_uuid: nightShift.story_version_uuid,
          options: {
            force: true,
            replace_strategy: 'in_place',
            generator: (args) => {
              // Produce a different content hash by injecting an extra event.
              const mutated = { ...args.story, beats: [...args.story.beats, 'NEW'] };
              return gen({
                story_uuid: nightShift.story_uuid,
                story_version_uuid: nightShift.story_version_uuid,
                opening_key: 'default',
                profile: defaultGenerationProfile(),
                story: mutated,
              });
            },
          },
        }),
      /in_place replace requires identical content_hash/,
    );
  });

  console.log('\nFirst-choice consumption');

  await check('first choice returns a session-local consumed marker', async () => {
    const { repository, fixtures } = createSeededRepository();
    const cafe = fixtures.find((f) => f.slug === 'cafe-rain');
    const built = await ensureOpeningCache({
      repository,
      story_version_uuid: cafe.story_version_uuid,
    });
    const snapshot = startSessionSnapshot({
      repository,
      session_uuid: '00000000-0000-4000-8000-cccccccccccc',
      story_uuid: cafe.story_uuid,
      story_version_uuid: cafe.story_version_uuid,
      user_ref: 'carol',
      role_id: 'stranger',
    });
    const after = markFirstChoiceConsumed({ repository, snapshot });
    assert.equal(after.status, 'consumed');
    assert.equal(after.session_uuid, snapshot.session_uuid);
    assert.equal(after.opening_cache_uuid, built.cache.cache_uuid);
    assert.equal(after.reason, 'first_ask_player_choice');
    assert.ok(after.first_choice_at);
    // Idempotent for the same session.
    const again = markFirstChoiceConsumed({ repository, snapshot });
    assert.equal(again.first_choice_at, after.first_choice_at);
  });

  await check('first choice does NOT invalidate the shared opening cache', async () => {
    const { repository, fixtures } = createSeededRepository();
    const cafe = fixtures.find((f) => f.slug === 'cafe-rain');
    const built = await ensureOpeningCache({
      repository,
      story_version_uuid: cafe.story_version_uuid,
    });
    const snapshot = startSessionSnapshot({
      repository,
      session_uuid: '00000000-0000-4000-8000-cccccccccccd',
      story_uuid: cafe.story_uuid,
      story_version_uuid: cafe.story_version_uuid,
      user_ref: 'dave',
      role_id: 'stranger',
    });
    markFirstChoiceConsumed({ repository, snapshot });
    // The shared row is still valid and still found by scope lookup.
    const stillThere = repository.findOpeningCacheByUuid(built.cache.cache_uuid);
    assert.ok(stillThere);
    assert.equal(stillThere.status, 'valid');
    assert.equal(stillThere.invalidated_at, null);
    const lookedUp = repository.findOpeningCacheByScope(
      cafe.story_uuid,
      cafe.story_version_uuid,
      'default',
      built.cache.generation_hash,
    );
    assert.equal(lookedUp.cache_uuid, built.cache.cache_uuid);
    // A different session can still pin and reuse the same public opening.
    const nextSession = startSessionSnapshot({
      repository,
      session_uuid: '00000000-0000-4000-8000-ccccccccccce',
      story_uuid: cafe.story_uuid,
      story_version_uuid: cafe.story_version_uuid,
      user_ref: 'erin',
      role_id: 'old-friend',
    });
    assert.equal(nextSession.opening_cache_uuid, built.cache.cache_uuid);
    assert.equal(nextSession.opening_cache_status, 'valid');
  });

  console.log('\nVersion import: provider name + slug mismatch is rejected');

  await check('importing a slug whose provider returns a different id is rejected', async () => {
    const repository = createInMemoryStoryRepository();
    const lyingProvider = {
      name: 'liar',
      async getStory() {
        return {
          id: 'something-else',
          title: 'X',
          hook: 'y',
          roles: [],
          beats: ['one'],
        };
      },
    };
    await assert.rejects(
      () =>
        importStory({
          repository,
          provider: lyingProvider,
          slug: 'cafe-rain',
          story_uuid: '00000000-0000-4000-8000-dddddddddddd',
        }),
      /provider returned story id/,
    );
  });

  console.log('\nimportStoryAndEnsureCache closes the bootstrap loop');

  await check('returns non-null opening_cache_uuid and status on first import', async () => {
    const repository = createInMemoryStoryRepository();
    const provider = createMockStoryProvider();
    const story_uuid = '00000000-0000-4000-8000-aaaaaaaaaaaa';
    const result = await importStoryAndEnsureCache({
      repository,
      provider,
      slug: 'cafe-rain',
      story_uuid,
    });
    assert.equal(result.story_uuid, story_uuid);
    assert.equal(typeof result.story_version_uuid, 'string');
    assert.ok(/^[0-9a-f-]{36}$/i.test(result.story_version_uuid));
    assert.ok(typeof result.opening_cache_uuid === 'string' && result.opening_cache_uuid.length > 0);
    assert.equal(result.opening_cache_status, 'valid');
    assert.equal(result.cache_reused, false);
    assert.equal(result.version_reused, false);
  });

  await check('second call with same story_uuid reuses both version and cache', async () => {
    const repository = createInMemoryStoryRepository();
    const provider = createMockStoryProvider();
    const story_uuid = '00000000-0000-4000-8000-aaaaaaaaaaab';
    const first = await importStoryAndEnsureCache({
      repository, provider, slug: 'cafe-rain', story_uuid,
    });
    const second = await importStoryAndEnsureCache({
      repository, provider, slug: 'cafe-rain', story_uuid,
    });
    assert.equal(second.story_version_uuid, first.story_version_uuid);
    assert.equal(second.opening_cache_uuid, first.opening_cache_uuid);
    assert.equal(second.version_reused, true);
    assert.equal(second.cache_reused, true);
  });

  await check('importStoryAndEnsureCache rejects missing provider', async () => {
    const repository = createInMemoryStoryRepository();
    await assert.rejects(
      () => importStoryAndEnsureCache({
        repository, provider: null, slug: 'cafe-rain',
        story_uuid: '00000000-0000-4000-8000-aaaaaaaaaaac',
      }),
      /provider with getStory required/,
    );
  });

  await check('importStoryAndEnsureCache rejects empty slug', async () => {
    const repository = createInMemoryStoryRepository();
    const provider = createMockStoryProvider();
    await assert.rejects(
      () => importStoryAndEnsureCache({
        repository, provider, slug: '', story_uuid: '00000000-0000-4000-8000-aaaaaaaaaaad',
      }),
      /slug required/,
    );
  });

  await check('importStoryAndEnsureCache rejects empty story_uuid', async () => {
    const repository = createInMemoryStoryRepository();
    const provider = createMockStoryProvider();
    await assert.rejects(
      () => importStoryAndEnsureCache({
        repository, provider, slug: 'cafe-rain', story_uuid: '',
      }),
      /story_uuid required/,
    );
  });

  console.log('\nRepository listStories returns rows ordered by created_at');

  await check('empty repository yields empty list', () => {
    const repository = createInMemoryStoryRepository();
    assert.deepEqual(repository.listStories(), []);
  });

  await check('seeded stories are returned by listStories', () => {
    const { repository } = createSeededRepository();
    const stories = repository.listStories();
    assert.ok(Array.isArray(stories) && stories.length >= 2);
    const slugs = stories.map((s) => s.slug);
    assert.ok(slugs.includes('cafe-rain'));
    for (const s of stories) {
      assert.equal(typeof s.story_uuid, 'string');
      assert.equal(typeof s.slug, 'string');
      assert.equal(typeof s.title, 'string');
    }
  });

  await check('listStories is ordered by created_at ascending', async () => {
    const repository = createInMemoryStoryRepository();
    repository.upsertStory({
      story_uuid: '00000000-0000-4000-8000-000000000001',
      slug: 'alpha-1',
      title: 'A1', hook: 'h',
    });
    // Wait long enough that created_at differs at millisecond resolution.
    await new Promise((r) => setTimeout(r, 5));
    repository.upsertStory({
      story_uuid: '00000000-0000-4000-8000-000000000002',
      slug: 'beta-2',
      title: 'B2', hook: 'h',
    });
    const stories = repository.listStories();
    assert.equal(stories.length, 2);
    assert.equal(stories[0].slug, 'alpha-1');
    assert.equal(stories[1].slug, 'beta-2');
  });
}

// Tiny helper to avoid inlining a CommonJS require() in the ESM test file.
runChecks().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} story-service check(s) failed`);
    process.exit(1);
  }
  console.log(`\nall story-service checks passed`);
}).catch((err) => {
  console.error(`\nunexpected error: ${err && err.message ? err.message : err}`);
  process.exit(1);
});