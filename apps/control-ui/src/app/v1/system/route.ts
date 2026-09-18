import { NextResponse } from "next/server";
import { getSystemStatus } from "@/lib/runtime-service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const sys = await getSystemStatus();
    return NextResponse.json(sys);
  } catch (err) {
    return NextResponse.json(
      { error: "SYSTEM_STATUS_FAILED", message: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
