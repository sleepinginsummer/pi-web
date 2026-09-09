import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import { createJiti } from "jiti";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  Node: { configurable: true, value: dom.window.Node },
});

const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { AskQuestionnaire } = await jiti.import("./AskQuestionnaire.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

afterEach(cleanup);

function renderQuestionnaire(questions, onSubmit) {
  return render(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(AskQuestionnaire, {
        questionnaire: {
          toolCallId: "ask-1",
          questions,
          submitting: false,
          error: null,
        },
        onSubmit,
        onCancel() {},
      }),
    ),
  );
}

const singleChoiceQuestion = {
  header: "Style",
  question: "Choose a style",
  multiSelect: false,
  options: [
    { label: "Photo", description: "Use a photo" },
    { label: "Illustration", description: "Use an illustration" },
  ],
};

test("单问题单选点击选项后立即提交且不显示检查答案", () => {
  const submitted = [];
  renderQuestionnaire([singleChoiceQuestion], (answers) => submitted.push(answers));

  assert.equal(screen.queryByText("Review answers"), null);
  fireEvent.click(screen.getByRole("button", { name: /Photo/ }));

  assert.deepEqual(submitted, [[{ kind: "options", optionIndexes: [0] }]]);
});

test("单问题多选通过提交按钮直接提交且不进入检查答案", () => {
  const submitted = [];
  renderQuestionnaire(
    [{ ...singleChoiceQuestion, multiSelect: true }],
    (answers) => submitted.push(answers),
  );

  fireEvent.click(screen.getByRole("button", { name: /Photo/ }));
  fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));

  assert.equal(screen.queryByText("Review answers"), null);
  assert.deepEqual(submitted, [[{ kind: "options", optionIndexes: [0] }]]);
});

test("多问题完成最后一题后仍进入检查答案", () => {
  const submitted = [];
  renderQuestionnaire(
    [singleChoiceQuestion, { ...singleChoiceQuestion, header: "Color", question: "Choose a color" }],
    (answers) => submitted.push(answers),
  );

  fireEvent.click(screen.getByRole("button", { name: /Photo/ }));
  fireEvent.click(screen.getByRole("button", { name: "Next question" }));
  fireEvent.click(screen.getByRole("button", { name: /Illustration/ }));
  const reviewButtons = screen.getAllByRole("button", { name: "Review answers" });
  fireEvent.click(reviewButtons.at(-1));

  assert.equal(screen.getByRole("heading", { name: "Review answers" }).textContent, "Review answers");
  assert.deepEqual(submitted, []);
});
