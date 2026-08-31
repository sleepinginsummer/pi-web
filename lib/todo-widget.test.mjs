import assert from "node:assert/strict";
import test from "node:test";
import { createTodoWidget, withTodoWidget } from "./todo-widget.ts";

test("creates an rpiv-todos widget from the current session tasks", () => {
  assert.deepEqual(createTodoWidget([
    { id: 1, subject: "已完成", status: "completed" },
    { id: 2, subject: "正在处理", status: "in_progress", activeForm: "处理任务", blockedBy: [1] },
    { id: 3, subject: "待处理", status: "pending" },
  ]), {
    key: "rpiv-todos",
    placement: "aboveEditor",
    lines: [
      "● Todos (1/3)",
      "├─ ✓ #1 已完成",
      "├─ ◐ #2 正在处理 (处理任务) ⛓ #1",
      "└─ ○ #3 待处理",
    ],
  });
});

test("does not create a widget for an empty task list", () => {
  assert.equal(createTodoWidget([]), null);
});

test("keeps a runtime rpiv-todos widget when one is available", () => {
  const runtime = [{ key: "rpiv-todos", lines: ["runtime"], placement: "aboveEditor" }];
  assert.deepEqual(withTodoWidget(runtime, [{ id: 1, subject: "历史任务", status: "pending" }]), runtime);
});

test("adds the historical widget when the runtime has no foreground widget", () => {
  assert.deepEqual(withTodoWidget([], [{ id: 1, subject: "历史任务", status: "pending" }]), [{
    key: "rpiv-todos",
    placement: "aboveEditor",
    lines: ["● Todos (0/1)", "└─ ○ 历史任务"],
  }]);
});
