import { assertPlatformInvariants } from "@ehf/identity";
import { initializeTelemetry } from "@ehf/telemetry";
import { buildCaseApi } from "./app.js";

assertPlatformInvariants({
  forbidden: ["EDGE_SERVICE_TOKEN", "RUNTIME_SERVICE_TOKEN"],
  required: ["ENTRA_TENANT_ID", "ENTRA_API_AUDIENCE", "PLATFORM_TENANT_ID"],
  databaseUrls: ["DATABASE_URL", "CASE_DATABASE_URL"],
});

const port = Number(process.env.CASE_API_PORT ?? 4102);
const telemetry = initializeTelemetry({ serviceName: "harness-case-service" });
const app = buildCaseApi();
await app.listen({ host: "0.0.0.0", port });
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void app.close().finally(() => telemetry.shutdown());
  });
}
