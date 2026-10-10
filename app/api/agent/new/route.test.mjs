import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("新会话思考等级复用共享守卫且不接受 auto", () => {
  assert.match(source, /import \{ isThinkingLevel, type ThinkingLevel \} from "@\/lib\/thinking-levels"/);
  assert.match(source, /if \(isThinkingLevel\(value\)\) return value/);
  assert.doesNotMatch(source, /const THINKING_LEVELS/);
});

test("auto 通过省略 thinkingLevel 字段表达", () => {
  assert.match(source, /\.\.\.\(explicitThinkingLevel \? \{ thinkingLevel: explicitThinkingLevel \} : \{\}\)/);
});

test("新会话仅在显式关闭时初始化 Shadow，失败时返回同一 runtime", () => {
  assert.match(source, /if \(shadowMindEnabled === false\)/);
  assert.match(source, /session\.send\(\{ type: "set_shadow_mind_enabled", enabled: false \}\)/);
  assert.match(source, /kind: "initialization-failed"/);
  assert.match(source, /sessionId: realSessionId/);
  assert.match(source, /satisfies NewSessionMaterializationResult/);
  assert.match(source, /operation === "finalize-existing"/);
  assert.match(source, /wrapper\.sessionId !== requestedSessionId/);
  assert.match(source, /realpathSync\(wrapper\.cwd\) !== realpathSync\(cwd\)/);
  assert.match(source, /kind: "materialization-failed"/);
  assert.ok(
    source.indexOf('type: "set_shadow_mind_enabled"') < source.indexOf("const state = await session.send"),
    "Shadow 预设必须先于首条 prompt 和状态返回生效",
  );
});

test("ensure_session 创建阶段先返回 runtime 身份，不等待审批或 get_state", () => {
  const created = source.slice(
    source.indexOf('if (operation === "create" && promptCommand.type === "ensure_session")'),
    source.indexOf('if (operation === "finalize-existing" && toolNames)'),
  );
  assert.match(created, /kind: "runtime-created"/);
  assert.match(created, /sessionId: realSessionId/);
  assert.match(created, /return NextResponse\.json/);
  assert.doesNotMatch(created, /await session\.send/);
  assert.ok(source.indexOf('kind: "runtime-created"') < source.indexOf('type: "set_shadow_mind_enabled"'));
});

test("创建幂等：同一个 operationId 的并发与重试共享一次创建", async () => {
  const route = await readFile(new URL("./route.ts", import.meta.url), "utf8");
  const registry = await readFile(new URL("../../../../lib/new-session-operation-registry.ts", import.meta.url), "utf8");

  // 路由只调用注册表的单一幂等边界：查找、在途登记、交付与失败清理都在注册表内。
  assert.match(route, /registry\.peekDelivered\(requestedOperationId, cwd\)/);
  assert.match(route, /registry\.getOrCreate\(requestedOperationId, cwd, async \(\) => \{/);
  assert.match(route, /if \(delivered && getRpcSession\(delivered\)\?\.isAlive\(\)\)/);
  // 已交付但已失效（例如被空闲回收）时要先清条目，重试才会重新创建。
  assert.match(route, /registry\.forgetIfUnusable\(requestedOperationId, cwd, \(sessionId\) => getRpcSession\(sessionId\)\?\.isAlive\(\) === true\)/);
  assert.match(route, /kind: "runtime-created",\n\s+sessionId: delivered,/);
  // 幂等只在创建阶段生效；finalize 必须按 sessionId 走。
  assert.match(route, /const createsNewSession = operation === "create" && promptCommand\.type === "ensure_session";/);
  assert.doesNotMatch(route, /operationRegistry\.remember/, "在途创建由注册表拥有，路由不再自己登记");
  // operationId 是 pi-web 的请求字段，不能透传给 SDK 命令。
  assert.match(route, /operationId, provider, modelId, toolNames/);

  // 注册表必须先同步登记在途 Promise，再执行 factory；否则并发请求会各建一个 runtime。
  const getOrCreate = registry.slice(registry.indexOf("getOrCreate("));
  assert.ok(getOrCreate.indexOf("entry.promise = create()") < getOrCreate.indexOf("this.operations.set(operationId, entry)"));
  assert.match(registry, /if \(existing.cwd !== cwd\)/);
  // globalThis 只放纯数据表，每次加载用当前实现包装：HMR 不能把旧方法留在内存里。
  assert.match(registry, /globalThis\.__piNewSessionOperationsData/);
  assert.match(registry, /return new NewSessionOperationRegistry\(data\)/);
  assert.doesNotMatch(registry, /globalThis\.__piNewSessionOperations\b/);
});
