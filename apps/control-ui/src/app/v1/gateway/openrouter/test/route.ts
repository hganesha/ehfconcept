import { NextResponse } from "next/server";
import { runOpenRouterConnectionTest } from "@/lib/runtime-service";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const res = await runOpenRouterConnectionTest();
    return NextResponse.json(res);
  } catch (err) {
    return NextResponse.json(
      { error: "OPENROUTER_TEST_FAILED", message: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
