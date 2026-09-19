import type { JWTPayload } from "jose";
import { EntraJwtPrincipalResolver, LocalHeaderPrincipalResolver, type PrincipalResolver } from "./principal.js";
import { isAzureMode } from "./platform-config.js";

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`identity.config_missing:${name}`);
  return value;
}

/**
 * Build the resolver the deployment selected.
 *
 * `IDENTITY_PROVIDER` is validated against the platform mode rather than trusted on its
 * own, so an Azure deployment cannot be talked into header-based identity by a stray
 * environment variable.
 */
export function createPrincipalResolverFromEnv(env: NodeJS.ProcessEnv = process.env): PrincipalResolver {
  const provider = env.IDENTITY_PROVIDER ?? (isAzureMode(env) ? "entra" : "local_headers");
  if (provider === "local_headers") {
    if (isAzureMode(env)) throw new Error("identity.local_headers_forbidden_in_azure_mode");
    return new LocalHeaderPrincipalResolver({
      tenantId: env.LOCAL_DEFAULT_TENANT_ID ?? "tenant_demo",
      roles: (env.LOCAL_DEFAULT_ROLES ?? "Harness.Reader").split(",").map((role) => role.trim()).filter(Boolean),
    }, env);
  }
  if (provider === "entra") {
    const tenantId = requiredEnv(env, "ENTRA_TENANT_ID");
    // A single-tenant POC maps every authorized principal into one platform tenant. A
    // multi-tenant deployment replaces this with a real assignment lookup; what matters
    // is that the value never comes from the request.
    const platformTenantId = requiredEnv(env, "PLATFORM_TENANT_ID");
    const resolveTenant = (claims: JWTPayload): string | undefined =>
      claims.tid === tenantId ? platformTenantId : undefined;
    return new EntraJwtPrincipalResolver({
      tenantId,
      audience: requiredEnv(env, "ENTRA_API_AUDIENCE"),
      issuer: env.ENTRA_ISSUER ?? `https://login.microsoftonline.com/${tenantId}/v2.0`,
      jwksUri: env.ENTRA_JWKS_URI ?? `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
      resolveTenant,
      ...(env.ENTRA_ALLOWED_CLIENT_IDS
        ? { allowedClientIds: env.ENTRA_ALLOWED_CLIENT_IDS.split(",").map((id) => id.trim()).filter(Boolean) }
        : {}),
    });
  }
  throw new Error(`identity.provider_unsupported:${provider}`);
}
