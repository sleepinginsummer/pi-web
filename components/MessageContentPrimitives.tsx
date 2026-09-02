"use client";

import { getImageSource } from "@/lib/image-content";
import type { CustomMessage, ImageContent, TextContent, UserMessage } from "@/lib/types";
import { ImagePreview } from "./ImagePreview";

export function formatMessageTime(timestamp?: number): string | null {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return time;
  const day = date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
  return `${day} ${time}`;
}

export function getMessageText(content: CustomMessage["content"] | UserMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function getMessageImages(content: CustomMessage["content"] | UserMessage["content"]): ImageContent[] {
  if (typeof content === "string") return [];
  return content.filter((block): block is ImageContent => block.type === "image" && getImageSource(block) !== "");
}

export function MessageImage({ image, variant }: { image: ImageContent; variant: "user" | "assistant" | "custom" }) {
  const src = getImageSource(image);
  if (!src) return null;

  const isAssistant = variant === "assistant";
  const border = variant === "user" ? "1px solid rgba(59,130,246,0.15)" : "1px solid var(--border)";
  return (
    <ImagePreview src={src} style={{ maxWidth: "100%" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        loading={isAssistant ? "lazy" : undefined}
        style={{
          maxWidth: isAssistant ? "100%" : 240,
          maxHeight: isAssistant ? 480 : 240,
          borderRadius: 6,
          objectFit: "contain",
          display: "block",
          border,
        }}
      />
    </ImagePreview>
  );
}
