import { NextResponse } from "next/server";
import { readSessionBrowseSnapshot, sessionVersionEtag } from "@/lib/session-browse-snapshot";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { readIndexedSessionDetails } from "@/lib/session-content-index";

/** 返回分支导航和文件元数据，不读取或构建消息 context。 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const requestStartedAt = performance.now();
    const liveRpc = getRpcSession(id);
    if (liveRpc?.isAlive() && liveRpc.hasUnseenDiskEntry()) {
      if (liveRpc.isRunning()) {
        return NextResponse.json({ error: "会话正在运行且文件被外部修改，请等待运行结束后刷新" }, { status: 409 });
      }
      liveRpc.evictIfDiskAhead();
    }
    const live = liveRpc?.isAlive() ? await readSessionBrowseSnapshot(id) : null;
    const filePath = live ? null : await resolveSessionPath(id);
    if (!live && !filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const readStartedAt = performance.now();
    const indexed = filePath ? await readIndexedSessionDetails(filePath) : null;
    const version = live?.version ?? indexed!.version;
    const resolveMs = live?.resolveMs ?? readStartedAt - requestStartedAt;
    const readMs = live?.readMs ?? performance.now() - readStartedAt;
    const etag = sessionVersionEtag(version);
    const baseHeaders = {
      "Cache-Control": "no-store",
      ETag: etag,
      "X-Session-Cache": live?.cacheStatus ?? "index",
      "X-Session-Version": version,
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
      filePath: live?.filePath ?? filePath!,
      leafId: live?.leafId ?? indexed!.leafId,
      tree: live?.tree ?? indexed!.tree,
      version,
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
