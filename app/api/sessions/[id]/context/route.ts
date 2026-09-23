import { NextResponse } from "next/server";
import { buildSessionContext, resolveSessionPath } from "@/lib/session-reader";
import { readSessionBrowseSnapshot, sessionVersionEtag } from "@/lib/session-browse-snapshot";
import { computeSessionTotalActiveMs } from "@/lib/session-timing";
import { getRpcSession } from "@/lib/rpc-manager";
import { readIndexedContextPage, readIndexedSessionDetails } from "@/lib/session-content-index";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;
  const deferThinking = url.searchParams.has("deferThinking");
  const deferToolResultImages = url.searchParams.has("deferMedia");
  // `tail` 按可见消息计数，同时限制原始记录数；`before` 不重复边界记录。
  const rawTail = Number(url.searchParams.get("tail"));
  const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;
  const before = url.searchParams.get("before") ?? undefined;

  try {
    const requestStartedAt = performance.now();
    const liveRpc = getRpcSession(id);
    const live = liveRpc?.isAlive() ? await readSessionBrowseSnapshot(id) : null;
    const filePath = live ? null : await resolveSessionPath(id);
    if (!live && !filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const readStartedAt = performance.now();
    const indexedMetadata = filePath ? await readIndexedSessionDetails(filePath) : null;
    let version = live?.version ?? indexedMetadata!.version;
    const cacheStatus = live?.cacheStatus ?? "index";
    const resolveMs = live?.resolveMs ?? readStartedAt - requestStartedAt;
    let readMs = live?.readMs ?? performance.now() - readStartedAt;
    const etag = sessionVersionEtag(version);
    const baseHeaders = {
      "Cache-Control": "no-store",
      ETag: etag,
      "X-Session-Cache": cacheStatus,
      "X-Session-Version": version,
    };
    if (!before && req.headers.get("if-none-match") === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          ...baseHeaders,
          "Server-Timing": `resolve;dur=${resolveMs.toFixed(1)}, read;dur=${readMs.toFixed(1)}`,
        },
      });
    }

    const indexed = filePath
      ? await readIndexedContextPage(filePath, { leafId, before, tail })
      : null;
    if (indexed) version = indexed.version;
    readMs = live?.readMs ?? performance.now() - readStartedAt;

    const activeLeafId = leafId ?? live?.leafId ?? indexed!.leafId;
    const contextStartedAt = performance.now();
    // `before` is the oldest entry already on the client; fetch its ancestors
    // only (excludeLeaf) so prepending the page does not duplicate `before`.
    const entries = live?.entries ?? indexed!.entries;
    const contextLeafId = live ? before ?? activeLeafId : entries.at(-1)?.id ?? null;
    const context = buildSessionContext(entries, contextLeafId, {
      deferThinking,
      deferToolResultImages,
      tail,
      excludeLeaf: Boolean(before && live),
      sessionId: id,
      ...(indexed ? { effectiveSettings: indexed.settings } : {}),
    });
    const contextMs = performance.now() - contextStartedAt;
    const payload = JSON.stringify({
      context,
      leafId: activeLeafId,
      totalActiveMs: live ? computeSessionTotalActiveMs(live.entries) : indexed!.totalActiveMs,
      version,
      tail,
      before: before ?? null,
    });

    return new Response(payload, {
      headers: {
        ...baseHeaders,
        ETag: sessionVersionEtag(version),
        "X-Session-Version": version,
        "Content-Type": "application/json; charset=utf-8",
        "Server-Timing": [
          `resolve;dur=${resolveMs.toFixed(1)}`,
          `read;dur=${readMs.toFixed(1)}`,
          `context;dur=${contextMs.toFixed(1)}`,
          `total;dur=${(performance.now() - requestStartedAt).toFixed(1)}`,
        ].join(", "),
        "X-Response-Bytes": String(Buffer.byteLength(payload)),
      },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
