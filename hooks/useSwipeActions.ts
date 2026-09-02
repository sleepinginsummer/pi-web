"use client";

import { useCallback, useEffect, useRef, useState, type PointerEventHandler } from "react";

const DIRECTION_LOCK_DISTANCE = 6;
const SWIPE_OPEN_RATIO = 0.42;
const SYNTHETIC_CLICK_WINDOW_MS = 80;

type GestureAxis = "pending" | "horizontal" | "vertical";

interface GestureState {
  pointerId: number;
  startX: number;
  startY: number;
  startOffset: number;
  axis: GestureAxis;
}

interface UseSwipeActionsOptions {
  enabled: boolean;
  open: boolean;
  actionWidth: number;
  onOpenChange: (open: boolean) => void;
}

interface UseSwipeActionsResult {
  offset: number;
  dragging: boolean;
  consumeClick: () => boolean;
  pointerHandlers: {
    onPointerDown: PointerEventHandler<HTMLElement>;
    onPointerMove: PointerEventHandler<HTMLElement>;
    onPointerUp: PointerEventHandler<HTMLElement>;
    onPointerCancel: PointerEventHandler<HTMLElement>;
  };
}

interface SwipeMoveResult {
  horizontal: boolean;
  startedDragging: boolean;
  offset: number;
}

interface SwipeFinishResult {
  handled: boolean;
  open: boolean;
  offset: number;
}

export function clampSwipeOffset(offset: number, actionWidth: number): number {
  return Math.max(-actionWidth, Math.min(0, offset));
}

export function shouldOpenSwipeActions(offset: number, actionWidth: number): boolean {
  return offset <= -actionWidth * SWIPE_OPEN_RATIO;
}

/** 纯手势状态机：同步处理 pointer 序列和紧随其后的合成 click。 */
export class SwipeActionMachine {
  private actionWidth: number;
  private gesture: GestureState | null = null;
  private suppressClickUntil = 0;
  open: boolean;
  offset: number;

  constructor(actionWidth: number, open = false) {
    this.actionWidth = actionWidth;
    this.open = open;
    this.offset = open ? -actionWidth : 0;
  }

  syncExternal(open: boolean, actionWidth: number, enabled: boolean): number {
    this.actionWidth = actionWidth;
    this.open = enabled && open;
    if (!this.gesture) this.offset = this.open ? -actionWidth : 0;
    return this.offset;
  }

  begin(pointerId: number, clientX: number, clientY: number): void {
    this.gesture = {
      pointerId,
      startX: clientX,
      startY: clientY,
      startOffset: this.open ? -this.actionWidth : 0,
      axis: "pending",
    };
  }

  move(pointerId: number, clientX: number, clientY: number): SwipeMoveResult {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== pointerId) return { horizontal: false, startedDragging: false, offset: this.offset };

    const deltaX = clientX - gesture.startX;
    const deltaY = clientY - gesture.startY;
    let startedDragging = false;
    if (gesture.axis === "pending") {
      if (Math.abs(deltaX) < DIRECTION_LOCK_DISTANCE && Math.abs(deltaY) < DIRECTION_LOCK_DISTANCE) {
        return { horizontal: false, startedDragging: false, offset: this.offset };
      }
      gesture.axis = Math.abs(deltaX) > Math.abs(deltaY) ? "horizontal" : "vertical";
      startedDragging = gesture.axis === "horizontal";
    }
    if (gesture.axis !== "horizontal") return { horizontal: false, startedDragging: false, offset: this.offset };

    this.offset = clampSwipeOffset(gesture.startOffset + deltaX, this.actionWidth);
    return { horizontal: true, startedDragging, offset: this.offset };
  }

  finish(pointerId: number, cancelled: boolean, now = Date.now()): SwipeFinishResult {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== pointerId) return { handled: false, open: this.open, offset: this.offset };

    const handled = gesture.axis === "horizontal";
    if (handled) {
      this.open = cancelled ? this.open : shouldOpenSwipeActions(this.offset, this.actionWidth);
      this.offset = this.open ? -this.actionWidth : 0;
      this.suppressClickUntil = now + SYNTHETIC_CLICK_WINDOW_MS;
    }
    this.gesture = null;
    return { handled, open: this.open, offset: this.offset };
  }

  consumeClick(enabled: boolean, now = Date.now()): boolean {
    if (now <= this.suppressClickUntil) {
      this.suppressClickUntil = 0;
      return true;
    }
    this.suppressClickUntil = 0;
    if (!enabled || !this.open) return false;
    this.open = false;
    this.offset = 0;
    return true;
  }
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("button, input, textarea, select, a"));
}

export function useSwipeActions({ enabled, open, actionWidth, onOpenChange }: UseSwipeActionsOptions): UseSwipeActionsResult {
  const machineRef = useRef(new SwipeActionMachine(actionWidth, open));
  const [offset, setOffset] = useState(open ? -actionWidth : 0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    setOffset(machineRef.current.syncExternal(open, actionWidth, enabled));
  }, [actionWidth, enabled, open]);

  const onPointerDown = useCallback<PointerEventHandler<HTMLElement>>((event) => {
    if (!enabled || event.button !== 0 || isInteractiveTarget(event.target)) return;
    machineRef.current.begin(event.pointerId, event.clientX, event.clientY);
  }, [enabled]);

  const onPointerMove = useCallback<PointerEventHandler<HTMLElement>>((event) => {
    const result = machineRef.current.move(event.pointerId, event.clientX, event.clientY);
    if (!result.horizontal) return;
    if (result.startedDragging) {
      setDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    setOffset(result.offset);
  }, []);

  const finishGesture = useCallback((pointerId: number, cancelled: boolean) => {
    const result = machineRef.current.finish(pointerId, cancelled);
    if (!result.handled) return;
    setDragging(false);
    setOffset(result.offset);
    onOpenChange(result.open);
  }, [onOpenChange]);

  const onPointerUp = useCallback<PointerEventHandler<HTMLElement>>((event) => {
    finishGesture(event.pointerId, false);
  }, [finishGesture]);

  const onPointerCancel = useCallback<PointerEventHandler<HTMLElement>>((event) => {
    finishGesture(event.pointerId, true);
  }, [finishGesture]);

  const consumeClick = useCallback(() => {
    const wasOpen = machineRef.current.open;
    const consumed = machineRef.current.consumeClick(enabled);
    if (consumed && wasOpen && !machineRef.current.open) {
      setOffset(0);
      onOpenChange(false);
    }
    return consumed;
  }, [enabled, onOpenChange]);

  return {
    offset,
    dragging,
    consumeClick,
    pointerHandlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  };
}
