"use client";

import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ExtensionUiRequest } from "@/lib/types";
import styles from "./AskDialog.module.css";
import { ChevronDown } from "lucide-react";

type AskDialogRequest = Extract<ExtensionUiRequest, { method: "select" }>;

function findCustomOptionIndex(options: string[]): number {
  const lastIndex = options.length - 1;
  const lastOption = options[lastIndex];
  return lastIndex >= 0 && /^\d+\.\s/.test(lastOption) && !lastOption.includes(" — ") ? lastIndex : -1;
}

function useAskDialogInteraction(
  request: AskDialogRequest,
  onSelect: (request: AskDialogRequest, value: string) => void,
  onCustomSubmit: (request: AskDialogRequest, sentinelText: string, text: string) => void,
) {
  const optionsRef = useRef<HTMLDivElement>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const customOptionIndex = findCustomOptionIndex(request.options);

  const openCustom = () => {
    setCustomValue("");
    setCustomOpen(true);
  };
  const closeCustom = () => {
    setCustomOpen(false);
    setCustomValue("");
  };
  const submitCustom = () => {
    const text = customValue.trim();
    if (!text || customOptionIndex < 0) {
      closeCustom();
      return;
    }
    onCustomSubmit(request, request.options[customOptionIndex], text);
  };

  // 方向键在选项间移动焦点，回车触发当前项；Esc 仍由全局停止快捷键处理。
  const handleOptionsKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
    const buttons = Array.from(optionsRef.current?.querySelectorAll<HTMLButtonElement>("button[data-ask-option]") ?? []);
    if (buttons.length === 0) return;
    const activeIndex = document.activeElement instanceof HTMLButtonElement
      ? buttons.indexOf(document.activeElement)
      : -1;
    if (event.key === "Enter") {
      if (activeIndex < 0) return;
      event.preventDefault();
      if (activeIndex === customOptionIndex) openCustom();
      else onSelect(request, buttons[activeIndex].dataset.askOption ?? "");
      return;
    }
    event.preventDefault();
    const nextIndex = event.key === "ArrowDown"
      ? (activeIndex + 1) % buttons.length
      : (activeIndex - 1 + buttons.length) % buttons.length;
    buttons[nextIndex].focus();
  };

  return {
    optionsRef,
    customOpen,
    customValue,
    customOptionIndex,
    setCustomValue,
    openCustom,
    closeCustom,
    submitCustom,
    handleOptionsKeyDown,
  };
}

function CustomAnswerOption({
  option,
  open,
  value,
  onOpen,
  onChange,
  onClose,
  onSubmit,
}: {
  option: string;
  open: boolean;
  value: string;
  onOpen: () => void;
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { t } = useI18n();
  if (!open) {
    return (
      <button type="button" data-ask-option={option} onClick={onOpen} className={styles.option} title={t("chat.typeYourAnswer")}>
        {option}
      </button>
    );
  }
  return (
    <input
      autoFocus
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onSubmit();
        } else if (event.key === "Escape") {
          onClose();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.stopPropagation();
        }
      }}
      onBlur={onClose}
      placeholder={t("chat.typeYourAnswer")}
      aria-label={t("chat.typeYourAnswer")}
      className={styles.customInput}
    />
  );
}

// RPC fallback 会把 "Type something." sentinel 作为最后一项；该项点击后切换为内联输入。
export function AskDialog({ request, onSelect, onCustomSubmit, onStop, onCollapse }: {
  request: AskDialogRequest;
  onSelect: (request: AskDialogRequest, value: string) => void;
  onCustomSubmit: (request: AskDialogRequest, sentinelText: string, text: string) => void;
  onStop: () => void;
  onCollapse: () => void;
}) {
  const { t } = useI18n();
  const interaction = useAskDialogInteraction(request, onSelect, onCustomSubmit);

  return (
    <div role="dialog" aria-label={request.title} onKeyDown={interaction.handleOptionsKeyDown} className={styles.card}>
      <div className={styles.header}>
        <div className={styles.title}>{request.title}</div>
        <div className={styles.actions}>
          <button type="button" onClick={onCollapse} className={styles.collapse} aria-label={t("chat.askCollapse")} title={t("chat.askCollapse")}>
            <ChevronDown size={17} aria-hidden="true" />
          </button>
          <button type="button" onClick={onStop} className={styles.stop}>{t("chat.stop")}</button>
        </div>
      </div>
      <div ref={interaction.optionsRef} className={styles.options}>
        {request.options.map((option, index) => index === interaction.customOptionIndex ? (
          <CustomAnswerOption
            key={option}
            option={option}
            open={interaction.customOpen}
            value={interaction.customValue}
            onOpen={interaction.openCustom}
            onChange={interaction.setCustomValue}
            onClose={interaction.closeCustom}
            onSubmit={interaction.submitCustom}
          />
        ) : (
          <button
            key={option}
            type="button"
            data-ask-option={option}
            onClick={() => onSelect(request, option)}
            className={styles.option}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}
