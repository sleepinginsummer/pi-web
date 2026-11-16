import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { runOptimisticInputSubmission, prependSubmittedInput } = await jiti.import("./optimistic-input-submission.ts");

function snapshot() {
  return {
    value: "hello",
    images: [{ previewUrl: "blob:test" }],
    textAttachment: "details",
    draftKey: "session-a",
  };
}

function harness(canRestore = true) {
  const events = [];
  return {
    events,
    options: {
      clearInput(revokeImages) { events.push(["clear", revokeImages]); },
      canRestore() { return canRestore; },
      restore(value) { events.push(["restore", value.draftKey]); },
      discard(value) { events.push(["discard", value.draftKey]); },
      releaseImages(images) { events.push(["release", images.length]); },
      onError(error) { events.push(["error", error.message]); },
    },
  };
}

test("synchronous rejection keeps the current input untouched", async () => {
  const state = harness();
  const result = await runOptimisticInputSubmission(state.options, snapshot(), () => false);
  assert.equal(result, false);
  assert.deepEqual(state.events, []);
});

test("accepted submission clears immediately and releases previews on success", async () => {
  const state = harness();
  let resolveSubmission;
  const pending = new Promise((resolve) => { resolveSubmission = resolve; });
  const operation = runOptimisticInputSubmission(state.options, snapshot(), () => pending);

  assert.deepEqual(state.events, [["clear", false]]);
  resolveSubmission(true);
  assert.equal(await operation, true);
  assert.deepEqual(state.events, [["clear", false], ["release", 1]]);
});

test("asynchronous failure restores the original draft snapshot", async () => {
  const state = harness(true);
  const result = await runOptimisticInputSubmission(state.options, snapshot(), async () => false);
  assert.equal(result, false);
  assert.deepEqual(state.events, [["clear", false], ["restore", "session-a"]]);
});

test("session switch discards through the owner instead of restoring into the current input", async () => {
  const state = harness(false);
  await runOptimisticInputSubmission(state.options, snapshot(), async () => false);
  assert.deepEqual(state.events, [["clear", false], ["discard", "session-a"]]);
});

test("rejected promise follows rollback and records the error", async () => {
  const state = harness(true);
  await runOptimisticInputSubmission(state.options, snapshot(), async () => {
    throw new Error("offline");
  });
  assert.deepEqual(state.events, [
    ["clear", false],
    ["error", "offline"],
    ["restore", "session-a"],
  ]);
});

for (const draftKey of ["new:/project", "session-a"]) {
  test(`${draftKey}: failure preserves submitted content and the draft typed while sending`, async () => {
    const submitted = { ...snapshot(), draftKey };
    let input = submitted;
    let fail;
    const pending = new Promise((resolve) => { fail = resolve; });
    const operation = runOptimisticInputSubmission({
      clearInput() { input = { value: "", images: [], textAttachment: null, draftKey }; },
      canRestore(value) { return input.draftKey === value.draftKey; },
      restore(value) { input = prependSubmittedInput(value, input); },
      discard() { assert.fail("当前会话失败内容不能丢弃"); },
      releaseImages() { assert.fail("失败附件仍需在输入框里显示"); },
    }, submitted, () => pending);
    const nextImage = { previewUrl: "blob:next" };
    input = { value: "new draft", images: [nextImage], textAttachment: "new details", draftKey };
    fail(false);
    assert.equal(await operation, false);
    assert.deepEqual(input, {
      draftKey, value: "hello\n\nnew draft",
      images: [...submitted.images, nextImage],
      textAttachment: "details\n\nnew details",
    });
  });
}

test("restoring to an empty composer preserves whitespace and all attachments", () => {
  const submitted = { ...snapshot(), value: "  hello  " };
  assert.deepEqual(prependSubmittedInput(submitted, {
    draftKey: submitted.draftKey, value: "", images: [], textAttachment: null,
  }), submitted);
});
