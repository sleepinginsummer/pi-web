import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { loadCollapsedProjects, saveCollapsedProjects } = await jiti.import("./project-collapse-state.ts");

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

test("persists collapsed projects across reloads", () => {
  const storage = createStorage();
  saveCollapsedProjects(new Set(["/workspace/a", "/workspace/b"]), storage);
  assert.deepEqual([...loadCollapsedProjects(storage)], ["/workspace/a", "/workspace/b"]);
});

test("removes the stored value when all projects are expanded", () => {
  const storage = createStorage({ "pi-web:collapsed-projects": '["/workspace/a"]' });
  saveCollapsedProjects(new Set(), storage);
  assert.equal(storage.values.has("pi-web:collapsed-projects"), false);
});

test("ignores malformed and non-string stored values", () => {
  assert.deepEqual([...loadCollapsedProjects(createStorage({ "pi-web:collapsed-projects": "not-json" }))], []);
  assert.deepEqual(
    [...loadCollapsedProjects(createStorage({ "pi-web:collapsed-projects": '["/workspace/a",42,""]' }))],
    ["/workspace/a"],
  );
});

test("storage failures do not break project navigation", () => {
  const unavailable = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  assert.deepEqual([...loadCollapsedProjects(unavailable)], []);
  assert.doesNotThrow(() => saveCollapsedProjects(new Set(["/workspace/a"]), unavailable));
  assert.deepEqual([...loadCollapsedProjects(null)], []);
  assert.doesNotThrow(() => saveCollapsedProjects(new Set(), null));
});
