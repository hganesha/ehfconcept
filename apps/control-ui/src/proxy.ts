import { AuthorizationError, createPrincipalResolverFromEnv, isAzureMode, type Principal } from "@ehf/identity";
import { NextRequest, NextResponse } from "next/server";

const INTERNAL_HEADERS = [
  "x-ehf-authenticated-subject",
  "x-ehf-authenticated-tenant",
  "x-ehf-authenticated-roles",
  "x-ehf-authenticated-source",
] as const;

let resolver: ReturnType<typeof createPrincipalResolverFromEnv> | undefined;

function localAutomaticPrincipal(request: NextRequest): Principal | null {
  if (isAzureMode() || process.env.CONTROL_UI_LOCAL_AUTOLOGIN !== "true") return null;
  const approvalRoute = /\/v1\/authoring\/drafts\/[^/]+\/(approve|publish)$/.test(request.nextUrl.pathname);
  const useApprover = approvalRoute && process.env.CONTROL_UI_LOCAL_AUTOMATED_APPROVAL === "true";
  const subjectId = useApprover
    ? process.env.CONTROL_UI_APPROVER_ID ?? "local-approver"
    : process.env.CONTROL_UI_ACTOR_ID ?? "local-author";
  const roles = (useApprover
    ? process.env.CONTROL_UI_APPROVER_ROLES ?? "Harness.Reader,Harness.Approver"
    : process.env.CONTROL_UI_ACTOR_ROLES ?? "Harness.Reader,Harness.Author,Harness.Operator,Case.Analyst,Case.Reviewer")
    .split(",").map((role) => role.trim()).filter(Boolean);
  return {
    subjectId,
    tenantId: process.env.LOCAL_DEFAULT_TENANT_ID ?? process.env.CASE_UI_TENANT_ID ?? "tenant_demo",
    roles,
    actorType: "human",
    source: "local",
  };
}

export async function proxy(request: NextRequest) {
  try {
    const principal = localAutomaticPrincipal(request)
      ?? await (resolver ??= createPrincipalResolverFromEnv()).resolve({
        headers: Object.fromEntries(request.headers.entries()),
      });
    if (principal.actorType !== "human") {
      return NextResponse.json({ error: "authorization.interactive_user_required" }, { status: 403 });
    }
    const forwarded = new Headers(request.headers);
    for (const name of INTERNAL_HEADERS) forwarded.delete(name);
    forwarded.set("x-ehf-authenticated-subject", principal.subjectId);
    forwarded.set("x-ehf-authenticated-tenant", principal.tenantId);
    forwarded.set("x-ehf-authenticated-roles", principal.roles.join(","));
    forwarded.set("x-ehf-authenticated-source", principal.source);
    return NextResponse.next({ request: { headers: forwarded } });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return NextResponse.json({ error: error.decision.reasonCode }, { status: error.httpStatus });
    }
    return NextResponse.json({ error: "authorization.configuration_invalid" }, { status: 503 });
  }
}

export const config = { matcher: ["/v1/:path*"] };
