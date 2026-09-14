import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../public/scripts/player.js', import.meta.url), 'utf8');
const values = new Map();
const storage = { get length() { return values.size; }, key: i => [...values.keys()][i], getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) };
const state = {};
const bind = new Function('state', 'localStorage', `const setText = () => {}; ${source.slice(source.indexOf('const READING_HISTORY_PREFIX'), source.indexOf('function isEndingNotCommittedError'))}; return { rememberReading, readReadingHistory, readingHistoryPage };`)(state, storage);
const saved = i => ({ story: { id: 'same-book', title: '同一本故事' }, role: { id: `role-${i}` }, sessionUuid: `session-${i}` });
storage.setItem('story-outside:reading', JSON.stringify(saved(0)));
Object.assign(state, saved(1)); bind.rememberReading();
assert.equal(bind.readReadingHistory().length, 2, 'legacy record survives the first new session');
Object.assign(state, saved(0), { finished: true }); bind.rememberReading();
assert.equal(bind.readReadingHistory().length, 2, 'resume updates rather than duplicates a session');
assert.equal(bind.readReadingHistory().find(x => x.sessionUuid === 'session-0').finished, true);
for (let i = 2; i < 22; i++) { Object.assign(state, saved(i), { finished: false }); bind.rememberReading(); }
storage.setItem('story-outside:reading-session:broken', '{bad json');
const records = bind.readReadingHistory();
assert.equal(records.length, 22, 'all sessions retained and malformed entries isolated');
assert.equal(new Set(records.map(x => x.sessionUuid)).size, 22);
const pages = [1, 2, 3].map(i => bind.readingHistoryPage(records, i));
assert.deepEqual(pages.map(x => x.records.length), [9, 9, 4]);
assert.equal(new Set(pages.flatMap(x => x.records.map(r => r.sessionUuid))).size, 22, 'no duplicate or missing items across pages');
assert.equal(bind.readingHistoryPage(records, 999).page, 3);
assert.equal(bind.readingHistoryPage([], 2).page, 1);
assert.ok(records.every((r, i) => !i || (records[i - 1].updatedAt || 0) >= (r.updatedAt || 0)));
console.log('reading history migration, independent sessions, ordering and pagination: PASS');

// A slow ending probe for A must not resume it after the player chooses B.
const probes = [];
const resumed = [];
const resumeState = {};
const resume = new Function('state', 'probes', 'resumed', `
const clearAutoplayTimer = () => {};
const setGenerationStatus = () => {};
const showScreen = () => {};
const setText = () => {};
const persistSessionContext = () => {};
const setStatus = () => {};
const rememberReading = () => {};
const showToast = () => {};
const recoverAndStart = async () => resumed.push(state.sessionUuid);
const mountEndingPage = async () => resumed.push('ending:' + state.sessionUuid);
const hasCommittedEnding = () => new Promise(resolve => probes.push(resolve));
${source.slice(source.indexOf('async function resumeSavedReading('), source.indexOf('function renderMine('))}
return resumeSavedReading;
`)(resumeState, probes, resumed);
const a = resume(saved('a'));
const b = resume(saved('b'));
probes[0](true); await a;
assert.deepEqual(resumed, []);
probes[1](false); await b;
assert.deepEqual(resumed, ['session-b']);
console.log('reading history stale resume isolation: PASS');

// Account switching cannot expose the legacy/shared demo shelf or another user.
state.authConfigured = true; state.ownerUuid = 'account-a';
assert.equal(bind.readReadingHistory().length, 0);
Object.assign(state, saved('a'), { finished: false }); bind.rememberReading();
assert.equal(bind.readReadingHistory().length, 1);
state.ownerUuid = 'account-b';
assert.equal(bind.readReadingHistory().length, 0);
Object.assign(state, saved('b')); bind.rememberReading();
assert.equal(bind.readReadingHistory().length, 1);
state.ownerUuid = 'account-a';
assert.deepEqual(bind.readReadingHistory().map(x => x.sessionUuid), ['session-a']);
state.ownerUuid = null;
assert.equal(bind.readReadingHistory().length, 0);
console.log('reading history account isolation and anonymous privacy: PASS');
