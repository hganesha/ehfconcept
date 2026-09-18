import { buildGateway } from "./app.js";
import { initializeTelemetry } from "@ehf/telemetry";

const port = Number(process.env.GATEWAY_PORT ?? 4101);
const telemetry = initializeTelemetry({ serviceName: "harness-capability-gateway" });
const app = buildGateway();
await app.listen({ host: "0.0.0.0", port });
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void app.close().finally(() => telemetry.shutdown());
  });
}
