"use client";

import { useEffect, useState } from "react";
import { ChevronUp } from "lucide-react";
import { useI18n } from "@/hooks/useI18n";
import type { AskQuestionnaireAnswer, AskQuestionnaireState } from "@/hooks/useAgentSession";
import type { ExtensionUiRequest } from "@/lib/types";
import { AskDialog } from "./AskDialog";
import { AskQuestionnaire } from "./AskQuestionnaire";

type SelectRequest = Extract<ExtensionUiRequest, { method: "select" }>;

export type AskInputFlyoutRequest =
  | { kind: "questionnaire"; value: AskQuestionnaireState }
  | { kind: "select"; value: SelectRequest }
  | null;

export interface AskInputFlyoutActions {
  submitQuestionnaire: (answers: AskQuestionnaireAnswer[]) => void;
  cancelQuestionnaire: () => void;
  select: (request: SelectRequest, value: string) => void;
  cancelSelect: (request: SelectRequest) => void;
  submitCustom: (request: SelectRequest, sentinelText: string, text: string) => void;
  stop: () => void;
}

interface AskInputFlyoutProps {
  ask: AskInputFlyoutRequest;
  actions: AskInputFlyoutActions;
  isMobile: boolean;
}

export function AskInputFlyout({ ask, actions, isMobile }: AskInputFlyoutProps) {
  const { t } = useI18n();
  const activeAskId = ask?.kind === "questionnaire" ? ask.value.toolCallId : ask?.value.id ?? null;
  const [collapseState, setCollapseState] = useState({ id: activeAskId, collapsed: false });
  const collapsed = collapseState.id === activeAskId && collapseState.collapsed;
  const title = ask?.kind === "questionnaire"
    ? ask.value.questions[0]?.question ?? ""
    : ask?.value.title ?? "";

  const expiresAt = ask?.kind === "select" ? ask.value.expiresAt : undefined;
  const [now, setNow] = useState(() => Date.now());
  const remainingSeconds = expiresAt === undefined ? null : Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const countdown = remainingSeconds === null ? null : t("chat.extensionExpiresIn", { seconds: remainingSeconds });
  const collapsedLabel = countdown ? `${t("chat.extensionPending")} ${title} ${countdown}` : t("chat.askExpand");

  useEffect(() => {
    if (expiresAt === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  if (!activeAskId) return null;

  const setCollapsed = (nextCollapsed: boolean) => {
    setCollapseState({ id: activeAskId, collapsed: nextCollapsed });
  };

  return (
    <div className="ask-input-flyout" style={{ paddingRight: isMobile ? 16 : 52 }}>
      <div className={`ask-input-flyout-content${collapsed ? " is-collapsed" : ""}`}>
        {collapsed ? (
          <button
            type="button"
            className="ask-collapsed-bar"
            onClick={() => setCollapsed(false)}
            aria-label={collapsedLabel}
            title={countdown ? `${t("chat.askExpand")}: ${collapsedLabel}` : t("chat.askExpand")}
          >
            <span>{countdown ? `${t("chat.extensionPending")} ${title}` : title}</span>
            {countdown && <span>{countdown}</span>}
            <ChevronUp size={17} aria-hidden="true" />
          </button>
        ) : (
          <div className="ask-expanded-content">
            {ask?.kind === "questionnaire" ? (
              <AskQuestionnaire
                key={ask.value.toolCallId}
                questionnaire={ask.value}
                onSubmit={actions.submitQuestionnaire}
                onCancel={actions.cancelQuestionnaire}
                onCollapse={() => setCollapsed(true)}
              />
            ) : ask?.kind === "select" ? (
              <AskDialog
                request={ask.value}
                remainingSeconds={remainingSeconds}
                onSelect={actions.select}
                onCancel={actions.cancelSelect}
                onCustomSubmit={actions.submitCustom}
                onStop={actions.stop}
                onCollapse={() => setCollapsed(true)}
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
