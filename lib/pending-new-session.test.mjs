import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  DEFAULT_PENDING_NEW_SESSION_CONTROL,
  reducePendingNewSession,
  selectNewSessionRequest,
  selectPendingNewSession,
} = await jiti.import("./pending-new-session.ts");

test("待创建会话按显式事件完成创建状态迁移", () => {
  // 新会话默认关闭 Shadow：不切换任何开关时提交的就是关闭。
  assert.equal(selectPendingNewSession(DEFAULT_PENDING_NEW_SESSION_CONTROL).desiredShadowMindEnabled, false);
  const disabled = reducePendingNewSession(DEFAULT_PENDING_NEW_SESSION_CONTROL, { type: "SET_SHADOW", enabled: false });
  const materializing = reducePendingNewSession(disabled, { type: "START" });
  const ready = reducePendingNewSession(materializing, { type: "READY", sessionId: "session-1" });

  assert.deepEqual(disabled, { kind: "staged", shadowMindEnabled: false, model: null, thinkingLevel: "auto", thinkingLevelSource: "auto" });
  assert.deepEqual(materializing, { kind: "materializing", shadowMindEnabled: false, model: null, thinkingLevel: "auto", thinkingLevelSource: "auto" });
  assert.deepEqual(ready, { kind: "materialized", sessionId: "session-1" });
});

test("待创建会话保留已选模型和思考强度", () => {
  const model = { provider: "test", modelId: "model-a" };
  const selected = reducePendingNewSession(DEFAULT_PENDING_NEW_SESSION_CONTROL, { type: "SET_MODEL", model });
  const configured = reducePendingNewSession(selected, { type: "SET_THINKING_LEVEL", level: "high" });

  assert.deepEqual(configured, {
    kind: "staged",
    shadowMindEnabled: false,
    model,
    thinkingLevel: "high",
    thinkingLevelSource: "manual",
    // 用户自己挑的档位同时推进档位修订号：切换到别的模型时据此判断要不要保留这一档。
    levelRevision: 1,
  });
});

test("切模型时模型和档位一次提交，草稿切走后能分清自动推荐与手动选择", () => {
  const modelA = { provider: "test", modelId: "model-a" };
  const modelB = { provider: "test", modelId: "model-b" };
  const staged = reducePendingNewSession(DEFAULT_PENDING_NEW_SESSION_CONTROL, { type: "SET_MODEL", model: modelA });
  // 只提交模型会留下一段「新模型 + 旧档位」的窗口：用户正好在这时候切走再回来，
  // 重建的组件会把上一个模型的档位套到新模型上。
  const switched = reducePendingNewSession(staged, {
    type: "SET_MODEL",
    model: modelB,
    thinkingLevel: "high",
    thinkingLevelSource: "auto",
  });
  assert.deepEqual(switched, {
    kind: "staged",
    shadowMindEnabled: false,
    model: modelB,
    thinkingLevel: "high",
    thinkingLevelSource: "auto",
  });
  // 来源要跟着身份继续传下去，重新挂载时才知道该把档位填回推荐值还是手动覆盖。
  assert.equal(reducePendingNewSession(switched, { type: "START" }).thinkingLevelSource, "auto");
  assert.equal(
    reducePendingNewSession(
      reducePendingNewSession(switched, { type: "START" }),
      { type: "RUNTIME_CREATED", sessionId: "session-1" },
    ).thinkingLevelSource,
    "auto",
  );
  // 用户自己点选的档位默认算手动选择。
  assert.equal(reducePendingNewSession(staged, { type: "SET_THINKING_LEVEL", level: "low" }).thinkingLevelSource, "manual");
});

test("初始化期间暴露 SSE 身份，完成后解锁模型和发送控件", () => {
  const model = { provider: "test", modelId: "model-a" };
  const starting = { kind: "materializing", shadowMindEnabled: false, model, thinkingLevel: "high", thinkingLevelSource: "auto" };
  const initializing = reducePendingNewSession(starting, { type: "RUNTIME_CREATED", sessionId: "session-1" });
  assert.deepEqual(initializing, { ...starting, kind: "initializing", sessionId: "session-1" });
  assert.equal(selectPendingNewSession(initializing).transportSessionId, "session-1");
  assert.equal(selectPendingNewSession(initializing).busy, true);
  const ready = reducePendingNewSession(initializing, { type: "READY", sessionId: "session-1" });
  assert.equal(selectPendingNewSession(ready).busy, false);
  assert.equal(selectPendingNewSession(ready).shadowPending, false);
});

test("初始化失败保留配置和身份以恢复同一会话", () => {
  const initializing = {
    kind: "initializing", sessionId: "session-1", shadowMindEnabled: true,
    model: { provider: "test", modelId: "model-a" }, thinkingLevel: "high", thinkingLevelSource: "auto",
  };
  const failed = reducePendingNewSession(initializing, { type: "POST_START_FAIL", sessionId: "session-1", error: "SSE failed" });
  assert.deepEqual(failed, { ...initializing, kind: "materialization-failed", error: "SSE failed" });
  const recovered = reducePendingNewSession(
    reducePendingNewSession(failed, { type: "RETRY" }),
    { type: "RUNTIME_CREATED", sessionId: "session-1" },
  );
  assert.deepEqual(recovered, initializing);
});

test("post-start 失败保留 real id，并通过 recovering 重试同一会话", () => {
  const materializing = { kind: "materializing", shadowMindEnabled: false };
  const failed = reducePendingNewSession(materializing, {
    type: "POST_START_FAIL",
    sessionId: "session-1",
    error: "finalize failed",
  });
  const recovering = reducePendingNewSession(failed, { type: "RETRY" });
  const ready = reducePendingNewSession(recovering, { type: "READY", sessionId: "session-1" });

  assert.deepEqual(failed, {
    kind: "materialization-failed",
    shadowMindEnabled: false,
    sessionId: "session-1",
    error: "finalize failed",
  });
  // 失败挂载只接管身份，不自动重跑初始化：重试必须是显式动作。
  assert.equal(selectPendingNewSession(failed).resumingInitialization, false);
  assert.equal(selectPendingNewSession(failed).transportSessionId, "session-1");
  assert.deepEqual(selectNewSessionRequest(selectPendingNewSession(failed)), { operation: "finalize-existing", sessionId: "session-1" });
  assert.equal(selectPendingNewSession(recovering).resumingInitialization, true, "显式 RETRY 后才恢复在途初始化");
  // 两个投影职责分开：接管监听用 transportSessionId，控制类 UI 的授权用 runtimeSessionId。
  assert.equal(selectPendingNewSession(failed).transportSessionId, "session-1", "失败态挂载仍要接管同一 runtime");
  assert.equal(selectPendingNewSession(failed).runtimeSessionId, null, "失败态不授权控制类 UI");
  assert.deepEqual(selectPendingNewSession(recovering), {
    busy: true,
    shadowPending: true,
    desiredShadowMindEnabled: false,
    transportSessionId: "session-1",
    shadowMode: "staged",
    extensionsPending: false,
    resumingInitialization: true,
    runtimeSessionId: null,
  });
  assert.deepEqual(ready, { kind: "materialized", sessionId: "session-1" });
});

test("初始化失败只能显式恢复默认开启，且不丢失 real id", () => {
  const failed = {
    kind: "initialization-failed",
    shadowMindEnabled: false,
    sessionId: "session-1",
    error: "Shadow unavailable",
  };
  assert.equal(reducePendingNewSession(failed, { type: "SET_SHADOW", enabled: false }), failed);
  assert.deepEqual(reducePendingNewSession(failed, { type: "SET_SHADOW", enabled: true }), {
    kind: "materialized",
    sessionId: "session-1",
  });
});

test("扩展绑定未完成时进入 extensions-binding，绑定完成或失败都能收敛", () => {
  const settings = { shadowMindEnabled: true, model: { provider: "test", modelId: "model-a" }, thinkingLevel: "high", thinkingLevelSource: "auto" };
  const materializing = { kind: "materializing", ...settings };
  const binding = reducePendingNewSession(materializing, { type: "EXTENSIONS_PENDING", sessionId: "session-1" });
  assert.deepEqual(binding, { kind: "extensions-binding", sessionId: "session-1", ...settings });
  // 第二阶段已应用 Shadow 预设：视图按运行时状态显示，且明确标出还在等扩展。
  assert.deepEqual(selectPendingNewSession(binding), {
    busy: true,
    shadowPending: false,
    desiredShadowMindEnabled: true,
    transportSessionId: "session-1",
    shadowMode: "runtime",
    extensionsPending: true,
    // 切走再切回时直接接管这个 runtime：不再走第二阶段，但要按等待态继续轮询绑定。
    resumingInitialization: false,
    runtimeSessionId: "session-1",
  });

  assert.deepEqual(
    reducePendingNewSession(binding, { type: "EXTENSIONS_READY", sessionId: "session-1" }),
    { kind: "materialized", sessionId: "session-1" },
  );
  assert.equal(selectPendingNewSession(reducePendingNewSession(binding, { type: "EXTENSIONS_READY", sessionId: "session-1" })).extensionsPending, false);

  const failed = reducePendingNewSession(binding, { type: "POST_START_FAIL", sessionId: "session-1", error: "bind failed" });
  assert.deepEqual(failed, { kind: "materialization-failed", sessionId: "session-1", error: "bind failed", ...settings });
});

test("只要状态机已有身份就只 finalize 同一会话，新等待态不会重复创建", () => {
  const settings = { shadowMindEnabled: true, model: null, thinkingLevel: "auto", thinkingLevelSource: "auto" };
  const request = (state) => selectNewSessionRequest(selectPendingNewSession(state));

  assert.deepEqual(request({ kind: "staged", ...settings }), { operation: "create" });
  assert.deepEqual(request({ kind: "materializing", ...settings }), { operation: "create" });
  const cases = [
    { kind: "initializing", sessionId: "session-1", ...settings },
    { kind: "recovering", sessionId: "session-1", ...settings },
    // 扩展还在绑定时重新挂载，绝不能当成新会话再建一个 runtime。
    { kind: "extensions-binding", sessionId: "session-1", ...settings },
    { kind: "materialization-failed", sessionId: "session-1", error: "x", ...settings },
  ];
  for (const state of cases) {
    assert.deepEqual(request(state), { operation: "finalize-existing", sessionId: "session-1" });
  }
});
test("绑定先完成时不提前解锁：等第二阶段落地，失败仍能收敛", () => {
  const initializing = {
    kind: "initializing", sessionId: "session-1", shadowMindEnabled: true,
    model: null, thinkingLevel: "auto", thinkingLevelSource: "auto",
  };
  const boundFirst = reducePendingNewSession(initializing, { type: "EXTENSIONS_READY", sessionId: "session-1" });
  assert.deepEqual(boundFirst, { ...initializing, bindingDone: true });
  assert.equal(selectPendingNewSession(boundFirst).busy, true, "第二阶段还没回来，不能解锁发送");

  // 第二阶段随后落地：两个事实都满足才 materialized。
  assert.deepEqual(
    reducePendingNewSession(boundFirst, { type: "READY", sessionId: "session-1" }),
    { kind: "materialized", sessionId: "session-1" },
  );
  // 若第二阶段报告仍在初始化，而绑定已经完成，同样视为就绪。
  assert.deepEqual(
    reducePendingNewSession(boundFirst, { type: "EXTENSIONS_PENDING", sessionId: "session-1" }),
    { kind: "materialized", sessionId: "session-1" },
  );
  // 迟到失败不能被已解锁状态吞掉。
  assert.deepEqual(
    reducePendingNewSession(boundFirst, { type: "POST_START_FAIL", sessionId: "session-1", error: "finalize failed" }),
    { ...initializing, kind: "materialization-failed", error: "finalize failed", bindingDone: true },
  );

  // 已就绪或已失败的状态不接受迟到事件。
  assert.deepEqual(
    reducePendingNewSession({ kind: "materialized", sessionId: "session-1" }, { type: "EXTENSIONS_PENDING", sessionId: "session-1" }),
    { kind: "materialized", sessionId: "session-1" },
  );
});

test("切模期间手动改过的档位不会被回来的推荐覆盖", () => {
  const modelB = { provider: "test", modelId: "model-b" };
  const started = reducePendingNewSession(
    DEFAULT_PENDING_NEW_SESSION_CONTROL,
    { type: "SET_THINKING_LEVEL", level: "high", source: "manual" },
  );
  // 发起切模时看到的修订号；切走再回来是在另一个实例里改的档，草稿修订号会前进。
  const revisionAtStart = started.levelRevision;
  const changedElsewhere = reducePendingNewSession(
    started,
    { type: "SET_THINKING_LEVEL", level: "low", source: "manual" },
  );
  const preserved = reducePendingNewSession(changedElsewhere, {
    type: "SET_MODEL",
    model: modelB,
    thinkingLevel: "max",
    thinkingLevelSource: "auto",
    levelRevisionAtStart: revisionAtStart,
  });
  // 期间手改过档：只提交模型，档位留在用户刚选的那一档。
  assert.deepEqual(preserved, { ...changedElsewhere, model: modelB });
  assert.equal(preserved.thinkingLevel, "low");
  assert.equal(preserved.thinkingLevelSource, "manual");

  // 没有人动过档位：模型的推荐档照常写进草稿。
  const applied = reducePendingNewSession(started, {
    type: "SET_MODEL",
    model: modelB,
    thinkingLevel: "max",
    thinkingLevelSource: "auto",
    levelRevisionAtStart: revisionAtStart,
  });
  assert.equal(applied.thinkingLevel, "max");
  assert.equal(applied.thinkingLevelSource, "auto");

  // 自动推荐（例如目录刷新带来的默认档）不推进修订号，不该否决还在路上的切模结果。
  const autoDefault = reducePendingNewSession(
    started,
    { type: "SET_THINKING_LEVEL", level: "max", source: "auto" },
  );
  assert.equal(autoDefault.levelRevision, revisionAtStart);
  const stillApplied = reducePendingNewSession(autoDefault, {
    type: "SET_MODEL",
    model: modelB,
    thinkingLevel: "low",
    thinkingLevelSource: "auto",
    levelRevisionAtStart: revisionAtStart,
  });
  assert.equal(stillApplied.thinkingLevel, "low");
});

test("工具档位记在草稿里，创建入口按它取名单", () => {
  // 浏览器偏好是整台浏览器共用的一份：别的标签页改它，或者写入被拒时，输入框显示的档位
  // 和创建请求用的名单会分叉。选择发生时就把名单写进草稿。
  const model = { provider: "test", modelId: "model-a" };
  const staged = reducePendingNewSession(DEFAULT_PENDING_NEW_SESSION_CONTROL, { type: "SET_MODEL", model });
  assert.equal(staged.tools ?? null, null);
  const readOnly = reducePendingNewSession(staged, { type: "SET_TOOLS", tools: { preset: "read-only", custom: null } });
  assert.deepEqual(readOnly.tools, { preset: "read-only", custom: null });
  // 自定义名单整份保留：创建请求要拿到用户勾选的那几个工具。
  const custom = reducePendingNewSession(readOnly, { type: "SET_TOOLS", tools: { preset: "custom", custom: ["read", "grep"] } });
  assert.deepEqual(custom.tools, { preset: "custom", custom: ["read", "grep"] });
  // 已经开始创建（materializing）之后不再接受：那份名单已经随创建请求发出去了。
  const starting = reducePendingNewSession(custom, { type: "START" });
  assert.deepEqual(
    reducePendingNewSession(starting, { type: "SET_TOOLS", tools: { preset: "full", custom: null } }).tools,
    { preset: "custom", custom: ["read", "grep"] },
  );
});
