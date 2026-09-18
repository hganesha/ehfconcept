import { NextRequest, NextResponse } from "next/server";
import { listAuthoringSkillsView, registerAuthoringSkillView } from "@/lib/runtime-service";
export const dynamic = "force-dynamic";
export async function GET() { try { return NextResponse.json({ items: await listAuthoringSkillsView() }); } catch (error) { return NextResponse.json({ error: "SKILL_REGISTRY_FAILED", message: error instanceof Error ? error.message : "Unknown error" }, { status: 502 }); } }
export async function POST(request: NextRequest) { try { return NextResponse.json(await registerAuthoringSkillView(await request.json()), { status: 201 }); } catch (error) { return NextResponse.json({ error: "SKILL_REGISTRATION_FAILED", message: error instanceof Error ? error.message : "Unknown error" }, { status: 400 }); } }
