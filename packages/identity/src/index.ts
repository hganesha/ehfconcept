export {
  actionsForRoles,
  AuthorizationError,
  createAuthorizer,
  evaluate,
  type AuthorizationDecision,
  type Authorizer,
  type HumanRole,
  type PlatformAction,
  type Principal,
  type ResourceRef,
  type WorkloadRole,
} from "./authorization.js";
export {
  EntraJwtPrincipalResolver,
  LocalHeaderPrincipalResolver,
  tryResolve,
  type EntraResolverOptions,
  type PrincipalResolver,
  type RequestLike,
} from "./principal.js";
export {
  assertPlatformInvariants,
  connectionStringHasPassword,
  isAzureMode,
  platformMode,
  PlatformConfigError,
  type PlatformMode,
  type StartupInvariantOptions,
} from "./platform-config.js";
export { createPrincipalResolverFromEnv } from "./factory.js";
export {
  createWorkloadResolverFromEnv,
  DelegatedPrincipalResolver,
  EDGE_DELEGATE_ROLE,
  ServiceTokenPrincipalResolver,
  type ServiceTokenGrant,
} from "./workload.js";
export { createGuard, type Guard, type GuardOptions } from "./fastify.js";
