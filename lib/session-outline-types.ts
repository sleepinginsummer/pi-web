/** 会话全量轻量大纲的共享类型（前后端共用，不依赖 Node 模块）。 */
export interface OutlineHeading {
  level: 1 | 2;
  text: string;
}

export interface SessionOutlineTurn {
  turnNumber: number;
  entryId: string;
  kind: "user" | "custom" | "compaction";
  customType?: string;
  hiddenAnchor?: boolean;
  userText: string;
  finalAssistantEntryId?: string;
  answerSummary: string;
  headings: OutlineHeading[];
}

export interface SessionOutlineResponse {
  sessionId: string;
  leafId: string | null;
  version: string;
  turns: SessionOutlineTurn[];
}
