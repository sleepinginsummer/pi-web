import { NextResponse } from "next/server";
import { getSessionListVersion } from "@/lib/session-reader";
import {
  getAwaitingInputRpcSessionIds,
  getCompletionNotificationSuppressedRpcSessionIds,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import { getSessionIdsWithUnsettledSubagentRuns } from "@/lib/subagent-runtime";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
// archive changed elsewhere; it costs one stat while the file is unchanged.
// subagentsActiveSessionIds: sessions whose subagents can still start a run
// there, so the sidebar announces their completion only after the last one.
export async function GET() {
  return NextResponse.json(
    {
      sessionListVersion: getSessionListVersion(),
      runningSessionIds: getRunningRpcSessionIds(),
      awaitingInputSessionIds: getAwaitingInputRpcSessionIds(),
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      subagentsActiveSessionIds: getSessionIdsWithUnsettledSubagentRuns(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
