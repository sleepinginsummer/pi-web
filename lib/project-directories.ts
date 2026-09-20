import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { withPrivateFileLock, writePrivateFileAtomicSync } from "./atomic-file";

interface ProjectDirectoriesFile {
  projects: string[];
}

export function getProjectDirectoriesPath(): string {
  return resolve(getAgentDir(), "pi-web-projects.json");
}

export function readProjectDirectories(path = getProjectDirectoriesPath()): string[] {
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Partial<ProjectDirectoriesFile>;
    if (!Array.isArray(data.projects)) return [];
    return [...new Set(data.projects.filter((project): project is string => typeof project === "string" && project.length > 0))];
  } catch (error) {
    console.error("读取 Pi Web 项目目录配置失败", error);
    return [];
  }
}

export function normalizeProjectDirectory(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("cwd required");
  const cwd = resolve(value.trim());
  if (!statSync(cwd).isDirectory()) throw new Error("cwd must be a directory");
  return cwd;
}

async function mutateProjectDirectories(
  path: string,
  mutation: (projects: string[]) => string[],
): Promise<string[]> {
  return withPrivateFileLock(path, () => {
    const projects = readProjectDirectories(path);
    const next = mutation(projects);
    if (next.length !== projects.length || next.some((project, index) => project !== projects[index])) {
      writePrivateFileAtomicSync(path, `${JSON.stringify({ projects: next }, null, 2)}\n`);
    }
    return next;
  });
}

export function addProjectDirectory(cwd: string, path = getProjectDirectoriesPath()): Promise<string[]> {
  return mutateProjectDirectories(path, (projects) => [cwd, ...projects.filter((project) => project !== cwd)]);
}

export function removeProjectDirectory(cwd: string, path = getProjectDirectoriesPath()): Promise<string[]> {
  return mutateProjectDirectories(path, (projects) => projects.filter((project) => project !== cwd));
}
