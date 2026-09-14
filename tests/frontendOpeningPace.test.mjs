import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../public/scripts/player.js', import.meta.url), 'utf8');
const opening = source.slice(source.indexOf('function scheduleOpeningStep('), source.indexOf('function appendCanonical('));
for (const elapsed of [100, 1500]) {
 let now = 0, resolveCommit;
 const timers = [];
 const state = { status: 'playing', openingCursor: 0, openingEvents: [{ text: '缓存正文' }], canonicalHistory: [], sessionUuid: 's' };
 const player = new Function('state', 'api', 'performance', 'setTimeout', `
 const STEP_DELAY_MS=1100, clearTimeout=()=>{}, renderPendingPlaceholder=()=>({}), registerPendingNode=()=>{}, clearPendingNode=()=>{}, commitPendingLineInDomNode=()=>{}, setProgress=()=>{}, computeProgress=()=>0, scheduleNextStep=()=>{}, startNextBatch=()=>{}, showToast=()=>{}, setStatus=()=>{};
 ${opening}
 return {runOpeningStep};
 `)(state, () => new Promise(resolve => { resolveCommit = resolve; }), { now: () => now }, (fn, delay) => { timers.push(delay); return 1; });
 const run = player.runOpeningStep();
 assert.equal(timers.length, 0, 'never schedule another line before durable acknowledgement');
 assert.equal(state.openingCursor, 0);
 now = elapsed;
 resolveCommit({revision: 1, event: {text: '缓存正文'}});
 await run;
 assert.equal(state.openingCursor, 1);
 assert.deepEqual(timers, [Math.max(0, 1100 - elapsed)], 'save latency counts toward the reading interval');
}
console.log('Opening pace: slow/fast saves, cursor and durable acknowledgement PASS');
