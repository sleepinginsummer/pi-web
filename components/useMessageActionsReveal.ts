"use client";

import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

/**
 * 触屏上「按一下这条消息」就显示动作栏（复制 / 新会话）。
 *
 * 动作栏原先只跟 hover 走（`onMouseEnter`）。触屏没有真正的 hover，浏览器只在它认为合适的
 * 时机补发合成鼠标事件：iOS Safari 只对「可点」的元素合成 mouseenter，按在回复正文这类纯文本
 * 上根本不发；安卓 Chrome 则常常要滚动一下才补发 mousemove/mouseover（用户实测「滚一下按钮就
 * 出来了」正是这个原因）。于是复制按钮怎么点都不出现，换个地方按一下之后又能出来。
 *
 * 所以给触屏补一个显式入口：在这一条上**点一下**（按下与抬起位置基本不动）就显示，
 * 按到别处收起。滚动时手指划过的消息不会闪出动作栏，鼠标指针仍交给 hover。
 */
/**
 * 按下到抬起的位移上限：超过它就算滚动/拖动，不当作「点了一下」。
 * 取 16px：安卓的 touch slop 约 8dp，手指落点常有几像素漂移，卡太紧会漏掉正常的点按。
 */
const TAP_SLOP_PX = 16;

export function useMessageActionsReveal(
  visible: boolean,
  setVisible: (visible: boolean) => void,
): {
  ref: RefObject<HTMLDivElement | null>;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
} {
  const ref = useRef<HTMLDivElement>(null);
  /** 触屏这次按下：抬起时用它判断是「点一下」还是「划过去」。 */
  const pressRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // 鼠标（包括带触摸屏的笔记本）继续走 hover，点一下就钉住反而不好用。
    if (event.pointerType === "mouse") {
      pressRef.current = null;
      return;
    }
    // 点在动作栏自己身上（复制按钮）：既不算「点了一下正文」，也不该收起。
    if ((event.target as Element | null)?.closest("[data-message-actions]")) {
      pressRef.current = null;
      return;
    }
    pressRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  };

  // 抬起挂在 document 上：手指最后落点未必还在这一条里（滑了一点、子元素换过），
  // 挂在自己身上就会丢掉这次点击。
  useEffect(() => {
    const finishPress = (event: PointerEvent) => {
      const press = pressRef.current;
      if (!press) return;
      // 别的手指抬起时不能把这次按下作废，只有同一根手指才算数。
      if (event.pointerId !== press.pointerId) return;
      pressRef.current = null;
      // 划着滚动时手指也在这条消息上抬起过：位移太大就不算「点一下」。
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > TAP_SLOP_PX) return;
      setVisible(true);
    };
    const cancel = () => { pressRef.current = null; };
    document.addEventListener("pointerup", finishPress, true);
    document.addEventListener("pointercancel", cancel, true);
    return () => {
      document.removeEventListener("pointerup", finishPress, true);
      document.removeEventListener("pointercancel", cancel, true);
    };
  }, [setVisible]);

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
