import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import "../public/sse-broker-core.js";

export const layoutViewports = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 640, height: 640 },
  { width: 641, height: 640 },
  { width: 768, height: 1024 },
  { width: 844, height: 390 },
  { width: 1024, height: 768 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
];

const saveSuccessScreenshots = process.env.E2E_LAYOUT_SCREENSHOTS === "1";
// 模型只连本地假服务；发送、真实 SSE、队列、Stop 和扩展弹窗都走实际产品入口。
async function startLayoutModel(agentDir) {
  const pending = new Map();
  const arrivals = new Map();
  const seen = [];
  const waitFor = (prompt) => {
    if (pending.has(prompt)) return Promise.resolve(pending.get(prompt));
    const arrival = Promise.withResolvers();
    const timer = setTimeout(() => arrival.reject(new Error(`模型未收到 ${prompt}；已收到：${JSON.stringify(seen)}`)), 60_000);
    arrivals.set(prompt, arrival);
    return arrival.promise.finally(() => { clearTimeout(timer); arrivals.delete(prompt); });
  };
  const model = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const last = JSON.parse(body).messages?.at(-1)?.content;
      const text = typeof last === "string" ? last : last?.filter(block => block.type === "text").map(block => block.text).join("");
      seen.push(text?.split("\n")[0]);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({
        id: "layout", object: "chat.completion.chunk", created: 1, model: "layout-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`);
      const stream = {
        append: content => chunk({ content }),
        finish: () => { chunk({}, "stop"); res.end("data: [DONE]\n\n"); },
      };
      chunk({ role: "assistant", content: "Layout response ready.\n\n" });
      if (text?.startsWith("layout stream ")) {
        pending.set(text, stream);
        arrivals.get(text)?.resolve(stream);
        res.on("close", () => pending.delete(text));
      } else stream.finish();
    });
  });
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "layout-fixture": {
    baseUrl: `http://127.0.0.1:${model.address().port}/v1`, api: "openai-completions", apiKey: "test-only",
    models: Array.from({ length: 12 }, (_, i) => ({ id: i ? `layout-model-${i}` : "layout-model", name: `Layout model ${i} with a long display name`, input: ["text"], contextWindow: 32000, maxTokens: 1024 })),
  } } }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "layout-fixture", defaultModel: "layout-model", retry: { enabled: false }, compaction: { enabled: false },
  }));
  return { pending, waitFor, close: () => { model.closeAllConnections(); model.close(); } };
}

// 连续几帧一致才取样，避免把 React 提交或字体加载的中间帧当成最终布局。
export async function geometry(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    let previous = "";
    let stable = 0;
    let frames = 0;
    const sample = () => {
      try {
        const input = document.querySelector(".chat-input-textarea");
        if (!input) throw new Error("布局采样缺少元素：.chat-input-textarea");
        const card = input.closest(".composer-card");
        if (!card) throw new Error("布局采样缺少元素：.composer-card");
        const chat = input.closest(".chat-window");
        if (!chat) throw new Error("布局采样缺少元素：.chat-window");
        const rect = el => {
          const { x, y, width, height, bottom, right } = el.getBoundingClientRect();
          return { x, y, width, height, bottom, right };
        };
        const value = { input: rect(input), card: rect(card), chat: rect(chat),
          width: innerWidth, height: visualViewport.height, pageWidth: document.documentElement.scrollWidth,
          scrollX, scrollY, focused: document.activeElement === input };
        const key = JSON.stringify(value);
        stable = key === previous ? stable + 1 : 0;
        previous = key;
        if (stable >= 4) resolve(value);
        else if (++frames > 180) reject(new Error(`布局持续跳变：${key}`));
        else requestAnimationFrame(sample);
      } catch (error) {
        // 后续帧已离开 Promise 执行器，必须显式拒绝才能进入截图和 trace 的失败处理。
        reject(error);
      }
    };
    sample();
  }));
}

function within(rect, bounds, label) {
  assert.ok(rect.x >= bounds.x - 1 && rect.right <= bounds.right + 1
    && rect.y >= bounds.y - 1 && rect.bottom <= bounds.bottom + 1,
  `${label} 被裁切：${JSON.stringify({ rect, bounds })}`);
}

async function checkComposer(page, label, expected) {
  const size = await geometry(page);
  within(size.card, { x: 0, y: 0, right: size.width, bottom: size.height }, `${label} 输入卡片`);
  within(size.input, size.card, `${label} 文本框`);
  assert.ok(size.pageWidth <= size.width + 1, `${label} 页面横向溢出`);
  assert.equal(size.scrollY, 0, `${label} 页面被光标滚动`);
  if (expected) {
    for (const key of ["y", "height", "bottom"]) {
      assert.ok(Math.abs(size.card[key] - expected.card[key]) <= 1,
        `${label} 卡片 ${key} 跳变：${expected.card[key]} -> ${size.card[key]}`);
    }
  }
  return size;
}

async function checkPopup(page, locator, label, fullViewport = false) {
  await locator.waitFor();
  // 先等尺寸稳定；滚动区的内容可以超出，但头尾与可操作的外框必须完整可见。
  const visible = await geometry(page);
  const box = await locator.boundingBox();
  assert.ok(box, label);
  const bounds = await page.locator(".chat-window").boundingBox();
  const viewport = { width: visible.width, height: visible.height };
  within({ ...box, right: box.x + box.width, bottom: box.y + box.height },
    { x: 0, y: fullViewport ? 0 : bounds.y, right: viewport.width, bottom: viewport.height }, label);
}

async function checkViewportFallback(page, tag) {
  const result = await page.evaluate(() => {
    const app = document.querySelector(".app-shell-root");
    const scroll = document.querySelector("[data-chat-scroll-container]");
    const root = document.documentElement;
    const previous = root.style.getPropertyValue("--app-viewport-height");
    const priority = root.style.getPropertyPriority("--app-viewport-height");
    const removed = [];
    const removeDynamicHeight = group => {
      for (let i = group.cssRules.length - 1; i >= 0; i--) {
        const rule = group.cssRules[i];
        if (rule instanceof CSSSupportsRule && rule.conditionText.includes("100dvh") && rule.cssText.includes(".app-shell-root")) {
          removed.push({ group, index: i, text: rule.cssText });
          group.deleteRule(i);
        } else if ("cssRules" in rule) removeDynamicHeight(rule);
      }
    };
    const tall = document.createElement("div");
    tall.style.height = "3000px";
    const scrollTop = scroll.scrollTop;
    try {
      // Chromium 支持 dvh；移除受支持条件保护的规则，实际执行旧 WebView 会采用的 CSS 分支。
      for (const sheet of document.styleSheets) removeDynamicHeight(sheet);
      root.style.removeProperty("--app-viewport-height");
      scroll.append(tall);
      const base = app.getBoundingClientRect().height;
      const pageHeight = document.scrollingElement.scrollHeight;
      root.style.setProperty("--app-viewport-height", "260px");
      return { rules: removed.length, inline: app.style.height, base, pageHeight, keyboard: app.getBoundingClientRect().height };
    } finally {
      tall.remove();
      scroll.scrollTop = scrollTop;
      if (previous) root.style.setProperty("--app-viewport-height", previous, priority);
      else root.style.removeProperty("--app-viewport-height");
      for (const { group, index, text } of removed.reverse()) group.insertRule(text, index);
    }
  });
  assert.ok(result.rules > 0, "必须实际移除 dvh 条件规则才能验证回退");
  assert.equal(result.inline, "", "内联高度不能覆盖样式表中的旧 WebView 回退");
  assert.ok(Math.abs(result.base - page.viewportSize().height) <= 1, `${tag} vh 回退高度错误：${JSON.stringify(result)}`);
  assert.ok(result.pageHeight <= page.viewportSize().height + 1, `${tag} 长历史撑开整页`);
  assert.equal(result.keyboard, 260, "vh 回退分支仍须优先使用键盘高度变量");
}

async function checkTypingAndSlash(page, tag) {
  const input = page.locator(".chat-input-textarea");
  await input.fill("");
  const empty = await checkComposer(page, tag);
  await input.focus();
  await page.keyboard.type("hello");
  await checkComposer(page, `${tag} 单行打字`, empty);
  await input.fill("多行草稿和自动折行需要保持光标可见。".repeat(100));
  const tall = await checkComposer(page, `${tag} 长草稿`);
  assert.ok(tall.input.height <= 201 && tall.input.height > empty.input.height);
  await input.press("ControlOrMeta+End");
  await page.keyboard.type("tail");
  await checkComposer(page, `${tag} 满高继续打字`, tall);
  assert.equal(await input.evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 2), true, "末尾光标可见");
  await input.fill("x");
  await checkComposer(page, `${tag} 删除回单行`, empty);
  const loads = [];
  const trackLoad = request => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/skills") loads.push("skills");
    else if (request.method() === "POST" && /^\/api\/agent\/[^/]+$/.test(path) && request.postDataJSON()?.type === "get_commands") loads.push("commands");
  };
  page.on("request", trackLoad);
  try {
    await input.fill("@src/");
    const files = page.locator(".file-mention-palette");
    await files.getByRole("button").filter({ hasText: "layout-example.ts" }).waitFor();
    await checkPopup(page, files, `${tag} 路径 token 不加载斜杠资源`);
    assert.deepEqual(loads, [], "有效 @ token 不应加载命令或技能");
    await page.keyboard.type(" /");
    await page.locator(".slash-palette").waitFor();
    await geometry(page);
    assert.equal(await files.count(), 0, "光标离开 @ token 后关闭文件菜单");
    assert.ok(loads.includes("commands") && loads.includes("skills"), "离开 @ token 后恢复正常斜杠加载");
    await input.press("Escape");
    await input.fill("");
  } finally {
    page.off("request", trackLoad);
  }
  await input.fill("/");
  const palette = page.locator(".slash-palette");
  await checkPopup(page, palette, `${tag} 斜杠菜单`);
  assert.equal(await palette.evaluate(el => [...el.querySelectorAll("section, section > div")]
    .every(node => node.scrollWidth <= node.clientWidth + 1)), true, `${tag} 斜杠卡片横向溢出`);
  await checkComposer(page, `${tag} 打开斜杠`, empty);
  await page.keyboard.type("compact");
  assert.equal(await palette.getByRole("button").count(), 1);
  await checkPopup(page, palette, `${tag} 斜杠筛选`);
  await checkComposer(page, `${tag} 筛选斜杠`, empty);
  await input.press("Tab");
  assert.equal(await input.inputValue(), "/compact ");
  assert.equal(await input.evaluate(el => document.activeElement === el), true);
  await palette.waitFor({ state: "hidden" });
  await geometry(page); // 等候补全回调的光标恢复，避免与下一次原生 fill 的选区操作交错。
  await input.fill("/zzzz-no-match");
  await palette.getByText("No extension, prompt, or skill commands found", { exact: true }).waitFor();
  await input.press("Escape");
  assert.equal(await input.inputValue(), "/zzzz-no-match");
  await input.fill("");
  return empty;
}

// 自动化只控制可见区域，不冒充 iOS/Android 的真实系统输入法。
async function setKeyboard(page, open) {
  const height = open ? Math.min(320, page.viewportSize().height - 100) : null;
  await page.evaluate(height => {
    const vv = window.visualViewport;
    if (height === null) delete vv.height;
    else Object.defineProperty(vv, "height", { configurable: true, get: () => height });
    vv.dispatchEvent(new Event("resize"));
  }, height);
  await page.waitForFunction(open => !!document.documentElement.dataset.keyboardOpen === open, open);
}

async function checkLongDraftCompletion(page, tag) {
  const input = page.locator(".chat-input-textarea");
  const draft = "这是一份需要保留的长草稿，补全时仍然要能继续编辑。\n".repeat(24);
  await input.fill(draft);
  await geometry(page);
  assert.equal(await input.evaluate(el => el.clientHeight), 200, `${tag} 先将草稿撑到原上限`);
  await input.press("ControlOrMeta+End");
  await page.keyboard.type("@pre");
  const palette = page.locator(".file-mention-palette");
  const checkTarget = async (option, label) => {
    await option.waitFor();
    await checkPopup(page, palette, `${tag} ${label}`);
    const target = await option.evaluate(el => {
      const row = el.getBoundingClientRect();
      const body = el.closest(".file-mention-palette").lastElementChild.getBoundingClientRect();
      return { top: row.top, bottom: row.bottom, height: row.height, bodyTop: body.top, bodyBottom: body.bottom,
        hit: el.contains(document.elementFromPoint(row.x + row.width / 2, row.y + row.height / 2)) };
    });
    assert.ok(target.height > 0 && target.top >= target.bodyTop - 1 && target.bottom <= target.bodyBottom + 1 && target.hit,
      `${tag} ${label}必须完整可点：${JSON.stringify(target)}`);
    assert.ok(await input.evaluate(el => el.clientHeight < 200), `${tag} 补全打开时临时缩小草稿`);
    assert.equal(await page.locator(".slash-palette").count(), 0, "文件补全期间不能渲染第二个限高写入者");
  };
  const option = palette.getByRole("button").filter({ hasText: "preview.html" });
  await checkTarget(option, "长草稿补全");
  await option.tap();
  await palette.waitFor({ state: "hidden" });
  assert.ok((await input.inputValue()).startsWith(draft), "点选不能丢失长草稿正文");
  assert.match(await input.inputValue(), /@preview\.html/);
  assert.equal(await input.evaluate(el => document.activeElement === el), true);
  await geometry(page);
  assert.equal(await input.evaluate(el => el.clientHeight), 200, "点选完成后恢复草稿上限");
  await checkComposer(page, `${tag} 长草稿点选后`);
  await input.fill(draft);
  await page.keyboard.type("@sr");
  const directory = palette.getByRole("button", { name: "src/", exact: true });
  await checkTarget(directory, "长草稿目录补全");
  await directory.tap();
  assert.equal(await input.inputValue(), draft + "@src/", "点目录后继续在原草稿内补全");
  const nestedFile = palette.getByRole("button").filter({ hasText: "layout-example.ts" });
  await checkTarget(nestedFile, "目录内文件补全");
  await nestedFile.tap();
  await palette.waitFor({ state: "hidden" });
  await geometry(page);
  assert.equal(await input.inputValue(), draft + "@src/layout-example.ts ");
  assert.equal(await input.evaluate(el => document.activeElement === el), true);
  assert.equal(await input.evaluate(el => el.clientHeight), 200, "目录内文件点选后恢复草稿上限");

  await input.fill(draft + "@src/");
  await checkTarget(nestedFile, "含斜杠的文件路径补全");
  await input.press("Escape");
  await palette.waitFor({ state: "hidden" });
  await geometry(page);
  assert.equal(await page.locator(".slash-palette").count(), 0, "Escape 后不能露出路径中的斜杠菜单");
  assert.equal(await input.evaluate(el => el.clientHeight), 200, "取消补全也应恢复草稿上限");
  assert.equal(await input.inputValue(), draft + "@src/");
  await input.fill(draft);
  await page.keyboard.type("@pre");
  await option.waitFor();
  await geometry(page);
  await setKeyboard(page, false);
  await geometry(page);
  assert.equal(await input.evaluate(el => el.clientHeight), 200, "键盘收起后补全仍打开也应恢复草稿高度");
  await input.press("Escape");
  assert.equal(await input.inputValue(), draft + "@pre");
  await setKeyboard(page, true);
  await input.fill("");
}

async function checkResizeAndKeyboard(page, tag) {
  const viewport = page.viewportSize();
  const input = page.locator(".chat-input-textarea");
  const draft = "Resize must refit this existing draft without another keystroke. ".repeat(4);
  await input.fill(draft);
  const fitted = async () => {
    await geometry(page);
    const result = await input.evaluate(el => {
      const copy = el.cloneNode();
      copy.removeAttribute("class");
      copy.style.cssText = getComputedStyle(el).cssText;
      // computedStyle.cssText 在 Chromium 中为空，逐项复制保证字体与内边距一致。
      for (const property of getComputedStyle(el)) copy.style.setProperty(property, getComputedStyle(el).getPropertyValue(property));
      Object.assign(copy.style, { position: "fixed", visibility: "hidden", height: "auto", width: `${el.getBoundingClientRect().width}px` });
      copy.value = el.value;
      document.body.append(copy);
      const expected = Math.min(copy.scrollHeight, 200);
      copy.remove();
      return { actual: el.clientHeight, expected };
    });
    assert.ok(Math.abs(result.actual - result.expected) <= 1, `${tag} 缩放后未重排草稿：${JSON.stringify(result)}`);
  };
  await page.setViewportSize({ width: viewport.width > 700 ? 390 : 1024, height: viewport.height });
  await fitted();
  await page.setViewportSize(viewport);
  await fitted();
  await input.fill("");
  if (viewport.width > 640 && viewport.height > 500) return;
  // Playwright 不弹系统键盘；模拟 visualViewport 收缩，让真实 viewport hook 和 CSS 响应。
  await input.focus();
  await setKeyboard(page, true);
  try {
    await page.waitForFunction(() => document.documentElement.dataset.keyboardOpen === "true");
    if (viewport.width <= 640) await checkLongDraftCompletion(page, tag);
    await checkComposer(page, `${tag} 软键盘打开`);
    await input.fill("/");
    await checkPopup(page, page.locator(".slash-palette"), `${tag} 软键盘斜杠`);
    await input.press("Escape");
    await page.keyboard.type("compact");
    await checkComposer(page, `${tag} 软键盘连续打字`);
  } finally {
    await setKeyboard(page, false);
    await input.fill("");
  }
  await page.locator('.chat-input-shell button[title="Change model"]').click();
  const models = page.getByRole("listbox");
  const filter = models.getByRole("textbox", { name: "Filter models…", exact: true });
  await filter.fill("Layout model");
  await setKeyboard(page, true);
  try {
    await checkPopup(page, models, `${tag} 软键盘模型筛选`, true);
    assert.equal(await filter.evaluate(el => document.activeElement === el), true, "模型筛选不能被键盘样式隐藏而失焦");
    await filter.press("Escape");
  } finally {
    await setKeyboard(page, false);
  }
}

async function stopAgent(page) {
  const more = page.locator(".mobile-composer-more");
  if (await more.isVisible()) await more.click();
  await page.getByRole("button", { name: "Stop agent", exact: true }).click();
  if (await page.locator(".mobile-composer-menu").isVisible()) await page.keyboard.press("Escape");
}

async function checkStream(page, model, tag) {
  const input = page.locator(".chat-input-textarea");
  const original = await input.elementHandle();
  const prompt = `layout stream ${tag}`;
  await input.fill(prompt);
  await input.press("Control+Enter");
  await page.getByText("Layout response ready.", { exact: false }).last().waitFor();
  await page.waitForFunction(() => document.querySelector(".chat-input-textarea")?.placeholder.includes("Steer"));
  const stream = await model.waitFor(prompt);
  await input.focus();
  const keyboard = page.viewportSize().width <= 640 || page.viewportSize().height <= 500;
  if (keyboard) await setKeyboard(page, true);
  const running = await checkComposer(page, `${tag} 开始输出`);
  await page.keyboard.type("draft during stream");
  await checkComposer(page, `${tag} 输出时打字`, running);
  for (let i = 0; i < 4; i++) {
    stream.append(`\n\nLayout chunk ${i}. ` + "输出正文与输入同时更新。".repeat(25));
    await page.getByText(`Layout chunk ${i}.`, { exact: false }).last().waitFor();
    assert.equal(await input.evaluate(el => document.activeElement === el), true, `${tag} 输出不得抢走焦点`);
    await input.evaluate(el => el.setSelectionRange(0, 1));
    await page.keyboard.type(String(i));
    assert.equal(await input.inputValue(), `${i}raft during stream`);
    await checkComposer(page, `${tag} 输出 ${i}`, running);
  }
  await input.fill("/co");
  await checkPopup(page, page.locator(".slash-palette"), `${tag} 输出中筛选斜杠`);
  await input.press("Escape");
  assert.ok(model.pending.has(prompt), "关闭斜杠菜单不能误停正在输出的回合");
  await checkComposer(page, `${tag} 输出中关闭斜杠`, running);
  await input.fill("queued draft returned by Stop");
  // 后续发送走产品的快捷键，Stop 必须把它取回，不能在当前轮结束时偷偷发出。
  await input.press("Control+Alt+Enter");
  await page.getByText("queued draft returned by Stop", { exact: true }).last().waitFor();
  await input.fill("unsent draft");
  if (keyboard) await setKeyboard(page, false);
  await stopAgent(page);
  await page.waitForFunction(() => document.querySelector(".chat-input-textarea")?.value.includes("queued draft returned by Stop"));
  assert.match(await input.inputValue(), /unsent draft/);
  await checkComposer(page, `${tag} Stop 取回草稿`);
  assert.equal(await original.evaluate(el => el.isConnected), true, "流式与 Stop 不得重挂输入框");
  await input.fill("");
  // 正常结束也测一遍，保留用户正在编辑的草稿和选区。
  const second = `${prompt} finish`;
  await input.fill(second);
  await input.press("Control+Enter");
  await page.waitForFunction(() => document.querySelector(".chat-input-textarea")?.placeholder.includes("Steer"));
  await input.fill("draft survives completion");
  await input.evaluate(el => el.setSelectionRange(5, 5));
  if (keyboard) await setKeyboard(page, true);
  const before = await checkComposer(page, `${tag} 等待正常结束`);
  (await model.waitFor(second)).finish();
  await page.waitForFunction(() => !document.querySelector(".chat-input-textarea")?.placeholder.includes("Steer"));
  await checkComposer(page, `${tag} 正常结束`, before);
  assert.equal(await input.inputValue(), "draft survives completion");
  assert.equal(await input.evaluate(el => el.selectionStart), 5);
  assert.equal(await input.evaluate(el => document.activeElement === el), true);
  if (keyboard) await setKeyboard(page, false);
  await input.fill("");
}

async function dismissCompletion(page) {
  const close = page.getByRole("region", { name: "Session notifications", exact: true }).getByRole("button", { name: /^Close:/ });
  for (const button of await close.all()) await button.click();
}

async function checkDialogs(page, tag, artifacts) {
  const input = page.locator(".chat-input-textarea");
  await dismissCompletion(page);
  await input.fill("@pre");
  const files = page.locator(".file-mention-palette");
  await files.getByRole("button").filter({ hasText: "preview.html" }).waitFor();
  await checkPopup(page, files, `${tag} 文件提及`);
  await input.press("Tab");
  assert.match(await input.inputValue(), /preview\.html/);
  assert.equal(await input.evaluate(el => document.activeElement === el), true);
  await input.fill("");
  await input.press("ArrowUp");
  const history = page.locator(".input-history-palette");
  await checkPopup(page, history, `${tag} 历史草稿`);
  await input.press("Escape");
  await history.waitFor({ state: "hidden" });
  const beforePicker = await checkComposer(page, `${tag} 模型菜单前`);
  await page.locator('.chat-input-shell button[title="Change model"]').click();
  const models = page.getByRole("listbox");
  await checkPopup(page, models, `${tag} 模型菜单`, true);
  const filter = models.getByRole("textbox", { name: "Filter models…", exact: true });
  await filter.fill("no-such-layout-model");
  assert.equal(await models.getByRole("option").count(), 0);
  await checkPopup(page, models, `${tag} 模型无结果`, true);
  await filter.press("Escape");
  await models.waitFor({ state: "hidden" });
  await checkComposer(page, `${tag} 模型菜单关闭`, beforePicker);
  for (const mode of ["select", "confirm", "input", "editor", "code", "panel"]) {
    await dismissCompletion(page);
    await input.fill(`/e2e-dialog ${mode}`);
    await input.press("Control+Enter");
    const dialog = page.getByRole("dialog", mode === "panel" ? undefined : { name: `E2E ${mode}`, exact: true });
    await checkPopup(page, dialog, `${tag} ${mode} 弹窗`);
    if (saveSuccessScreenshots) await page.screenshot({ animations: "disabled", path: join(artifacts, `layout-${tag}-${mode}.png`) });
    if (["input", "editor"].includes(mode)) {
      await dialog.getByRole("textbox").fill("弹窗草稿要保留\n".repeat(mode === "editor" ? 20 : 1));
      await checkPopup(page, dialog, `${tag} ${mode} 输入后`);
    }
    if (mode === "select") {
      await page.keyboard.press("End");
      await checkPopup(page, dialog, `${tag} select 滚到底部`);
      await page.keyboard.press("Escape");
    } else {
      await dialog.getByRole("button", { name: mode === "panel" ? "Close" : "Cancel", exact: true }).click();
    }
    await dialog.waitFor({ state: "hidden" });
    await page.getByText(`E2E ${mode} result:`, { exact: false }).last().waitFor();
    await checkComposer(page, `${tag} ${mode} 关闭后`);
  }
  await dismissCompletion(page);
  const sidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await checkPopup(page, settings, `${tag} 设置`, true);
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  if (page.viewportSize().width <= 640) {
    await page.locator(".sidebar-overlay-backdrop").click({ position: { x: page.viewportSize().width - 4, y: 100 } });
  }
}

// 诊断采集各自独立；页面或浏览器已关闭时也不能用采集错误覆盖原始用例错误。
export async function withLayoutDiagnostics({ page, context, artifacts, tag }, check) {
  let failed = false;
  try {
    return await check();
  } catch (error) {
    failed = true;
    const captures = [
      ["截图", () => page.screenshot({ path: join(artifacts, `layout-failure-${tag}.png`) })],
      ["trace", () => context.tracing.stop({ path: join(artifacts, `layout-trace-${tag}.zip`) })],
    ];
    for (const [label, capture] of captures) {
      try {
        await capture();
      } catch (captureError) {
        console.error(`[layout ${tag}] 保存${label}失败：`, captureError);
      }
    }
    throw error;
  } finally {
    try {
      await context.close();
    } catch (closeError) {
      if (!failed) throw closeError;
      console.error(`[layout ${tag}] 关闭浏览器上下文失败：`, closeError);
    }
  }
}

export async function prewarmLayoutEventStream(base, sessionId) {
  const controller = new AbortController();
  try {
    const response = await fetch(`${base}/api/agent/${sessionId}/events`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
    });
    assert.equal(response.status, 200, `布局会话 ${sessionId} 的事件流开发预热失败`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let connected = false;
    // 复用 broker 的增量解析器，只有完整 SSE 帧才能触发 JSON 解析，不能在半帧中提前匹配事件类型。
    const parser = globalThis.piWebSseBrokerCore.createSseParser(({ data }) => {
      if (connected || !data) return;
      const event = JSON.parse(data);
      if (event.type === "startup_error") {
        throw new Error(`布局会话 ${sessionId} 启动失败：${event.errorMessage}`);
      }
      if (event.type === "connected") connected = true;
    });
    while (!connected) {
      const { value, done } = await reader.read();
      assert.ok(!done, `布局会话 ${sessionId} 的事件流在 connected 前结束`);
      parser.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    controller.abort();
  }
}

export async function checkResponsiveLayout(browser, { base, agentDir, project, artifacts }) {
  const model = await startLayoutModel(agentDir);
  const post = async (path, body) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    const data = await response.json();
    assert.ok(response.ok && data.success, `${path}: ${JSON.stringify(data)}`);
    return data;
  };
  try {
    for (const viewport of layoutViewports) {
      const tag = `${viewport.width}x${viewport.height}`;
      const { sessionId } = await post("/api/agent/new", { cwd: project, type: "prompt", message: `Layout seed ${tag}`, provider: "layout-fixture", modelId: "layout-model" });
      // 与主入口的开发预热保持一致；SSE 路由也需完成冷编译，生产模式仍验证冷启动。
      if (viewport === layoutViewports[0] && (process.env.E2E_SERVER_MODE || "dev") === "dev") {
        await prewarmLayoutEventStream(base, sessionId);
      }
      const context = await browser.newContext({ viewport, locale: "en-US", isMobile: viewport.width <= 640, hasTouch: viewport.width <= 844 });
      await context.tracing.start({ screenshots: true, snapshots: true });
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", event => { if (event.type() === "error") errors.push(event.text()); });
      page.on("response", response => { if (response.url().startsWith(base) && response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });
      await withLayoutDiagnostics({ page, context, artifacts, tag }, async () => {
        await page.goto(`${base}/?session=${sessionId}`, { waitUntil: "domcontentloaded" });
        await page.locator(".chat-input-textarea").waitFor();
        await page.getByText("Layout response ready.", { exact: false }).last().waitFor();
        // 首条种子消息要等服务端和页面都结算；正文出现早于真实 idle，不能据此启动下一轮。
        await page.waitForFunction(async id => {
          const response = await fetch(`/api/agent/${encodeURIComponent(id)}?systemPrompt=0`);
          if (!response.ok) return false;
          const snapshot = await response.json();
          return snapshot.alive && !snapshot.busy;
        }, sessionId, { polling: 100 });
        await page.waitForFunction(() => !document.querySelector(".chat-input-textarea")?.placeholder.includes("Steer"));
        await checkViewportFallback(page, tag);
        await checkTypingAndSlash(page, tag);
        await checkResizeAndKeyboard(page, tag);
        await checkStream(page, model, tag);
        await checkDialogs(page, tag, artifacts);
        if (saveSuccessScreenshots) await page.screenshot({ animations: "disabled", path: join(artifacts, `layout-${tag}.png`) });
        assert.deepEqual(errors, [], `${tag} 浏览器异常`);
        console.log(`PASS: ${tag} typing, slash filtering, real streaming/Stop/queue, and dialogs`);
      });
    }
  } finally {
    model.close();
  }
}
