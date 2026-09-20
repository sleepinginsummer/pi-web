import { NextResponse } from "next/server";
import { readIndexedSessionEntry } from "@/lib/session-content-index";
import { resolveSessionPath } from "@/lib/session-reader";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; entryId: string }> },
) {
  const { id, entryId } = await params;
  const url = new URL(req.url);
  const resource = url.searchParams.get("resource");
  const rawBlockIndex = url.searchParams.get("blockIndex");
  const blockIndex = rawBlockIndex === null ? 0 : Number(rawBlockIndex);
  if (!Number.isSafeInteger(blockIndex) || blockIndex < 0) {
    return NextResponse.json({ error: "Valid blockIndex is required" }, { status: 400 });
  }

  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    const entry = await readIndexedSessionEntry(filePath, entryId);
    if (!entry || entry.type !== "message") return NextResponse.json({ error: "Message not found" }, { status: 404 });
    const message = entry.message as unknown as Record<string, unknown>;

    let value: unknown;
    if (resource === "bash-output" && message.role === "bashExecution") {
      value = message.output;
    } else if (Array.isArray(message.content)) {
      const block = message.content[blockIndex];
      if (resource === "text" && isRecord(block) && block.type === "text") value = block.text;
      if (resource === "tool-input" && isRecord(block) && block.type === "toolCall") value = block.arguments ?? block.input;
    } else if (resource === "text" && blockIndex === 0 && typeof message.content === "string") {
      value = message.content;
    }
    if (value === undefined) return NextResponse.json({ error: "Content not found" }, { status: 404 });
    return NextResponse.json({ value }, { headers: { "Cache-Control": "private, no-cache" } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
