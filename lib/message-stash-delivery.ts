import { realpath } from "node:fs/promises";
import { readSessionHeader, resolveSessionPath } from "./session-reader";
import { resolveProject } from "./worktree";
import { samePath } from "./paths";
import { claimStashedMessage, dueStashedMessages, finishStashedMessage, StashError } from "./message-stash";
import { openSessionForDelivery } from "./session-wake";

export async function resolveStashProject(cwd: string): Promise<string> {
  const { projectRoot } = await resolveProject(await realpath(cwd));
  return realpath(projectRoot);
}

export async function checkStashTarget(project: string, sessionId: string): Promise<void> {
  const path = await resolveSessionPath(sessionId);
  const session = path && readSessionHeader(path);
  const root = session && await resolveStashProject(session.cwd).catch(() => null);
  if (!root || !samePath(root, project)) throw new StashError(404, "Target session is unavailable in this project");
}

async function deliver(item: ReturnType<typeof dueStashedMessages>[number]): Promise<void> {
  const { id, project, revision, schedule } = item;
  let claim: Awaited<ReturnType<typeof claimStashedMessage>>;
  try {
    claim = await claimStashedMessage(project, id, revision, true);
  } catch (error) {
    // 另一客户端可能刚取消或改期，或另一个进程已认领它。
    if (!(error instanceof StashError)) console.warn("[pi-web] 暂存消息认领失败", { id, error });
    return;
  }
  let accepted = false;
  try {
    await checkStashTarget(project, schedule.sessionId);
    const session = await openSessionForDelivery(schedule.sessionId);
    if (!samePath(await resolveStashProject(session.cwd), project)) throw new Error("Scheduled session changed project");
    await session.send({ type: "prompt", message: claim.draft.text, images: claim.draft.images.map((image) => ({ ...image, type: "image" })), streamingBehavior: "followUp" });
    accepted = true;
  } catch (error) {
    console.warn("[pi-web] 暂存消息定时投递失败", { id, sessionId: schedule.sessionId, error });
  }
  try {
    await finishStashedMessage(project, id, claim.token, accepted);
  } catch (error) {
    console.warn("[pi-web] 暂存消息无法记录投递结果", { id, accepted, error });
  }
}

export async function deliverDueStashedMessages(): Promise<void> {
  const queues = Map.groupBy(dueStashedMessages(), (item) => item.schedule.sessionId);
  await Promise.all([...queues.values()].map(async (queue) => {
    for (const item of queue) await deliver(item);
  }));
}
