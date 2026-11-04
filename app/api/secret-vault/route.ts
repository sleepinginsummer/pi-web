import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { listSecrets, removeSecret, saveSecret, SECRET_NAME_RE } from "@/lib/secret-vault";

export const dynamic = "force-dynamic";

function failure(error: unknown, status = 500) {
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status });
}

/** Names and metadata. No route in this file returns a value. */
export async function GET() {
  try {
    return NextResponse.json({ secrets: listSecrets() });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await req.json() as { name?: unknown; value?: unknown };
    if (typeof body.name !== "string" || !SECRET_NAME_RE.test(body.name)) {
      return NextResponse.json({ error: "Invalid secret name" }, { status: 400 });
    }
    if (typeof body.value !== "string" || !body.value.trim()) {
      return NextResponse.json({ error: "Secret value is required" }, { status: 400 });
    }
    saveSecret(body.name, body.value);
    return NextResponse.json({ secrets: listSecrets() });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  try {
    const name = new URL(req.url).searchParams.get("name") ?? "";
    if (!SECRET_NAME_RE.test(name)) return NextResponse.json({ error: "Invalid secret name" }, { status: 400 });
    removeSecret(name);
    return NextResponse.json({ secrets: listSecrets() });
  } catch (error) {
    return failure(error);
  }
}
