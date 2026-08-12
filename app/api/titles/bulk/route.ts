import { NextResponse } from "next/server";
import {
  cancelBulkTitleGeneration,
  getBulkTitleProgress,
  startBulkTitleGeneration,
} from "@/lib/bulk-title";

// POST /api/titles/bulk — 触发批量标题生成（回收站 + 全部未删除会话；已有标题的跳过）
export async function POST() {
  startBulkTitleGeneration();
  return NextResponse.json({ progress: getBulkTitleProgress() });
}

// GET /api/titles/bulk — 查询批量任务进度
export async function GET() {
  return NextResponse.json({ progress: getBulkTitleProgress() });
}

// DELETE /api/titles/bulk — 请求停止批量任务（当前文件处理完后停止）
export async function DELETE() {
  cancelBulkTitleGeneration();
  return NextResponse.json({ ok: true });
}
