import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  PRESET_DEFAULT,
  PRESET_FULL,
  PRESET_NONE,
  PRESET_READ_ONLY,
  getPresetFromTools,
  getToolNamesForPreset,
  missingBuiltinTools,
  normalizeBuiltinToolName,
  toolPresetLabelKey,
} = await jiti.import("./tool-presets.ts");

const BUILTIN_NAMES = ["bash", "read", "edit", "write", "grep", "find", "ls"];

function toolEntries(activeNames, customNames = []) {
  const active = new Set(activeNames);
  return [...BUILTIN_NAMES, ...customNames].map((name) => ({
    name,
    description: name,
    active: active.has(name),
  }));
}

test("maps every tool preset to its built-in tools", () => {
  assert.deepEqual(getToolNamesForPreset("none"), PRESET_NONE);
  assert.deepEqual(getToolNamesForPreset("read-only"), PRESET_READ_ONLY);
  assert.deepEqual(getToolNamesForPreset("default"), PRESET_DEFAULT);
  assert.deepEqual(getToolNamesForPreset("full"), PRESET_FULL);
  assert.deepEqual(PRESET_READ_ONLY, ["read", "grep", "find", "ls"]);
});

test("recognizes presets while ignoring active custom tools", () => {
  const customNames = ["web_search", "delegate"];

  assert.equal(getPresetFromTools(toolEntries([], customNames)), "none");
  assert.equal(
    getPresetFromTools(toolEntries([...PRESET_READ_ONLY, ...customNames], customNames)),
    "read-only",
  );
  assert.equal(
    getPresetFromTools(toolEntries([...PRESET_DEFAULT, ...customNames], customNames)),
    "default",
  );
  assert.equal(
    getPresetFromTools(toolEntries([...PRESET_FULL, ...customNames], customNames)),
    "full",
  );
});

test("returns fresh tool arrays that callers can safely modify", () => {
  const names = getToolNamesForPreset("read-only");
  names.push("custom");
  assert.deepEqual(getToolNamesForPreset("read-only"), PRESET_READ_ONLY);
});

test("reports settings-enabled built-ins the session runs without", () => {
  const settings = [...PRESET_FULL];
  // 钉死 full、但扩展把 edit 换掉了：只有 edit 需要标注。
  assert.deepEqual(missingBuiltinTools(settings, [...PRESET_FULL], ["bash", "read", "write", "grep", "find", "ls"]), ["edit"]);
  // 跟随 settings.json（expected = 设置本身）时同样只看"要了却没激活"的。
  assert.deepEqual(missingBuiltinTools(settings, settings, ["read", "bash", "edit", "write", "grep", "find"]), ["ls"]);
  // 预设主动排除的不算：read-only 会话本来就不要 bash/edit/write。
  assert.deepEqual(missingBuiltinTools(settings, [...PRESET_READ_ONLY], [...PRESET_READ_ONLY]), []);
  // 设置里本来就关掉的工具不算。
  assert.deepEqual(missingBuiltinTools([...PRESET_READ_ONLY], [...PRESET_FULL], [...PRESET_READ_ONLY]), []);
  // 任一输入未知时不猜。
  assert.deepEqual(missingBuiltinTools(null, [...PRESET_FULL], [...PRESET_FULL]), []);
  assert.deepEqual(missingBuiltinTools(settings, null, [...PRESET_FULL]), []);
  assert.deepEqual(missingBuiltinTools(settings, [...PRESET_FULL], undefined), []);
});

test("PowerShell 会话只把 powershell 归一成 bash 来推预设", () => {
  // 界面上的只读清单照服务端名字显示 powershell；预设与 settings.json 里那个位置都叫 bash。
  assert.equal(normalizeBuiltinToolName("powershell"), "bash");
  assert.equal(normalizeBuiltinToolName("read"), "read");
  const entries = (names) => names.map((name) => ({ name, description: "", active: true }));
  // full 预设里 shell 那一格在 PowerShell 模式下叫 powershell，归一后仍是 full。
  const fullWithPowerShell = [...PRESET_FULL.filter((name) => name !== "bash"), "powershell"];
  assert.equal(getPresetFromTools(entries(fullWithPowerShell)), "full");
  assert.equal(getPresetFromTools(entries(PRESET_FULL)), "full");
  // 不是 bash 的会话：多出来的 shell 不在预设里，按自定义处理（回落到 default）。
  assert.equal(getPresetFromTools(entries(["powershell", ...PRESET_READ_ONLY])), "default");
});

test("每个预设都有统一的界面名字", () => {
  // 菜单行和 chip 共用这套 key，不能一个用英文标识符、一个用译名。
  assert.equal(toolPresetLabelKey("none"), "chat.presetOff");
  assert.equal(toolPresetLabelKey("configured"), "chat.presetConfigured");
  assert.equal(toolPresetLabelKey("read-only"), "chat.presetReadOnly");
  assert.equal(toolPresetLabelKey("default"), "chat.presetDefault");
  assert.equal(toolPresetLabelKey("full"), "chat.presetFull");
});
