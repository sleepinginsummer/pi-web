import { readFileSync, statSync } from "fs";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

export type SessionDiskFreshness = "current" | "changed" | "unstable";
type SessionDiskManager = Pick<SessionManager, "getHeader" | "getEntries">;

function version(filePath: string): string | null {
  try {
    const stat = statSync(filePath, { bigint: true });
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * 只在文件元信息变化时核对完整 JSONL，既识别同 ID 的原地重写，
 * 又不在长会话的每次 context 请求中重复解析整个文件。
 */
export class SessionDiskInspector {
  private verifiedVersion: string | null = null;
  private observedFile: boolean;

  constructor(private readonly manager: SessionDiskManager, existedOnOpen: boolean) {
    this.observedFile = existedOnOpen;
  }

  inspect(filePath: string): SessionDiskFreshness {
    if (!filePath) return "current";
    const before = version(filePath);
    if (!before) return this.observedFile ? "unstable" : "current";
    this.observedFile = true;
    if (before === this.verifiedVersion) return "current";

    let contents: string;
    try {
      contents = readFileSync(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "unstable";
      throw error;
    }
    // 文件在校验期间变化时拒绝使用当前 wrapper，下次请求再重试。
    if (version(filePath) !== before) return "unstable";
    if (!contents.endsWith("\n")) return "unstable";

    const expected = this.manager.getEntries();
    let index = 0;
    let headerSeen = false;
    let differs = false;
    for (const line of contents.split("\n")) {
      if (!line) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        return "unstable";
      }
      if (!headerSeen) {
        headerSeen = true;
        if (JSON.stringify(entry) !== JSON.stringify(this.manager.getHeader())) differs = true;
      } else {
        if (index >= expected.length || JSON.stringify(entry) !== JSON.stringify(expected[index])) differs = true;
        index += 1;
      }
    }
    // 解析长文件期间也可能发生写入，判定结果只能基于前后相同的文件版本。
    if (version(filePath) !== before) return "unstable";
    if (!headerSeen || index !== expected.length || differs) return "changed";
    this.verifiedVersion = before;
    return "current";
  }
}
