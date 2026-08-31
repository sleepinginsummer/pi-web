import { NextResponse } from "next/server";
import {
  commitModelsConfigWithCapabilities,
  readModelsConfigWithCapabilities,
} from "@/lib/models-config-commit";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await readModelsConfigWithCapabilities());
}

export async function PUT(req: Request) {
  try {
    const body = await req.json() as Record<string, unknown>;
    await commitModelsConfigWithCapabilities(body);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
