import type { ChatDraft, ChatDraftImage } from "./draft-store";

/** 队列与移回共用完整附件契约，不能用 SDK 的纯文本队列代替。 */
export interface QueuedMessage {
  text: string;
  images: ChatDraftImage[];
}

export interface QueuedMessages {
  steering: QueuedMessage[];
  followUp: QueuedMessage[];
}

export function queuedMessagesToDraft(queue: QueuedMessages): ChatDraft {
  const messages = [...queue.steering, ...queue.followUp];
  return {
    value: messages.map((message) => message.text).filter((text) => text.trim()).join("\n\n"),
    images: messages.flatMap((message) => message.images.map((image) => ({ ...image }))),
  };
}

/** 恢复队列时保留输入框里尚未发送的内容，附件顺序与文字顺序一致。 */
export function prependChatDraft(restored: ChatDraft, current: ChatDraft): ChatDraft {
  return {
    ...current,
    value: [restored.value, current.value].filter((text) => text.trim()).join("\n\n"),
    images: [...restored.images, ...current.images].map((image) => ({ ...image })),
  };
}
