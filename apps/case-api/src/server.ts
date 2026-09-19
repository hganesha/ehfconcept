import { createCaseStore } from "@ehf/case-store";
import { LoggingOutboxSink, startOutboxRelay } from "@ehf/case-store/outbox-relay";
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
const store = createCaseStore();
const app = buildCaseApi({ store });

// Every case transaction writes an outbox row and nothing ever read them, so the tables
// grew without bound and the "transactional outbox" was decorative. The sink is
// replaceable; what matters is that events leave the table and published rows age out.
const relay = startOutboxRelay(store, new LoggingOutboxSink(), {
  ...(process.env.OUTBOX_INTERVAL_MS ? { intervalMs: Number(process.env.OUTBOX_INTERVAL_MS) } : {}),
  retentionDays: Number(process.env.OUTBOX_RETENTION_DAYS ?? 7),
  onError: (error) => app.log.warn({ err: error }, "outbox relay drain failed"),
});

await app.listen({ host: "0.0.0.0", port });
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    relay.stop();
    void app.close().finally(() => telemetry.shutdown());
  });
}
