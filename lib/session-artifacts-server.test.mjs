import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  listExistingSessionArtifactPaths,
  listSessionArtifacts,
  verifySessionArtifactForDeletion,
} = await jiti.import("./session-artifacts-server.ts");
const { recordSessionArtifactTargets } = await jiti.import("./session-artifact-targets.ts");

const SESSION_ID = "00000000-0000-0000-0000-000000000001";

function createTempWorkspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-web-artifacts-auth-")));
  const projectA = join(root, "project-a");
  const projectB = join(root, "project-b");
  const targetStoreDir = join(root, "targets");
  mkdirSync(join(projectA, "out"), { recursive: true });
  mkdirSync(projectB, { recursive: true });
  return { root, projectA, projectB, targetStoreDir };
}

/**
 * 使用 SDK 原始持久化格式（toolCall 字段为 id/name/arguments，而非已归一化的 toolCallId/toolName/input），
 * 验证服务端直接读取原始会话条目时的聚合、存在性过滤和删除授权逻辑。
 */
function makeRawSdkSessionEntries(projectA, projectB) {
  const writtenPath = join(projectA, "out", "report.md");
  const failedWritePath = join(projectA, "failed.md");
  const nestedErrorPath = join(projectA, "nested-error.md");
  const mentionedOnlyPath = join(projectA, "mentioned.md");
  const otherProjectPath = join(projectB, "secret.txt");

  const entries = [
    {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "2026-11-25T00:00:00.000Z",
      message: {
        role: "assistant",
        timestamp: 1000,
        content: [
          { type: "text", text: `Please check ${mentionedOnlyPath} and ${otherProjectPath}.` },
          // 原始 SDK 字段：id / name / arguments
          { type: "toolCall", id: "tc-ok", name: "write", arguments: { path: "out/report.md", content: "ok" } },
          { type: "toolCall", id: "tc-fail", name: "write", arguments: { path: "failed.md", content: "no" } },
          { type: "toolCall", id: "tc-code", name: "codemode", arguments: { code: "..." } },
          {
            type: "toolCall",
            id: "tc-web",
            name: "mcp__magpie_artifacts",
            arguments: { tool: "publish_artifact", args: JSON.stringify({ title: "Demo Page", entry: "demo.html" }) },
          },
        ],
      },
    },
    {
      type: "message",
      id: "m2",
      parentId: "m1",
      timestamp: "2026-11-25T00:00:01.000Z",
      message: {
        role: "toolResult",
        toolCallId: "tc-ok",
        toolName: "write",
        isError: false,
        timestamp: 1001,
        content: [{ type: "text", text: "ok" }],
      },
    },
    {
      type: "message",
      id: "m3",
      parentId: "m2",
      timestamp: "2026-11-25T00:00:02.000Z",
      message: {
        role: "toolResult",
        toolCallId: "tc-fail",
        toolName: "write",
        isError: true,
        timestamp: 1002,
        content: [{ type: "text", text: "permission denied" }],
      },
    },
    {
      type: "message",
      id: "m4",
      parentId: "m3",
      timestamp: "2026-11-25T00:00:03.000Z",
      message: {
        role: "toolResult",
        toolCallId: "tc-code",
        toolName: "codemode",
        isError: false,
        timestamp: 1003,
        nestedCalls: {
          calls: [
            { id: "n1", name: "write", arguments: { path: nestedErrorPath }, status: "error", error: "boom" },
            { id: "n2", name: "write", arguments: { path: otherProjectPath }, status: "unfinished" },
          ],
        },
        content: [{ type: "text", text: "done" }],
      },
    },
    {
      type: "message",
      id: "m5",
      parentId: "m4",
      timestamp: "2026-11-25T00:00:04.000Z",
      message: {
        role: "toolResult",
        toolCallId: "tc-web",
        toolName: "mcp__magpie_artifacts",
        isError: false,
        timestamp: 1004,
        content: [{ type: "text", text: JSON.stringify({ id: "art1demo", url: "http://127.0.0.1:3425/a/art1demo/", version: 1, title: "Demo Page" }) }],
      },
    },
  ];

  return {
    entries,
    writtenPath,
    failedWritePath,
    nestedErrorPath,
    mentionedOnlyPath,
    otherProjectPath,
  };
}

test("verifySessionArtifactForDeletion rejects missing sessions with 404", async () => {
  const { root, projectA, targetStoreDir } = createTempWorkspace();
  try {
    const filePath = join(projectA, "any.md");
    writeFileSync(filePath, "hello");
    const result = await verifySessionArtifactForDeletion(SESSION_ID, filePath, {
      loader: async () => null,
      targetStoreDir,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw SDK entries: listSessionArtifacts returns full active-branch local and web artifacts and handles delete+recreate", async () => {
  const { root, projectA, projectB, targetStoreDir } = createTempWorkspace();
  try {
    const { entries, writtenPath } = makeRawSdkSessionEntries(projectA, projectB);
    writeFileSync(writtenPath, "written");
    const loader = async () => ({ cwd: projectA, entries });

    const before = await listSessionArtifacts(SESSION_ID, { loader, targetStoreDir });
    assert.equal(before.ok, true);
    assert.deepEqual(before.existingPaths, [writtenPath]);
    assert.equal(before.artifacts.length, 2);
    assert.ok(before.artifacts.some((a) => a.kind === "web" && a.artifactId === "art1demo"));
    assert.ok(before.artifacts.some((a) => a.kind === "doc" && a.path === writtenPath));

    // 删除文件后，存在性查询排除本地产物但保留网页产物
    unlinkSync(writtenPath);
    const deleted = await listSessionArtifacts(SESSION_ID, { loader, targetStoreDir });
    assert.equal(deleted.ok, true);
    assert.deepEqual(deleted.existingPaths, []);
    assert.equal(deleted.artifacts.length, 1);
    assert.equal(deleted.artifacts[0].kind, "web");

    // 同一路径重新生成后，立即恢复出现在列表里
    writeFileSync(writtenPath, "recreated");
    const recreated = await listExistingSessionArtifactPaths(SESSION_ID, loader);
    assert.equal(recreated.ok, true);
    assert.deepEqual(recreated.existingPaths, [writtenPath]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifySessionArtifactForDeletion enforces raw SDK authorship and blocks non-artifacts and direct symlinks", async () => {
  const { root, projectA, projectB, targetStoreDir } = createTempWorkspace();
  try {
    const {
      entries,
      writtenPath,
      failedWritePath,
      nestedErrorPath,
      mentionedOnlyPath,
      otherProjectPath,
    } = makeRawSdkSessionEntries(projectA, projectB);

    writeFileSync(writtenPath, "written");
    writeFileSync(failedWritePath, "failed");
    writeFileSync(nestedErrorPath, "nested");
    writeFileSync(mentionedOnlyPath, "mentioned");
    writeFileSync(otherProjectPath, "secret");

    const symlinkPath = join(projectA, "out", "report-link.md");
    symlinkSync(writtenPath, symlinkPath);

    const loader = async (id) => (id === SESSION_ID ? { cwd: projectA, entries } : null);
    const opts = { loader, targetStoreDir };

    // 1. 本会话成功写出的真实本地文件允许删除（原始 SDK 格式 id/name/arguments）
    const ok = await verifySessionArtifactForDeletion(SESSION_ID, writtenPath, opts);
    assert.equal(ok.ok, true);
    assert.equal(ok.matchedArtifact.name, "report.md");

    // 2. 仅在对话正文中提及的文件拒绝删除
    const mentioned = await verifySessionArtifactForDeletion(SESSION_ID, mentionedOnlyPath, opts);
    assert.equal(mentioned.ok, false);
    assert.equal(mentioned.status, 403);

    // 3. 其他项目目录中的未关联文件拒绝删除
    const other = await verifySessionArtifactForDeletion(SESSION_ID, otherProjectPath, opts);
    assert.equal(other.ok, false);
    assert.equal(other.status, 403);

    // 4. 写入失败的工具调用以及失败/未完成的嵌套写入均拒绝删除
    const failed = await verifySessionArtifactForDeletion(SESSION_ID, failedWritePath, opts);
    assert.equal(failed.ok, false);
    assert.equal(failed.status, 403);

    const nestedErr = await verifySessionArtifactForDeletion(SESSION_ID, nestedErrorPath, opts);
    assert.equal(nestedErr.ok, false);
    assert.equal(nestedErr.status, 403);

    // 5. 拒绝符号链接和目录
    const sym = await verifySessionArtifactForDeletion(SESSION_ID, symlinkPath, opts);
    assert.equal(sym.ok, false);
    assert.equal(sym.status, 400);

    const dir = await verifySessionArtifactForDeletion(SESSION_ID, projectA, opts);
    assert.equal(dir.ok, false);
    assert.equal(dir.status, 400);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifySessionArtifactForDeletion blocks parent-directory symlink redirection with and without write-time records", async () => {
  const { root, projectA, projectB, targetStoreDir } = createTempWorkspace();
  try {
    const { entries, writtenPath } = makeRawSdkSessionEntries(projectA, projectB);
    const outDir = join(projectA, "out");
    const victimFile = join(projectB, "report.md");
    writeFileSync(writtenPath, "original");
    writeFileSync(victimFile, "do-not-delete");

    const loader = async () => ({ cwd: projectA, entries });

    // 情况 A：存在写入时刻记录，事后父目录被替换为指向 projectB 的符号链接
    await recordSessionArtifactTargets(SESSION_ID, [writtenPath], targetStoreDir);
    renameSync(outDir, join(projectA, "out-original"));
    symlinkSync(projectB, outDir);

    const redirectedWithRecord = await verifySessionArtifactForDeletion(SESSION_ID, writtenPath, {
      loader,
      targetStoreDir,
    });
    assert.equal(redirectedWithRecord.ok, false);
    assert.equal(redirectedWithRecord.status, 403);
    assert.match(redirectedWithRecord.error, /redirected/i);

    // 情况 B：无写入时刻记录（历史/外部会话），父目录为符号链接同样拒绝
    const emptyStore = join(root, "empty-targets");
    const redirectedWithoutRecord = await verifySessionArtifactForDeletion(SESSION_ID, writtenPath, {
      loader,
      targetStoreDir: emptyStore,
    });
    assert.equal(redirectedWithoutRecord.ok, false);
    assert.equal(redirectedWithoutRecord.status, 403);
    assert.match(redirectedWithoutRecord.error, /redirected/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifySessionArtifactForDeletion allows legitimate symlinked workspace when bound to write-time real target", async () => {
  const { root, projectA, projectB, targetStoreDir } = createTempWorkspace();
  try {
    const linkedWorkspace = join(root, "linked-workspace");
    symlinkSync(projectA, linkedWorkspace);
    const { entries } = makeRawSdkSessionEntries(linkedWorkspace, projectB);
    const logicalFile = join(linkedWorkspace, "out", "report.md");
    const realFile = join(projectA, "out", "report.md");
    writeFileSync(realFile, "written-through-workspace-link");

    // 写入时刻记录了真实目标 realFile
    await recordSessionArtifactTargets(SESSION_ID, [logicalFile], targetStoreDir);

    const loader = async () => ({ cwd: linkedWorkspace, entries });
    const allowed = await verifySessionArtifactForDeletion(SESSION_ID, logicalFile, {
      loader,
      targetStoreDir,
    });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.resolvedPath, realFile);

    // 若事后把子目录 out 重定向到 projectB，则即使在 symlink 工作区内也必须拒绝
    const victimFile = join(projectB, "report.md");
    writeFileSync(victimFile, "victim");
    renameSync(join(projectA, "out"), join(projectA, "out-moved"));
    symlinkSync(projectB, join(projectA, "out"));

    const blocked = await verifySessionArtifactForDeletion(SESSION_ID, logicalFile, {
      loader,
      targetStoreDir,
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, 403);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
