import { initializeTelemetry } from "@ehf/telemetry";
import { buildCaseApi } from "./app.js";

const port = Number(process.env.CASE_API_PORT ?? 4102);
const telemetry = initializeTelemetry({ serviceName: "harness-case-service" });
const app = buildCaseApi();
await app.listen({ host: "0.0.0.0", port });
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void app.close().finally(() => telemetry.shutdown());
  });
}
