import { NextResponse } from "next/server";
import { configPort, configUrl, readLaunchConfigs } from "@/lib/dev-server-config";
import { jsonError, readMutationBody, resolveAllowedProject } from "@/lib/dev-server-api";
import { listDevServers, startDevServer } from "@/lib/dev-server-manager";
import { isDevServersEnabled } from "@/lib/dev-server-settings";
import type { DevServerListResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const cwd = await resolveAllowedProject(new URL(req.url).searchParams.get("cwd"));
  if (cwd instanceof NextResponse) return cwd;
  try {
    const { configs, errors } = await readLaunchConfigs(cwd);
    return NextResponse.json({
      enabled: isDevServersEnabled(),
      servers: listDevServers(cwd),
      configs: configs.map((config) => ({
        name: config.name,
        source: config.source,
        managed: Boolean(config.runtimeExecutable),
        ...(configPort(config) !== undefined ? { port: configPort(config) } : {}),
        ...(configUrl(config) ? { url: configUrl(config) } : {}),
      })),
      errors,
    } satisfies DevServerListResponse);
  } catch (error) {
    return jsonError(500, error instanceof Error ? error.message : String(error));
  }
}

/** The panel's Start button: the user starts a declared server themselves. */
export async function POST(req: Request) {
  const body = await readMutationBody(req);
  if (body instanceof NextResponse) return body;
  if (!isDevServersEnabled()) return jsonError(409, "Dev servers are turned off in Settings › General");
  const cwd = await resolveAllowedProject(body.cwd);
  if (cwd instanceof NextResponse) return cwd;
  if (typeof body.name !== "string") return jsonError(400, "name required");
  const { configs } = await readLaunchConfigs(cwd);
  const config = configs.find((item) => item.name === body.name);
  if (!config) return jsonError(404, `No server named "${body.name}" is declared`);
  try {
    const { server } = await startDevServer(cwd, config, { readyTimeoutMs: 15_000 });
    return NextResponse.json({ server });
  } catch (error) {
    return jsonError(409, error instanceof Error ? error.message : String(error));
  }
}
