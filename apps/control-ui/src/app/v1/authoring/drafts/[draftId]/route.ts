import { NextRequest, NextResponse } from "next/server";
import { getAuthoringDraftView, updateAuthoringDraftView } from "@/lib/runtime-service";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, context: { params: Promise<{ draftId: string }> }) {
  try {
    const { draftId } = await context.params;
    const draft = await getAuthoringDraftView(draftId);
    return draft ? NextResponse.json(draft) : NextResponse.json({ error: "AUTHORING_DRAFT_NOT_FOUND" }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: "AUTHORING_DETAIL_FAILED", message: error instanceof Error ? error.message : "Unknown error" }, { status: 502 });
  }
}

export async function PUT(request: NextRequest, context: { params: Promise<{ draftId: string }> }) {
  try {
    const { draftId } = await context.params;
    return NextResponse.json(await updateAuthoringDraftView(draftId, await request.json()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: "AUTHORING_UPDATE_FAILED", message }, { status: message.includes("conflict") ? 409 : 400 });
  }
}
