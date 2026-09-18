import { NextRequest, NextResponse } from "next/server";
import { getCaseDetail } from "@/lib/runtime-service";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ caseId: string }> },
) {
  try {
    const { caseId } = await context.params;
    const detail = await getCaseDetail(caseId);
    if (!detail) return NextResponse.json({ error: "CASE_NOT_FOUND" }, { status: 404 });
    return NextResponse.json(detail);
  } catch (error) {
    return NextResponse.json(
      { error: "CASE_DETAIL_FAILED", message: error instanceof Error ? error.message : "Unknown error" },
      { status: 502 },
    );
  }
}
