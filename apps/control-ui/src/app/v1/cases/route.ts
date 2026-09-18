import { NextRequest, NextResponse } from "next/server";
import { listCaseSummaries } from "@/lib/runtime-service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const items = await listCaseSummaries({
      query: request.nextUrl.searchParams.get("query") ?? undefined,
      status: request.nextUrl.searchParams.get("status") ?? undefined,
    });
    return NextResponse.json({ items, generatedAt: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json(
      { error: "CASES_QUERY_FAILED", message: error instanceof Error ? error.message : "Unknown error" },
      { status: 502 },
    );
  }
}
