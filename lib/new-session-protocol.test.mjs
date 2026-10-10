import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { projectExtensionBinding } = await jiti.import("./new-session-protocol.ts");

test("绑定协议投影：失败优先于“布尔值为 false”", () => {
  // 服务端绑定失败时返回的正是 false + 错误文本，不能当成已就绪。
  assert.equal(projectExtensionBinding({ extensionsInitializing: false, extensionsError: "extension failed" }), "failed");
  assert.equal(projectExtensionBinding({ extensionsError: "extension failed" }), "failed");
  assert.equal(projectExtensionBinding({ extensionsInitializing: true, extensionsError: "extension failed" }), "failed");
});

test("绑定协议投影：初始化中与已完成的区分", () => {
  assert.equal(projectExtensionBinding({ extensionsInitializing: true, extensionsError: null }), "binding");
  assert.equal(projectExtensionBinding({ extensionsInitializing: true }), "binding");
  assert.equal(projectExtensionBinding({ extensionsInitializing: false, extensionsError: null }), "bound");
  // 缺字段（例如旧服务端或 Chat only 会话）视为已就绪。
  assert.equal(projectExtensionBinding({}), "bound");
  assert.equal(projectExtensionBinding({ extensionsError: "" }), "bound");
});
