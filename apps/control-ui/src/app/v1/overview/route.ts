import { NextResponse } from "next/server";
import { getOverviewData } from "@/lib/runtime-service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getOverviewData();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: "OVERVIEW_FETCH_FAILED", message: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
