import path from "path";

export interface RevealCommand {
  command: string;
  args: string[];
}

/**
 * 生成由 Node 直接执行的文件管理器命令。
 * 参数始终以数组传递，禁止经过 shell，避免路径被解释为命令片段。
 */
export function getRevealCommand(targetPath: string, isDirectory: boolean, platform = process.platform): RevealCommand {
  if (platform === "darwin") {
    return { command: "open", args: isDirectory ? [targetPath] : ["-R", targetPath] };
  }

  if (platform === "win32") {
    return { command: "explorer.exe", args: isDirectory ? [targetPath] : [`/select,${targetPath}`] };
  }

  // Linux 桌面环境没有统一的“选中文件”协议，打开父目录是兼容性最好的原生行为。
  return {
    command: "xdg-open",
    args: [isDirectory ? targetPath : path.dirname(targetPath)],
  };
}
