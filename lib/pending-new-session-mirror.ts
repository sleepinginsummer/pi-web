import type { PendingNewSessionControl } from "./pending-new-session";

/**
 * 待创建会话设置的一份渲染无关镜像。
 *
 * 切走再回来会重建 `useAgentSession`：等待切模或初始化期间，用户是在**新**的实例里改模型、
 * 档位、工具和 Shadow 开关的，而旧实例的 props 与 refs 都停在离开的那一刻，可它负责的
 * 那次创建还要继续。事件派发处同步写这份镜像，创建入口在等完之后按 cwd 取最新的一份，
 * 不依赖任何实例有没有重新渲染过。
 *
 * `useSessionNavigation` 的 `dispatchPending` 是唯一写入口，并且它**以镜像作为归约的输入**：
 * React 的 state 提交时机不可控，切模任务结算与 UI 更新同在一个微任务链里，读 state（或它的
 * 派生副本）会读到还没提交的上一份；镜像同步写入，谁先谁后都读到最新的那一份。
 */
const controls = new Map<string, PendingNewSessionControl>();

export function mirrorPendingNewSessionControl(cwd: string, control: PendingNewSessionControl): void {
  controls.set(cwd, control);
}

/** 这个 cwd 最新的待创建会话设置；没有登记过返回 null（调用方退回自己的 refs）。 */
export function latestPendingNewSessionControl(cwd: string): PendingNewSessionControl | null {
  return controls.get(cwd) ?? null;
}

/** 会话已经建好或草稿被丢弃：这份记录不能再留给下一个草稿。 */
export function clearPendingNewSessionControl(cwd: string): void {
  controls.delete(cwd);
}

/** 测试用：清空镜像，免得用例之间互相影响。 */
export function resetPendingNewSessionMirror(): void {
  controls.clear();
}
