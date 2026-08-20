import type { UserMessage } from "./types";

export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
  /** 输入框中以 TXT 条目展示的超长粘贴文本。 */
  textAttachment?: string;
}

const drafts = new Map<string, ChatDraft>();

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
    textAttachment: draft.textAttachment,
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0 && !draft.textAttachment;
}

export function getDraft(key: string): ChatDraft | null {
  const draft = drafts.get(key);
  return draft ? cloneDraft(draft) : null;
}

export function setDraft(key: string, draft: ChatDraft): void {
  if (isEmptyDraft(draft)) {
    drafts.delete(key);
    return;
  }
  drafts.set(key, cloneDraft(draft));
}

export function clearDraft(key: string): void {
  drafts.delete(key);
}

/** 将用户消息转换为新会话输入草稿；仅保留输入框支持的文本与 base64 图片。 */
export function createDraftFromUserMessage(message: UserMessage): ChatDraft {
  if (typeof message.content === "string") return { value: message.content, images: [] };

  return {
    value: message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n"),
    images: message.content.flatMap((block) => (
      block.type === "image"
      && block.source.type === "base64"
      && block.source.data
      && block.source.media_type
        ? [{ data: block.source.data, mimeType: block.source.media_type }]
        : []
    )),
  };
}
