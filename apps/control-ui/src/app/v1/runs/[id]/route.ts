import { NextRequest, NextResponse } from "next/server";
import { getRunDetail } from "@/lib/runtime-service";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const detail = await getRunDetail(id);
    if (!detail) {
      return NextResponse.json(
        { error: "RUN_NOT_FOUND", message: `Run ${id} not found.` },
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
      { error: "RUN_DETAIL_FAILED", message: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
