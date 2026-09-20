import { NextResponse } from "next/server";
import {
  attachSessionProjectInfo,
  getSessionListVersion,
  listAllSessions,
  mergeSessionLists,
} from "@/lib/session-reader";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSessionInfos,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import type { SessionInfo } from "@/lib/types";

export const dynamic = "force-dynamic";

interface DirectoryRevision {
  version: number;
  sessions: SessionInfo[];
}

declare global {
  var __piSessionDirectoryRevisions: DirectoryRevision[] | undefined;
  var __piSessionDirectoryVersion: number | undefined;
}

function sessionFingerprint(session: SessionInfo | undefined): string {
  return JSON.stringify(session);
}

function publishDirectoryRevision(sessions: SessionInfo[]): DirectoryRevision {
  const revisions = globalThis.__piSessionDirectoryRevisions ??= [];
  const latest = revisions.at(-1);
  const unchanged = latest
    && latest.sessions.length === sessions.length
    && latest.sessions.every((session, index) => sessionFingerprint(session) === sessionFingerprint(sessions[index]));
  if (unchanged) return latest;
  const revision = { version: (globalThis.__piSessionDirectoryVersion ?? 0) + 1, sessions };
  globalThis.__piSessionDirectoryVersion = revision.version;
  revisions.push(revision);
  if (revisions.length > 4) revisions.splice(0, revisions.length - 4);
  return revision;
}

export async function GET(req: Request) {
  try {
    const force = new URL(req.url).searchParams.get("force") === "1";
    const persistedSessionsPromise = listAllSessions({ force });
    // Capture before awaiting: mutations during the scan still require a later refresh.
    const sessionListVersion = getSessionListVersion();
    const [persistedSessions, runtimeSessions] = await Promise.all([
      persistedSessionsPromise,
      attachSessionProjectInfo(getRpcSessionInfos()),
    ]);
    const sessions = mergeSessionLists(persistedSessions, runtimeSessions);
    const revision = publishDirectoryRevision(sessions);
    const rawSince = new URL(req.url).searchParams.get("since");
    const since = rawSince === null ? null : Number(rawSince);
    const previous = Number.isSafeInteger(since)
      ? globalThis.__piSessionDirectoryRevisions?.find((candidate) => candidate.version === since)
      : undefined;
    if (previous) {
      const previousById = new Map(previous.sessions.map((session) => [session.id, session]));
      const currentById = new Map(sessions.map((session) => [session.id, session]));
      const upserts = sessions.filter((session) => sessionFingerprint(previousById.get(session.id)) !== sessionFingerprint(session));
      const removed = previous.sessions.filter((session) => !currentById.has(session.id)).map((session) => session.id);
      return NextResponse.json(
        {
          upserts,
          removed,
          sessionDirectoryVersion: revision.version,
          sessionListVersion,
          runningSessionIds: getRunningRpcSessionIds(),
          completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      {
        sessions,
        sessionDirectoryVersion: revision.version,
        sessionListVersion,
        runningSessionIds: getRunningRpcSessionIds(),
        completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
