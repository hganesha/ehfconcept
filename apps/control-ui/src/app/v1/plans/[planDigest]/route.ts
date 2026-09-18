import { NextRequest, NextResponse } from "next/server";
import { getHarnessDetail } from "@/lib/runtime-service";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ planDigest: string }> }
) {
  try {
    const { planDigest } = await context.params;
    const detail = await getHarnessDetail(planDigest);
    if (!detail) {
      return NextResponse.json(
        { error: "PLAN_NOT_FOUND", message: "Admitted plan digest not found." },
        { status: 404 }
      );
    }
    const nowIso = new Date().toISOString();
    return NextResponse.json({
      ...detail,
      generatedAt: nowIso,
      telemetryFreshThrough: nowIso,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "PLAN_DETAIL_FAILED", message: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
