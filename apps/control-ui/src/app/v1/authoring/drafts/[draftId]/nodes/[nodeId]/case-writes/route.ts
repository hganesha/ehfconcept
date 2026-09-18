import { NextRequest, NextResponse } from "next/server";
import { updateNodeCaseWritesView } from "@/lib/runtime-service";

export async function PUT(request: NextRequest, context: { params: Promise<{ draftId: string; nodeId: string }> }) {
  try {
    const { draftId, nodeId } = await context.params;
    return NextResponse.json(await updateNodeCaseWritesView(draftId, nodeId, await request.json()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: "CASE_WRITES_UPDATE_FAILED", message }, { status: message.includes("conflict") ? 409 : 400 });
  }
}
