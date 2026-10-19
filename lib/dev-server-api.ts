import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "./file-access";
import { getDevServer, type DevServerSnapshot } from "./dev-server-manager";
import { hasJsonContentType, isApiRequestAllowed } from "./request-security";

export function jsonError(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

/** A project directory the browser may manage servers for, or an error response. */
export async function resolveAllowedProject(value: unknown): Promise<string | NextResponse> {
  if (typeof value !== "string" || !value.trim()) return jsonError(400, "cwd required");
  const cwd = resolve(value);
  try {
    if (!(await stat(cwd)).isDirectory()) return jsonError(400, "cwd must be a directory");
  } catch {
    return jsonError(400, "cwd must be a directory");
  }
  if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) return jsonError(403, "Access denied");
  return cwd;
}

export async function resolveAllowedServer(id: string): Promise<DevServerSnapshot | NextResponse> {
  const server = getDevServer(id);
  if (!server) return jsonError(404, "Server not found");
  const project = await resolveAllowedProject(server.projectCwd);
  return project instanceof NextResponse ? project : server;
}

/** Same-origin JSON body for a state-changing request, or an error response. */
export async function readMutationBody(req: Request): Promise<Record<string, unknown> | NextResponse> {
  if (!isApiRequestAllowed(req)) return jsonError(403, "Untrusted API request");
  if (!hasJsonContentType(req)) return jsonError(415, "Content-Type must be application/json");
  try {
    const body: unknown = await req.json();
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : jsonError(400, "Invalid JSON body");
  } catch {
    return jsonError(400, "Invalid JSON body");
  }
}
