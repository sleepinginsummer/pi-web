import { NextResponse } from "next/server";
import {
  commitModelsConfigWithCapabilities,
  readModelsConfigWithCapabilities,
} from "@/lib/models-config-commit";
import { forceRefreshModelCatalog } from "@/lib/model-catalog-refresh";
import { ModelsConfigReadError } from "@/lib/models-config-store";
import { ContextWindowError, normalizeContextWindowOverrides } from "@/lib/model-context";

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
    // 托管模型的上下文窗口覆盖值先校验并规整为整数，再进入成对加锁提交。
    await commitModelsConfigWithCapabilities(normalizeContextWindowOverrides(body));
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
    if (error instanceof ContextWindowError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ModelsConfigReadError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
