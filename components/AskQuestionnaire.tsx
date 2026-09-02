"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { AskQuestionnaireAnswer, AskQuestionnaireState } from "@/hooks/useAgentSession";
import { normalizeAskQuestionnairePreview } from "@/lib/ask-questionnaire-preview";

export function AskQuestionnaire({
  questionnaire,
  onSubmit,
  onCancel,
}: {
  questionnaire: AskQuestionnaireState;
  onSubmit: (answers: AskQuestionnaireAnswer[]) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [page, setPage] = useState(0);
  const [answers, setAnswers] = useState<Array<AskQuestionnaireAnswer | null>>(
    () => questionnaire.questions.map(() => null),
  );
  const question = questionnaire.questions[page];
  const isReview = page === questionnaire.questions.length;

  useEffect(() => {
    setPage(0);
    setAnswers(questionnaire.questions.map(() => null));
  }, [questionnaire.toolCallId, questionnaire.questions]);

  const setAnswer = (answer: AskQuestionnaireAnswer) => {
    setAnswers((current) => current.map((value, index) => index === page ? answer : value));
  };
  const currentAnswer = answers[page];
  const isAnswerComplete = (answer: AskQuestionnaireAnswer | null, questionIndex: number) => {
    if (!answer) return false;
    if (answer.kind === "custom") return answer.text.trim().length > 0;
    return questionnaire.questions[questionIndex]?.multiSelect || answer.optionIndexes.length === 1;
  };
  const canContinue = isAnswerComplete(currentAnswer ?? null, page);

  return (
    <div
      className="ask-questionnaire"
      role="dialog"
      aria-label={isReview ? t("chat.askReview") : question.question}
    >
        <div className="ask-questionnaire-tabs">
          {questionnaire.questions.map((item, index) => (
            <button
              key={`${item.header}-${index}`}
              type="button"
              className={page === index ? "is-active" : undefined}
              onClick={() => setPage(index)}
              disabled={questionnaire.submitting}
            >
              {index + 1}. {item.header}
            </button>
          ))}
          <button type="button" className={isReview ? "is-active" : undefined} onClick={() => setPage(questionnaire.questions.length)} disabled={questionnaire.submitting}>
            {t("chat.askReview")}
          </button>
        </div>

        <div className="ask-questionnaire-body">
          {isReview ? (
            <>
              <h2>{t("chat.askReview")}</h2>
              <div className="ask-questionnaire-review">
                {questionnaire.questions.map((item, index) => {
                  const answer = answers[index];
                  const text = answer?.kind === "custom"
                    ? answer.text
                    : answer?.kind === "options"
                      ? answer.optionIndexes.length > 0
                        ? answer.optionIndexes.map((optionIndex) => item.options[optionIndex]?.label).filter(Boolean).join(", ")
                        : t("chat.askNoSelection")
                      : t("chat.askUnanswered");
                  return (
                    <button key={`${item.header}-${index}`} type="button" onClick={() => setPage(index)} disabled={questionnaire.submitting}>
                      <span>{index + 1}. {item.question}</span>
                      <strong>{text || t("chat.askUnanswered")}</strong>
                      <small>{t("chat.askEdit")}</small>
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <div className="ask-questionnaire-heading">
                <span>{question.header}</span>
                <small>{t("chat.askQuestionProgress", { current: page + 1, total: questionnaire.questions.length })}</small>
              </div>
              <h2>{question.question}</h2>
              <div className={`ask-questionnaire-options${question.multiSelect ? " is-multi" : ""}`}>
                {question.options.map((option, optionIndex) => {
                  const selected = currentAnswer?.kind === "options" && currentAnswer.optionIndexes.includes(optionIndex);
                  return (
                    <button
                      key={`${option.label}-${optionIndex}`}
                      type="button"
                      className={selected ? "is-selected" : undefined}
                      onClick={() => {
                        if (!question.multiSelect) {
                          setAnswer({ kind: "options", optionIndexes: [optionIndex] });
                          return;
                        }
                        const indexes = currentAnswer?.kind === "options" ? currentAnswer.optionIndexes : [];
                        setAnswer({
                          kind: "options",
                          optionIndexes: selected
                            ? indexes.filter((value) => value !== optionIndex)
                            : [...indexes, optionIndex],
                        });
                      }}
                      disabled={questionnaire.submitting}
                    >
                      <span className="ask-questionnaire-choice">{selected ? "✓" : ""}</span>
                      <span><strong>{option.label}</strong><small>{option.description}</small></span>
                      {option.preview && <pre>{normalizeAskQuestionnairePreview(option.preview)}</pre>}
                    </button>
                  );
                })}
                <textarea
                  value={currentAnswer?.kind === "custom" ? currentAnswer.text : ""}
                  onChange={(event) => setAnswer({ kind: "custom", text: event.target.value })}
                  placeholder={t("chat.askCustomPlaceholder")}
                  aria-label={t("chat.askCustomPlaceholder")}
                  disabled={questionnaire.submitting}
                />
              </div>
            </>
          )}
          {questionnaire.error && <div className="ask-questionnaire-error">{questionnaire.error}</div>}
        </div>

        <div className="ask-questionnaire-actions">
          <button type="button" onClick={onCancel} disabled={questionnaire.submitting}>{t("chat.cancel")}</button>
          <div>
            {page > 0 && <button type="button" onClick={() => setPage((value) => value - 1)} disabled={questionnaire.submitting}>{t("chat.askPrevious")}</button>}
            {isReview ? (
              <button
                type="button"
                className="is-primary"
                disabled={questionnaire.submitting || answers.some((answer, index) => !isAnswerComplete(answer, index))}
                onClick={() => onSubmit(answers as AskQuestionnaireAnswer[])}
              >
                {questionnaire.submitting ? t("chat.askSubmitting") : t("chat.askSubmit")}
              </button>
            ) : (
              <button
                type="button"
                className="is-primary"
                disabled={questionnaire.submitting || !canContinue}
                onClick={() => setPage((value) => value + 1)}
              >
                {page === questionnaire.questions.length - 1 ? t("chat.askReview") : t("chat.askNext")}
              </button>
            )}
          </div>
        </div>
    </div>
  );
}
