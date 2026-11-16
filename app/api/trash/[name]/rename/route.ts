import { statSync } from "fs";
import { join } from "path";
import { NextResponse } from "next/server";
import { assertTrashFileName, getTrashDir, listTrashedSessions } from "@/lib/trash";
import { generateTitleForSessionFile } from "@/lib/session-file-title";

// 复用文件级 AI 标题生成器；overwrite 允许用户显式重新生成已有标题。
export async function POST(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  try {
    assertTrashFileName(name);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
  const filePath = join(getTrashDir(), name);
  try {
    statSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ error: "回收站会话不存在" }, { status: 404 });
    }
    throw error;
  }
  try {
    const title = await generateTitleForSessionFile(filePath, { overwrite: true });
    if (!title) {
      return NextResponse.json({ error: "会话没有可命名的用户消息，或生成期间已发生变化" }, { status: 409 });
    }
    const session = listTrashedSessions().find((item) => item.fileName === name);
    if (!session) return NextResponse.json({ error: "会话已移出回收站" }, { status: 409 });
    return NextResponse.json({ session });
  } catch (error) {
    console.error(`[pi-web] failed to generate trash session title ${name}:`, error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
