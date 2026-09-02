import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const flyoutSource = await readFile(new URL("./AskInputFlyout.tsx", import.meta.url), "utf8");
const questionnaireSource = await readFile(new URL("./AskQuestionnaire.tsx", import.meta.url), "utf8");
const askDialogSource = await readFile(new URL("./AskDialog.tsx", import.meta.url), "utf8");
const askDialogStyles = await readFile(new URL("./AskDialog.module.css", import.meta.url), "utf8");
const globalStyles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const agentSessionSource = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");

test("multi-question ask supports previous navigation and final review", () => {
  assert.match(questionnaireSource, /chat\.askPrevious/);
  assert.match(questionnaireSource, /chat\.askReview/);
  assert.match(questionnaireSource, /answers\.some\(\(answer, index\) => !isAnswerComplete\(answer, index\)\)/);
  assert.match(questionnaireSource, /onSubmit\(answers as AskQuestionnaireAnswer\[\]\)/);
});

test("单问题结构化 ask 保留问题、描述和预览换行", () => {
  assert.match(agentSessionSource, /questions\.length < 1/);
  assert.doesNotMatch(agentSessionSource, /questions\.length < 2/);
  assert.match(questionnaireSource, /<small>\{option\.description\}<\/small>/);
  assert.match(questionnaireSource, /option\.preview && <pre>\{normalizeAskQuestionnairePreview\(option\.preview\)\}<\/pre>/);
  assert.match(globalStyles, /\.ask-questionnaire-body h2\s*\{[\s\S]*?white-space: pre-wrap/);
  assert.match(globalStyles, /\.ask-questionnaire-options pre\s*\{[\s\S]*?white-space: pre-wrap/);
});

test("ask flyout supports collapse and preserves transcript scrolling", () => {
  assert.match(flyoutSource, /className="ask-input-flyout"/);
  assert.match(flyoutSource, /<AskQuestionnaire/);
  assert.doesNotMatch(chatWindowSource, /ask-questionnaire-backdrop/);
  assert.match(globalStyles, /\.chat-window\s*\{[\s\S]*?--ask-max-height: min\(620px, calc\(100dvh - 150px\)\);[\s\S]*?--ask-gap: 8px;[\s\S]*?--ask-collapsed-height: 44px/);
  assert.match(globalStyles, /\.ask-input-flyout\s*\{[\s\S]*?bottom: calc\(100% \+ var\(--ask-gap\)\);[\s\S]*?pointer-events: none/);
  assert.match(globalStyles, /\.ask-input-flyout-content\s*\{[\s\S]*?pointer-events: auto/);
  assert.match(flyoutSource, /className="ask-collapse-button"[\s\S]*?chat\.askCollapse/);
  assert.match(flyoutSource, /className="ask-collapsed-bar"[\s\S]*?chat\.askExpand/);
  assert.match(chatWindowSource, /<AskInputFlyout[\s\S]*?className=\{`flex-1[\s\S]*?chat-scroll-ask-reserve/);
  assert.doesNotMatch(chatWindowSource, /askCollapseState|askCollapsed/);
  assert.match(globalStyles, /\.chat-scroll-ask-reserve\s*\{[\s\S]*?padding-bottom: calc\(var\(--ask-max-height\) \+ var\(--ask-gap\)\)/);
  assert.match(globalStyles, /\.chat-window:has\(\.ask-input-flyout-content\.is-collapsed\) \.chat-scroll-ask-reserve\s*\{[\s\S]*?padding-bottom: calc\(var\(--ask-collapsed-height\) \+ var\(--ask-gap\)\)/);
  assert.match(globalStyles, /@media \(max-width: 640px\)[\s\S]*?\.chat-window\s*\{[\s\S]*?--ask-max-height: min\(560px, calc\(100dvh - 130px\)\)/);
  assert.match(askDialogSource, /onCollapse[\s\S]*?className=\{styles\.collapse\}/);
  assert.match(askDialogStyles, /\.card\s*\{[\s\S]*?max-height: var\(--ask-max-height\)/);
  assert.doesNotMatch(askDialogStyles, /max-height: min\(/);
  assert.doesNotMatch(globalStyles, /\.ask-questionnaire-backdrop/);
});
