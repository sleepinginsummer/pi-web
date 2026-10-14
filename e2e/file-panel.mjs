import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

export const filePanelFixture = `<!doctype html><html><body style="margin:20px;min-height:2400px">
<label>Notes <input id="notes"></label>
<label>Filter <select id="filter"><option>All</option><option>Pending</option></select></label>
<p>HTML preview state must survive layout changes.</p>
<script>window.previewInstance = Math.random();</script></body></html>`;

export async function checkFilePanel(page, filePath) {
  const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  // The DOM title normalizes Windows paths to forward slashes
  // (lib/file-paths.ts normalizeFilePathSlashes), so match in that form.
  await page.getByTitle(filePath.replace(/\\/g, "/"), { exact: true }).click();
  const panel = page.locator("#file-panel");
  const iframe = panel.locator("iframe");
  const nextMetaResponse = () => page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.searchParams.get("type") === "meta"
      && decodeURIComponent(url.pathname).endsWith(filePath.replace(/\\/g, "/"));
  });
  await iframe.waitFor();
  const frame = await (await iframe.elementHandle()).contentFrame();
  await frame.locator("#notes").fill("Keep this note");
  await frame.locator("#filter").selectOption({ label: "Pending" });
  await frame.evaluate(() => scrollTo(0, 120));
  const instance = await frame.evaluate(() => window.previewInstance);
  const width = () => panel.evaluate(async el => {
    await new Promise(requestAnimationFrame);
    await Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {})));
    return el.getBoundingClientRect().width;
  });
  const storedWidths = () => page.evaluate(() => [
    localStorage.getItem("pi-sidebar-width"), localStorage.getItem("pi-right-panel-width"),
  ]);
  const toggle = panel.getByRole("button", { name: "Expand file panel", exact: true });
  if (page.viewportSize().width <= 640) {
    assert.equal(await toggle.isVisible(), false, "Mobile already uses full width");
  } else {
    // Include a manually resized split in the round trip.
    const separator = page.locator('[data-resize-handle="right-panel"]');
    if (await separator.isVisible()) await separator.press("ArrowLeft");
    const originalWidth = await width();
    const originalStored = await storedWidths();
    const sessionInfo = page.getByRole("button", { name: "Session info", exact: true });
    const sessionPopover = page.locator(".session-info-popover");
    for (let i = 0; i < 2; i++) {
      await sessionInfo.click();
      await sessionPopover.waitFor();
      await toggle.click();
      assert.equal(await sessionPopover.count(), 0, "Full-width mode dismisses inert top-bar menus");
      assert.equal(await panel.getByRole("button", { name: "Restore file panel width", exact: true }).getAttribute("aria-pressed"), "true");
      assert.equal(Math.round(await width()), page.viewportSize().width);
      assert.equal(await page.locator("#session-sidebar").evaluate(el => el.inert), true);
      assert.equal(await frame.evaluate(() => window.previewInstance), instance);
      assert.equal(await frame.evaluate(() => scrollY), 120);
      assert.equal(await frame.locator("#notes").inputValue(), "Keep this note");
      assert.equal(await frame.locator("#filter").inputValue(), "Pending");
      await panel.getByRole("button", { name: "Restore file panel width", exact: true }).press("Enter");
      assert.equal(await width(), originalWidth);
      assert.deepEqual(await storedWidths(), originalStored);
      assert.equal(await page.locator("#session-sidebar").evaluate(el => el.inert), false);
    }
    await toggle.click();
    await panel.getByRole("button", { name: "Restore file panel width", exact: true }).click();
    await page.getByRole("button", { name: "Hide file panel", exact: true }).click();
    const unchangedMeta = nextMetaResponse();
    await page.getByRole("button", { name: "Show file panel", exact: true }).click();
    assert.equal((await unchangedMeta).status(), 200);
    assert.equal(await toggle.getAttribute("aria-pressed"), "false", "Reopening returns to the split layout");
    assert.equal(await width(), originalWidth);
    assert.equal(await frame.evaluate(() => window.previewInstance), instance);
    assert.equal(await frame.evaluate(() => scrollY), 120);
    assert.equal(await frame.locator("#notes").inputValue(), "Keep this note");
    assert.equal(await frame.locator("#filter").inputValue(), "Pending");

    // 隐藏期间同大小编辑文件：重开必须发现版本变化并加载新的预览。
    const originalContent = readFileSync(filePath, "utf8");
    await page.getByRole("button", { name: "Hide file panel", exact: true }).click();
    try {
      writeFileSync(filePath, originalContent.replace("Notes", "Draft"));
      const changedMeta = nextMetaResponse();
      await page.getByRole("button", { name: "Show file panel", exact: true }).click();
      assert.equal((await changedMeta).status(), 200);
      const updatedFrame = page.frameLocator("#file-panel iframe");
      await updatedFrame.getByLabel("Draft").waitFor();
      const reloaded = await (await iframe.elementHandle()).contentFrame();
      assert.notEqual(await reloaded.evaluate(() => window.previewInstance), instance);
      assert.equal(await updatedFrame.locator("#notes").inputValue(), "");
    } finally {
      writeFileSync(filePath, originalContent);
    }
  }
  // 预览工具栏的 @ 按钮必须真的把提及写进输入框（无选区时是整文件提及）。
  const composer = page.locator(".chat-input-textarea");
  const mobile = page.viewportSize().width <= 640;
  const panelIsOpen = () => panel.evaluate((element) => element.classList.contains("right-panel-open"));
  assert.equal(await composer.inputValue(), "", "Composer starts empty so the mention value is unambiguous");
  assert.equal(await panelIsOpen(), true, "The mention button only exists while the panel is open");
  await panel.getByRole("button", { name: "mention", exact: true }).click();
  // 等 React 提交受控输入值再读。
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await composer.inputValue(), `@${basename(filePath)} `, "The @ button inserts a whole-file mention");
  // 移动端面板盖住聊天区，插入后必须回到输入框；桌面端并排显示，面板保持打开。
  assert.equal(await panelIsOpen(), !mobile, mobile
    ? "Mobile returns to the composer after mentioning"
    : "Desktop keeps the split layout after mentioning");
  if (!mobile) await page.getByRole("button", { name: "Hide file panel", exact: true }).click();
  console.log(`PASS: file panel width and preview state at ${page.viewportSize().width}px`);
}
