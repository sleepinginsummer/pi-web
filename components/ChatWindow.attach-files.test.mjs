import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url);
const { splitDroppedItems } = await jiti.import("../lib/file-upload-client.ts");
const { buildAtMentionText: buildMention } = await jiti.import("../lib/file-fuzzy.ts");

const sourceText = readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("ChatWindow.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** Runs one of ChatWindow's useCallback bodies against the given scope. */
function chatWindowCallback(name, context) {
  function findCallback(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      return node.initializer.arguments[0];
    }
    return ts.forEachChild(node, findCallback);
  }
  return new Script(ts.transpileModule(findCallback(source).getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText).runInNewContext(context);
}

const photo = new File(["x"], "photo.png", { type: "image/png" });
const report = new File(["x"], "report.pdf", { type: "application/pdf" });
const log = new File(["x"], "server.log", { type: "" });

/** Picks files with the composer's attach button, through ChatWindow's real drop path. */
async function attach(files, { cwd = "/project", response, target = "/Users/them/Downloads", targetError } = {}) {
  const calls = { images: [], uploads: [], mentions: [], notices: [], refreshed: 0 };
  const scope = {
    session: cwd === null ? null : { cwd },
    newSessionCwd: cwd,
    chatInputRef: {
      current: {
        addImages: (images) => calls.images.push(...images),
        insertText: (text) => calls.mentions.push(text),
      },
    },
    addNotice: (notice) => calls.notices.push([notice.type, notice.message]),
    t: (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
    onFilesUploaded: () => { calls.refreshed += 1; },
    splitDroppedItems,
    buildAtMentionText: buildMention,
    resolveUploadTarget: async () => {
      if (targetError) throw targetError;
      return target;
    },
    uploadFiles: async (directory, uploads, strategy) => {
      calls.uploads.push([directory, uploads.map((file) => file.name), strategy]);
      return response;
    },
  };
  scope.uploadDroppedFiles = chatWindowCallback("uploadDroppedFiles", scope);
  scope.onDrop = chatWindowCallback("onDrop", scope);
  chatWindowCallback("onAttachFiles", scope)(files);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return calls;
}

test("the attach button sends picked files to the downloads folder, never replacing one (#1101)", async () => {
  const downloadedAt = "/Users/them/Downloads";
  const mixed = await attach([photo, report, log], {
    response: {
      status: 200,
      data: {
        uploaded: ["report (1).pdf", "server.log"],
        paths: [`${downloadedAt}/report (1).pdf`, `${downloadedAt}/server.log`],
      },
    },
  });
  // 图片仍附到消息；其余进下载目录，重名不覆盖（rename），按服务端给的绝对路径 @ 引用。
  assert.deepEqual(mixed.images, [photo]);
  assert.deepEqual(mixed.uploads, [[downloadedAt, ["report.pdf", "server.log"], "rename"]]);
  // 改名后的 "report (1).pdf" 带空格，所以加引号；server.log 不用。
  assert.deepEqual(mixed.mentions, [`@"${downloadedAt}/report (1).pdf" @${downloadedAt}/server.log `]);
  assert.deepEqual(mixed.notices, [
    ["info", 'chat.dropUploading {"count":2}'],
    ["success", 'chat.dropUploaded {"count":2}'],
  ]);
  assert.equal(mixed.refreshed, 1);

  // 带空格的名字要加引号，否则模型看到的路径会被拆成两个词。
  const spaced = await attach([report], {
    response: { status: 200, data: { uploaded: ["my report.pdf"], paths: [`${downloadedAt}/my report.pdf`] } },
  });
  assert.deepEqual(spaced.mentions, [`@"${downloadedAt}/my report.pdf" `]);

  const imagesOnly = await attach([photo]);
  assert.deepEqual(imagesOnly.images, [photo]);
  assert.deepEqual(imagesOnly.uploads, []);
  assert.deepEqual(imagesOnly.notices, []);
});

test("picked files no longer need a session working directory (#1101)", async () => {
  const calls = await attach([photo, report], {
    cwd: null,
    response: { status: 200, data: { uploaded: ["report.pdf"], paths: ["/Users/them/Downloads/report.pdf"] } },
  });
  assert.deepEqual(calls.uploads, [["/Users/them/Downloads", ["report.pdf"], "rename"]]);
  assert.deepEqual(calls.notices.map(([type]) => type), ["info", "success"]);
});

test("a failed upload reports one error and still keeps the picked images", async () => {
  const failed = await attach([photo, report], { response: { status: 413, data: { error: "too big" } } });
  assert.deepEqual(failed.images, [photo]);
  assert.deepEqual(failed.mentions, []);
  assert.deepEqual(failed.notices.at(-1), ["error", 'chat.dropFailed {"message":"too big"}']);

  // 跨 realm 的 Error 不满足 instanceof，按字符串落进提示（真实浏览器里是同一个 realm）。
  const noTarget = await attach([report], { targetError: new Error("offline") });
  assert.deepEqual(noTarget.notices.at(-1), ["error", 'chat.dropFailed {"message":"Error: offline"}']);
  assert.deepEqual(noTarget.uploads, []);
});

