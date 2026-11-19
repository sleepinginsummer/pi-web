import { NextResponse } from "next/server";
import { getSessionListVersion } from "@/lib/session-reader";
import {
  getAwaitingInputRpcSessionIds,
  getCompletionNotificationSuppressedRpcSessionIds,
  getRunningRpcSessionIds,
  getStartingRpcSessions,
} from "@/lib/rpc-manager";
import { listSessionCompletionSummaries } from "@/lib/session-completion-summaries";
import { listSessionBackgroundActivity } from "@/lib/session-background-activity";
import { getSessionIdsWithUnsettledSubagentRuns } from "@/lib/subagent-runtime";
import { readSessionReceipts } from "@/lib/session-read-receipts";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
// subagentsActiveSessionIds: sessions whose subagents can still start a run
// there, so the sidebar announces their completion only after the last one.
// serverNow: this server's clock, which stamps reads (`readAt`); a browser
// dates its unread markers on it (lib/unread-markers.ts), never on its own.
export async function GET() {
  return NextResponse.json(
    {
      sessionListVersion: getSessionListVersion(),
      serverNow: Date.now(),
      readAt: readSessionReceipts(),
      runningSessionIds: getRunningRpcSessionIds(),
      awaitingInputSessionIds: getAwaitingInputRpcSessionIds(),
      startingSessions: getStartingRpcSessions(),
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      subagentsActiveSessionIds: getSessionIdsWithUnsettledSubagentRuns(),
      completionSummaries: listSessionCompletionSummaries(),
      // Background commands and pending scheduled tasks: shown apart from running, never notified.
      backgroundActivity: listSessionBackgroundActivity(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
