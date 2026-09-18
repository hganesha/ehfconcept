import { NextResponse } from "next/server";
import { getSystemStatus } from "@/lib/runtime-service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const system = await getSystemStatus();
    if (system.globalReadiness === "Unavailable") throw new Error("control-surface.upstream_unavailable");
    return NextResponse.json({
      status: "Ready",
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      {
        status: "Unavailable",
        error: err instanceof Error ? err.message : "Readiness check failed",
      },
      { status: 503 }
    );
  }
}
