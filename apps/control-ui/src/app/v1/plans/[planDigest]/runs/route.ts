import { NextRequest, NextResponse } from "next/server";
import { listRuns } from "@/lib/runtime-service";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ planDigest: string }> }
) {
  try {
    const { planDigest } = await context.params;
    const items = await listRuns({ planDigest });
    const nowIso = new Date().toISOString();
    return NextResponse.json({
      items,
      nextCursor: null,
      generatedAt: nowIso,
      telemetryFreshThrough: nowIso,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "PLAN_RUNS_FAILED", message: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
