import { NextRequest, NextResponse } from "next/server";
import { admitCompiledPlan, getGatewayStatus, listHarnessSummariesPage } from "@/lib/runtime-service";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const [page, gateway] = await Promise.all([
      listHarnessSummariesPage({
        query: sp.get("query") || undefined,
        domain: sp.get("domain") || undefined,
        modelTier: sp.get("modelTier") || undefined,
        cursor: sp.get("cursor") || undefined,
        limit: sp.get("limit") ? Number(sp.get("limit")) : undefined,
      }),
      getGatewayStatus(),
    ]);
    const nowIso = new Date().toISOString();
    return NextResponse.json({
      items: page.items,
      nextCursor: page.nextCursor,
      generatedAt: nowIso,
      telemetryFreshThrough: nowIso,
      runtimeMode: gateway.runtimeMode,
      fixture: gateway.runtimeMode === "Recorded",
    });
  } catch (err) {
    return NextResponse.json(
      { error: "PLANS_QUERY_FAILED", message: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const rawText =
      typeof body.rawPlan === "string"
        ? body.rawPlan
        : JSON.stringify(body, null, 2);

    const result = await admitCompiledPlan(rawText);
    const status = result.admitted ? 201 : result.collision ? 409 : 422;

    return NextResponse.json(
      {
        ...result,
        generatedAt: new Date().toISOString(),
      },
      { status }
    );
  } catch (err) {
    return NextResponse.json(
      {
        admitted: false,
        collision: false,
        planDigest: null,
        diagnostics: [
          `ERR_REQUEST_PARSE: ${err instanceof Error ? err.message : "Invalid payload"}`,
        ],
      },
      { status: 400 }
    );
  }
}
