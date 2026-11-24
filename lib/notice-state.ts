export type NoticeType = "info" | "success" | "warning" | "error";

export type NoticeItem = {
  id: string;
  message: string;
  type: NoticeType;
  // 排队中的提示不计时，从真正进入可见队列时开始停留 5 秒。
  shownAt?: number;
  exiting?: boolean;
  // 用户点开后保持显示；收起时重新计时。
  expanded?: boolean;
};

export type NoticeState = {
  visible: NoticeItem[];
  pending: NoticeItem[];
};

export type NoticeAction =
  | { type: "add"; notice: NoticeItem; now: number }
  | { type: "mark_expired"; now: number }
  | { type: "set_expanded"; id: string; expanded: boolean; now: number }
  | { type: "remove"; id: string; now: number; expectedExit?: NoticeItem };

export const MAX_NOTICES = 5;
export const NOTICE_VISIBLE_MS = 5_000;

function fillPendingNotices(visible: NoticeItem[], pending: NoticeItem[], now: number): NoticeState {
  let nextVisible = visible;
  let nextPending = pending;
  while (nextPending.length > 0 && nextVisible.length < MAX_NOTICES) {
    const [next, ...rest] = nextPending;
    nextVisible = [...nextVisible, { ...next, shownAt: now }];
    nextPending = rest;
  }
  return { visible: nextVisible, pending: nextPending };
}

export function noticeReducer(state: NoticeState, action: NoticeAction): NoticeState {
  switch (action.type) {
    case "add": {
      const visibleIndex = state.visible.findIndex((notice) => notice.id === action.notice.id);
      const pendingIndex = visibleIndex < 0 ? state.pending.findIndex((notice) => notice.id === action.notice.id) : -1;
      const current = visibleIndex >= 0 ? state.visible[visibleIndex] : state.pending[pendingIndex];
      if (current) {
        // ID 标识同一条提示；更新正文时保留用户展开状态和排队位置，相同内容不续时。
        if (current.message === action.notice.message && current.type === action.notice.type) return state;
        const updated = { ...current, message: action.notice.message, type: action.notice.type,
          ...(visibleIndex >= 0 ? { shownAt: action.now, exiting: false } : {}) };
        return visibleIndex >= 0
          ? { ...state, visible: state.visible.map((notice, index) => index === visibleIndex ? updated : notice) }
          : { ...state, pending: state.pending.map((notice, index) => index === pendingIndex ? updated : notice) };
      }
      if (state.visible.length >= MAX_NOTICES) {
        return { ...state, pending: [...state.pending, action.notice] };
      }
      return {
        ...state,
        visible: [...state.visible, { ...action.notice, shownAt: action.now }],
      };
    }
    case "mark_expired":
      return {
        ...state,
        visible: state.visible.map((notice) => (
          !notice.exiting && !notice.expanded && notice.shownAt !== undefined
            && action.now - notice.shownAt >= NOTICE_VISIBLE_MS
            ? { ...notice, exiting: true }
            : notice
        )),
      };
    case "set_expanded":
      return {
        ...state,
        visible: state.visible.map((notice) => (
          notice.id === action.id
            // 退场动画期间点开也要留住；收起从此刻重新计时。
            ? { ...notice, expanded: action.expanded, exiting: false, shownAt: action.now }
            : notice
        )),
      };
    case "remove": {
      // 旧计时器可能在更新 commit 前已入队；只有仍对应同一退场项时才能移除。
      if (action.expectedExit !== undefined) {
        const current = state.visible.find((notice) => notice.id === action.id);
        if (current !== action.expectedExit || !current?.exiting) return state;
      }
      const visible = state.visible.filter((notice) => notice.id !== action.id);
      return fillPendingNotices(visible, state.pending, action.now);
    }
    default:
      return state;
  }
}
