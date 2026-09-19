import { assertPlatformInvariants } from "@ehf/identity";
import { buildControlApi } from "./app.js";

// Refuse to start in Azure mode with a local-mode credential or a password-bearing
// database URL, rather than serving traffic that silently accepts them.
assertPlatformInvariants({
  forbidden: ["EDGE_SERVICE_TOKEN", "RUNTIME_SERVICE_TOKEN"],
  required: ["ENTRA_TENANT_ID", "ENTRA_API_AUDIENCE", "PLATFORM_TENANT_ID"],
  databaseUrls: ["DATABASE_URL"],
});

await buildControlApi().listen({ host: "0.0.0.0", port: Number(process.env.CONTROL_API_PORT ?? 4100) });
