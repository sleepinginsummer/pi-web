import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const controls = await readFile(new URL("./InputControls.tsx", import.meta.url), "utf8");
const session = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
const model = await readFile(new URL("../hooks/useModelSelection.ts", import.meta.url), "utf8");
const schema = await readFile(new URL("../lib/model-data-schema.ts", import.meta.url), "utf8");
const thinking = controls.slice(controls.indexOf("const ThinkingControl ="), controls.indexOf("interface FastModeControlProps"));

test("思考控制只有一份，运行中保留当前等级但不可修改", () => {
  assert.match(controls, /<ThinkingControl[^>]*isStreaming=\{isStreaming\}/);
  assert.match(thinking, /disabled=\{isStreaming \|\| !onThinkingLevelChange\}/);
  assert.match(thinking, /t\(isStreaming \? "chat.currentReasoning" : "chat.changeReasoning"/);
  assert.doesNotMatch(controls, /流式时只读展示当前思考强度/);
});

test("Auto 只表示新会话未显式选择，按钮展示已解析的默认等级", () => {
  assert.match(schema, /defaultThinkingLevel: isThinkingLevel\(value.defaultThinkingLevel\)/);
  assert.match(model, /newSessionDefaultThinkingLevel: action.payload.defaultThinkingLevel \?\? null/);
  assert.match(session, /thinkingLevel: isNew && thinkingLevel === "auto"[\s\S]*?newSessionDefaultThinkingLevel \?\? "auto"/);
  assert.match(session, /isAutoThinkingSelection: isNew && thinkingLevelOverrideRef.current === null/);
  assert.match(thinking, /lvl === "auto"[\s\S]*?isAutoThinkingSelection/);
});

test("活动会话 Auto 不覆盖运行态，具体等级才发送 RPC", () => {
  const start = session.slice(session.indexOf("const handleThinkingLevelChange = useCallback"), session.indexOf("const handleFastEnabledChange"));
  assert.match(start, /if \(level === "auto"\) \{[\s\S]*?if \(isNew\) modelSelectionActions.setThinkingLevel\("auto"\);[\s\S]*?return;/);
  assert.match(start, /sendAgentCommand\(sid, \{ type: "set_thinking_level", level \}\)/);
});
