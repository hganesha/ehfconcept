import { NextRequest, NextResponse } from "next/server";
import { listAuthoringAgentsView, registerAuthoringAgentView } from "@/lib/runtime-service";
export const dynamic = "force-dynamic";
export async function GET() { try { return NextResponse.json({ items: await listAuthoringAgentsView() }); } catch (error) { return NextResponse.json({ error: "AGENT_REGISTRY_FAILED", message: error instanceof Error ? error.message : "Unknown error" }, { status: 502 }); } }
export async function POST(request: NextRequest) { try { return NextResponse.json(await registerAuthoringAgentView(await request.json()), { status: 201 }); } catch (error) { return NextResponse.json({ error: "AGENT_REGISTRATION_FAILED", message: error instanceof Error ? error.message : "Unknown error" }, { status: 400 }); } }
