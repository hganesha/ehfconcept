import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createDatabase } from "@ehf/persistence";
import { initializeTelemetry } from "@ehf/telemetry";
import { buildRuntimeHost } from "./app.js";
import { executeRuntimeInvocation } from "./executor.js";

function requiredEnv(name: string, error: string): string {
  const value = process.env[name];
  if (!value) throw new Error(error);
  return value;
}

const telemetry = initializeTelemetry({ serviceName: "harness-runtime-host" });
const connectionString = requiredEnv("RUNTIME_CHECKPOINT_DATABASE_URL", "runtime.checkpoint_database_url_missing");
const db = createDatabase(connectionString);
const saver = PostgresSaver.fromConnString(connectionString, { schema: "langgraph_checkpoint" });
await saver.setup();

const app = buildRuntimeHost({
  authToken: requiredEnv("RUNTIME_HOST_AUTH_TOKEN", "runtime_host.auth_token_missing"),
  execute: (request) => executeRuntimeInvocation(request, {
    db,
    saver,
    gatewayUrl: process.env.CAPABILITY_GATEWAY_URL ?? "http://capability-gateway:4101",
    caseApiUrl: process.env.CASE_API_URL ?? "http://case-api:4102",
    executionSecret: requiredEnv("EXECUTION_ENVELOPE_SECRET", "execution_auth.secret_missing"),
    serviceToken: requiredEnv("RUNTIME_SERVICE_TOKEN", "runtime.service_token_missing"),
    providerMetadata: {
      host: "local_http",
      contractVersion: "runtime.invocation.v1",
    },
  }),
});

const close = async () => {
  await app.close();
  await saver.end();
  await db.end();
  await telemetry.shutdown();
};
process.once("SIGTERM", () => { void close(); });
process.once("SIGINT", () => { void close(); });

await app.listen({ host: "0.0.0.0", port: Number(process.env.RUNTIME_HOST_PORT ?? 8088) });
