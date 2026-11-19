import type { ChatDraftImage } from "./draft-store";

export interface StashedMessage {
  id: string;
  revision: string;
  preview: string;
  imageCount: number;
  schedule?: { at: number; sessionId: string; label: string };
  status: "ready" | "sending" | "failed" | "uncertain";
}

export interface StashedContent {
  text: string;
  images: ChatDraftImage[];
}

export interface StashSnapshot {
  items: StashedMessage[];
  schedulingEnabled: boolean;
}
