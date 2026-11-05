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

const EMPTY_IDS: ReadonlySet<string> = new Set();

/** 在应用生命周期内把稳定的运行快照转换成一次性 transition 事件。 */
export function useRunningSessionTransitions(
  runningSessionIds: ReadonlySet<string>,
  selectedSessionId: string | null,
  subagentsActiveSessionIds: ReadonlySet<string> = EMPTY_IDS,
): RunningSessionTransitionEvent {
  const previousRef = useRef<ReadonlySet<string>>(new Set());
  const revisionRef = useRef(0);
  const [transition, setTransition] = useState<RunningSessionTransitionEvent>(EMPTY_TRANSITION);

  useEffect(() => {
    // A session is done once it neither runs nor waits for a subagent's report, which starts
    // another run there: its first run's end is not the task's (#1434). Leaving that set is the
    // completion, so a last run too short for any poll to see still counts.
    const active = new Set([...runningSessionIds, ...subagentsActiveSessionIds]);
    const next = diffRunningSessions(previousRef.current, active, selectedSessionId);
    previousRef.current = active;
    if (next.completedInBackground.length === 0 && next.started.length === 0) return;

    revisionRef.current += 1;
    setTransition({ ...next, revision: revisionRef.current });
  }, [runningSessionIds, selectedSessionId, subagentsActiveSessionIds]);

  return transition;
}
