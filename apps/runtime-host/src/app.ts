import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import { runtimeInvocationSchema, runtimeInvocationResultSchema } from "@ehf/contracts";
import { extractTraceContext, SpanKind, withSpan } from "@ehf/telemetry";

export type RuntimeHostExecutor = (request: unknown) => Promise<unknown>;

function tokenMatches(header: string | undefined, expected: string): boolean {
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return suppliedBuffer.length === expectedBuffer.length
    && suppliedBuffer.length > 0
    && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

export function buildRuntimeHost(input: { authToken: string; execute: RuntimeHostExecutor }) {
  if (!input.authToken) throw new Error("runtime_host.auth_token_missing");
  const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => ({ status: "ready", contractVersion: "runtime.invocation.v1" }));
  app.post("/invocations", async (request, reply) => {
    if (!tokenMatches(request.headers.authorization, input.authToken)) {
      return reply.code(401).send({ error: "runtime_host.unauthorized" });
    }
    const parsed = runtimeInvocationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "runtime_host.invalid_invocation" });
    }
    const parent = extractTraceContext(request.headers);
    const result = await withSpan("runtime.invoke", {
      kind: SpanKind.SERVER,
      attributes: {
        "harness.execution.id": parsed.data.runId,
        "harness.execution.attempt": parsed.data.attempt,
        "harness.fencing.epoch": parsed.data.fencingEpoch,
        "harness.plan.digest_prefix": parsed.data.planDigest.slice(0, 12),
        "harness.runtime.contract": parsed.data.contractVersion,
      },
    }, async (span) => {
      const value = runtimeInvocationResultSchema.parse(await input.execute(parsed.data));
      span.setAttribute("harness.outcome", value.status.toUpperCase());
      return value;
    }, parent);
    return reply.send(result);
  });

  return app;
}
