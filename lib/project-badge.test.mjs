import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { PROJECT_BADGE_COLORS, projectBadge, projectBadgeInitial } = await jiti.import("./project-badge.ts");

test("首字跳过分隔符，字母转大写，CJK 取一个汉字", () => {
  assert.equal(projectBadgeInitial("pi-web"), "P");
  assert.equal(projectBadgeInitial("-blog"), "B");
  assert.equal(projectBadgeInitial(".config"), "C");
  assert.equal(projectBadgeInitial("项目A"), "项");
  assert.equal(projectBadgeInitial("🎨art"), "A");
  assert.equal(projectBadgeInitial("  "), "?");
});

test("同一路径永远得到同一个色块，并且色块都在色板里", () => {
  const path = "/Volumes/syy2t/project/pi-web";
  const first = projectBadge(path, "pi-web");
  const second = projectBadge(path, "pi-web");
  assert.deepEqual(first, second);
  assert.ok(PROJECT_BADGE_COLORS.some((color) => color.background === first.background));
  assert.equal(first.initial, "P");
});

test("不同目录会落到不同色块，名字不影响颜色", () => {
  const paths = [
    "/repo/pi-web",
    "/repo/blog",
    "/repo/api-gateway",
    "/repo/syy-notes",
    "/repo/second-brain",
    "/repo/website",
  ];
  const colors = new Set(paths.map((path) => projectBadge(path, path.split("/").at(-1)).background));
  assert.ok(colors.size >= 3, `6 个目录只出现了 ${colors.size} 种颜色`);
  // 同一个目录改名后颜色保持不变，只有首字跟着变。
  const renamed = projectBadge(paths[0], "另一个名字");
  assert.equal(renamed.background, projectBadge(paths[0], "pi-web").background);
  assert.equal(renamed.initial, "另");
});
