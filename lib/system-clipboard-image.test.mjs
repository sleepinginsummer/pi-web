import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { readSystemClipboardPng } = await jiti.import("./system-clipboard-image.ts");

test("returns the PNG osascript wrote to the temporary file", async () => {
  const png = await readSystemClipboardPng(async (args) => {
    await writeFile(args.at(-1), "png-bytes");
  }, "darwin");
  assert.equal(png.toString(), "png-bytes");
});

test("returns null when the clipboard has no image or the platform is unsupported", async () => {
  assert.equal(await readSystemClipboardPng(async () => { throw new Error("Can't make into type"); }, "darwin"), null);
  let ran = false;
  assert.equal(await readSystemClipboardPng(async () => { ran = true; }, "linux"), null);
  assert.equal(ran, false);
});
