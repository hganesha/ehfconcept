import { hostname } from "node:os";
import { stableDigest, type RuntimeInvocation } from "@ehf/contracts";
import {
  appendEvent,
  bindRunTrace,
  claimRun,
  completeRun,
  createDatabase,
  getPlan,
  renewLease,
} from "@ehf/persistence";
import { createRuntimeProviderFromEnv } from "@ehf/runtime-provider";
import {
  SpanKind,
  SpanStatusCode,
  contextFromTraceReference,
  initializeTelemetry,
  recordFailure,
  traceReference,
  withSpan,
} from "@ehf/telemetry";

const telemetry = initializeTelemetry({ serviceName: "harness-runtime-dispatcher" });

function requiredEnv(name: string, error: string): string {
  const value = process.env[name];
  if (!value) throw new Error(error);
  return value;
}

const connectionString = requiredEnv("DATABASE_URL", "database.url_missing");
const db = createDatabase(connectionString);
const workerId = process.env.WORKER_ID ?? `${hostname()}:${process.pid}`;
const leaseSeconds = Number(process.env.WORKER_LEASE_SECONDS ?? 60);
const pollMs = Number(process.env.WORKER_POLL_MS ?? 750);

async function workOnce(): Promise<boolean> {
  const run = await claimRun(db, workerId, leaseSeconds);
  if (!run) return false;
  const claimedRun = run;
  const plan = await getPlan(db, run.planDigest);
  if (!plan) throw new Error("runtime.plan_missing");
  const requestedTargets = [...new Set(plan.graph.nodes.flatMap((node) => {
    const target = node.config.runtimeTarget;
    return target === "local_http" || target === "azure_foundry" ? [target] : [];
  }))];
  if (requestedTargets.length > 1) throw new Error("runtime.provider_mixed_targets_unsupported");
  const provider = createRuntimeProviderFromEnv(requestedTargets[0]
    ? { ...process.env, RUNTIME_PROVIDER: requestedTargets[0] }
    : process.env);
  const parent = contextFromTraceReference(run.traceId && run.rootSpanId ? {
    traceId: run.traceId,
    spanId: run.rootSpanId,
    traceFlags: run.traceFlags ?? 0,
  } : null);
  return withSpan("harness.run", {
    kind: SpanKind.CONSUMER,
    attributes: {
      "harness.execution.id": run.runId,
      "harness.execution.attempt": run.attempt,
      "harness.plan.digest_prefix": run.planDigest.slice(0, 12),
      "harness.domain": plan.metadata.domain,
      "harness.engine": plan.execution.engine.kind,
      "harness.engine.adapter_version": plan.execution.engine.adapterVersion,
      "harness.fencing.epoch": run.fencingEpoch,
      "harness.runtime.provider": provider.kind,
      "harness.runtime.profile_digest_prefix": provider.executionProfileDigest.slice(0, 12),
    },
  }, async (span) => {
    const root = traceReference(span);
    await bindRunTrace(db, {
      runId: run.runId,
      attempt: run.attempt,
      workerId,
      fencingEpoch: run.fencingEpoch,
      traceId: root.traceId,
      spanId: root.spanId,
      traceFlags: root.traceFlags,
      serviceName: "harness-runtime-dispatcher",
    });
    await appendEvent(db, {
      runId: run.runId,
      eventKey: `run:${run.attempt}:started`,
      code: "run.started",
      nodeId: null,
      status: "observed",
      values: {
        workerId,
        fencingEpoch: run.fencingEpoch,
        traceId: root.traceId,
        runtimeProvider: provider.kind,
        executionProfileDigest: provider.executionProfileDigest,
      },
    });
    const heartbeat = setInterval(() => {
      void renewLease(db, run.runId, workerId, run.fencingEpoch, leaseSeconds);
    }, Math.max(1_000, Math.floor(leaseSeconds * 500)));
    try {
      const invocation: RuntimeInvocation = {
        contractVersion: "runtime.invocation.v1",
        invocationId: `INV-${stableDigest({ runId: run.runId, attempt: run.attempt, fencingEpoch: run.fencingEpoch }).slice(0, 32)}`,
        runId: claimedRun.runId,
        attempt: run.attempt,
        workerId,
        leaseId: `${run.runId}:${run.attempt}:${run.fencingEpoch}`,
        fencingEpoch: claimedRun.fencingEpoch,
        deadlineAt: new Date(Date.now() + plan.budgets.maxDurationMs).toISOString(),
        planDigest: run.planDigest,
        executionProfileDigest: provider.executionProfileDigest,
        plan,
        input: run.input,
      };
      const result = await provider.invoke(invocation, AbortSignal.timeout(plan.budgets.maxDurationMs + 5_000));
      if (result.status === "completed") {
        await completeRun(db, {
          runId: run.runId,
          workerId,
          fencingEpoch: run.fencingEpoch,
          status: "completed",
          terminalOutcome: "completed",
          output: result.output,
        });
        span.setAttributes({
          "harness.outcome": "COMPLETED",
          "harness.stop_reason": "terminal_reached",
          "harness.checkpoint.present": Boolean(result.checkpointId),
        });
        await appendEvent(db, {
          runId: run.runId,
          eventKey: `run:${run.attempt}:completed`,
          code: "run.completed",
          nodeId: null,
          status: "passed",
          values: {
            traceId: root.traceId,
            runtimeProvider: provider.kind,
            ...result.providerMetadata,
          },
        });
      } else {
        const errorCode = result.errorCode ?? `runtime.${result.status}`;
        await recordTerminalFailure(errorCode, result.status === "denied");
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : "runtime.unhandled";
      await recordTerminalFailure(code, code.includes("denied"));
    } finally {
      clearInterval(heartbeat);
    }
    return true;

    async function recordTerminalFailure(code: string, denied: boolean): Promise<void> {
      if (denied) {
        span.setStatus({ code: SpanStatusCode.OK });
        span.setAttribute("harness.outcome", "DENIED");
      } else {
        recordFailure(span, new Error(code));
      }
      await completeRun(db, {
        runId: claimedRun.runId,
        workerId,
        fencingEpoch: claimedRun.fencingEpoch,
        status: denied ? "denied" : "failed",
        terminalOutcome: denied ? "denied" : "failed",
        output: { error: code },
        errorCode: code,
      });
      await appendEvent(db, {
        runId: claimedRun.runId,
        eventKey: `run:${claimedRun.attempt}:failed`,
        code: "run.failed",
        nodeId: null,
        status: denied ? "denied" : "failed",
        values: { errorCode: code, traceId: root.traceId, runtimeProvider: provider.kind },
      });
    }
  }, parent);
}

let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
while (!stopping) {
  const worked = await workOnce();
  if (!worked) await new Promise((resolve) => setTimeout(resolve, pollMs));
}
await db.end();
await telemetry.shutdown();
