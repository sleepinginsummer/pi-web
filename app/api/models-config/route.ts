import { NextResponse } from "next/server";
import {
  commitModelsConfigWithCapabilities,
  readModelsConfigWithCapabilities,
} from "@/lib/models-config-commit";
import { forceRefreshModelCatalog } from "@/lib/model-catalog-refresh";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await readModelsConfigWithCapabilities());
}

export async function PUT(req: Request) {
  try {
    const body = await req.json() as Record<string, unknown>;
    await commitModelsConfigWithCapabilities(body);
    const providers = body.providers && typeof body.providers === "object" && !Array.isArray(body.providers)
      ? Object.keys(body.providers)
      : [];
    try {
      await forceRefreshModelCatalog(providers);
      return NextResponse.json({ success: true, catalogRefreshed: true });
    } catch (error) {
      console.error("模型配置已保存，但远程模型目录强制刷新失败", { providers, error });
      return NextResponse.json({ success: true, catalogRefreshed: false });
    }
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
