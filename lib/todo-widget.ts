import type { ExtensionWidgetItem } from "./types";

export type TodoWidgetTaskStatus = "pending" | "in_progress" | "completed";

export interface TodoWidgetTask {
  id: number;
  subject: string;
  status: TodoWidgetTaskStatus;
  activeForm?: string;
  blockedBy?: number[];
}

/**
 * 为当前会话生成 rpiv-todo 的兼容 widget。
 *
 * rpiv-todo 的运行时 overlay 只支持单个前台会话，而 Pi Web 可以同时保留
 * 多个 AgentSession。历史消息已经包含完整 Todo 快照，因此这里用当前分支的
 * 派生状态补出同样的展示，避免把其它会话的全局 overlay 误带过来。
 */
export function createTodoWidget(tasks: readonly TodoWidgetTask[]): ExtensionWidgetItem | null {
  if (tasks.length === 0) return null;

  const completed = tasks.filter((task) => task.status === "completed").length;
  const hasActive = tasks.some((task) => task.status === "pending" || task.status === "in_progress");
  const showIds = tasks.some((task) => task.blockedBy && task.blockedBy.length > 0);
  const lines = [`${hasActive ? "●" : "○"} Todos (${completed}/${tasks.length})`];

  tasks.forEach((task, index) => {
    const glyph = task.status === "completed" ? "✓" : task.status === "in_progress" ? "◐" : "○";
    const activeForm = task.status === "in_progress" && task.activeForm ? ` (${task.activeForm})` : "";
    const taskId = showIds ? ` #${task.id}` : "";
    const blockedBy = task.blockedBy && task.blockedBy.length > 0
      ? ` ⛓ ${task.blockedBy.map((id) => `#${id}`).join(",")}`
      : "";
    const prefix = index === tasks.length - 1 ? "└─" : "├─";
    lines.push(`${prefix} ${glyph}${taskId} ${task.subject}${activeForm}${blockedBy}`);
  });

  return {
    key: "rpiv-todos",
    lines,
    placement: "aboveEditor",
  };
}

/** 运行时已经提供同名 widget 时保留它，否则补上当前会话的历史快照。 */
export function withTodoWidget(
  widgets: ExtensionWidgetItem[],
  tasks: readonly TodoWidgetTask[],
): ExtensionWidgetItem[] {
  if (widgets.some((widget) => widget.key === "rpiv-todos")) return widgets;
  const todoWidget = createTodoWidget(tasks);
  return todoWidget ? [...widgets, todoWidget] : widgets;
}
