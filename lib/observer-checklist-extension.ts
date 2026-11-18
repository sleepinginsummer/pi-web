import { Type } from "typebox";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import type { SessionObserver } from "./session-observer";

export function createObserverChecklistExtension(observer: () => SessionObserver | undefined): InlineExtension {
  return {
    name: "pi-web-observer-checklist",
    hidden: true,
    factory: (pi) => {
      pi.registerTool(defineTool({
        name: "observer_checklist",
        label: "观察清单",
        description: "管理当前分支的观察清单。list 返回所有事项及 ID，add 默认加到末尾，update 可改标题、重要程度或勾选状态，delete 删除，move 将事项移到 beforeId 前面（null 表示移到末尾）。勾选保留原位置和条目。仅在用户要求管理清单或明确需要更新观察事项时使用。",
        parameters: Type.Object({
          action: Type.Union([Type.Literal("list"), Type.Literal("add"), Type.Literal("update"), Type.Literal("delete"), Type.Literal("move")]),
          id: Type.Optional(Type.String()),
          title: Type.Optional(Type.String()),
          done: Type.Optional(Type.Boolean()),
          priority: Type.Optional(Type.Union([Type.Literal("normal"), Type.Literal("important"), Type.Literal("urgent")])),
          beforeId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        async execute(_toolCallId, params, signal) {
          try {
            if (signal?.aborted) throw new Error("操作已取消");
            const current = observer();
            if (!current) throw new Error("观察清单尚未就绪");
            const { items } = params.action === "list" ? current.snapshot() : current.editChecklist(params);
            return { content: [{ type: "text", text: JSON.stringify(items) }], details: undefined };
          } catch (error) {
            return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
          }
        },
      }));
    },
  };
}
