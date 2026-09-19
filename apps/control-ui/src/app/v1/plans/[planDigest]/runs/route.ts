import { NextRequest, NextResponse } from "next/server";
import { listRunsPage } from "@/lib/runtime-service";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ planDigest: string }> }
) {
  try {
    const { planDigest } = await context.params;
    const page = await listRunsPage({
      planDigest,
      cursor: req.nextUrl.searchParams.get("cursor") || undefined,
      limit: req.nextUrl.searchParams.get("limit") ? Number(req.nextUrl.searchParams.get("limit")) : undefined,
    });
    const nowIso = new Date().toISOString();
    return NextResponse.json({
      items: page.items,
      nextCursor: page.nextCursor,
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
