import { assertPlatformInvariants } from "@ehf/identity";
import { initializeTelemetry } from "@ehf/telemetry";
import { buildGateway } from "./app.js";

// Fail to boot rather than serve traffic with a local-mode credential in Azure. A shared
// HMAC secret and a static service token are development conveniences; in the cloud they
// are an authentication bypass, and a degraded verifier is not a state to serve from.
assertPlatformInvariants({
  forbidden: ["EXECUTION_ENVELOPE_SECRET", "RUNTIME_SERVICE_TOKEN", "EDGE_SERVICE_TOKEN"],
  required: ["ENTRA_TENANT_ID", "ENTRA_API_AUDIENCE", "PLATFORM_TENANT_ID"],
  databaseUrls: ["DATABASE_URL"],
});

const port = Number(process.env.GATEWAY_PORT ?? 4101);
const telemetry = initializeTelemetry({ serviceName: "harness-capability-gateway" });
const app = buildGateway();
await app.listen({ host: "0.0.0.0", port });
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void app.close().finally(() => telemetry.shutdown());
  });
}
