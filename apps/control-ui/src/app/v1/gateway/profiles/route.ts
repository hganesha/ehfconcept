import { NextResponse } from "next/server";
import { listModelProfiles } from "@/lib/runtime-service";

export const dynamic = "force-dynamic";

export async function GET() {
  const nowIso = new Date().toISOString();
  return NextResponse.json({
    items: await listModelProfiles(),
    generatedAt: nowIso,
    telemetryFreshThrough: nowIso,
  });
}
