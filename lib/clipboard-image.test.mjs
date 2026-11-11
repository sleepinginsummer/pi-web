import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { readClipboardImageFiles } = await jiti.import("./clipboard-image.ts");

function item(blobs) {
  return {
    types: Object.keys(blobs),
    getType: async (type) => new Blob([blobs[type]], { type }),
  };
}

test("prefers PNG data over other clipboard image formats", async () => {
  const files = await readClipboardImageFiles({
    read: async () => [item({ "text/plain": "x", "image/jpeg": "jpeg", "image/png": "png-data" })],
  });
  assert.equal(files.length, 1);
  assert.equal(files[0].type, "image/png");
  assert.equal(await files[0].text(), "png-data");
});

test("uses another image format when PNG is absent and skips non-image items", async () => {
  const files = await readClipboardImageFiles({
    read: async () => [item({ "text/plain": "x" }), item({ "image/jpeg": "jpeg" })],
  });
  assert.deepEqual(files.map((file) => file.type), ["image/jpeg"]);
});

test("returns no files when the clipboard API is unavailable or denied", async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await readClipboardImageFiles({ read: undefined }), []);
    assert.deepEqual(await readClipboardImageFiles({
      read: async () => { throw new DOMException("denied", "NotAllowedError"); },
    }), []);
  } finally {
    console.warn = originalWarn;
  }
});

test("server fallback returns the PNG and ignores empty or refused responses", async () => {
  const { readServerClipboardImageFiles } = await jiti.import("./clipboard-image.ts");
  const files = await readServerClipboardImageFiles(async (url, init) => {
    assert.equal(url, "/api/clipboard-image");
    assert.equal(init.method, "POST");
    return { ok: true, status: 200, blob: async () => new Blob(["png"], { type: "image/png" }) };
  });
  assert.equal(files.length, 1);
  assert.equal(files[0].type, "image/png");
  assert.equal(await files[0].text(), "png");

  assert.deepEqual(await readServerClipboardImageFiles(async () => ({ ok: true, status: 204, blob: async () => new Blob([]) })), []);
  assert.deepEqual(await readServerClipboardImageFiles(async () => ({ ok: false, status: 403, blob: async () => new Blob([]) })), []);
});
