/**
 * Platform mode and the startup invariants that go with it.
 *
 * The POC runs the same images locally and in Azure, and the difference between the two
 * is configuration. That only holds if the Azure configuration cannot quietly degrade
 * into the local one: a shared HMAC secret, a password-bearing connection string or a
 * header-trusting principal resolver is a development convenience locally and an
 * authentication bypass in the cloud. These checks run at startup and refuse to boot
 * rather than serving traffic in a half-configured state.
 */

export type PlatformMode = "local" | "azure";

export class PlatformConfigError extends Error {}

export function platformMode(env: NodeJS.ProcessEnv = process.env): PlatformMode {
  const value = env.PLATFORM_MODE ?? "local";
  if (value !== "local" && value !== "azure") throw new PlatformConfigError(`platform.mode_unsupported:${value}`);
  return value;
}

export function isAzureMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return platformMode(env) === "azure";
}

/** A connection string that carries its own password can never be a managed-identity one. */
export function connectionStringHasPassword(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.password);
  } catch {
    return /(^|[;\s])password=/i.test(value);
  }
}

export type StartupInvariantOptions = {
  /** Environment variables that must be absent in Azure mode. */
  forbidden?: string[];
  /** Environment variables that must be present in Azure mode. */
  required?: string[];
  /** Environment variables holding database URLs, which must be passwordless in Azure mode. */
  databaseUrls?: string[];
};

/**
 * Assert the invariants for the current mode. Local mode asserts nothing: the local
 * stack is expected to use shared secrets and password connection strings.
 */
export function assertPlatformInvariants(
  options: StartupInvariantOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isAzureMode(env)) return;
  const failures: string[] = [];
  for (const name of options.forbidden ?? []) {
    if (env[name]) failures.push(`platform.azure_forbids:${name}`);
  }
  for (const name of options.required ?? []) {
    if (!env[name]) failures.push(`platform.azure_requires:${name}`);
  }
  for (const name of options.databaseUrls ?? []) {
    const value = env[name];
    if (value && connectionStringHasPassword(value)) failures.push(`platform.azure_forbids_password_in:${name}`);
    if (value && value.startsWith("postgresql://") && /@(localhost|127\.0\.0\.1|postgres)[:/]/.test(value)) {
      failures.push(`platform.azure_forbids_local_host_in:${name}`);
    }
  }
  if (failures.length) throw new PlatformConfigError(failures.join("; "));
}
