import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { DEFAULT_PENDING_NEW_SESSION_CONTROL, reducePendingNewSession } = await jiti.import("./pending-new-session.ts");
const { latestPendingNewSessionControl, mirrorPendingNewSessionControl, resetPendingNewSessionMirror } = await jiti.import("./pending-new-session-mirror.ts");

test("镜像按 cwd 保存最新草稿，切走再回来重建的实例也能读到", () => {
  resetPendingNewSessionMirror();
  assert.equal(latestPendingNewSessionControl("/work/mirror"), null);

  const model = { provider: "test", modelId: "model-b" };
  const staged = reducePendingNewSession(DEFAULT_PENDING_NEW_SESSION_CONTROL, { type: "SET_MODEL", model });
  mirrorPendingNewSessionControl("/work/mirror", staged);
  // 另一个实例后来才改的设置直接覆盖：创建入口只认最新的一份。
  const changed = reducePendingNewSession(staged, { type: "SET_SHADOW", enabled: true });
  mirrorPendingNewSessionControl("/work/mirror", changed);
  assert.deepEqual(latestPendingNewSessionControl("/work/mirror"), changed);
  // 按 cwd 分开：别的草稿不会串味。
  assert.equal(latestPendingNewSessionControl("/work/other"), null);
  resetPendingNewSessionMirror();
  assert.equal(latestPendingNewSessionControl("/work/mirror"), null);
});
