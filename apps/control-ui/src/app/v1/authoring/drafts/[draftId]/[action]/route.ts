import { NextRequest, NextResponse } from "next/server";
import { advanceAuthoringDraft } from "@/lib/runtime-service";

export const dynamic = "force-dynamic";
const ACTIONS = new Set(["compile", "evaluate", "approve", "publish"]);

export async function POST(_request: NextRequest, context: { params: Promise<{ draftId: string; action: string }> }) {
  try {
    const { draftId, action } = await context.params;
    if (!ACTIONS.has(action)) return NextResponse.json({ error: "AUTHORING_ACTION_INVALID" }, { status: 404 });
    return NextResponse.json(await advanceAuthoringDraft(draftId, action as "compile" | "evaluate" | "approve" | "publish"));
  } catch (error) {
    return NextResponse.json({ error: "AUTHORING_ACTION_FAILED", message: error instanceof Error ? error.message : "Unknown error" }, { status: 409 });
  }
}
