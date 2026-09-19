/**
 * Application roles and the actions they permit.
 *
 * Coarse gates at the edge (Static Web Apps route roles, Container Apps authentication)
 * decide who may reach a service. They do not decide what a caller may do once it is
 * there, so every protected operation is authorized again here against the resolved
 * principal. The table below is the single place that mapping lives.
 */

export type PlatformAction =
  | "plan.read" | "plan.admit"
  | "run.read" | "run.start" | "run.cancel" | "run.retry"
  | "draft.read" | "draft.write" | "draft.compile" | "draft.evaluate" | "draft.approve" | "draft.publish"
  | "agent.register"
  | "capability.read" | "capability.register"
  | "case.read" | "case.write" | "case.review"
  | "evidence.read" | "evidence.write"
  | "receipt.read" | "event.read"
  | "runtime.state.write" | "envelope.mint";

export type HumanRole =
  | "Harness.Reader" | "Harness.Author" | "Harness.Approver" | "Harness.Operator"
  | "Case.Analyst" | "Case.Reviewer" | "Platform.Auditor";

export type WorkloadRole =
  | "Control.Api.Access" | "Case.Api.Access" | "Capability.Invoke" | "Runtime.State.Write";

const READ_ACTIONS: PlatformAction[] = [
  "plan.read", "run.read", "draft.read", "capability.read",
  "case.read", "evidence.read", "receipt.read", "event.read",
];

const ROLE_ACTIONS: Record<string, PlatformAction[]> = {
  "Harness.Reader": READ_ACTIONS,
  "Harness.Author": [...READ_ACTIONS, "draft.write", "draft.compile", "draft.evaluate", "agent.register", "capability.register"],
  // Approval is deliberately not a superset of authoring: the separation-of-duties check
  // that rejects self-approval only means anything if the two are distinct grants.
  "Harness.Approver": [...READ_ACTIONS, "draft.approve", "draft.publish"],
  "Harness.Operator": [...READ_ACTIONS, "plan.admit", "run.start", "run.cancel", "run.retry"],
  "Case.Analyst": ["case.read", "case.write", "evidence.read", "evidence.write", "run.read"],
  "Case.Reviewer": ["case.read", "case.review", "evidence.read", "run.read"],
  "Platform.Auditor": READ_ACTIONS,

  // Workload roles. A workload never inherits a human role and vice versa.
  "Control.Api.Access": ["plan.read", "run.read", "run.start", "event.read", "receipt.read"],
  "Case.Api.Access": ["case.read", "case.write", "evidence.read", "evidence.write"],
  "Capability.Invoke": ["capability.read"],
  "Runtime.State.Write": ["runtime.state.write", "envelope.mint", "plan.read", "run.read"],
};

export type ResourceRef = {
  kind: string;
  id?: string;
  tenantId?: string;
};

export type AuthorizationDecision = {
  outcome: "allowed" | "denied";
  reasonCode: string;
  action: PlatformAction;
  subjectId: string;
  actorType: string;
  tenantId: string;
  resourceKind: string;
  resourceId: string | null;
};

export class AuthorizationError extends Error {
  readonly httpStatus: number;
  constructor(readonly decision: AuthorizationDecision) {
    super(decision.reasonCode);
    this.httpStatus = decision.reasonCode === "authorization.principal_unauthenticated" ? 401 : 403;
  }
}

export type Principal = {
  subjectId: string;
  tenantId: string;
  actorType: "human" | "workload";
  roles: string[];
  source: "local" | "entra" | "swa";
};

export function actionsForRoles(roles: readonly string[]): Set<PlatformAction> {
  const allowed = new Set<PlatformAction>();
  for (const role of roles) {
    for (const action of ROLE_ACTIONS[role] ?? []) allowed.add(action);
  }
  return allowed;
}

/**
 * Authorize an action and return the bounded decision record.
 *
 * The decision carries identifiers and a stable reason code and nothing else: no tokens,
 * no claim payloads, no case content. It is safe to log and safe to attach to a span.
 */
export function evaluate(
  principal: Principal | null,
  action: PlatformAction,
  resource: ResourceRef,
): AuthorizationDecision {
  const base = {
    action,
    subjectId: principal?.subjectId ?? "anonymous",
    actorType: principal?.actorType ?? "unknown",
    tenantId: principal?.tenantId ?? "unknown",
    resourceKind: resource.kind,
    resourceId: resource.id ?? null,
  };
  if (!principal) return { ...base, outcome: "denied", reasonCode: "authorization.principal_unauthenticated" };
  if (!actionsForRoles(principal.roles).has(action)) {
    return { ...base, outcome: "denied", reasonCode: "authorization.role_missing" };
  }
  // A caller may only ever act inside the tenant its identity was assigned. A requested
  // tenant is a scope, never an authority.
  if (resource.tenantId && resource.tenantId !== principal.tenantId) {
    return { ...base, outcome: "denied", reasonCode: "authorization.tenant_mismatch" };
  }
  return { ...base, outcome: "allowed", reasonCode: "authorization.role_granted" };
}

export interface Authorizer {
  require(principal: Principal | null, action: PlatformAction, resource: ResourceRef): AuthorizationDecision;
}

export function createAuthorizer(
  onDecision?: (decision: AuthorizationDecision) => void,
): Authorizer {
  return {
    require(principal, action, resource) {
      const decision = evaluate(principal, action, resource);
      onDecision?.(decision);
      if (decision.outcome === "denied") throw new AuthorizationError(decision);
      return decision;
    },
  };
}
