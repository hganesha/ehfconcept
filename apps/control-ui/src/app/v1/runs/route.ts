import { NextRequest, NextResponse } from "next/server";
import { getGatewayStatus, listRuns, startNewRun } from "@/lib/runtime-service";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const [items, gateway] = await Promise.all([
      listRuns({
        query: sp.get("query") || undefined,
        status: sp.get("status") || undefined,
        planDigest: sp.get("planDigest") || undefined,
        domain: sp.get("domain") || undefined,
        modelTier: sp.get("modelTier") || undefined,
        onlyNeedsAttention: sp.get("onlyNeedsAttention") === "true",
      }),
      getGatewayStatus(),
    ]);
    const nowIso = new Date().toISOString();
    return NextResponse.json({
      items,
      nextCursor: null,
      generatedAt: nowIso,
      telemetryFreshThrough: nowIso,
      runtimeMode: gateway.runtimeMode,
      fixture: gateway.runtimeMode === "Recorded",
    });
  } catch (err) {
    return NextResponse.json(
      { error: "RUNS_QUERY_FAILED", message: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const result = await startNewRun({
      planDigest: String(body.planDigest || ""),
      inputPayload: (body.inputPayload as Record<string, unknown>) || {},
      idempotencyKey: String(
        body.idempotencyKey || `idem-${Date.now()}`
      ),
    });

    if (result.validationErrors.length > 0) {
      return NextResponse.json(
        {
          error: "SCHEMA_VALIDATION_FAILED",
          validationErrors: result.validationErrors,
        },
        { status: 422 }
      );
    }

    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (err) {
    return NextResponse.json(
      {
        error: "RUN_START_FAILED",
        validationErrors: [err instanceof Error ? err.message : "Invalid payload"],
      },
      { status: 400 }
    );
  }
}
