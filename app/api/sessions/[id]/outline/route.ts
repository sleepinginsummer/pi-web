import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { readSessionBrowseSnapshot, sessionVersionEtag } from "@/lib/session-browse-snapshot";
import { sessionExternalWritePayload } from "@/lib/session-external-write";
import { buildSessionOutlineFromEntries, readIndexedSessionOutline } from "@/lib/session-outline";
import { resolveSessionPath } from "@/lib/session-reader";

/** 返回当前活动分支的全量轻量大纲（轮次锚点 + 最终回答摘要与 h1/h2 标题），不加载完整正文和工具输出。 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { searchParams } = new URL(req.url);
  const requestedLeafId = searchParams.get("leafId") || undefined;

  try {
    const requestStartedAt = performance.now();
    const liveRpc = getRpcSession(id);
    if (liveRpc?.isAlive() && liveRpc.diskFreshness() !== "current") {
      if (liveRpc.isRunning() || !liveRpc.evictIfDiskAhead()) {
        return NextResponse.json(
          sessionExternalWritePayload("会话文件正在被外部修改，请等待写入完成后刷新"),
          { status: 409 },
        );
      }
    }

    const live = liveRpc?.isAlive() ? await readSessionBrowseSnapshot(id) : null;
    const filePath = live ? null : await resolveSessionPath(id);
    if (!live && !filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const readStartedAt = performance.now();
    const outline = live
      ? (() => {
        const built = buildSessionOutlineFromEntries(live.entries, requestedLeafId ?? live.leafId);
        return { leafId: built.leafId, version: live.version, turns: built.turns };
      })()
      : await readIndexedSessionOutline(filePath!, requestedLeafId);

    const etag = sessionVersionEtag(`${outline.version}:${outline.leafId ?? ""}`);
    const resolveMs = live?.resolveMs ?? readStartedAt - requestStartedAt;
    const readMs = live?.readMs ?? performance.now() - readStartedAt;
    const baseHeaders = {
      "Cache-Control": "no-store",
      ETag: etag,
      "X-Session-Cache": live?.cacheStatus ?? "index",
      "X-Session-Version": outline.version,
    };

    if (req.headers.get("if-none-match") === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          ...baseHeaders,
          "Server-Timing": `resolve;dur=${resolveMs.toFixed(1)}, read;dur=${readMs.toFixed(1)}`,
        },
      });
    }

    const payload = JSON.stringify({
      sessionId: id,
      leafId: outline.leafId,
      version: outline.version,
      turns: outline.turns,
    });
    return new Response(payload, {
      headers: {
        ...baseHeaders,
        "Content-Type": "application/json; charset=utf-8",
        "Server-Timing": [
          `resolve;dur=${resolveMs.toFixed(1)}`,
          `read;dur=${readMs.toFixed(1)}`,
          `total;dur=${(performance.now() - requestStartedAt).toFixed(1)}`,
        ].join(", "),
        "X-Response-Bytes": String(Buffer.byteLength(payload)),
      },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
