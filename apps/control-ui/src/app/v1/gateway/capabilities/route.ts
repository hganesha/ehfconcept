import { NextResponse } from "next/server";
import { listToolCapabilities } from "@/lib/runtime-service";

export const dynamic = "force-dynamic";

export async function GET() {
  const nowIso = new Date().toISOString();
  return NextResponse.json({
    items: await listToolCapabilities(),
    generatedAt: nowIso,
    telemetryFreshThrough: nowIso,
  });
}
