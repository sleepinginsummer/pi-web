const LEGACY_STORAGE_KEY = "pi-web:project-directories";

export interface ProjectDirectoriesResponse {
  projects?: string[];
  cwd?: string;
  error?: string;
}

async function parseResponse(response: Response): Promise<ProjectDirectoriesResponse> {
  const data = await response.json().catch(() => ({})) as ProjectDirectoriesResponse;
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

export function readLegacyProjectDirectories(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(LEGACY_STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function retainFailedLegacyProjectDirectories(projects: string[]): void {
  if (projects.length > 0) window.localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(projects));
  else window.localStorage.removeItem(LEGACY_STORAGE_KEY);
}

export async function fetchProjectDirectories(): Promise<string[]> {
  const data = await parseResponse(await fetch("/api/project-directories", { cache: "no-store" }));
  return data.projects ?? [];
}

export async function addProjectDirectoryClient(cwd: string): Promise<{ projects: string[]; cwd: string }> {
  const data = await parseResponse(await fetch("/api/project-directories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  }));
  return { projects: data.projects ?? [], cwd: data.cwd ?? cwd };
}

export async function removeProjectDirectoryClient(cwd: string): Promise<string[]> {
  const data = await parseResponse(await fetch("/api/project-directories", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  }));
  return data.projects ?? [];
}

export async function migrateLegacyProjectDirectories(
  legacyProjects: string[],
  initialProjects: string[],
  addProject: (cwd: string) => Promise<{ projects: string[] }> = addProjectDirectoryClient,
): Promise<{ projects: string[]; failed: string[] }> {
  let projects = initialProjects;
  const failed: string[] = [];
  for (const cwd of legacyProjects) {
    try {
      const migrated = await addProject(cwd);
      projects = migrated.projects;
    } catch (error) {
      console.error(`迁移旧项目目录失败: ${cwd}`, error);
      failed.push(cwd);
    }
  }
  return { projects, failed };
}
