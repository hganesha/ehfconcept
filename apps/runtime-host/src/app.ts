import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import { runtimeInvocationSchema, runtimeInvocationResultSchema, type RuntimeInvocationStatus } from "@ehf/contracts";
import { extractTraceContext, SpanKind, withSpan } from "@ehf/telemetry";

export type RuntimeHostExecutor = (request: unknown, signal?: AbortSignal) => Promise<unknown>;

function tokenMatches(header: string | undefined, expected: string): boolean {
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return suppliedBuffer.length === expectedBuffer.length
    && suppliedBuffer.length > 0
    && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

type InFlight = {
  state: RuntimeInvocationStatus["state"];
  controller: AbortController;
};

export function buildRuntimeHost(input: { authToken: string; execute: RuntimeHostExecutor }) {
  if (!input.authToken) throw new Error("runtime_host.auth_token_missing");
  const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });

  /**
   * Invocations this host has seen, so a dispatcher that lost contact can ask what
   * happened rather than guessing. Bounded: an entry is dropped once its terminal state
   * has been observable for long enough to be collected by the dispatcher.
   */
  const inFlight = new Map<string, InFlight>();
  const forget = (invocationId: string) => setTimeout(() => inFlight.delete(invocationId), 5 * 60_000).unref();

  const authorized = (request: { headers: { authorization?: string | undefined } }): boolean =>
    tokenMatches(request.headers.authorization, input.authToken);

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => ({ status: "ready", contractVersion: "runtime.invocation.v1" }));
  app.get<{ Params: { invocationId: string } }>("/invocations/:invocationId", async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: "runtime_host.unauthorized" });
    const entry = inFlight.get(request.params.invocationId);
    // An invocation this host has no record of is genuinely unknown, not failed: saying
    // "failed" would licence a retry that could duplicate an effect already committed.
    const status: RuntimeInvocationStatus = {
      contractVersion: "runtime.status.v1",
      invocationId: request.params.invocationId,
      state: entry?.state ?? "unknown",
      providerMetadata: { host: "local_http" },
    };
    return reply.send(status);
  });

  app.post<{ Params: { invocationId: string } }>("/invocations/:invocationId/cancel", async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: "runtime_host.unauthorized" });
    const entry = inFlight.get(request.params.invocationId);
    if (!entry) return reply.code(404).send({ error: "runtime_host.invocation_unknown" });
    // Requested, not effective: the runtime stops at its next cancellation point, and
    // an effect it already committed stays committed.
    entry.controller.abort(new Error("runtime.cancelled"));
    return reply.code(202).send({ accepted: true });
  });

  app.post("/invocations", async (request, reply) => {
    if (!authorized(request)) {
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
      const entry: InFlight = { state: "running", controller: new AbortController() };
      inFlight.set(parsed.data.invocationId, entry);
      try {
        const value = runtimeInvocationResultSchema.parse(await input.execute(parsed.data, entry.controller.signal));
        entry.state = value.status === "completed" ? "completed" : "failed";
        span.setAttribute("harness.outcome", value.status.toUpperCase());
        return value;
      } catch (error) {
        entry.state = entry.controller.signal.aborted ? "cancelled" : "failed";
        throw error;
      } finally {
        forget(parsed.data.invocationId);
      }
    }, parent);
    return reply.send(result);
  });

  return app;
}
