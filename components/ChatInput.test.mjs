import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ChatInput, ModelDataDiagnosticBanner, ModelErrorBanner, ModelScopeWarningBanner, modelSupportsImageInput } = await jiti.import("./ChatInput.tsx");
const { filterModelOptions } = await jiti.import("./ModelPicker.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { clearDraft, setDraft } = await jiti.import("../lib/draft-store.ts");

const emptyModelState = {
  names: {}, list: [], error: null, scopeWarnings: [], dataDiagnostics: [],
  thinkingLevels: {}, thinkingLevelMaps: {}, newSessionModel: null,
  newSessionDefaultModel: null, thinkingLevel: "auto", model: null,
  isAutoModelSelection: false, availableThinkingLevels: null, thinkingLevelMap: null,
  fastEnabled: false, fastAvailable: false, fastPending: false,
};
const emptyModelActions = {};

test("renders structured model-data diagnostics at the presentation layer", () => {
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null,
      React.createElement(ModelDataDiagnosticBanner, {
        diagnostics: [{ code: "unknown-pin", modelKey: "p/m", level: "future" }],
      })),
  );
  assert.match(html, /Model data warning/);
  assert.match(html, /p\/m/);
  assert.match(html, /future/);
});

test("follow-up shortcuts preserve newline, IME, mobile and completion behavior", () => {
  const source = ts.createSourceFile("ChatInput.tsx", readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function findHandler(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleKeyDown") {
      return node.initializer.arguments[0];
    }
    return ts.forEachChild(node, findHandler);
  }
  // Execute the component's actual callback without mounting the rest of the UI.
  const script = new Script(ts.transpileModule(findHandler(source).getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);
  const cases = [
    ["Enter steers", {}, {}, "steer"],
    ["Alt+Enter follows up", { altKey: true }, {}, "followup"],
    ["idle Alt+Enter sends", { altKey: true }, { isStreaming: false }, "send"],
    ["Shift+Enter inserts a newline", { shiftKey: true }, {}, "native"],
    ["Alt+Shift+Enter keeps native behavior", { altKey: true, shiftKey: true }, {}, "native"],
    ["composition ref blocks sending", { altKey: true }, { isComposingRef: { current: true } }, "native"],
    ["native composition blocks sending", { altKey: true, nativeEvent: { isComposing: true } }, {}, "native"],
    ["IME keyCode blocks sending", { altKey: true, nativeEvent: { keyCode: 229 } }, {}, "native"],
    ["composition grace blocks sending", { altKey: true }, { lastCompositionEndAtRef: { current: 950 } }, "prevented"],
    ["mobile Alt+Enter keeps native behavior", { altKey: true }, { isMobile: true }, "native"],
    ["mobile composition grace cannot send", { altKey: true }, { isMobile: true, lastCompositionEndAtRef: { current: 950 } }, "native"],
    ["mobile Ctrl+Alt+Enter follows up", { altKey: true, ctrlKey: true }, { isMobile: true }, "followup"],
    ["mobile Cmd+Alt+Enter follows up", { altKey: true, metaKey: true }, { isMobile: true }, "followup"],
    ["mobile modified Enter respects composition grace", { altKey: true, ctrlKey: true }, { isMobile: true, lastCompositionEndAtRef: { current: 950 } }, "prevented"],
    ["slash completion takes priority", { altKey: true }, { slashMenuOpen: true, slashQuery: "help" }, "slash"],
    ["file completion takes priority", { altKey: true }, { atMenuOpen: true, atQuery: {} }, "file"],
    ["history selection takes priority", { altKey: true }, { historyMenuOpen: true }, "history"],
  ];
  for (const [name, keys, state, expected] of cases) {
    let action = "native";
    const handler = script.runInNewContext({
      Date: { now: () => 1000 },
      COMPOSITION_END_ENTER_GRACE_MS: 100,
      isMobile: false, isStreaming: true,
      isComposingRef: { current: false }, lastCompositionEndAtRef: { current: 0 },
      historyMenuOpen: false, inputHistory: ["previous"], historyActiveIndex: 0,
      slashMenuOpen: false, slashQuery: null, displayedSlashCommands: [{}], slashActiveIndex: 0,
      atMenuOpen: false, atQuery: null, atMatches: [{}], atActiveIndex: 0,
      onQueuedSubmit() {},
      sendQueued(mode) { action = mode; }, handleSend() { action = "send"; },
      applySlashCommand() { action = "slash"; },
      value: "", setSlashMenuOpen() {},
      applyAtCompletion() { action = "file"; },
      applyHistoryInput() { action = "history"; },
      ...state,
    });
    handler({
      key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
      nativeEvent: { isComposing: false, keyCode: 13 },
      preventDefault() { action = "prevented"; },
      ...keys,
    });
    assert.equal(action, expected, name);
  }
});

test("shows the follow-up shortcut in the button tooltip", () => {
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(ChatInput, {
      onSend() {}, onAbort() {}, onQueuedSubmit: async () => true, isStreaming: true,
      modelState: emptyModelState, modelActions: emptyModelActions,
    })),
  );

  assert.match(html, /title="Queue this message after the agent finishes \(Alt\/Option\+Enter\)"/);
  assert.match(html, /aria-keyshortcuts="Alt\+Enter"/);
});
test("renders the upstream model error", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ModelErrorBanner, {
        error: "Invalid models.json schema:\nproviders.custom.models.0.id must not be empty",
      }),
    ),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Model error/);
  assert.match(html, /providers\.custom\.models\.0\.id must not be empty/);
});

test("does not render an empty model error", () => {
  assert.equal(
    renderToStaticMarkup(
      React.createElement(I18nProvider, null, React.createElement(ModelErrorBanner, { error: null })),
    ),
    "",
  );
});

test("renders enabledModels scope warnings", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ModelScopeWarningBanner, {
        warnings: ['No models match pattern "ghost-gateway/*"'],
      }),
    ),
  );

  assert.match(html, /Model scope warning/);
  assert.match(html, /ghost-gateway/);
  assert.equal(
    renderToStaticMarkup(
      React.createElement(I18nProvider, null, React.createElement(ModelScopeWarningBanner, { warnings: [] })),
    ),
    "",
  );
});

test("keeps the model selector visible when a model error leaves no options", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        modelState: { ...emptyModelState, error: "Invalid models.json schema" },
        modelActions: { changeModel() {} },
        isStreaming: false,
      }),
    ),
  );

  assert.match(html, />No models</);
  assert.match(html, /title="No available models"/);
});

test("renders the compact composer with the standard Send button and no session controls", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        isStreaming: false,
        compact: true,
        modelState: emptyModelState,
        modelActions: emptyModelActions,
      }),
    ),
  );

  assert.match(html, /<textarea/);
  assert.match(html, />Send<\/button>/);
  assert.equal((html.match(/<button\b/g) ?? []).length, 1);
  assert.doesNotMatch(html, /type="file"|Attach image|Change tool preset/);
});

test("filters model options by name and id", () => {
  const options = [
    { provider: "ollama", modelId: "qwen3:latest", name: "Qwen 3" },
    { provider: "anthropic", modelId: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { provider: "openai", modelId: "gpt-5.4", name: "GPT-5.4" },
  ];

  assert.deepEqual(filterModelOptions(options, "QWEN"), [options[0]]);
  assert.deepEqual(filterModelOptions(options, "claude-sonnet"), [options[1]]);
  assert.equal(filterModelOptions(options, "OpenAI").length, 0);
  assert.equal(filterModelOptions(options, "anthropic/claude").length, 0);
  assert.equal(filterModelOptions(options, "missing").length, 0);
  assert.equal(filterModelOptions(options, "  "), options);
});

test("renders compact errors above the input as a wrapping alert", () => {
  const error = "Compaction failed: OpenAI API error (403): <html>request forbidden</html>";
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        modelState: emptyModelState,
        modelActions: emptyModelActions,
        onCompact() {},
        isStreaming: false,
        compactError: error,
      }),
    ),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Compaction failed: OpenAI API error/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
  assert.match(html, /white-space:pre-wrap/);
  assert.ok(html.indexOf('role="alert"') < html.indexOf("<textarea"));
});

test("运行期间允许添加图片，仍校验附件大小和数量", async () => {
  const source = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const processImageSource = source.slice(
    source.indexOf("const processImageFiles = useCallback"),
    source.indexOf("const removeImage = useCallback"),
  );
  const fileInputSource = source.slice(
    source.indexOf('id="chat-attach-input"'),
    source.indexOf("onChange=", source.indexOf('id="chat-attach-input"')),
  );

  assert.doesNotMatch(processImageSource, /isStreaming/);
  assert.doesNotMatch(fileInputSource, /disabled=\{isStreaming\}/);
  assert.match(processImageSource, /file\.size > MAX_ATTACHED_IMAGE_BYTES/);
  assert.match(processImageSource, /chat\.imageAttachmentTooLarge/);
  assert.match(processImageSource, /chat\.imageAttachmentLimit/);
  assert.match(source, /role="alert"[\s\S]*?imageAttachmentError/);
});

test("offers the built-in clone command", async () => {
  const source = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  assert.match(source, /name: "clone", description: "chat\.commandClone"/);
});

test("renders the worktree selector only for a new session", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        modelState: emptyModelState,
        modelActions: emptyModelActions,
        isStreaming: false,
        cwd: "/repo",
        newSessionCwd: "/repo-wt",
        newSessionWorktrees: [
          { path: "/repo", branch: "main", upstreamBranch: "fork/main", upstreamDisplayBranch: "sleepinginsummer/main", isMain: true },
          { path: "/repo-wt", branch: "feature/test", isMain: false },
        ],
      }),
    ),
  );
  assert.match(html, /选择 worktree/);
  assert.match(html, /sleepinginsummer\/main/);
  assert.match(html, /feature\/test/);
  assert.doesNotMatch(html, /主分支/);
});

const thinkingBaseProps = {
  onSend() {}, onAbort() {}, isStreaming: false,
  modelState: { ...emptyModelState, thinkingLevel: "high" },
  modelActions: { changeModel() {}, changeThinkingLevel() {} },
};

test("streaming shows read-only thinking badge before Stop", () => {
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null,
      React.createElement(ChatInput, { ...thinkingBaseProps, isStreaming: true })),
  );
  const badgeIndex = html.indexOf(">high</span>");
  assert.ok(badgeIndex > -1, "badge should show current thinking level");
  const stopIndex = html.indexOf(">Stop<");
  assert.ok(stopIndex > -1, "stop button should render");
  assert.ok(stopIndex > badgeIndex, "badge should appear before stop button");
  const badgeOpen = html.lastIndexOf("<div", badgeIndex);
  const beforeBadge = html.slice(Math.max(0, badgeOpen - 200), badgeOpen);
  assert.ok(!beforeBadge.includes("cursor:pointer"), "badge should not be clickable");
});

test("streaming Fast 会话在思考强度徽标中显示组合状态", () => {
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null,
      React.createElement(ChatInput, {
        ...thinkingBaseProps,
        isStreaming: true,
        modelState: { ...thinkingBaseProps.modelState, thinkingLevel: "low", fastEnabled: true, fastAvailable: true },
      })),
  );
  assert.match(html, />low \+ Fast<\/span>/);
});

test("idle renders the interactive thinking button instead of the badge", () => {
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null,
      React.createElement(ChatInput, thinkingBaseProps)),
  );
  assert.ok(html.includes('aria-label="Change reasoning level"'), "idle thinking button has aria-label");
  assert.ok(!html.includes(">Stop<"), "no stop button when idle");
});

test("Fast 开关通过模型视图状态与动作渲染", () => {
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null,
      React.createElement(ChatInput, {
        ...thinkingBaseProps,
        modelState: { ...thinkingBaseProps.modelState, fastAvailable: true, fastEnabled: true },
        modelActions: { ...thinkingBaseProps.modelActions, changeFastEnabled() {} },
      })),
  );
  assert.match(html, /role="switch"/);
  assert.match(html, /aria-checked="true"/);
  assert.match(html, />Fast</);
});

test("streaming badge shows the mapped level label when thinkingLevelMap is set", () => {
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null,
      React.createElement(ChatInput, {
        ...thinkingBaseProps,
        isStreaming: true,
        modelState: { ...thinkingBaseProps.modelState, thinkingLevelMap: { high: "claude thinking" } },
      })),
  );
  assert.ok(html.includes(">claude thinking</span>"), "badge should show mapped label");
});

test("streaming without thinkingLevel hides the badge but keeps Stop", () => {
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null,
      React.createElement(ChatInput, { ...thinkingBaseProps, isStreaming: true, modelState: { ...thinkingBaseProps.modelState, thinkingLevel: undefined } })),
  );
  assert.ok(!html.includes(">high</span>"), "no badge when thinkingLevel is undefined");
  assert.ok(html.includes(">Stop<"), "stop button still renders");
});

test("clearing an accepted new-session prompt cannot restore its draft", async () => {
  const source = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const clearInputSource = source.slice(
    source.indexOf("const clearInput = useCallback"),
    source.indexOf("useEffect(() =>", source.indexOf("const clearInput = useCallback")),
  );
  const persistStart = source.indexOf("// 发送清空或切换草稿 key 时");
  const persistDraftSource = source.slice(
    persistStart,
    source.indexOf("useEffect(() =>", persistStart + 1),
  );

  assert.match(clearInputSource, /valueRef\.current = "";[\s\S]*?setValue\(""\)/);
  assert.match(clearInputSource, /textareaRef\.current\.value = ""/);
  assert.match(clearInputSource, /attachedImagesRef\.current = \[\]/);
  assert.match(persistDraftSource, /draftKeyRef\.current !== draftKey \|\| valueRef\.current !== value/);
});

test("运行中消息仅在服务端确认后清空，失败保留输入", async () => {
  const source = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const queuedSource = source.slice(
    source.indexOf("const sendQueued = useCallback"),
    source.indexOf("const getNextSlashIndex", source.indexOf("const sendQueued = useCallback")),
  );

  assert.match(queuedSource, /queuedSubmitPendingRef\.current\) return/);
  assert.match(queuedSource, /queuedSubmitPendingRef\.current = true/);
  assert.match(queuedSource, /const submittedImages = \[\.\.\.attachedImages\]/);
  assert.match(queuedSource, /const accepted = await onQueuedSubmit/);
  assert.match(queuedSource, /submittedImages\.length \? submittedImages : undefined/);
  assert.match(queuedSource, /queuedSubmitTokenRef\.current === token/);
  assert.match(queuedSource, /valueRef\.current\.trim\(\) === msg/);
  assert.match(queuedSource, /imagesUnchanged/);
  assert.match(source, /readOnly=\{queuedSubmitPending\}/);
  assert.ok(queuedSource.indexOf("clearInput()") < queuedSource.indexOf("finally"));
});

test("modelSupportsImageInput warns only when modality info is known and lacks image", () => {
  const modelList = [
    { id: "text-only", name: "Text Only", provider: "ollama", input: ["text"] },
    { id: "vision", name: "Vision", provider: "anthropic", input: ["text", "image"] },
    { id: "unknown", name: "Unknown", provider: "custom", input: undefined },
  ];

  assert.equal(modelSupportsImageInput({ provider: "ollama", modelId: "text-only" }, modelList), false);
  assert.equal(modelSupportsImageInput({ provider: "anthropic", modelId: "vision" }, modelList), true);
  // Unknown modality info never blocks the user.
  assert.equal(modelSupportsImageInput({ provider: "custom", modelId: "unknown" }, modelList), true);
  // Model missing from the list is treated as unknown.
  assert.equal(modelSupportsImageInput({ provider: "x", modelId: "missing" }, modelList), true);
  assert.equal(modelSupportsImageInput(null, modelList), true);
  assert.equal(modelSupportsImageInput({ provider: "ollama", modelId: "text-only" }, undefined), true);
});

test("renders image warnings for known text-only defaults without an explicit model selection", () => {
  const draftKey = "new:/tmp/image-warning-default";
  const modelList = [
    { id: "text-only", name: "Text Only", provider: "custom", input: ["text"] },
    { id: "vision", name: "Vision", provider: "custom", input: ["text", "image"] },
    { id: "unknown", name: "Unknown", provider: "custom" },
  ];
  setDraft(draftKey, {
    value: "Describe this image",
    images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
  });

  try {
    for (const [modelId, warningExpected] of [["text-only", true], ["vision", false], ["unknown", false], [null, false]]) {
      const html = renderToStaticMarkup(
        React.createElement(
          I18nProvider,
          null,
          React.createElement(ChatInput, {
            onSend() {},
            onAbort() {},
            isStreaming: false,
            modelState: {
              ...emptyModelState,
              model: modelId ? { provider: "custom", modelId } : null,
              isAutoModelSelection: true,
              list: modelList.map((entry) => ({ ...entry, fastAvailable: false })),
            },
            modelActions: emptyModelActions,
            draftKey,
          }),
        ),
      );

      assert.match(html, /<img/);
      assert.equal(html.includes("Images may not be sent"), warningExpected, `default model: ${modelId}`);
      if (warningExpected) {
        assert.match(html, /The selected model \(Text Only\) does not support image input/);
        assert.ok(html.indexOf('role="alert"') < html.indexOf("<textarea"));
      }
    }
  } finally {
    clearDraft(draftKey);
  }
});
