import { hostname } from "node:os";
import { createServer } from "node:http";
import { stableDigest, type RuntimeInvocation } from "@ehf/contracts";
import {
  appendEvent,
  bindRunTrace,
  cancellationRequested,
  claimRun,
  completeCancelledRun,
  completeRun,
  createDatabase,
  createRunQueueListener,
  failExhaustedRuns,
  finalizeAbandonedCancellations,
  getPlan,
  getRunQueueStats,
  renewLease,
  scheduleRunRetry,
} from "@ehf/persistence";
import { mintRuntimeGrant } from "@ehf/execution-auth";
import { assertPlatformInvariants, isAzureMode } from "@ehf/identity";
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

assertPlatformInvariants({
  forbidden: ["RUNTIME_GRANT_SECRET"],
  required: ["RUNTIME_GRANT_PRIVATE_KEY_PEM"],
  databaseUrls: ["DATABASE_URL"],
});

function requiredEnv(name: string, error: string): string {
  const value = process.env[name];
  if (!value) throw new Error(error);
  return value;
}

const connectionString = requiredEnv("DATABASE_URL", "database.url_missing");
// The dispatcher owns the lease and the fence, so it is the only component that may
// issue authority for an invocation. The runtime receives a grant, never a signing key.
const grantSecret = isAzureMode()
  ? requiredEnv("RUNTIME_GRANT_PRIVATE_KEY_PEM", "runtime.grant_private_key_missing")
  : requiredEnv("RUNTIME_GRANT_SECRET", "runtime.grant_secret_missing");
const db = createDatabase(connectionString);
const workerId = process.env.WORKER_ID ?? `${hostname()}:${process.pid}`;
const workerConcurrency = Number(process.env.WORKER_CONCURRENCY ?? 1);
const leaseSeconds = Number(process.env.WORKER_LEASE_SECONDS ?? 60);
const pollMs = Number(process.env.WORKER_POLL_MS ?? 750);
const retryBaseMs = Number(process.env.WORKER_RETRY_BASE_MS ?? 2_000);
const retryMaxMs = Number(process.env.WORKER_RETRY_MAX_MS ?? 60_000);
const metricsPort = Number(process.env.WORKER_METRICS_PORT ?? 9090);
const inFlight = new Set<string>();
let claimedTotal = 0;
let failedIterationsTotal = 0;

/**
 * A denial is a decision, not a fault.
 *
 * Retrying a denied capability call would re-ask a question the gateway already answered,
 * and retrying a plan or contract problem would repeat it forever. Everything else --
 * transport failures, provider unavailability, timeouts -- is worth another attempt.
 */
function retryable(code: string): boolean {
  if (code.includes("denied") || code.includes("authorization") || code.includes("stale_fence")) return false;
  return !code.startsWith("runtime.plan_") && !code.startsWith("langgraph.") && !code.includes("contract");
}

function backoffMs(attempt: number): number {
  return Math.min(retryMaxMs, retryBaseMs * 2 ** Math.max(0, attempt - 1));
}



async function workOnce(slotWorkerId: string): Promise<boolean> {
  const run = await claimRun(db, slotWorkerId, leaseSeconds);
  if (!run) return false;
  inFlight.add(run.runId);
  claimedTotal += 1;
  try {
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
      workerId: slotWorkerId,
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
        workerId: slotWorkerId,
        fencingEpoch: run.fencingEpoch,
        traceId: root.traceId,
        runtimeProvider: provider.kind,
        executionProfileDigest: provider.executionProfileDigest,
      },
    });
    // Losing the lease means another worker now owns this run at a higher fence. The
    // renewal result used to be discarded, so a superseded worker kept executing and
    // only its gateway calls were refused -- everything else it did carried on.
    const leaseLost = new AbortController();
    const cancelled = new AbortController();
    const heartbeat = setInterval(() => {
      void renewLease(db, run.runId, slotWorkerId, run.fencingEpoch, leaseSeconds).then((held) => {
        if (!held && !leaseLost.signal.aborted) leaseLost.abort(new Error("runtime.lease_lost"));
      }).catch(() => { /* a failed renewal is retried on the next beat */ });
      // Requesting a cancellation moves the fence, so the renewal above fails too. The
      // marker is read as well so the run is recorded as cancelled rather than as a
      // worker that simply lost its lease.
      void cancellationRequested(db, run.runId).then((reason) => {
        if (reason && !cancelled.signal.aborted) cancelled.abort(new Error("runtime.cancelled"));
      }).catch(() => { /* re-read on the next beat */ });
    }, Math.max(1_000, Math.floor(leaseSeconds * 500)));
    try {
      const invocationId = `INV-${stableDigest({ runId: run.runId, attempt: run.attempt, fencingEpoch: run.fencingEpoch }).slice(0, 32)}`;
      const executionGrant = await mintRuntimeGrant({
        secret: grantSecret,
        grantId: invocationId,
        runId: run.runId,
        attempt: run.attempt,
        workerId: slotWorkerId,
        planDigest: run.planDigest,
        fencingEpoch: run.fencingEpoch,
        // Outlives the invocation deadline by a small margin and no more.
        ttlSeconds: Math.ceil(plan.budgets.maxDurationMs / 1000) + 30,
      });
      const invocation: RuntimeInvocation = {
        contractVersion: "runtime.invocation.v1",
        invocationId,
        runId: claimedRun.runId,
        attempt: run.attempt,
        workerId: slotWorkerId,
        leaseId: `${run.runId}:${run.attempt}:${run.fencingEpoch}`,
        fencingEpoch: claimedRun.fencingEpoch,
        deadlineAt: new Date(Date.now() + plan.budgets.maxDurationMs).toISOString(),
        planDigest: run.planDigest,
        executionProfileDigest: provider.executionProfileDigest,
        executionGrant,
        plan,
        input: run.input,
      };
      const result = await provider.invoke(invocation, AbortSignal.any([
        AbortSignal.timeout(plan.budgets.maxDurationMs + 5_000),
        leaseLost.signal,
        cancelled.signal,
      ])).catch(async (error: unknown) => {
        // Ask the provider to stop as well: aborting our side of the call leaves the
        // invocation running wherever it actually executes.
        if (cancelled.signal.aborted) {
          await provider.cancel(invocationId, "operator_request").catch(() => { /* best effort */ });
        }
        throw error;
      });
      if (result.status === "completed") {
        await completeRun(db, {
          runId: run.runId,
          workerId: slotWorkerId,
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
        await handleFailure(errorCode, result.status === "denied");
      }
    } catch (error) {
      const code = cancelled.signal.aborted
        ? "runtime.cancelled"
        : leaseLost.signal.aborted
          ? "runtime.lease_lost"
          : error instanceof Error ? error.message : "runtime.unhandled";
      if (code === "runtime.cancelled") {
        span.setAttributes({ "harness.outcome": "CANCELLED", "harness.stop_reason": "cancellation_requested" });
        span.setStatus({ code: SpanStatusCode.OK });
        await completeCancelledRun(db, { runId: claimedRun.runId, errorCode: code });
        await appendEvent(db, {
          runId: claimedRun.runId,
          eventKey: `run:${claimedRun.attempt}:cancelled`,
          code: "run.cancelled",
          nodeId: null,
          status: "observed",
          values: { traceId: root.traceId, runtimeProvider: provider.kind },
        });
      } else if (code === "runtime.lease_lost") {
        // A superseded worker must not write terminal state: the fence guards the
        // update, but there is no point attempting it either.
        span.setAttribute("harness.outcome", "SUPERSEDED");
      } else {
        await handleFailure(code, code.includes("denied"));
      }
    } finally {
      clearInterval(heartbeat);
    }
    return true;

    async function handleFailure(code: string, denied: boolean): Promise<void> {
      // The attempt budget lives on the run row, so scheduleRunRetry is the single
      // authority on whether another attempt is allowed: it returns false once the
      // budget is spent or the fence has moved, and the failure becomes terminal.
      if (!denied && retryable(code)) {
        const scheduled = await scheduleRunRetry(db, {
          runId: claimedRun.runId, workerId: slotWorkerId, fencingEpoch: claimedRun.fencingEpoch,
          errorCode: code, backoffMs: backoffMs(claimedRun.attempt),
        });
        if (scheduled) {
          span.setAttributes({ "harness.outcome": "RETRYING", "harness.stop_reason": code });
          await appendEvent(db, {
            runId: claimedRun.runId,
            eventKey: `run:${claimedRun.attempt}:retrying`,
            code: "run.retrying",
            nodeId: null,
            status: "observed",
            values: { errorCode: code, attempt: claimedRun.attempt, traceId: root.traceId },
          });
          return;
        }
      }
      await recordTerminalFailure(code, denied);
    }

    async function recordTerminalFailure(code: string, denied: boolean): Promise<void> {
      if (denied) {
        span.setStatus({ code: SpanStatusCode.OK });
        span.setAttribute("harness.outcome", "DENIED");
      } else {
        recordFailure(span, new Error(code));
      }
      await completeRun(db, {
        runId: claimedRun.runId,
        workerId: slotWorkerId,
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
  } finally {
    inFlight.delete(run.runId);
  }
}

if (!Number.isInteger(workerConcurrency) || workerConcurrency < 1 || workerConcurrency > 64) {
  throw new Error("runtime.worker_concurrency_invalid");
}
if (!Number.isInteger(metricsPort) || metricsPort < 1 || metricsPort > 65_535) {
  throw new Error("runtime.worker_metrics_port_invalid");
}
if (!Number.isFinite(pollMs) || pollMs < 25 || pollMs > 60_000) {
  throw new Error("runtime.worker_poll_interval_invalid");
}

let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

const queueListener = await createRunQueueListener(db).catch((error: unknown) => {
  process.stderr.write(`dispatcher.listen_unavailable ${error instanceof Error ? error.message : "unknown"}\n`);
  return null;
});

const metricsServer = createServer(async (request, response) => {
  if (request.url === "/health/live") {
    response.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
    return;
  }
  if (request.url !== "/health/ready" && request.url !== "/metrics") {
    response.writeHead(404).end();
    return;
  }
  try {
    const queue = await getRunQueueStats(db);
    if (request.url === "/health/ready") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        status: "ready", concurrency: workerConcurrency, inFlight: inFlight.size, queue,
      }));
      return;
    }
    const lines = [
      "# TYPE ehf_runtime_worker_concurrency gauge",
      `ehf_runtime_worker_concurrency ${workerConcurrency}`,
      "# TYPE ehf_runtime_worker_in_flight gauge",
      `ehf_runtime_worker_in_flight ${inFlight.size}`,
      "# TYPE ehf_runtime_queue_ready gauge",
      `ehf_runtime_queue_ready ${queue.ready}`,
      "# TYPE ehf_runtime_queue_delayed gauge",
      `ehf_runtime_queue_delayed ${queue.delayed}`,
      "# TYPE ehf_runtime_queue_oldest_ready_seconds gauge",
      `ehf_runtime_queue_oldest_ready_seconds ${queue.oldestReadySeconds}`,
      "# TYPE ehf_runtime_worker_claimed_total counter",
      `ehf_runtime_worker_claimed_total ${claimedTotal}`,
      "# TYPE ehf_runtime_worker_iteration_failures_total counter",
      `ehf_runtime_worker_iteration_failures_total ${failedIterationsTotal}`,
      "",
    ];
    response.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(lines.join("\n"));
  } catch {
    response.writeHead(503, { "content-type": "application/json" }).end('{"status":"unavailable"}');
  }
});
metricsServer.listen(metricsPort, "0.0.0.0");

// A throw here used to reject at the top level and take the process with it, so one
// unadmitted plan or one transport error turned into a container restart loop. The loop
// absorbs failures; the claimed run is released by lease expiry and retried under the
// normal attempt budget.
async function runSlot(slot: number): Promise<void> {
  const slotWorkerId = `${workerId}:${slot}`;
  while (!stopping) {
    let worked = false;
    try {
      worked = await workOnce(slotWorkerId);
    } catch (error) {
      failedIterationsTotal += 1;
      process.stderr.write(`dispatcher.iteration_failed ${error instanceof Error ? error.message : "unknown"}\n`);
    }
    if (!worked) {
      if (slot === 0) {
        try {
          await failExhaustedRuns(db);
          await finalizeAbandonedCancellations(db);
        } catch { /* the sweep retries on the next idle poll */ }
      }
      if (queueListener) await queueListener.wait(pollMs);
      else await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}
await Promise.all(Array.from({ length: workerConcurrency }, (_, slot) => runSlot(slot)));
await queueListener?.close();
await new Promise<void>((resolve) => metricsServer.close(() => resolve()));
await db.end();
await telemetry.shutdown();
