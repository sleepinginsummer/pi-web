import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { InputControls, MobileComposerMenu, PreferenceToggles } = await jiti.import("./InputControls.tsx");
const { InputControlsMenu } = await jiti.import("./InputControlsMenu.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const modelState = {
  names: {},
  list: [],
  error: null,
  scopeWarnings: [],
  dataDiagnostics: [],
  thinkingLevel: "low",
  model: { provider: "openai", modelId: "gpt-test" },
  isAutoModelSelection: false,
  availableThinkingLevels: ["low", "high"],
  thinkingLevelMap: null,
  fastEnabled: false,
  fastAvailable: true,
  fastPending: false,
};

const sharedProps = {
  isStreaming: false,
  modelState,
  modelActions: { changeFastEnabled() {} },
  onThinkingLevelChange() {},
  toolPreset: "default",
  onToolPresetChange() {},
  onCompact() {},
  onAbort() {},
  soundEnabled: true,
  onSoundToggle() {},
  notificationEnabled: true,
  notificationPermission: "granted",
  onNotificationToggle() {},
};

function renderControls(isMobile, overrides = {}) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null,
      React.createElement(InputControls, {
        ...sharedProps,
        isMobile,
        ...overrides,
      })),
  );
}

function renderOpenMobileMenu() {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null,
      React.createElement(InputControlsMenu, {
        isMobile: true,
        isOpen: true,
        modelControls: React.createElement("button", { type: "button", role: "switch", "aria-checked": false }, React.createElement("span", null, "Fast")),
        onClose() {},
        preferenceControls: React.createElement("button", { type: "button" }, "Sound"),
        runControls: React.createElement("button", { type: "button" }, "Compact"),
      })),
  );
}

test("the phone's More trigger lives above the input, not in the bottom row", () => {
  // 移动端输入行什么都不放：Stop、压缩、暂存库都在「更多」里，空间留给模型名称。
  const row = renderControls(true);
  assert.doesNotMatch(row, /aria-label="More controls"/);

  const menu = renderToStaticMarkup(
    React.createElement(I18nProvider, null,
      React.createElement(MobileComposerMenu, { ...sharedProps })),
  );
  assert.match(menu, /aria-label="More controls"/);
  assert.match(menu, /aria-expanded="false"/);
  assert.match(menu, /mobile-composer-more is-compact/);
  assert.doesNotMatch(menu, /class="mobile-controls-menu"/);
});

test("open mobile menu groups model actions and preferences", () => {
  const html = renderOpenMobileMenu();
  assert.match(html, /class="mobile-controls-menu" role="group"/);
  assert.match(html, /role="switch"/);
  assert.match(html, />Fast<\/span>/);
  assert.ok(html.indexOf('class="mobile-controls-actions"') < html.indexOf('class="mobile-controls-preferences"'));
  assert.match(html, /aria-label="Collapse controls"/);
});

test("Fast switch renders for an available desktop model", () => {
  const html = renderControls(false);

  assert.match(html, /role="switch"/);
  assert.match(html, /aria-checked="false"/);
  assert.match(html, />Fast<\/span>/);
});


test("暂存库也搬进「更多」，输入行只留模型名称", () => {
  const row = renderControls(true, { endAction: React.createElement("button", { type: "button" }, "Stash") });
  assert.doesNotMatch(row, /Stash/, "移动端输入行不再渲染暂存库");

  // 菜单里由 PreferenceToggles 渲染同一个入口（菜单只在打开时才渲染内容，所以直接渲染这一层）。
  const toggles = renderToStaticMarkup(
    React.createElement(I18nProvider, null,
      React.createElement(PreferenceToggles, {
        isMobile: true,
        endAction: React.createElement("button", { type: "button" }, "Stash"),
      })),
  );
  assert.match(toggles, /Stash/);
});

test("Stop is out of the phone's input row and behind the More trigger", async () => {
  // 贴着手边的 Stop 一路滑动就会误触（停掉一次运行），所以它只在「更多」里。
  const row = renderControls(true, { isStreaming: true });
  assert.doesNotMatch(row, /mobile-composer-stop/);
  assert.doesNotMatch(row, /aria-label="Stop Agent"/);
  assert.doesNotMatch(row, /class="mobile-controls-menu"/);

  // 运行中「更多」亮一个点，否则 Stop 藏进去后看不出还在跑。
  const trigger = renderToStaticMarkup(
    React.createElement(I18nProvider, null,
      React.createElement(MobileComposerMenu, { ...sharedProps, isStreaming: true })),
  );
  assert.match(trigger, /border-radius:50%/);
  const idleTrigger = renderToStaticMarkup(
    React.createElement(I18nProvider, null,
      React.createElement(MobileComposerMenu, { ...sharedProps })),
  );
  assert.doesNotMatch(idleTrigger, /border-radius:50%/);

  // 菜单里的运行控制不再按运行状态隐藏：空闲给压缩，运行中给停止。
  const source = await readFile(new URL("./InputControls.tsx", import.meta.url), "utf8");
  const menu = source.slice(source.indexOf("export const MobileComposerMenu"), source.indexOf("interface ComposerTopUtilitiesProps"));
  assert.match(menu, /runControls=\{\(\s*<RunControls/);
  assert.match(menu, /endAction=\{endAction\}/, "「更多」要把暂存库交给菜单渲染");
  assert.ok(!menu.includes("(!isStreaming && !isCompacting) ? ("), "运行控制不该被运行状态藏起来");
});

test("keeps the tool preset clickable during a run, showing its tools read-only", async () => {
  const html = renderControls(false, { isStreaming: true });

  // 运行中照样能点开看：这个会话用哪些工具、哪些被扩展顶替，只是改不了。
  assert.match(html, /aria-label="Tools this session uses — view only during a run"/);
  assert.doesNotMatch(html, /aria-disabled="true"/, "运行中不是整体禁用，只是只读");
  assert.match(html, />default<\/span>/, "chip 展示英文预设短名");
  assert.doesNotMatch(html, /No tools/);

  const source = await readFile(new URL("./InputControls.tsx", import.meta.url), "utf8");
  // 只读落在菜单内部：预设行不响应，顶部一行说明此刻不能切换。
  assert.match(source, /locked=\{isStreaming \|\| Boolean\(isCompacting\)\} lockedReason=\{isCompacting \? "compacting" : "running"\}/);
  assert.match(source, /disabled=\{locked\}/);
  assert.match(source, /\{locked && \([\s\S]*?chat\.toolsLockedWhileRunning[\s\S]*?\)\}/);
  // 手动压缩期间服务端同样拒绝 set_tools（isRunning 含 isCompacting），菜单也必须是只读的。
  assert.match(source, /lockedReason === "compacting" \? "chat\.toolsLockedWhileCompacting" : "chat\.toolsLockedWhileRunning"/);
  // 清单直接列 `get_tools` 的激活名单（扩展、MCP 的工具也在内）：预设记录的档位不再冒充勾选状态，
  // 否则会话沿用旧名单而全局设置后来开了 write 时，这里会把它显示成已选中。
  assert.match(source, /\{locked && \(\s*<div[\s\S]*?activeToolNames === undefined[\s\S]*?chat\.toolsUnknown/);
  // 空名单（off 会话）和拿不到名单是两件事，不能都显示成"名单不可用"。
  assert.match(source, /activeToolNames\.length === 0[\s\S]*?chat\.toolsNoneInUse/);
  assert.match(source, /\{!locked && SETTINGS_BUILTIN_TOOLS\.map/);
  // 名单上的名字照服务端原样显示；只有推算内置子集时才把 powershell 归一成 bash。
  assert.match(source, /activeToolNames\?\.map\(normalizeBuiltinToolName\)/);
  assert.match(source, /activeToolNames\.map\(\(name\) => \(/);
});

test("re-reads the active tool list every time the read-only menu opens", async () => {
  const source = await readFile(new URL("./InputControls.tsx", import.meta.url), "utf8");

  // 运行中扩展切换、Shadow 开关都会改服务端激活的工具：打开只读菜单前重读一次，
  // 切换会话后返回的结果由 hook 按会话 id 丢弃。可编辑时不需要（那里本来就在改名单）。
  assert.match(source, /if \(locked && !toolDropdownOpen\) onRefreshTools\?\.\(\);/);
  assert.match(source, /onRefreshTools\?: \(\) => void;/);
  assert.match(source, /onRefreshTools=\{onRefreshTools\}/);
});

test("anchors the phone's tool flyout to the More panel instead of the button", async () => {
  const source = await readFile(new URL("./InputControls.tsx", import.meta.url), "utf8");

  // 320px 屏上运行中 Fast 先隐藏，工具按钮成了「更多」面板的第一项，贴着屏幕左边；
  // 若仍以按钮右沿对齐、最小 120px 宽，弹层会把左侧的名字和勾选框推出屏幕。
  // 手机上让按钮容器失去定位（面板就是定位祖先），弹层右沿对齐面板、宽度按视口收住。
  assert.match(source, /style=\{\{ position: isMobile \? "static" : "relative" \}\}/);
  assert.match(source, /\.\.\.\(isMobile \? \{ maxWidth: "calc\(100vw - 24px\)" \} : null\)/);
  assert.match(source, /overflowX: "hidden", overflowY: "auto"/);
  assert.match(source, /maxHeight: isMobile\s*\n\s*\? \(toolDropdownFit \? toolDropdownFit\.maxHeight : "min\(70vh, 420px\)"\)/);
  // 高度按真实剩余空间收：欢迎页的输入框在屏幕中间，固定高度会把菜单顶出屏幕上方。
  // 量的是弹层真正贴着的那块面板（offsetParent），不是按钮。
  assert.match(source, /const anchor = \(wrapper\.offsetParent as HTMLElement \| null\) \?\? wrapper;/);
  assert.match(source, /const roomUp = Math\.max\(0, Math\.round\(rect\.top - top - 12\)\);/);
  assert.match(source, /const roomDown = Math\.max\(0, Math\.round\(top \+ height - rect\.bottom - 12\)\);/);
  // 上方不够 140px 时不再硬留 140：挑更宽敞的一侧，必要时向下展开，并把高度收到那一侧的剩余空间。
  assert.match(source, /const side: "up" \| "down" = roomUp >= 140 \|\| roomUp >= roomDown \? "up" : "down";/);
  assert.match(source, /setToolDropdownFit\(\{ side, maxHeight: Math\.max\(1, side === "up" \? roomUp : roomDown\) \}\)/);
  assert.doesNotMatch(source, /Math\.max\(140, Math\.round\(top - 16\)\)/);
  // 旋转屏幕、弹出键盘都会改变可用空间：视口变化时重新测，而不是只在打开时测一次。
  assert.match(source, /window\.addEventListener\("resize", measure\)/);
  assert.match(source, /viewport\?\.addEventListener\("resize", measure\)/);
  assert.match(source, /viewport\?\.addEventListener\("scroll", measure\)/);
  // 向下展开时阴影也要翻过来。
  assert.match(source, /isMobile && toolDropdownFit\?\.side === "down"[\s\S]{0,120}?top: "calc\(100% \+ 6px\)"/);
});

test("leaves the tool preset clickable when idle", () => {
  const html = renderControls(false);

  assert.match(html, /aria-label="Change tool preset"/);
  assert.doesNotMatch(html, /aria-disabled="true"/);
});

test("the phone's More menu keeps the tool row but no longer hides reasoning", async () => {
  const source = await readFile(new URL("./InputControls.tsx", import.meta.url), "utf8");
  // 移动端菜单的内容只有一份（MobileComposerMenu）：Fast + 工具预设，思考强度已经移到下方那一行。
  const menu = source.slice(source.indexOf("export const MobileComposerMenu"), source.indexOf("interface ComposerTopUtilitiesProps"));
  assert.match(menu, /modelControls=\{/);
  assert.ok(menu.includes("ToolPresetControl"));
  assert.ok(!menu.includes("ThinkingControl"), "思考强度不再藏在「更多」里");
  assert.doesNotMatch(menu, /!isStreaming && <ToolPresetControl/);
  // 运行或手动压缩期间只读（locked）：菜单照常打开；上一次工具切换还没落地时整体禁用（disabled）。
  assert.match(menu, /<ToolPresetControl[^>]*locked=\{isStreaming \|\| Boolean\(isCompacting\)\} lockedReason=\{isCompacting \? "compacting" : "running"\} disabled=\{toolSelectionPending\}/);

});

test("shows the configured preset's tools without editing them from the menu", async () => {
  const source = await readFile(new URL("./InputControls.tsx", import.meta.url), "utf8");

  // configured 的名单只在 Settings › General 里改：菜单只展示，勾选禁用并给出去处。
  assert.match(source, /const followsSettings = toolPreset === "configured" && !customToolNames;/);
  assert.match(source, /disabled=\{!selectedTools \|\| followsSettings \|\| disabled\}/);
  assert.match(source, /followsSettings \? "cursor-default" : "cursor-pointer"/);
  assert.match(source, /\{!locked && followsSettings && \([\s\S]*?chat\.toolsFollowSettingsHint/);
});

test("unknown tool selection keeps the icon without a placeholder preset name", () => {
  const html = renderControls(false, { toolPreset: "configured", toolSelectionKnown: false });
  assert.match(html, /aria-label="Change tool preset"/);
  assert.doesNotMatch(html, /Built-in tools|>configured<|>default</);
  const ready = renderControls(false, { toolPreset: "configured", toolSelectionKnown: true });
  assert.match(ready, />configured<\/span>/);
});

test("marks a settings-enabled tool this session runs without", async () => {
  const source = await readFile(new URL("./InputControls.tsx", import.meta.url), "utf8");

  // 每次打开菜单都读一遍设置（配置来源比 configured 单一用途更广），但只读视图用不到它：
  // 那里不摆勾选清单，等菜单可编辑时再请求，省一次往返。
  assert.match(source, /if \(!toolDropdownOpen \|\| configuredTools \|\| locked\) return;/);
  assert.match(source, /\}, \[configuredTools, locked, toolDropdownOpen\]\);/);
  // 菜单保持打开、会话从运行切回空闲时也要补上这次请求（locked 在依赖里）。
  // locked 在依赖里：菜单保持打开、会话从运行切回空闲时，这次请求才补得回来。
  // 钉死名单存在时以它为准，没有就以设置为准；两者都由 missingBuiltinTools 判定。
  assert.match(source, /missingBuiltinTools\(configuredTools, pinnedToolNames \?\? configuredTools, activeBuiltins\)/);
  assert.match(source, /\{missingHere\.includes\(name\) && \([\s\S]*?chat\.toolMissingHere/);
});

test("names every preset from one i18n source in the chip and the menu", async () => {
  const source = await readFile(new URL("./InputControls.tsx", import.meta.url), "utf8");

  // chip 与菜单行共用同一个 key 函数，统一展示英文短名（off/configured/read-only/default/full/custom）。
  assert.match(source, /const toolPresetLabel = !toolSelectionKnown[\s\S]*?\? t\("chat\.customToolSelection"\)[\s\S]*?: t\(toolPresetLabelKey\(toolPreset \?\? "default"\)\);/);
  assert.match(source, /const name = t\(toolPresetLabelKey\(preset\)\);/);
  // 说明和名字重复（例如"不使用工具"）时不再重复一行。
  assert.match(source, /desc !== name &&/);
});

test("compacting shows one stop control, not two", () => {
  // 压缩期间只留「停止压缩」：原来压缩 + 运行中会同时画出两个一模一样的红方块。
  const compacting = renderControls(false, { isStreaming: true, isCompacting: true });
  assert.match(compacting, /aria-label="Stop compaction"/);
  assert.doesNotMatch(compacting, /aria-label="Stop agent"/);

  const running = renderControls(false, { isStreaming: true, isCompacting: false });
  assert.match(running, /aria-label="Stop agent"/);
  assert.doesNotMatch(running, /aria-label="Stop compaction"/);
});

test("a pending tool change locks the preset control and the checklist", async () => {
  const source = await readFile(new URL("./InputControls.tsx", import.meta.url), "utf8");

  // 上一次切换还没落地时候选名单仍是旧的：再点一次只会拿着旧名单算出一份过时的请求。
  assert.match(source, /locked=\{isStreaming \|\| Boolean\(isCompacting\)\} lockedReason=.*?disabled=\{toolSelectionPending\}/);
  assert.match(source, /disabled=\{!selectedTools \|\| followsSettings \|\| disabled\}/);
});
