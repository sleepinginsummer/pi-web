import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { InvalidRemarkError, listSecrets, normalizeRemark, removeSecret, renameSecret, saveSecret, SECRET_NAME_RE, setSecretRemark } from "@/lib/secret-vault";

export const dynamic = "force-dynamic";

function failure(error: unknown, status = error instanceof InvalidRemarkError ? 400 : 500) {
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
    const body = await req.json() as { name?: unknown; value?: unknown; remark?: unknown };
    if (typeof body.name !== "string" || !SECRET_NAME_RE.test(body.name)) {
      return NextResponse.json({ error: "Invalid secret name" }, { status: 400 });
    }
    if (typeof body.value !== "string" || !body.value.trim()) {
      return NextResponse.json({ error: "Secret value is required" }, { status: 400 });
    }
    if (body.remark !== undefined && typeof body.remark !== "string") {
      return NextResponse.json({ error: "Remark must be a string" }, { status: 400 });
    }
    // Absent keeps the existing remark; the add form only sends one when it was filled in.
    saveSecret(body.name, body.value, undefined, undefined, body.remark === undefined ? undefined : normalizeRemark(body.remark));
    return NextResponse.json({ secrets: listSecrets() });
  } catch (error) {
    return failure(error);
  }
}

/** `{ name, remark }` sets or clears a remark; `{ name, newName }` renames. Returns metadata only. */
export async function PATCH(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await req.json() as { name?: unknown; remark?: unknown; newName?: unknown };
    if (typeof body.name !== "string" || !SECRET_NAME_RE.test(body.name)) {
      return NextResponse.json({ error: "Invalid secret name" }, { status: 400 });
    }
    if (typeof body.remark === "string" && body.newName === undefined) {
      if (!setSecretRemark(body.name, normalizeRemark(body.remark))) {
        return NextResponse.json({ error: "Secret not found" }, { status: 404 });
      }
    } else if (typeof body.newName === "string" && body.remark === undefined) {
      if (!SECRET_NAME_RE.test(body.newName)) return NextResponse.json({ error: "Invalid secret name" }, { status: 400 });
      const outcome = renameSecret(body.name, body.newName);
      if (outcome === "missing") return NextResponse.json({ error: "Secret not found" }, { status: 404 });
      if (outcome === "taken") return NextResponse.json({ error: "That name is already in use" }, { status: 409 });
    } else {
      return NextResponse.json({ error: "Send either remark or newName" }, { status: 400 });
    }
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
