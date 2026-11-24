import type { SelectedModel } from "@/lib/model-types";
import type { ThinkingLevelOption } from "@/lib/thinking-levels";
import type { ThinkingLevelSource } from "@/lib/pending-new-session";

/** 草稿切模解析出的选择：模型 + 档位 + 档位来源，正好是草稿状态要提交的那一组值。 */
export type DraftModelSelection = {
  model: SelectedModel;
  thinkingLevel: ThinkingLevelOption;
  thinkingLevelSource: ThinkingLevelSource;
};

type DraftSwitchState = {
  version: number;
  task: Promise<DraftModelSelection | null> | null;
};

// 同一草稿的切模任务按 cwd 存放。它不能只挂在组件上：切走再回来会换一个 useAgentSession
// 实例，组件内的 ref 随之消失，重建后的创建入口（首条消息、系统提示词面板）就会绕过还没落地的
// 那次切换。版本号解决另一半问题：两个实例各自发起的切换可能交错完成，先发起的那次不能把
// 后来选中的模型又提交回草稿。
const draftModelSwitches = new Map<string, DraftSwitchState>();
const switchListeners = new Map<string, Set<() => void>>();

function notifySwitchChanged(cwd: string): void {
  for (const listener of switchListeners.get(cwd) ?? []) listener();
}

/** 等当前任务或版本变化，旧推荐永久挂起也不会挡住后来的选择；退出时释放监听。 */
export async function waitForDraftModelSwitchTask(
  cwd: string,
  pending: { version: number; task: Promise<DraftModelSelection | null> },
): Promise<DraftModelSelection | null> {
  if (!isLatestDraftModelSwitch(cwd, pending.version)) return null;
  let changed!: () => void;
  const superseded = new Promise<null>((resolve) => { changed = () => resolve(null); });
  const listeners = switchListeners.get(cwd) ?? new Set<() => void>();
  switchListeners.set(cwd, listeners);
  listeners.add(changed);
  try {
    return await Promise.race([pending.task.catch(() => null), superseded]);
  } finally {
    listeners.delete(changed);
    if (listeners.size === 0) switchListeners.delete(cwd);
  }
}

/** 开始一轮新的切模：版本自增并占住这个 cwd，返回本轮版本号。 */
export function beginDraftModelSwitch(cwd: string): number {
  const version = (draftModelSwitches.get(cwd)?.version ?? 0) + 1;
  draftModelSwitches.set(cwd, { version, task: null });
  notifySwitchChanged(cwd);
  return version;
}

/** 登记本轮的在途任务。已不是当前版本说明这一轮过期了，直接丢弃登记。 */
export function registerDraftModelSwitch(
  cwd: string,
  version: number,
  task: Promise<DraftModelSelection | null>,
): void {
  const current = draftModelSwitches.get(cwd);
  if (current?.version !== version) return;
  draftModelSwitches.set(cwd, { version, task });
}

/** 提交或采用结果之前核对：同一草稿上是否已经有更新的一轮切模。 */
export function isLatestDraftModelSwitch(cwd: string, version: number): boolean {
  return draftModelSwitches.get(cwd)?.version === version;
}

/** 本轮结算：只清掉自己的任务，版本留着让过期的提交仍能被认出来。 */
export function settleDraftModelSwitch(cwd: string, version: number): void {
  const current = draftModelSwitches.get(cwd);
  if (current?.version !== version) return;
  draftModelSwitches.set(cwd, { version, task: null });
}

/** 还没落地的切换（最新那一轮）：创建入口要等它，并核对它的版本。 */
export function getDraftModelSwitch(
  cwd: string,
): { version: number; task: Promise<DraftModelSelection | null> } | null {
  const current = draftModelSwitches.get(cwd);
  if (!current?.task) return null;
  return { version: current.version, task: current.task };
}
