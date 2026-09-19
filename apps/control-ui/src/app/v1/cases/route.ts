import { NextRequest, NextResponse } from "next/server";
import { createDemoKycCase, listCaseSummariesPage } from "@/lib/runtime-service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const page = await listCaseSummariesPage({
      query: request.nextUrl.searchParams.get("query") ?? undefined,
      status: request.nextUrl.searchParams.get("status") ?? undefined,
      cursor: request.nextUrl.searchParams.get("cursor") ?? undefined,
      limit: request.nextUrl.searchParams.get("limit") ? Number(request.nextUrl.searchParams.get("limit")) : undefined,
    });
    return NextResponse.json({ items: page.items, nextCursor: page.nextCursor, generatedAt: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json(
      { error: "CASES_QUERY_FAILED", message: error instanceof Error ? error.message : "Unknown error" },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    if (typeof body.planDigest !== "string" || !/^[a-f0-9]{64}$/i.test(body.planDigest)) {
      return NextResponse.json({ error: "DEMO_CASE_PLAN_DIGEST_INVALID" }, { status: 400 });
    }
    const result = await createDemoKycCase({
      planDigest: body.planDigest,
      ...(typeof body.tenantId === "string" ? { tenantId: body.tenantId } : {}),
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.country === "string" ? { country: body.country } : {}),
      ...(typeof body.customerType === "string" ? { customerType: body.customerType } : {}),
      ...(typeof body.riskTier === "string" ? { riskTier: body.riskTier } : {}),
      ...(typeof body.policySnapshotDigest === "string" ? { policySnapshotDigest: body.policySnapshotDigest } : {}),
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: "DEMO_CASE_CREATE_FAILED", message: error instanceof Error ? error.message : "Unknown error" },
      { status: 502 },
    );
  }
}
