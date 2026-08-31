// tests/cacheKey.test.mjs — opening cache key derivation contract:
// user/role/session identifiers MUST NEVER participate in the cache key.

import assert from 'node:assert/strict';

import {
  _forbiddenCacheKeyDimensions,
  deriveOpeningCacheKey,
} from '../src/stories/cacheKey.mjs';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`    ${err && err.message ? err.message : err}`);
  }
}

const PROFILE = {
  identifier: 'opening-default',
  rules_version: 'opening-rules/1',
  locale: 'zh-CN',
  variant: 'default',
};

console.log('Cache key derivation');

check('key is 64-char hex', () => {
  const k = deriveOpeningCacheKey({
    story_uuid: 's-1',
    story_version_uuid: 'v-1',
    profile: PROFILE,
  });
  assert.equal(k.length, 64);
  assert.match(k, /^[0-9a-f]{64}$/);
});

check('same scope + profile → same key', () => {
  const a = deriveOpeningCacheKey({
    story_uuid: 's-1',
    story_version_uuid: 'v-1',
    profile: PROFILE,
  });
  const b = deriveOpeningCacheKey({
    story_uuid: 's-1',
    story_version_uuid: 'v-1',
    profile: PROFILE,
  });
  assert.equal(a, b);
});

check('different story_version_uuid → different key', () => {
  const a = deriveOpeningCacheKey({
    story_uuid: 's-1',
    story_version_uuid: 'v-1',
    profile: PROFILE,
  });
  const b = deriveOpeningCacheKey({
    story_uuid: 's-1',
    story_version_uuid: 'v-2',
    profile: PROFILE,
  });
  assert.notEqual(a, b);
});

check('different rules_version → different key', () => {
  const a = deriveOpeningCacheKey({
    story_uuid: 's-1',
    story_version_uuid: 'v-1',
    profile: { ...PROFILE, rules_version: 'opening-rules/1' },
  });
  const b = deriveOpeningCacheKey({
    story_uuid: 's-1',
    story_version_uuid: 'v-1',
    profile: { ...PROFILE, rules_version: 'opening-rules/2' },
  });
  assert.notEqual(a, b);
});

check('different identifier → different key', () => {
  const a = deriveOpeningCacheKey({
    story_uuid: 's-1',
    story_version_uuid: 'v-1',
    profile: { ...PROFILE, identifier: 'opening-default' },
  });
  const b = deriveOpeningCacheKey({
    story_uuid: 's-1',
    story_version_uuid: 'v-1',
    profile: { ...PROFILE, identifier: 'opening-experimental' },
  });
  assert.notEqual(a, b);
});

check('different opening_key → different key', () => {
  const a = deriveOpeningCacheKey({
    story_uuid: 's-1',
    story_version_uuid: 'v-1',
    profile: PROFILE,
  });
  const b = deriveOpeningCacheKey({
    story_uuid: 's-1',
    story_version_uuid: 'v-1',
    profile: PROFILE,
    opening_key: 'spoiler',
  });
  assert.notEqual(a, b);
});

check('different variant → different key', () => {
  const a = deriveOpeningCacheKey({
    story_uuid: 's-1',
    story_version_uuid: 'v-1',
    profile: { ...PROFILE, variant: 'default' },
  });
  const b = deriveOpeningCacheKey({
    story_uuid: 's-1',
    story_version_uuid: 'v-1',
    profile: { ...PROFILE, variant: 'bundle' },
  });
  assert.notEqual(a, b);
});

check('unlisted variant is rejected', () => {
  assert.throws(
    () =>
      deriveOpeningCacheKey({
        story_uuid: 's-1',
        story_version_uuid: 'v-1',
        profile: { ...PROFILE, variant: 'user-secret' },
      }),
    /not an allow-listed public variant/,
  );
});

console.log('\nForbidden dimensions');

// The whole point of this test: user/role/session identifiers must never
// be allowed to influence the cache key. We check every forbidden token.
for (const key of _forbiddenCacheKeyDimensions()) {
  check(`forbids '${key}' as a top-level field`, () => {
    assert.throws(
      () =>
        deriveOpeningCacheKey({
          story_uuid: 's-1',
          story_version_uuid: 'v-1',
          profile: PROFILE,
          [key]: 'sneaky',
        }),
      /forbidden dimension/,
    );
  });
}

check('forbids user_id as an unknown profile field', () => {
  assert.throws(
    () =>
      deriveOpeningCacheKey({
        story_uuid: 's-1',
        story_version_uuid: 'v-1',
        profile: { ...PROFILE, user_id: 'u-1' },
      }),
    /forbidden dimension|unknown field/,
  );
});

check('free-form tags are rejected as an unknown profile field', () => {
  assert.throws(
    () =>
      deriveOpeningCacheKey({
        story_uuid: 's-1',
        story_version_uuid: 'v-1',
        profile: { ...PROFILE, tags: { narrator: 'internal' } },
      }),
    /unknown field 'tags'/,
  );
});

check('unknown top-level scope fields are rejected', () => {
  assert.throws(
    () =>
      deriveOpeningCacheKey({
        story_uuid: 's-1',
        story_version_uuid: 'v-1',
        profile: PROFILE,
        request_id: 'req-1',
      }),
    /unknown field 'request_id'/,
  );
});

check('unknown non-identity profile fields are rejected too', () => {
  assert.throws(
    () =>
      deriveOpeningCacheKey({
        story_uuid: 's-1',
        story_version_uuid: 'v-1',
        profile: { ...PROFILE, experiment: 'alpha' },
      }),
    /unknown field 'experiment'/,
  );
});

check('empty opening_key defaults to "default"', () => {
  const a = deriveOpeningCacheKey({
    story_uuid: 's-1',
    story_version_uuid: 'v-1',
    profile: PROFILE,
  });
  const b = deriveOpeningCacheKey({
    story_uuid: 's-1',
    story_version_uuid: 'v-1',
    opening_key: 'default',
    profile: PROFILE,
  });
  assert.equal(a, b);
});

if (failures > 0) {
  console.error(`\n${failures} cache-key check(s) failed`);
  process.exit(1);
}
console.log(`\nall cache-key checks passed`);