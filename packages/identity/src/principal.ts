import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { AuthorizationError, evaluate, type Principal } from "./authorization.js";
import { isAzureMode } from "./platform-config.js";

export type RequestLike = {
  headers: Record<string, string | string[] | undefined>;
};

export interface PrincipalResolver {
  readonly source: Principal["source"];
  resolve(request: RequestLike): Promise<Principal>;
}

function header(request: RequestLike, name: string): string | undefined {
  const value = request.headers[name];
  const single = Array.isArray(value) ? value[0] : value;
  return single?.trim() || undefined;
}

function unauthenticated(reasonCode: string): AuthorizationError {
  return new AuthorizationError({
    outcome: "denied",
    reasonCode,
    action: "plan.read",
    subjectId: "anonymous",
    actorType: "unknown",
    tenantId: "unknown",
    resourceKind: "request",
    resourceId: null,
  });
}

/**
 * Development resolver: the caller asserts its own identity through headers.
 *
 * This is only safe because nothing but a developer's own machine can reach the local
 * stack. It refuses to construct in Azure mode rather than relying on a deployment to
 * remember not to select it -- the previous code defaulted a missing `x-actor-id` to
 * "local-author", which in a cloud deployment is an unauthenticated author.
 */
export class LocalHeaderPrincipalResolver implements PrincipalResolver {
  readonly source = "local" as const;

  constructor(
    private readonly defaults: { tenantId: string; roles: string[] },
    env: NodeJS.ProcessEnv = process.env,
  ) {
    if (isAzureMode(env)) throw new Error("identity.local_resolver_forbidden_in_azure_mode");
  }

  async resolve(request: RequestLike): Promise<Principal> {
    const subjectId = header(request, "x-actor-id");
    if (!subjectId) throw unauthenticated("authorization.principal_unauthenticated");
    const roles = header(request, "x-actor-roles")?.split(",").map((role) => role.trim()).filter(Boolean);
    return {
      subjectId,
      tenantId: header(request, "x-tenant-id") ?? this.defaults.tenantId,
      actorType: header(request, "x-actor-type") === "workload" ? "workload" : "human",
      roles: roles?.length ? roles : this.defaults.roles,
      source: "local",
    };
  }
}

export type EntraResolverOptions = {
  tenantId: string;
  audience: string;
  /** OpenID issuer, e.g. https://login.microsoftonline.com/<tenant>/v2.0 */
  issuer: string;
  jwksUri: string;
  /** Maps an Entra tenant/group assignment to the platform tenant this principal acts in. */
  resolveTenant: (claims: JWTPayload) => string | undefined;
  /** Client application IDs permitted to call this API, when the deployment restricts them. */
  allowedClientIds?: string[];
};

/**
 * Entra resolver for internal HTTP services.
 *
 * Container Apps authentication can validate the token in front of the app, but the
 * application still has to enforce the claims it cares about -- the roles, the audience
 * it was actually issued for, and which client applications may call it. A validated
 * token is not an authorization decision.
 */
export class EntraJwtPrincipalResolver implements PrincipalResolver {
  readonly source = "entra" as const;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly options: EntraResolverOptions) {
    this.jwks = createRemoteJWKSet(new URL(options.jwksUri));
  }

  async resolve(request: RequestLike): Promise<Principal> {
    const authorization = header(request, "authorization");
    if (!authorization?.startsWith("Bearer ")) throw unauthenticated("authorization.principal_unauthenticated");
    let claims: JWTPayload;
    try {
      const verified = await jwtVerify(authorization.slice(7), this.jwks, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: ["RS256"],
        clockTolerance: 5,
      });
      claims = verified.payload;
    } catch {
      throw unauthenticated("authorization.token_invalid");
    }
    if (claims.tid && claims.tid !== this.options.tenantId) throw unauthenticated("authorization.token_foreign_tenant");
    if (this.options.allowedClientIds?.length) {
      const clientId = typeof claims.azp === "string" ? claims.azp : typeof claims.appid === "string" ? claims.appid : undefined;
      if (!clientId || !this.options.allowedClientIds.includes(clientId)) {
        throw unauthenticated("authorization.client_not_permitted");
      }
    }
    const roles = Array.isArray(claims.roles) ? claims.roles.filter((role): role is string => typeof role === "string") : [];
    // Tenancy comes from an assignment the platform controls, never from a value the
    // caller supplied. A caller-provided x-tenant-id is at most a requested scope.
    const tenantId = this.options.resolveTenant(claims);
    if (!tenantId) throw unauthenticated("authorization.tenant_unassigned");
    const subjectId = typeof claims.oid === "string" ? claims.oid : typeof claims.sub === "string" ? claims.sub : undefined;
    if (!subjectId) throw unauthenticated("authorization.subject_missing");
    return {
      subjectId,
      tenantId,
      actorType: claims.idtyp === "app" || !claims.name ? "workload" : "human",
      roles,
      source: "entra",
    };
  }
}

/**
 * Resolve the principal for a request, returning null instead of throwing so a caller
 * can record a single denial decision for an unauthenticated request.
 */
export async function tryResolve(resolver: PrincipalResolver, request: RequestLike): Promise<Principal | null> {
  try {
    return await resolver.resolve(request);
  } catch (error) {
    if (error instanceof AuthorizationError) return null;
    throw error;
  }
}

export { evaluate };
