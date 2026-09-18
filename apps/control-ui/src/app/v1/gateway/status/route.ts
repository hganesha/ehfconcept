import { NextResponse } from "next/server";
import { getGatewayStatus } from "@/lib/runtime-service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const status = await getGatewayStatus();
    return NextResponse.json(status);
  } catch (err) {
    return NextResponse.json(
      { error: "GATEWAY_STATUS_FAILED", message: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
