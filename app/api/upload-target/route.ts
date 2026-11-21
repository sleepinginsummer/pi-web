import { NextResponse } from "next/server";
import { homedir } from "os";
import path from "path";

/**
 * 聊天附件的落点：系统下载目录。
 *
 * 客户端不自己拼这个路径 —— Windows 的分隔符和盘符只有服务端能可靠处理，
 * 而且「拷东西进来」这个动作本身就该由服务端决定放在哪。
 */
export async function GET() {
  return NextResponse.json({ directory: path.join(homedir(), "Downloads") });
}
