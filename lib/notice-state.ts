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
  | { type: "remove"; id: string; now: number };

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
      const visible = state.visible.filter((notice) => notice.id !== action.id);
      return fillPendingNotices(visible, state.pending, action.now);
    }
    default:
      return state;
  }
}
