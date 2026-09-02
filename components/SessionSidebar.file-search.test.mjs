import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8");
const sidebarSource = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const actionsSource = await readFile(new URL("./FileTreeNodeActions.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../app/api/files/[...path]/route.ts", import.meta.url), "utf8");

test("provides a debounced file search UI and opens selected results", () => {
  assert.match(source, /searchQuery/);
  assert.match(source, /\/api\/file-index\?cwd=\$\{encodeURIComponent\(cwd\)\}&q=\$\{encodeURIComponent\(query\)\}/);
  assert.match(source, /setTimeout\(\(\) =>/);
  assert.match(source, /onOpenFile\(node\.fullPath, node\.name\)/);
});

test("connects the file search toggle to the explorer", () => {
  assert.match(sidebarSource, /const \[fileSearchOpen, setFileSearchOpen\] = useState\(false\)/);
  assert.match(sidebarSource, /title=\{t\("sidebar\.searchFiles"\)\}/);
  assert.match(sidebarSource, /fileSearchOpen=\{fileSearchOpen\}/);
  assert.match(sidebarSource, /onFileSearchOpenChange=\{setFileSearchOpen\}/);
});

test("renders search results with the existing expandable file tree", () => {
  assert.match(source, /buildSearchTree/);
  assert.match(source, /searchRoots\.map/);
  assert.match(source, /<TreeNode/);
  assert.match(source, /expandedPaths=\{searchExpanded\}/);
});

test("search result rows offer mention and download actions like the file tree", () => {
  assert.match(source, /<FileTreeNodeActions/);
  assert.match(actionsSource, /onAtMention\(getRelativeFilePath\(fullPath, cwd\), isDirectory\)/);
  assert.match(actionsSource, /encodeFilePathForApi\(fullPath\)\}\?type=download/);
});

test("keeps search on the bounded index and reports request failures", () => {
  assert.match(source, /setSearchError\(true\)/);
  assert.match(source, /role="alert"/);
  assert.doesNotMatch(apiSource, /type === "search"|searchFiles/);
});
