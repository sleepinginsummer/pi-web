import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { FrameBatcher } = await jiti.import("./frame-batcher.ts");

function createScheduler() {
  let nextId = 1;
  const callbacks = new Map();
  return {
    scheduler: {
      request(callback) {
        const id = nextId++;
        callbacks.set(id, callback);
        return id;
      },
      cancel(id) {
        callbacks.delete(id);
      },
    },
    runFrames() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      pending.forEach((callback) => callback(0));
    },
    pendingCount() {
      return callbacks.size;
    },
  };
}

test("merges same-frame items in enqueue order", () => {
  const frame = createScheduler();
  const batches = [];
  const batcher = new FrameBatcher((items) => batches.push(items), frame.scheduler);

  batcher.enqueue("a");
  batcher.enqueue("b");
  assert.equal(frame.pendingCount(), 1);
  frame.runFrames();

  assert.deepEqual(batches, [["a", "b"]]);
});

test("flush commits pending items before the caller continues", () => {
  const frame = createScheduler();
  const events = [];
  const batcher = new FrameBatcher((items) => events.push(...items), frame.scheduler);

  batcher.enqueue("delta-1");
  batcher.enqueue("delta-2");
  batcher.flush();
  events.push("end");
  frame.runFrames();

  assert.deepEqual(events, ["delta-1", "delta-2", "end"]);
});

test("reset cancels and drops a previous session batch", () => {
  const frame = createScheduler();
  const batches = [];
  const batcher = new FrameBatcher((items) => batches.push(items), frame.scheduler);

  batcher.enqueue("old-session");
  batcher.reset();
  frame.runFrames();
  batcher.enqueue("new-session");
  frame.runFrames();

  assert.deepEqual(batches, [["new-session"]]);
});
