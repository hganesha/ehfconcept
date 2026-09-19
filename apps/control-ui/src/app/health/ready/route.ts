import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const endpoints = [
      process.env.CONTROL_API_INTERNAL_URL ?? "http://127.0.0.1:4100",
      process.env.CAPABILITY_GATEWAY_INTERNAL_URL ?? "http://127.0.0.1:4101",
      process.env.CASE_API_INTERNAL_URL ?? "http://127.0.0.1:4102",
    ];
    const checks = await Promise.all(endpoints.map(async (base) => {
      const response = await fetch(`${base.replace(/\/$/, "")}/health/ready`, {
        cache: "no-store",
        signal: AbortSignal.timeout(3_000),
      });
      return response.ok;
    }));
    if (checks.some((ready) => !ready)) throw new Error("control-surface.upstream_unavailable");
    return NextResponse.json({
      status: "Ready",
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      {
        status: "Unavailable",
        error: err instanceof Error ? err.message : "Readiness check failed",
      },
      { status: 503 }
    );
  }
}
