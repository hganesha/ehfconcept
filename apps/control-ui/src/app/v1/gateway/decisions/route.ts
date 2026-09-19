import { NextRequest, NextResponse } from "next/server";
import { listGatewayDecisionsPage } from "@/lib/runtime-service";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const decision = req.nextUrl.searchParams.get("decision") || undefined;
    const page = await listGatewayDecisionsPage({
      decision,
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
      { error: "GATEWAY_DECISIONS_FAILED", message: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
