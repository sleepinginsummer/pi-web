import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./image-content.ts");
}

test("returns URL and base64 image sources", async () => {
  const { getImageSource } = await loadSubject();

  assert.equal(
    getImageSource({ type: "image", source: { type: "url", url: " https://example.com/image.png " } }),
    "https://example.com/image.png",
  );
  assert.equal(
    getImageSource({ type: "image", source: { type: "base64", media_type: "image/png", data: " YWJj " } }),
    "data:image/png;base64,YWJj",
  );
});

test("rejects image sources without URL or data", async () => {
  const { getImageSource } = await loadSubject();

  assert.equal(getImageSource({ type: "image", source: { type: "url", url: "  " } }), "");
  assert.equal(getImageSource({ type: "image", source: { type: "base64", media_type: "image/png", data: "" } }), "");
  assert.equal(getImageSource({ type: "image", source: { type: "base64" } }), "");
  assert.equal(getImageSource({ type: "image", source: { type: "base64", data: "YWJj" } }), "");
  assert.equal(getImageSource({ type: "image", data: "", mimeType: "image/png" }), "");
  assert.equal(getImageSource({ type: "image", data: "YWJj" }), "");
});
