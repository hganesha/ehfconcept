import { NextResponse } from "next/server";
import { listAuthoringTemplates } from "@/lib/runtime-service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ items: await listAuthoringTemplates(), generatedAt: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json({ error: "AUTHORING_TEMPLATES_FAILED", message: error instanceof Error ? error.message : "Unknown error" }, { status: 502 });
  }
}
