import path from "path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
    const nativePath = path.win32.normalize(targetPath);
    return { command: "explorer.exe", args: isDirectory ? [nativePath] : [`/select,${nativePath}`] };
  }

  // Linux 桌面环境没有统一的“选中文件”协议，打开父目录是兼容性最好的原生行为。
  return {
    command: "xdg-open",
    args: [isDirectory ? targetPath : path.dirname(targetPath)],
  };
}

/** Explorer 会把请求交给已有桌面进程，退出码不能作为定位结果；只确认进程启动成功。 */
export async function runRevealCommand({ command, args }: RevealCommand, platform = process.platform): Promise<void> {
  if (platform !== "win32") {
    await execFileAsync(command, args, { timeout: 10_000, windowsHide: true });
    return;
  }

  await new Promise<void>((resolve, reject) => {
    // 只隐藏服务终端；Explorer 的桌面窗口必须显式显示，避免继承隐藏启动状态。
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
