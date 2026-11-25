import { NextResponse } from "next/server";
import { loadModelBrandIconsConfig } from "@/lib/model-brand-icons-server";

export const dynamic = "force-dynamic";

export async function GET() {
  const config = loadModelBrandIconsConfig();
  return NextResponse.json(config, {
    headers: { "Cache-Control": "no-store" },
  });
}
