"use client";

import { useEffect, useRef, useState } from "react";
import {
  diffRunningSessions,
  type RunningSessionTransitions,
} from "@/lib/running-session-transitions";

export interface RunningSessionTransitionEvent extends RunningSessionTransitions {
  revision: number;
}

const EMPTY_TRANSITION: RunningSessionTransitionEvent = {
  completedInBackground: [],
  started: [],
  revision: 0,
};

/** 在应用生命周期内把稳定的运行快照转换成一次性 transition 事件。 */
export function useRunningSessionTransitions(
  runningSessionIds: ReadonlySet<string>,
  selectedSessionId: string | null,
): RunningSessionTransitionEvent {
  const previousRef = useRef<ReadonlySet<string>>(new Set());
  const revisionRef = useRef(0);
  const [transition, setTransition] = useState<RunningSessionTransitionEvent>(EMPTY_TRANSITION);

  useEffect(() => {
    const next = diffRunningSessions(previousRef.current, runningSessionIds, selectedSessionId);
    previousRef.current = runningSessionIds;
    if (next.completedInBackground.length === 0 && next.started.length === 0) return;

    revisionRef.current += 1;
    setTransition({ ...next, revision: revisionRef.current });
  }, [runningSessionIds, selectedSessionId]);

  return transition;
}
