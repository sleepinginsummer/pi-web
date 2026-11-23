import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { withPrivateFileLock, writePrivateFileAtomicSync } from "./atomic-file";
import { validateAgentImages } from "./image-attachments";
import type { StashedContent, StashedMessage, StashSendMode } from "./message-stash-protocol";
import { samePath } from "./paths";

interface Item extends Omit<StashedMessage, "preview" | "status"> {
  project: string;
  text: string;
  attachment?: string;
  claim?: { token: string; at: number };
  failed?: boolean;
}

// 进程在投递期间退出时无法判定模型是否已收到。等待后显示状态待确认，绝不自动重发。
const CLAIM_TIMEOUT_MS = 15 * 60_000;
const pathForStore = () => join(getAgentDir(), "message-stash", "messages.json");
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/heic", "image/heif"]);

export class StashError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function parseStashedContent(text: unknown, images: unknown): StashedContent {
  if (typeof text !== "string" || !Array.isArray(images)) throw new StashError(400, "Invalid draft content");
  const attachments = images.map((image) => ({ type: "image", data: image?.data, mimeType: image?.mimeType }));
  const error = validateAgentImages(attachments);
  if (error || attachments.some(({ mimeType }) => !imageTypes.has(mimeType))) throw new StashError(400, error ?? "Unsupported image type");
  if (!text.trim() && images.length === 0) throw new StashError(400, "Empty draft");
  return { text, images: attachments.map(({ data, mimeType }) => ({ data, mimeType })) };
}

function imageFile(path: string, attachment: string) {
  if (!idPattern.test(attachment)) throw new Error("Invalid stash attachment reference");
  return join(dirname(path), `${attachment}.json`);
}

function readIndex(path: string): Item[] {
  if (!existsSync(path)) return [];
  const store = JSON.parse(readFileSync(path, "utf8"));
  if (store.version !== 1 || !Array.isArray(store.items)) throw new Error("Invalid message stash index");
  return store.items;
}

function content(path: string, item: Item): StashedContent {
  return { text: item.text, images: item.attachment ? JSON.parse(readFileSync(imageFile(path, item.attachment), "utf8")) : [] };
}

function view(item: Item, now = Date.now()): StashedMessage {
  return {
    id: item.id, revision: item.revision, preview: item.text.slice(0, 280), imageCount: item.imageCount,
    mode: item.mode ?? "followUp",
    schedule: item.schedule,
    status: item.claim ? now - item.claim.at >= CLAIM_TIMEOUT_MS ? "uncertain" : "sending" : item.failed ? "failed" : "ready",
  };
}

function find(items: Item[], project: string, id: unknown, revision?: unknown) {
  const item = items.find((entry) => entry.id === id && samePath(entry.project, project));
  if (!item) throw new StashError(404, "Draft not found");
  if (revision !== undefined && revision !== item.revision) throw new StashError(409, "Draft changed. Reload it and try again.");
  return item;
}

function cleanAttachment(path: string, attachment: string | undefined, items: Item[]) {
  if (!attachment || items.some((item) => item.attachment === attachment)) return;
  try {
    rmSync(imageFile(path, attachment), { force: true });
  } catch (error) {
    console.warn("[pi-web] 暂存库附件清理失败", { attachment, error });
  }
}

async function mutate<T>(path: string, operation: (items: Item[]) => T): Promise<T> {
  return withPrivateFileLock(path, () => {
    const items = readIndex(path);
    const before = new Set(items.map(({ attachment }) => attachment));
    let result: T;
    try {
      result = operation(items);
      writePrivateFileAtomicSync(path, JSON.stringify({ version: 1, items }));
    } catch (error) {
      for (const { attachment } of items) if (!before.has(attachment)) cleanAttachment(path, attachment, []);
      throw error;
    }
    for (const attachment of before) cleanAttachment(path, attachment, items);
    return result;
  });
}

export function listStashedMessages(project: string, path = pathForStore()): StashedMessage[] {
  return readIndex(path).filter((item) => samePath(item.project, project)).map((item) => view(item));
}

// 编辑与附件读取共用写入锁，避免在读取旧版本时附件已被另一浏览器替换。
export function loadStashedContent(project: string, id: unknown, revision: unknown, path = pathForStore()): Promise<StashedContent> {
  return withPrivateFileLock(path, () => content(path, find(readIndex(path), project, id, revision)));
}

export function saveStashedMessage(project: string, draft: StashedContent, identity?: { id: unknown; revision: unknown }, path = pathForStore()): Promise<StashedMessage> {
  return mutate(path, (items) => {
    const item = identity ? find(items, project, identity.id, identity.revision) : undefined;
    if (item?.claim) throw new StashError(409, "Draft delivery is pending");
    const revision = randomUUID();
    const attachment = draft.images.length ? revision : undefined;
    // 编辑保存等于重新排队：上一次投递失败的标记必须清掉，否则界面还显示「失败」。
    // 缺少类型的旧消息保持后续；新消息默认引导。
    const next: Item = { ...item, project, id: item?.id ?? randomUUID(), revision, mode: item?.mode ?? (item ? "followUp" : "steer"), text: draft.text, imageCount: draft.images.length, attachment, failed: false };
    if (item) items[items.indexOf(item)] = next;
    else items.unshift(next);
    if (attachment) writePrivateFileAtomicSync(imageFile(path, attachment), JSON.stringify(draft.images));
    return view(next);
  });
}

export function changeStashedMessage(project: string, id: unknown, revision: unknown, change: "delete" | "recover" | StashSendMode | Item["schedule"] | null, path = pathForStore()): Promise<void> {
  return mutate(path, (items) => {
    const item = find(items, project, id, revision);
    if (item.claim && !(view(item).status === "uncertain" && (change === "recover" || change === "delete"))) {
      throw new StashError(409, "Draft delivery is pending");
    }
    if (change === "delete") {
      items.splice(items.indexOf(item), 1);
      return;
    }
    item.revision = randomUUID();
    item.claim = undefined;
    item.failed = false;
    if (change === "steer" || change === "followUp") {
      item.mode = change;
      return;
    }
    item.schedule = change === "recover" ? undefined : change ?? undefined;
  });
}

export function dueStashedMessages(now = Date.now(), path = pathForStore()) {
  return readIndex(path).flatMap(({ id, project, revision, schedule, claim, mode }) => schedule && !claim && schedule.at <= now
    ? [{ id, project, revision, schedule, mode: mode ?? "followUp" }] : []).sort((a, b) => a.schedule.at - b.schedule.at);
}

export function claimStashedMessage(project: string, id: unknown, revision: unknown, scheduled = false, path = pathForStore()) {
  return mutate(path, (items) => {
    const item = find(items, project, id, revision);
    if (item.claim || (scheduled ? !item.schedule || item.schedule.at > Date.now() : item.schedule)) {
      throw new StashError(409, "Draft is already scheduled or being sent");
    }
    const draft = content(path, item);
    const token = randomUUID();
    item.revision = randomUUID();
    item.claim = { token, at: Date.now() };
    return { token, draft };
  });
}

export function finishStashedMessage(project: string, id: unknown, token: unknown, sent: boolean, path = pathForStore()) {
  return mutate(path, (items) => {
    const item = find(items, project, id);
    if (!item.claim || item.claim.token !== token) throw new StashError(409, "Draft delivery changed");
    if (sent) items.splice(items.indexOf(item), 1);
    else {
      item.claim = undefined;
      item.schedule = undefined;
      item.failed = true;
      item.revision = randomUUID();
    }
  });
}
