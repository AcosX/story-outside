// Regression: a /generate response that arrives AFTER the turn was
// superseded (player interrupt) must not leave an unconsumed pending
// batch on the server.
//
// Production incident (2026-09-13, session da0e5bc7…):
//   19:50:52  POST /interrupt            → 200, revision advances
//   19:51:01  POST /generate             → 200, server staged pending
//                                          a3960a17… (committed=0/3)
//   19:51:45  POST /generate             → 400 pending_conflict
//   19:52:17  POST /generate             → 400 pending_conflict
// The interrupt bumped `generationEpoch`, so the in-flight turn's
// successful response hit the epoch guard and was dropped client-side
// — but the batch it created stayed active on the server. Every later
// /generate then failed closed with
//   "stageNarrativeBatch: session already has an unconsumed pending
//    batch (pending_id=…, committed=0/3)"
// and the player was stuck until a reload. The error surfaced to the
// user through the generic toast, which is why it was first reported
// as an "invalid json response".
//
// The fix: before discarding a superseded response, explicitly release
// the batch it staged via POST /discard-pending.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../public/scripts/player.js", import.meta.url),
  "utf8",
);
const helper = source.slice(
  source.indexOf("async function discardSupersededPending("),
  source.indexOf("function startNextBatch()"),
);
const generation = source.slice(
  source.indexOf("function startNextBatch()"),
  source.indexOf("async function surfaceToolCall("),
);
const interrupt = source.slice(
  source.indexOf("async function interruptWithPlayerText("),
  source.indexOf("async function sendPlayerInput("),
);

const pending = [];
const notices = [];
const calls = [];
const fields = new Map();
const $ = (id) => {
  if (!fields.has(id)) fields.set(id, { value: "", children: [], focus() {} });
  return fields.get(id);
};
const state = {
  sessionUuid: "session-1",
  status: "playing",
  lastRevision: 6,
  lastPlayerRequestId: 1,
  canonicalHistory: [],
  nextBatchInput: "old",
};
const api = async (path, options) => {
  calls.push({ path, body: options?.body ? JSON.parse(options.body) : null });
  if (path.endsWith("/interrupt")) {
    const body = JSON.parse(options.body);
    return {
      revision: state.lastRevision + 1,
      event: { event_type: "player_input", payload: { text: body.text } },
    };
  }
  if (path.endsWith("/discard-pending")) return { dropped_pending_id: "obsolete" };
  return new Promise((resolve, reject) =>
    pending.push({ resolve, reject, body: JSON.parse(options.body) }),
  );
};
const bind = new Function(
  "state",
  "api",
  "$",
  "notices",
  `
const setText = () => {};
const setStatus = s => { state.status = s; };
const setInputsDisabled = () => {};
const clearAutoplayTimer = () => {};
const clearAllPendingNodes = () => {};
const appendLine = () => {};
const inOpeningPhase = () => false;
const scheduleOpeningStep = () => {};
const scheduleNextStep = () => {};
const growProgressTotal = () => {};
const registerPendingNode = () => {};
const renderPendingPlaceholder = () => ({});
const surfaceToolCall = async () => {};
const showToast = message => notices.push(message);
${helper}
${generation}
${interrupt}
return {startNextBatch, interruptWithPlayerText};`,
);
const player = bind(state, api, $, notices);

// 1) A generation is in flight when the player interrupts.
const superseded = player.startNextBatch();
assert.equal(pending.length, 1, "the turn is in flight");
await player.interruptWithPlayerText("我推开了门");
assert.equal(state.lastRevision, 7, "interrupt advanced the revision");

// 2) The superseded turn now succeeds on the server: it staged a batch.
pending[0].resolve({
  revision: 6,
  pending_id: "obsolete",
  events: [
    { type: "narration", text: "旧剧情1" },
    { type: "narration", text: "旧剧情2" },
    { type: "narration", text: "旧剧情3" },
  ],
});
await superseded;

// 3) The client must have released that batch on the server.
const discards = calls.filter((c) => c.path.endsWith("/discard-pending"));
assert.equal(
  discards.length,
  1,
  "a superseded generation must release the pending batch it staged",
);
assert.equal(
  discards[0].path,
  "/api/sessions/session-1/discard-pending",
  "the discard targets the session the turn was issued for",
);
assert.equal(
  discards[0].body.pending_id,
  "obsolete",
  "the discard targets the superseded batch by id, never a newer one",
);

// 4) The abandoned turn stays silent and does not corrupt live state.
assert.equal(state.lastRevision, 7, "a superseded turn cannot roll revision back");
assert.equal(state.pending, null, "a superseded turn cannot install a pending batch");
assert.deepEqual(notices, [], "abandoning a turn is not a user-facing failure");

// 5) A cleanup failure must never surface as a bogus request error.
const failing = [];
const apiFailingDiscard = async (path, options) => {
  if (path.endsWith("/discard-pending")) throw new Error("network down");
  return api(path, options);
};
const player2 = bind(state, apiFailingDiscard, $, notices);
state.pending = null;
state.status = "playing";
const superseded2 = player2.startNextBatch();
await player2.interruptWithPlayerText("再推一次门");
pending[pending.length - 1].resolve({
  revision: 7,
  pending_id: "obsolete-2",
  events: [{ type: "narration", text: "旧剧情" }],
});
await superseded2;
assert.equal(
  notices.filter((x) => x.startsWith("请求失败")).length,
  0,
  "a best-effort cleanup failure stays silent",
);

console.log("frontend superseded pending discard: PASS");
