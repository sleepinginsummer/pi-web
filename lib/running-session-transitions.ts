export interface RunningSessionTransitions {
  completedInBackground: string[];
  started: string[];
}

/** 比较两次运行快照；当前会话完成不属于后台完成。 */
export function diffRunningSessions(
  previous: ReadonlySet<string>,
  current: ReadonlySet<string>,
  selectedSessionId: string | null,
): RunningSessionTransitions {
  return {
    completedInBackground: [...previous].filter(
      (sessionId) => !current.has(sessionId) && sessionId !== selectedSessionId,
    ),
    started: [...current].filter((sessionId) => !previous.has(sessionId)),
  };
}
