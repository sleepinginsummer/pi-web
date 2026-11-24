import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { Script, createContext } from "node:vm";
import { createJiti } from "jiti";

const store = await createJiti(import.meta.url).import("../lib/draft-store.ts");
const sources = await Promise.all(["./useAgentSession.ts", "./useSessionNavigation.ts", "../components/ChatInput.tsx"].map(path => readFile(new URL(path, import.meta.url), "utf8")));
const asts = sources.map((source, index) => ts.createSourceFile(`fixture-${index}.tsx`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
function find(ast, predicate) {
  if (predicate(ast)) return ast;
  return ts.forEachChild(ast, node => find(node, predicate));
}
function callback(ast, name, context) {
  const declaration = find(ast, node => ts.isVariableDeclaration(node) && node.name.getText(ast) === name);
  assert.ok(declaration, name);
  return compile(`(${declaration.initializer.arguments[0].getText(ast)})`, context);
}
function compile(source, context) {
  return new Script(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText).runInContext(context);
}

for (const edited of [false, true]) test(`前台暂存首发${edited ? "保留尚未写回的新输入" : "清除迁移源且不被 key 切换写回"}`, () => {
  const sourceKey = "new:/handoff-a";
  const targetKey = "handoff-session";
  const original = { value: "发送前草稿", images: [{ data: "original", mimeType: "image/png" }], textAttachment: "原文本附件" };
  const updated = { value: "等待期间新输入", images: [{ data: "new", mimeType: "image/png" }], textAttachment: "新文本附件" };
  store.clearDraft(targetKey);
  store.setDraft(sourceKey, original);
  const transfer = store.captureDraftTransfer(sourceKey);
  const shown = edited ? updated : original;
  const noOp = () => {};
  const context = createContext({
    ...store, isNew: true, newSessionCwd: "/handoff-a", sessionIdRef: { current: targetKey },
    newSessionPromotedRef: { current: false }, isNavigationActive: () => true, navigationKey: 1,
    draftKeyRef: { current: sourceKey }, textareaRef: { current: { value: shown.value } }, valueRef: { current: shown.value },
    attachedImagesRef: { current: shown.images }, textAttachmentRef: { current: shown.textAttachment },
    imageToDraftImage: image => ({ data: image.data, mimeType: image.mimeType }),
    activeSessionIdRef: { current: null }, invalidateWorkspaceRestore: noOp, invalidateNotificationNavigation: noOp,
    releaseNewSessionMaterialization: noOp, setNewSessionCwd: noOp, setPendingNewSessions: noOp,
    clearPendingNewSessionControl: noOp, setSelectedSession: noOp, requestSidebarLocate: noOp,
    setTabOpenSession: noOp, onRefresh: noOp, hydrateSelectedSession: noOp, replaceSessionUrl: noOp,
    onSessionCreatedInBackground: () => assert.fail("前台确认不应走后台"),
  });
  const prepareNode = find(asts[2], node => ts.isMethodDeclaration(node) && node.name.getText(asts[2]) === "prepareDraftKeyChange");
  const prepare = compile(`(function(sourceKey) ${prepareNode.body.getText(asts[2])})`, context);
  context.opts = { chatInputRef: { current: { prepareDraftKeyChange: prepare, clearAcceptedPrompt: () => assert.fail("暂存首发不能无条件清输入") } } };
  context.onSessionCreated = callback(asts[1], "sessionCreated", context);
  callback(asts[0], "promoteNewSession", context)(1, "发送的暂存消息", true, transfer);
  assert.deepEqual(store.getDraft(targetKey), original);
  assert.deepEqual(store.getDraft(sourceKey), edited ? updated : null);

  // 执行生产输入框的 key-change effect，确认它不会重新写回已交出的旧键。
  const keyChange = find(asts[2], node => ts.isCallExpression(node) && node.expression.getText(asts[2]) === "useEffect" && node.arguments[0]?.getText(asts[2]).includes("const previousDraftKey = draftKeyRef.current"));
  Object.assign(context, {
    draftKey: targetKey, setValue: noOp, setTextAttachment: noOp, setImageAttachmentError: noOp,
    setAtQuery: noOp, setHistoryMenuOpen: noOp, setAttachedImages: noOp,
  });
  compile(`(${keyChange.arguments[0].getText(asts[2])})`, context)();
  assert.deepEqual(store.getDraft(sourceKey), edited ? updated : null);
  assert.deepEqual(store.getDraft(targetKey), original);
  store.clearDraft(sourceKey);
  store.clearDraft(targetKey);
});

for (const handoff of ["same", "new-key", "detached", "unmounted", "cleared-source"]) test(`图片读取迟到时按开始草稿归属处理：${handoff}`, async () => {
  const sourceKey = `new:/image-${handoff}`;
  const targetKey = `image-target-${handoff}`;
  const current = { value: "原键最新正文", images: [{ data: "existing", mimeType: "image/png" }], textAttachment: "最新文本附件" };
  store.setDraft(sourceKey, current);
  store.setDraft(targetKey, { value: "新会话草稿", images: [] });
  const readers = [];
  const revoked = [];
  let displayed = [];
  const context = createContext({
    ...store, compact: false, MAX_ATTACHED_IMAGES: 8, MAX_ATTACHED_IMAGE_BYTES: 1024,
    attachedImagesRef: { current: [] }, pendingImageCountRef: { current: 0 },
    imageReaderMountedRef: { current: true }, draftKeyRef: { current: sourceKey },
    t: key => key, console, setImageAttachmentError() {},
    setAttachedImagesState: update => { displayed = typeof update === "function" ? update(displayed) : update; },
    imageToDraftImage: image => ({ data: image.data, mimeType: image.mimeType }),
    revokeImagePreview: image => revoked.push(image.previewUrl),
    URL: { createObjectURL: () => "blob:late-image" },
    FileReader: class { constructor() { readers.push(this); } readAsDataURL() {} },
  });
  context.setAttachedImages = callback(asts[2], "setAttachedImages", context);
  const pending = callback(asts[2], "processImageFiles", context)([{ type: "image/png", size: 10 }]);
  assert.equal(readers.length, 1);
  if (handoff === "new-key" || handoff === "cleared-source") context.draftKeyRef.current = targetKey;
  if (handoff === "detached") context.draftKeyRef.current = undefined;
  if (handoff === "unmounted") context.imageReaderMountedRef.current = false;
  if (handoff === "cleared-source") store.clearDraft(sourceKey);
  readers[0].result = "data:image/png;base64,late-image";
  readers[0].onload();
  await pending;
  if (handoff === "same") {
    assert.equal(displayed.length, 1);
    assert.equal(displayed[0].data, "late-image");
    assert.equal(revoked.length, 0);
  } else {
    assert.equal(displayed.length, 0, "迟到图片不能加入新输入框");
    const saved = store.getDraft(sourceKey);
    assert.equal(saved.images.at(-1).data, "late-image");
    assert.equal(saved.value, handoff === "cleared-source" ? "" : current.value);
    assert.equal(store.getDraft(targetKey).images.length, 0);
    assert.deepEqual(revoked, ["blob:late-image"]);
  }
  assert.equal(context.pendingImageCountRef.current, 0);
  store.clearDraft(sourceKey);
  store.clearDraft(targetKey);
});

test("删除、清空和草稿切换在 React 提交前同步更新同一份附件引用", () => {
  const oldKey = "new:/image-sync-old";
  const newKey = "session:image-sync-new";
  const first = { data: "first", mimeType: "image/png", previewUrl: "blob:first" };
  const second = { data: "second", mimeType: "image/png", previewUrl: "blob:second" };
  const pendingStates = [];
  const revoked = [];
  store.setDraft(newKey, { value: "新草稿", images: [{ data: "stored", mimeType: "image/png" }] });
  const context = createContext({
    ...store, draftKey: newKey, draftKeyRef: { current: oldKey },
    valueRef: { current: "旧草稿" }, textAttachmentRef: { current: null },
    attachedImagesRef: { current: [first, second] },
    setAttachedImagesState: state => pendingStates.push(state),
    revokeImagePreview: image => revoked.push(image.previewUrl),
    imageToDraftImage: ({ data, mimeType }) => ({ data, mimeType }),
    draftImagesToAttachedImages: images => (images ?? []).map(image => ({ ...image, previewUrl: `data:${image.mimeType};base64,${image.data}` })),
    setValue() {}, setTextAttachment() {}, setAtQuery() {}, setImageAttachmentError() {}, setHistoryMenuOpen() {},
    textareaRef: { current: null },
  });
  context.setAttachedImages = callback(asts[2], "setAttachedImages", context);
  callback(asts[2], "removeImage", context)(0);
  assert.strictEqual(context.attachedImagesRef.current[0], second);
  callback(asts[2], "clearImages", context)();
  assert.equal(context.attachedImagesRef.current.length, 0);
  assert.deepEqual(revoked, ["blob:first", "blob:second"]);
  const keyEffect = find(asts[2], node => ts.isCallExpression(node) && node.expression.getText(asts[2]) === "useEffect"
    && node.arguments[0]?.getText(asts[2]).includes("const previousDraftKey = draftKeyRef.current;"));
  compile(`(${keyEffect.arguments[0].getText(asts[2])})`, context)();
  assert.equal(context.attachedImagesRef.current[0].data, "stored");
  assert.equal(store.getDraft(oldKey).images.length, 0, "清空后切键不能保存旧附件");
  assert.strictEqual(pendingStates.at(-1), context.attachedImagesRef.current);
  store.clearDraft(oldKey);
  store.clearDraft(newKey);
});
for (const renderText of [false, true]) test(`图片读完后${renderText ? "先插入正文渲染" : "尚未提交 React"}，交接仍保存到源草稿`, async () => {
  const sourceKey = "new:/image-before-commit";
  const targetKey = "image-before-commit-session";
  const original = { value: "原输入", images: [], textAttachment: "原文本" };
  store.setDraft(sourceKey, original);
  store.clearDraft(targetKey);
  const transfer = store.captureDraftTransfer(sourceKey);
  const readers = [];
  const pendingStates = [];
  const context = createContext({
    ...store, compact: false, MAX_ATTACHED_IMAGES: 8, MAX_ATTACHED_IMAGE_BYTES: 1024,
    attachedImagesRef: { current: [] }, pendingImageCountRef: { current: 0 },
    imageReaderMountedRef: { current: true }, draftKeyRef: { current: sourceKey },
    textareaRef: { current: { value: original.value } }, valueRef: { current: original.value }, textAttachmentRef: { current: original.textAttachment },
    t: key => key, console, setImageAttachmentError() {},
    // 故意只记录状态，不运行 render，也不执行函数式 updater。
    setAttachedImagesState: state => pendingStates.push(state),
    imageToDraftImage: image => ({ data: image.data, mimeType: image.mimeType }),
    revokeImagePreview() {}, URL: { createObjectURL: () => "blob:before-commit" },
    FileReader: class { constructor() { readers.push(this); } readAsDataURL() {} },
  });
  context.setAttachedImages = callback(asts[2], "setAttachedImages", context);
  const pending = callback(asts[2], "processImageFiles", context)([{ type: "image/png", size: 10 }]);
  readers[0].result = "data:image/png;base64,before-commit";
  readers[0].onload();
  await pending;
  assert.equal(pendingStates.length, 1);
  if (renderText) {
    Object.assign(context, { value: "高优先级正文更新", textAttachment: original.textAttachment, attachedImages: [] });
    // 执行生产组件 render 中的引用同步段，此时附件 state 仍是旧数组。
    const start = sources[2].indexOf("  valueRef.current = value;");
    const end = sources[2].indexOf("  textAttachmentRef.current = textAttachment;", start) + "  textAttachmentRef.current = textAttachment;".length;
    compile(`(() => { ${sources[2].slice(start, end)} })`, context)();
    context.textareaRef.current.value = context.value;
    assert.equal(context.attachedImagesRef.current.length, 1, "正文渲染不能用旧附件 state 覆盖交接引用");
  }
  const prepareNode = find(asts[2], node => ts.isMethodDeclaration(node) && node.name.getText(asts[2]) === "prepareDraftKeyChange");
  compile(`(function(sourceKey) ${prepareNode.body.getText(asts[2])})`, context)(sourceKey);
  transfer(targetKey);
  assert.equal(store.getDraft(sourceKey).images[0].data, "before-commit");
  assert.equal(store.getDraft(sourceKey).value, renderText ? "高优先级正文更新" : original.value);
  assert.deepEqual(store.getDraft(targetKey), original);
  store.clearDraft(sourceKey);
  store.clearDraft(targetKey);
});

test("旧订阅尚未清理时也不能处理已交出草稿键的图片通知", () => {
  const sourceKey = "new:/image-old-subscription";
  let delivered = 0;
  const context = createContext({
    ...store, draftKey: sourceKey, draftKeyRef: { current: sourceKey },
    subscribedDraftKeyRef: { current: sourceKey }, initialRecallRevisionRef: { current: 0 },
    prependDraft: () => { delivered += 1; }, adoptStoredDraft() {},
  });
  const effect = find(asts[2], node => ts.isCallExpression(node) && node.expression.getText(asts[2]) === "useEffect" && node.arguments[0]?.getText(asts[2]).includes("return subscribeRecalledDraft"));
  const unsubscribe = compile(`(${effect.arguments[0].getText(asts[2])})`, context)();
  context.draftKeyRef.current = undefined;
  store.notifyRecalledDraft(sourceKey, { value: "", images: [{ data: "late", mimeType: "image/png" }] });
  assert.equal(delivered, 0);
  context.draftKeyRef.current = "another-session";
  store.notifyRecalledDraft(sourceKey, { value: "", images: [] });
  assert.equal(delivered, 0);
  context.draftKeyRef.current = sourceKey;
  store.notifyRecalledDraft(sourceKey, { value: "", images: [] });
  assert.equal(delivered, 1, "仍持有源键的当前订阅正常接收");
  unsubscribe();
});
