import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const { SessionDiskInspector } = await createJiti(import.meta.url).import("./session-disk-freshness.ts");
const header = { type: "session", version: 3, id: "11111111-1111-4111-8111-111111111111", cwd: "/tmp", timestamp: "2026-01-01T00:00:00.000Z" };
const entry = (content) => ({ type: "message", id: "same-id", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content } });
const fileContents = (content) => `${JSON.stringify(header)}\n${JSON.stringify(entry(content))}\n`;

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-disk-freshness-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, fileContents("old"));
  const manager = SessionManager.open(file);
  return { file, manager };
}

test("同 ID 原地重写会被识别，不能继续使用旧 manager", (t) => {
  const { file, manager } = fixture(t);
  const inspector = new SessionDiskInspector(manager, true);
  assert.equal(inspector.inspect(file), "current");
  writeFileSync(file, fileContents("new"));
  assert.equal(manager.getEntry("same-id").message.content, "old");
  assert.equal(inspector.inspect(file), "changed");
});

test("manager 打开后、wrapper 构建前的外部写入仍被识别", (t) => {
  const { file, manager } = fixture(t);
  appendFileSync(file, `${JSON.stringify({ ...entry("external"), id: "external-id", parentId: "same-id" })}\n`);
  assert.equal(new SessionDiskInspector(manager, true).inspect(file), "changed");
});

test("SDK 自己追加的记录可验证通过，后续未修改文件命中版本缓存", (t) => {
  const { file, manager } = fixture(t);
  const inspector = new SessionDiskInspector(manager, true);
  assert.equal(inspector.inspect(file), "current");
  manager.appendMessage({ role: "user", content: "own write" });
  assert.equal(inspector.inspect(file), "current");
  assert.equal(inspector.inspect(file), "current");
});

test("尾部撕裂写入不能被淘汰为可正常打开的稳定文件", (t) => {
  const { file, manager } = fixture(t);
  const inspector = new SessionDiskInspector(manager, true);
  assert.equal(inspector.inspect(file), "current");
  appendFileSync(file, '{"id":"incomplete"');
  assert.equal(inspector.inspect(file), "unstable");
});

// 原子替换文件的短暂缺口不能触发旧 wrapper 淘汰，更不能用残缺内容重建。
test("短暂缺失的会话文件保持不可用，替换完成后才判定变更", (t) => {
  const { file, manager } = fixture(t);
  const inspector = new SessionDiskInspector(manager, true);
  assert.equal(inspector.inspect(file), "current");
  renameSync(file, `${file}.old`);
  assert.equal(inspector.inspect(file), "unstable");
  writeFileSync(file, fileContents("new"));
  assert.equal(inspector.inspect(file), "changed");
});

test("解析期间文件变化不能被缓存为当前版本", (t) => {
  const { file, manager } = fixture(t);
  let mutated = false;
  const inspector = new SessionDiskInspector({
    getHeader: () => manager.getHeader(),
    getEntries: () => {
      if (!mutated) {
        mutated = true;
        appendFileSync(file, `${JSON.stringify({ ...entry("external"), id: "external-id" })}\n`);
      }
      return manager.getEntries();
    },
  }, true);
  assert.equal(inspector.inspect(file), "unstable");
  assert.equal(inspector.inspect(file), "changed");
});
