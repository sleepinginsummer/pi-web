"use client";

import { useEffect, useRef } from "react";
import type { AttentionEvent } from "@/lib/attention-events";

type NotifySession = (title: string, body: string, sessionId?: string | null) => Promise<void>;

type GlobalAttentionNotificationOptions = {
  notifySession: NotifySession;
  attentionTitle: string;
  attentionBody: string;
};

function compactNotificationText(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact;
}

function getAskQuestion(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const questions = (args as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return undefined;
  const first = questions[0];
  if (!first || typeof first !== "object") return undefined;
  const question = (first as { question?: unknown }).question;
  return typeof question === "string" ? question : undefined;
}

/** 在应用生命周期内持续订阅所有会话的交互事件，不依赖当前 ChatWindow。 */
export function useGlobalAttentionNotifications({
  notifySession,
  attentionTitle,
  attentionBody,
}: GlobalAttentionNotificationOptions): void {
  const notifySessionRef = useRef(notifySession);
  notifySessionRef.current = notifySession;

  useEffect(() => {
    const eventSource = new EventSource("/api/agent/attention/events");
    eventSource.onmessage = (message) => {
      let event: AttentionEvent;
      try {
        event = JSON.parse(message.data) as AttentionEvent;
      } catch (error) {
        console.error("交互通知事件解析失败", { data: message.data, error });
        return;
      }
      if (event.type !== "attention" || !event.sessionId || !event.requestId) return;

      const title = event.kind === "dialog"
        ? compactNotificationText(event.title ?? "", 48) || attentionTitle
        : attentionTitle;
      const body = event.kind === "ask"
        ? getAskQuestion(event.args) ?? attentionBody
        : event.kind === "dialog"
          ? compactNotificationText(event.body ?? "", 80) || attentionBody
          : attentionBody;
      void notifySessionRef.current(title, body, event.sessionId);
    };
    eventSource.onerror = (error) => {
      // EventSource 会自动重连；记录异常但不主动关闭。
      console.error("交互通知事件流异常", error);
    };
    return () => eventSource.close();
  }, [attentionBody, attentionTitle]);
}
