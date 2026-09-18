import { NextRequest, NextResponse } from "next/server";
import { listGatewayDecisions } from "@/lib/runtime-service";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const decision = req.nextUrl.searchParams.get("decision") || undefined;
    const items = await listGatewayDecisions(decision);
    const nowIso = new Date().toISOString();
    return NextResponse.json({
      items,
      nextCursor: null,
      generatedAt: nowIso,
      telemetryFreshThrough: nowIso,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "GATEWAY_DECISIONS_FAILED", message: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
