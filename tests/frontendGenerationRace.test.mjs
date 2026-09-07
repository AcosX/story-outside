import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../public/scripts/player.js", import.meta.url),
  "utf8",
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
  if (path.endsWith("/interrupt")) {
    const body = JSON.parse(options.body);
    assert.equal(body.expected_revision, state.lastRevision);
    return {
      revision: state.lastRevision + 1,
      event: { event_type: "player_input", payload: { text: body.text } },
    };
  }
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
${generation}
${interrupt}
return {startNextBatch, interruptWithPlayerText};`,
);
const player = bind(state, api, $, notices);
const old = player.startNextBatch();
assert.equal(
  player.startNextBatch(),
  old,
  "duplicate playback clicks reuse the in-flight generation",
);
assert.equal(pending.length, 1);
const result = await player.interruptWithPlayerText("我推开了门");
assert.equal(
  result.revision,
  7,
  "interrupt completes without waiting for the old AI response",
);
assert.equal(state.lastRevision, 7);
const fresh = player.startNextBatch();
assert.equal(
  pending.length,
  2,
  "new revision starts a new generation immediately",
);
assert.equal(pending[1].body.expected_revision, 7);
assert.equal(pending[1].body.input.text, "我推开了门");
pending[1].resolve({
  revision: 8,
  pending_id: "fresh",
  events: [{ type: "narration", text: "新剧情" }],
});
await fresh;
pending[0].resolve({
  revision: 7,
  pending_id: "obsolete",
  events: [{ type: "narration", text: "旧剧情" }],
});
await old;
assert.equal(
  state.lastRevision,
  8,
  "late obsolete generation cannot roll revision backward",
);
assert.equal(
  state.pending.pending_id,
  "fresh",
  "late obsolete generation cannot overwrite the new pending batch",
);
assert.deepEqual(notices, []);
state.pending = null;
const oldFailure = player.startNextBatch();
await player.interruptWithPlayerText("换一种选择");
pending[2].reject(new Error("revision_mismatch"));
await oldFailure;
assert.equal(
  notices.filter((x) => x.startsWith("请求失败")).length,
  0,
  "obsolete errors stay silent",
);
console.log("frontend generation race: PASS");
