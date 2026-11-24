import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const controls = await readFile(new URL("./InputControls.tsx", import.meta.url), "utf8");
const session = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
const model = await readFile(new URL("../hooks/useModelSelection.ts", import.meta.url), "utf8");
const schema = await readFile(new URL("../lib/model-data-schema.ts", import.meta.url), "utf8");
const thinking = controls.slice(controls.indexOf("const ThinkingControl ="), controls.indexOf("interface FastModeControlProps"));

// SDK 每次模型请求前重读推理等级，运行中修改应从下一次请求生效。
test("思考控制只有一份，运行中仍可修改等级", () => {
  assert.match(controls, /<ThinkingControl[^>]*isStreaming=\{isStreaming\}/);
  assert.match(thinking, /disabled=\{!onThinkingLevelChange\}/);
  assert.doesNotMatch(thinking, /disabled=\{isStreaming/);
  assert.match(thinking, /t\(isStreaming \? "chat.currentReasoning" : "chat.changeReasoning"/);
  assert.doesNotMatch(controls, /流式时只读展示当前思考强度/);
});

test("Auto 只表示新会话未显式选择，按钮展示已解析的默认等级", () => {
  assert.match(schema, /defaultThinkingLevel: isThinkingLevel\(value.defaultThinkingLevel\)/);
  assert.match(model, /newSessionDefaultThinkingLevel: action.payload.defaultThinkingLevel \?\? null/);
  // 内部 auto 时显示 settings 的默认档位，但要按当前模型限幅（默认 max、模型最高只到 high 时
  // 不能显示一个它做不到的档位），所以走 resolveDisplayedThinkingLevel 而不是直接回退。
  assert.match(session, /thinkingLevel: resolveDisplayedThinkingLevel\(\{[\s\S]{0,80}level: thinkingLevel,[\s\S]{0,80}fallback: isNew \? newSessionDefaultThinkingLevel : null,[\s\S]{0,80}supported: modelKey \? \(modelThinkingLevels\[modelKey\] \?\? null\) : null,/);
  assert.match(session, /isAutoThinkingSelection: isNew && thinkingLevelOverrideRef.current === null/);
  assert.match(thinking, /lvl === "auto"[\s\S]*?isAutoThinkingSelection/);
});

test("活动会话 Auto 不覆盖运行态，具体等级才发送 RPC", () => {
  const start = session.slice(session.indexOf("const handleThinkingLevelChange = useCallback"), session.indexOf("const handleFastEnabledChange"));
  assert.match(start, /if \(level === "auto"\) \{[\s\S]*?if \(isNew\) modelSelectionActions.setThinkingLevel\("auto"\);[\s\S]*?return;/);
  assert.match(start, /sendAgentCommand\(sid, \{ type: "set_thinking_level", level \}\)/);
});
