"use client";

import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

/**
 * 触屏上「按一下这条消息」就显示动作栏（复制 / 新会话）。
 *
 * 动作栏原先只跟 hover 走（`onMouseEnter`）。触屏没有真正的 hover：iOS Safari 只对浏览器
 * 认为「可点」的元素合成 mouseenter，按在回复正文这类纯文本上根本不发，于是复制按钮怎么点
 * 都不出现；换个可点的地方按一下之后，合成事件才「打开」，再点正文又能出来——这正是用户
 * 看到的现象。
 *
 * 所以给触屏补一个显式入口：按在这条消息里就显示，按到别处收起。鼠标指针仍交给 hover，
 * 免得把悬停状态钉死。
 */
export function useMessageActionsReveal(
  visible: boolean,
  setVisible: (visible: boolean) => void,
): { ref: RefObject<HTMLDivElement | null>; onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void } {
  const ref = useRef<HTMLDivElement>(null);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // 鼠标（包括带触摸屏的笔记本）继续走 hover，点一下就钉住反而不好用。
    if (event.pointerType === "mouse") return;
    // 点在动作栏自己身上（复制按钮）时不要重新收起或重复显示。
    if ((event.target as Element | null)?.closest("[data-message-actions]")) return;
    setVisible(true);
  };

  useEffect(() => {
    if (!visible) return;
    const hideOnOutsidePress = (event: PointerEvent) => {
      if (event.pointerType === "mouse") return;
      if (ref.current?.contains(event.target as Node)) return;
      setVisible(false);
    };
    // 捕获阶段：消息区里的按钮可能自己 stopPropagation，这里必须先看到这次按下。
    document.addEventListener("pointerdown", hideOnOutsidePress, true);
    return () => document.removeEventListener("pointerdown", hideOnOutsidePress, true);
  }, [setVisible, visible]);

  return { ref, onPointerDown };
}
