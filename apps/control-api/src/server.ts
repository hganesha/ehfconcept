import { buildControlApi } from "./app.js";

await buildControlApi().listen({ host: "0.0.0.0", port: Number(process.env.CONTROL_API_PORT ?? 4100) });
