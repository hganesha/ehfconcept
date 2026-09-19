import { timingSafeEqual } from "node:crypto";
import { AuthorizationError, type Principal } from "./authorization.js";
import { isAzureMode } from "./platform-config.js";
import { EntraJwtPrincipalResolver, type PrincipalResolver, type RequestLike } from "./principal.js";
import { createPrincipalResolverFromEnv } from "./factory.js";

function constantTimeEquals(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function unauthenticated(reasonCode: string): AuthorizationError {
  return new AuthorizationError({
    outcome: "denied", reasonCode, action: "plan.read", subjectId: "anonymous",
    actorType: "workload", tenantId: "unknown", resourceKind: "request", resourceId: null,
  });
}

export type ServiceTokenGrant = {
  token: string;
  subjectId: string;
  roles: string[];
  tenantId: string;
};

/**
 * Development workload identity: a shared bearer token per calling service.
 *
 * The Azure deployment replaces this with managed-identity Entra tokens; the point of
 * keeping the same interface is that services enforce app roles either way, so the
 * authorization code does not change when the credential does.
 */
export class ServiceTokenPrincipalResolver implements PrincipalResolver {
  readonly source = "local" as const;

  constructor(private readonly grants: ServiceTokenGrant[], env: NodeJS.ProcessEnv = process.env) {
    if (isAzureMode(env)) throw new Error("identity.service_token_forbidden_in_azure_mode");
    if (!grants.length) throw new Error("identity.service_token_grants_missing");
    for (const grant of grants) {
      if (grant.token.length < 24) throw new Error(`identity.service_token_too_short:${grant.subjectId}`);
    }
  }

  async resolve(request: RequestLike): Promise<Principal> {
    const value = request.headers.authorization;
    const authorization = (Array.isArray(value) ? value[0] : value) ?? "";
    if (!authorization.startsWith("Bearer ")) throw unauthenticated("authorization.principal_unauthenticated");
    const supplied = authorization.slice(7);
    const grant = this.grants.find((candidate) => constantTimeEquals(supplied, candidate.token));
    if (!grant) throw unauthenticated("authorization.service_token_invalid");
    return {
      subjectId: grant.subjectId,
      tenantId: grant.tenantId,
      actorType: "workload",
      roles: grant.roles,
      source: "local",
    };
  }
}

/**
 * Resolve the workload identity of a calling service.
 *
 * Grants are declared by the consuming service, so each one states which callers it
 * expects rather than sharing one platform-wide credential.
 */
export function createWorkloadResolverFromEnv(
  grants: ServiceTokenGrant[],
  env: NodeJS.ProcessEnv = process.env,
): PrincipalResolver {
  if (!isAzureMode(env)) return new ServiceTokenPrincipalResolver(grants, env);
  const resolver = createPrincipalResolverFromEnv(env);
  if (!(resolver instanceof EntraJwtPrincipalResolver)) {
    throw new Error("identity.workload_resolver_requires_entra_in_azure_mode");
  }
  return resolver;
}

/** Role a caller must hold before its asserted end-user context is believed. */
export const EDGE_DELEGATE_ROLE = "Edge.Delegate";

function headerValue(request: RequestLike, name: string): string | undefined {
  const value = request.headers[name];
  const single = Array.isArray(value) ? value[0] : value;
  return single?.trim() || undefined;
}

/**
 * Identity for requests that arrive through the UI backend-for-frontend.
 *
 * The edge is the only component that has seen the interactive sign-in, so it has to
 * pass the end-user context onwards. That context is believed only when the request also
 * proves it came from the edge and the edge holds the delegation role -- so the actor
 * and tenant headers, which used to be accepted from anyone, now carry no authority on
 * their own. The edge is expected to strip inbound copies before setting its own.
 */
export class DelegatedPrincipalResolver implements PrincipalResolver {
  readonly source: Principal["source"];

  constructor(private readonly edge: PrincipalResolver) {
    this.source = edge.source;
  }

  async resolve(request: RequestLike): Promise<Principal> {
    const edgePrincipal = await this.edge.resolve(request);
    if (!edgePrincipal.roles.includes(EDGE_DELEGATE_ROLE)) throw unauthenticated("authorization.delegation_not_permitted");
    const subjectId = headerValue(request, "x-actor-id");
    if (!subjectId) throw unauthenticated("authorization.delegated_actor_missing");
    const roles = headerValue(request, "x-actor-roles")?.split(",").map((role) => role.trim()).filter(Boolean) ?? [];
    if (!roles.length) throw unauthenticated("authorization.delegated_roles_missing");
    // The edge may narrow the tenant it acts in, never widen it beyond its own assignment.
    const requestedTenant = headerValue(request, "x-tenant-id");
    if (requestedTenant && requestedTenant !== edgePrincipal.tenantId) throw unauthenticated("authorization.delegated_tenant_mismatch");
    return {
      subjectId,
      tenantId: edgePrincipal.tenantId,
      actorType: "human",
      roles,
      source: edgePrincipal.source,
    };
  }
}
