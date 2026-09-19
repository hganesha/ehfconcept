import { MemorySaver } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import {
  assertPlatformInvariants,
  createAzureAccessTokenProvider,
  createWorkloadResolverFromEnv,
  isAzureMode,
} from "@ehf/identity";
import { initializeTelemetry } from "@ehf/telemetry";
import { buildRuntimeHost } from "./app.js";
import { executeRuntimeInvocation } from "./executor.js";

function requiredEnv(name: string, error: string): string {
  const value = process.env[name];
  if (!value) throw new Error(error);
  return value;
}

// The runtime signs nothing and journals through the control plane, so it must not hold
// an envelope secret in any mode, and must hold no database credential in Azure mode.
if (process.env.EXECUTION_ENVELOPE_SECRET) throw new Error("runtime.envelope_secret_forbidden");
if (process.env.RUNTIME_GRANT_SECRET) throw new Error("runtime.grant_secret_forbidden");
assertPlatformInvariants({
  forbidden: ["RUNTIME_SERVICE_TOKEN", "RUNTIME_HOST_AUTH_TOKEN", "RUNTIME_CHECKPOINT_DATABASE_URL"],
  required: ["INTERNAL_API_TOKEN_SCOPE"],
  databaseUrls: ["RUNTIME_CHECKPOINT_DATABASE_URL"],
});

const telemetry = initializeTelemetry({ serviceName: "harness-runtime-host" });
const serviceToken = isAzureMode()
  ? createAzureAccessTokenProvider(requiredEnv("INTERNAL_API_TOKEN_SCOPE", "runtime.internal_api_token_scope_missing"))
  : requiredEnv("RUNTIME_SERVICE_TOKEN", "runtime.service_token_missing");
const hostAuthorization = isAzureMode()
  ? createWorkloadResolverFromEnv([], process.env)
  : null;

/**
 * Checkpoint backend, chosen explicitly.
 *
 * `postgres` keeps runs resumable and is the local default. `memory` exists so the
 * runtime can be deployed with no database credential whatsoever -- which is what a
 * hosted agent outside the platform's trust boundary needs -- at the cost of
 * resumability. A deployment using it is a connectivity milestone, not a durable one.
 */
const checkpointBackend = process.env.RUNTIME_CHECKPOINT_BACKEND ?? "postgres";
let saver: BaseCheckpointSaver;
let closeSaver = async (): Promise<void> => {};
if (checkpointBackend === "postgres") {
  const connectionString = requiredEnv("RUNTIME_CHECKPOINT_DATABASE_URL", "runtime.checkpoint_database_url_missing");
  const postgres = PostgresSaver.fromConnString(connectionString, { schema: "langgraph_checkpoint" });
  await postgres.setup();
  saver = postgres;
  closeSaver = () => postgres.end();
} else if (checkpointBackend === "memory") {
  saver = new MemorySaver();
} else {
  throw new Error(`runtime.checkpoint_backend_unsupported:${checkpointBackend}`);
}

const app = buildRuntimeHost({
  ...(hostAuthorization
    ? {
        authorize: async (authorization: string | undefined) => {
          try {
            await hostAuthorization.resolve({ headers: { authorization } });
            return true;
          } catch {
            return false;
          }
        },
      }
    : { authToken: requiredEnv("RUNTIME_HOST_AUTH_TOKEN", "runtime_host.auth_token_missing") }),
  execute: (request, signal) => executeRuntimeInvocation(request, {
    saver,
    gatewayUrl: process.env.CAPABILITY_GATEWAY_URL ?? "http://capability-gateway:4101",
    caseApiUrl: process.env.CASE_API_URL ?? "http://case-api:4102",
    controlPlaneUrl: process.env.ENVELOPE_BROKER_URL ?? "http://control-api:4100",
    serviceToken,
    providerMetadata: {
      host: isAzureMode() ? "azure_foundry" : "local_http",
      contractVersion: "runtime.invocation.v1",
      checkpointBackend,
    },
  }, signal),
});

const close = async () => {
  await app.close();
  await closeSaver();
  await telemetry.shutdown();
};
process.once("SIGTERM", () => { void close(); });
process.once("SIGINT", () => { void close(); });

await app.listen({ host: "0.0.0.0", port: Number(process.env.RUNTIME_HOST_PORT ?? 8088) });
