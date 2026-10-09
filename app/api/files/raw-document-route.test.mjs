import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./[...path]/route.ts", import.meta.url), "utf8");

test("the raw document namespace serves a file without a query string", () => {
  // A previewed page loads its stylesheets, scripts, and images over relative
  // URLs, and those requests carry no `type` parameter to select the mode with.
  // The segment itself is defined next to the origin guard that admits those
  // subresource loads; lib/request-security.test.mjs proves its value.
  assert.match(source, /import \{ RAW_FILE_PATH_SEGMENT[^}]*\} from "@\/lib\/request-security"/);
  assert.match(source, /segments\[0\] === RAW_FILE_PATH_SEGMENT/);
  assert.match(source, /filePathFromApiSegments\(isRawDocument \? segments\.slice\(1\) : segments\)/);
  assert.match(source, /const type = isRawDocument \? "raw" : parseFileRequestType\(rawType\)/);
});

test("raw responses stream the file inline with its own content type", () => {
  const start = source.indexOf('if (type === "raw")');
  const end = source.indexOf('if (type === "read")', start);
  assert.ok(start !== -1 && end > start, "the raw branch must exist before the read branch");

  const block = source.slice(start, end);
  assert.match(block, /streamFile\(filePath, stat, getInlineFileMime\(filePath\), request\.headers\.get\("range"\)\)/);
  assert.doesNotMatch(block, /,\s*true\)/, "a raw preview is inline, never a download");
});

test("the raw namespace cannot skip the file authorization checks", () => {
  const denial = source.indexOf("if (!allowedByRoot && !allowedBySessionReference) {");
  const rawBranch = source.indexOf('if (type === "raw")');
  assert.ok(denial !== -1 && rawBranch > denial, "the raw branch must sit behind the root and session checks");
});
