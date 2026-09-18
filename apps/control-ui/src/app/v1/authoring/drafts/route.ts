import { NextRequest, NextResponse } from "next/server";
import { createAuthoringDraftView, listAuthoringDraftsView } from "@/lib/runtime-service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ items: await listAuthoringDraftsView(), generatedAt: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json({ error: "AUTHORING_QUERY_FAILED", message: error instanceof Error ? error.message : "Unknown error" }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    return NextResponse.json(await createAuthoringDraftView(body), { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: "AUTHORING_CREATE_FAILED", message: error instanceof Error ? error.message : "Unknown error" }, { status: 400 });
  }
}
