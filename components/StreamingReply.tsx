"use client";

import { memo, type RefObject } from "react";
import { MessageView } from "./MessageView";
import { selectStreamingMessage, useStreamingSelector } from "@/hooks/useStreamingSelector";
import type { StreamingStore } from "@/lib/streaming-message";
import type { ToolResultMessage } from "@/lib/types";

/** 只让当前回复订阅正文；滚动跟随仍由 fork 的 useChatScrollFollow 管理。 */
export const StreamingReply = memo(function StreamingReply({
  store, messageRef, toolResults, modelNames, cwd, onOpenFile, onOpenSubagent, visibleBlockOffset = 0,
}: {
  store: StreamingStore;
  messageRef: RefObject<HTMLDivElement | null>;
  toolResults: Map<string, ToolResultMessage>;
  modelNames: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  onOpenSubagent?: (sessionId: string, label: string) => void;
  visibleBlockOffset?: number;
}) {
  const message = useStreamingSelector(store, selectStreamingMessage);
  if (!message) return null;
  return (
    <div ref={messageRef}>
      <MessageView
        message={message}
        isStreaming
        toolResults={toolResults}
        modelNames={modelNames}
        cwd={cwd}
        onOpenFile={onOpenFile}
        onOpenSubagent={onOpenSubagent}
        visibleBlockOffset={visibleBlockOffset}
      />
    </div>
  );
});
