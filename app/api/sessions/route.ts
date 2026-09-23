import { NextResponse } from "next/server";
import { jsonResponse } from "@/lib/json-response";
import {
  attachSessionProjectInfo,
  getSessionListVersion,
  listAllSessions,
  listSessionSummaries,
  mergeSessionLists,
} from "@/lib/session-reader";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSessionInfos,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import type { SessionInfo } from "@/lib/types";
import { startServerPerf } from "@/lib/perf";

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
  const perf = startServerPerf("GET /api/sessions");
  try {
    const searchParams = new URL(req.url).searchParams;
    const force = searchParams.get("force") === "1";
    // `summary=1` serves header/stat metadata so the sidebar can paint without
    // waiting for every session transcript to be parsed.
    const summary = searchParams.get("summary") === "1";
    perf?.span("start");
    const persistedSessionsPromise = summary
      ? listSessionSummaries()
      : listAllSessions({ force });
    // Capture before awaiting: mutations during the scan still require a later refresh.
    const sessionListVersion = getSessionListVersion();
    const [persistedSessions, runtimeSessions] = await Promise.all([
      persistedSessionsPromise,
      attachSessionProjectInfo(getRpcSessionInfos()),
    ]);
    perf?.span("scan+projects");
    const sessions = mergeSessionLists(persistedSessions, runtimeSessions);
    const revision = publishDirectoryRevision(sessions);
    const rawSince = searchParams.get("since");
    const since = rawSince === null ? null : Number(rawSince);
    const previous = Number.isSafeInteger(since)
      ? globalThis.__piSessionDirectoryRevisions?.find((candidate) => candidate.version === since)
      : undefined;
    const basePayload = {
      sessionDirectoryVersion: revision.version,
      sessionListVersion,
      runningSessionIds: getRunningRpcSessionIds(),
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
    };
    // 摘要与完整列表不能共享增量版本：同一个 id 的摘要会被完整详情补齐。
    if (previous && !summary) {
      const previousById = new Map(previous.sessions.map((session) => [session.id, session]));
      const currentById = new Map(sessions.map((session) => [session.id, session]));
      const upserts = sessions.filter((session) => sessionFingerprint(previousById.get(session.id)) !== sessionFingerprint(session));
      const removed = previous.sessions.filter((session) => !currentById.has(session.id)).map((session) => session.id);
      const response = jsonResponse(req, { upserts, removed, ...basePayload }, { headers: { "Cache-Control": "no-store" } });
      return perf?.attach(response) ?? response;
    }
    const response = jsonResponse(req, { sessions, ...basePayload }, { headers: { "Cache-Control": "no-store" } });
    return perf?.attach(response) ?? response;
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
