// tests/canonicalHash.test.mjs — unit tests for canonical JSON hashing and
// story content normalisation. No database / network / file I/O.

import assert from 'node:assert/strict';

import {
  canonicalJsonStringify,
  canonicalSha256,
  canonicalStoryContent,
  canonicalStoryHash,
} from '../src/stories/canonicalHash.mjs';

let failures = 0;
function check(name, fn) {
  try {
    const detail = fn();
    if (detail && typeof detail === 'object' && detail.skip) {
      console.log(`  skip ${name}${detail.reason ? ` (${detail.reason})` : ''}`);
      return;
    }
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`    ${err && err.message ? err.message : err}`);
  }
}

console.log('Canonical JSON');

check('key order does not change the hash', () => {
  const a = canonicalSha256({ b: 1, a: 2, c: { y: 1, x: 2 } });
  const b = canonicalSha256({ c: { x: 2, y: 1 }, a: 2, b: 1 });
  assert.equal(a, b);
});

check('value change DOES change the hash', () => {
  const a = canonicalSha256({ a: 1, b: 2 });
  const b = canonicalSha256({ a: 1, b: 3 });
  assert.notEqual(a, b);
});

check('array order IS preserved (matters)', () => {
  // Arrays are positional by contract. Reversing the order must change
  // the hash — this is a feature, not a bug.
  const a = canonicalSha256([1, 2, 3]);
  const b = canonicalSha256([3, 2, 1]);
  assert.notEqual(a, b);
});

check('null vs missing are distinct', () => {
  const a = canonicalSha256({ a: null });
  const b = canonicalSha256({});
  assert.notEqual(a, b);
});

check('rejects NaN / Infinity', () => {
  assert.throws(() => canonicalSha256({ a: Number.NaN }), /non-finite/);
  assert.throws(() => canonicalSha256({ a: Number.POSITIVE_INFINITY }), /non-finite/);
});

check('rejects non-printable characters', () => {
  assert.throws(() => canonicalSha256({ a: 'hi\u0001' }), /non-printable/);
});

check('json stringify has no whitespace', () => {
  const out = canonicalJsonStringify({ a: 1, b: [1, 2] });
  assert.equal(out, '{"a":1,"b":[1,2]}');
});

console.log('\nCanonical story content');

const BASE = {
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
    '你想起一个还没问出口的问题。',
  ],
};

check('hash is 64-char hex', () => {
  const h = canonicalStoryHash(BASE);
  assert.equal(h.length, 64);
  assert.match(h, /^[0-9a-f]{64}$/);
});

check('same content → same hash regardless of key order', () => {
  const reordered = {
    beats: BASE.beats,
    roles: BASE.roles.map((r) => ({ mood: r.mood, label: r.label, id: r.id })),
    hook: BASE.hook,
    title: BASE.title,
    id: BASE.id,
  };
  assert.equal(canonicalStoryHash(BASE), canonicalStoryHash(reordered));
});

check('extra unknown fields are stripped before hashing', () => {
  const extra = {
    ...BASE,
    secret_field: 'should-not-affect-hash',
    nested: { ignored: true, deeper: { x: 1 } },
  };
  assert.equal(canonicalStoryHash(BASE), canonicalStoryHash(extra));
});

check('beat text change → different hash', () => {
  const changed = {
    ...BASE,
    beats: [...BASE.beats.slice(0, -1), '你还没问出口的问题还没说。'],
  };
  assert.notEqual(canonicalStoryHash(BASE), canonicalStoryHash(changed));
});

check('role mood change → different hash', () => {
  const changed = {
    ...BASE,
    roles: BASE.roles.map((r) =>
      r.id === 'stranger' ? { ...r, mood: '放松' } : r,
    ),
  };
  assert.notEqual(canonicalStoryHash(BASE), canonicalStoryHash(changed));
});

check('title change → different hash', () => {
  const changed = { ...BASE, title: '雨夜咖啡馆（修订）' };
  assert.notEqual(canonicalStoryHash(BASE), canonicalStoryHash(changed));
});

check('detail must include id/title/hook/roles/beats', () => {
  assert.throws(() => canonicalStoryContent({}), /missing id/);
  assert.throws(() => canonicalStoryContent({ id: 'x' }), /missing title/);
  assert.throws(() => canonicalStoryContent({ id: 'x', title: 't' }), /missing hook/);
  assert.throws(() => canonicalStoryContent({ id: 'x', title: 't', hook: 'h' }), /missing roles/);
  assert.throws(
    () => canonicalStoryContent({ id: 'x', title: 't', hook: 'h', roles: [] }),
    /missing beats/,
  );
});

check('beats can be objects with text/index', () => {
  const out = canonicalStoryContent({
    ...BASE,
    beats: BASE.beats.map((text, index) => ({ text, index })),
  });
  assert.equal(out.beats.length, 3);
  assert.equal(out.beats[0].index, 0);
});

check('roles without mood default to empty string', () => {
  const out = canonicalStoryContent({
    ...BASE,
    roles: BASE.roles.map((r) => ({ id: r.id, label: r.label })),
  });
  assert.equal(out.roles[0].mood, '');
});

if (failures > 0) {
  console.error(`\n${failures} canonical-hash check(s) failed`);
  process.exit(1);
}
console.log(`\nall canonical-hash checks passed`);