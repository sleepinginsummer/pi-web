import { NextResponse } from "next/server";
import {
  commitModelsConfigWithCapabilities,
  readModelsConfigWithCapabilities,
} from "@/lib/models-config-commit";
import { forceRefreshModelCatalog } from "@/lib/model-catalog-refresh";
import { ModelsConfigReadError } from "@/lib/models-config-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await readModelsConfigWithCapabilities());
  } catch (error) {
    if (error instanceof ModelsConfigReadError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
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
    if (error instanceof ModelsConfigReadError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
