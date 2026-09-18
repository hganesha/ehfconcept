import { NextRequest, NextResponse } from "next/server";
import { getRunDetail } from "@/lib/runtime-service";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const afterSeq = Number(req.nextUrl.searchParams.get("afterSequence") || "0");
    const detail = await getRunDetail(id);
    if (!detail) {
      return NextResponse.json({ error: "RUN_NOT_FOUND" }, { status: 404 });
    }

    const events = detail.events.filter((e) => e.sequence > afterSeq);
    const nowIso = new Date().toISOString();
    return NextResponse.json({
      runId: id,
      status: detail.status,
      events,
      generatedAt: nowIso,
      telemetryFreshThrough: nowIso,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "RUN_EVENTS_FAILED", message: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
