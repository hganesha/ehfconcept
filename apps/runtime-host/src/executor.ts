import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import {
  runtimeInvocationSchema,
  type RuntimeInvocationResult,
} from "@ehf/contracts";
import { lowerHarnessPlan } from "@ehf/runtime-langgraph";
import { HttpRuntimeStateStore, type RuntimeStateStore, type WorkloadCredential } from "@ehf/runtime-state";

export type RuntimeExecutorDependencies = {
  /** Optional: absent when the deployment runs without a resumable checkpoint backend. */
  saver?: BaseCheckpointSaver;
  gatewayUrl: string;
  caseApiUrl?: string;
  controlPlaneUrl: string;
  serviceToken: WorkloadCredential;
  providerMetadata?: Record<string, string>;
  /** Overridable so contract tests can drive a Postgres-backed store directly. */
  createStateStore?: (grant: string) => RuntimeStateStore;
};

export async function executeRuntimeInvocation(
  raw: unknown,
  dependencies: RuntimeExecutorDependencies,
  cancellation?: AbortSignal,
): Promise<RuntimeInvocationResult> {
  const request = runtimeInvocationSchema.parse(raw);
  const remainingMs = new Date(request.deadlineAt).getTime() - Date.now();
  if (remainingMs <= 0) throw new Error("runtime.deadline_exceeded");
  const timeoutMs = Math.min(remainingMs, request.plan.budgets.maxDurationMs);
  const state = dependencies.createStateStore?.(request.executionGrant) ?? new HttpRuntimeStateStore({
    baseUrl: dependencies.controlPlaneUrl,
    serviceToken: dependencies.serviceToken,
    executionGrant: request.executionGrant,
  });
  const fenced = {
    runId: request.runId,
    attempt: request.attempt,
    workerId: request.workerId,
    fencingEpoch: request.fencingEpoch,
  };
  const compiled = lowerHarnessPlan(request.plan, {
    state,
    plan: request.plan,
    runId: request.runId,
    runAttempt: request.attempt,
    workerId: request.workerId,
    fencingEpoch: request.fencingEpoch,
    gatewayUrl: dependencies.gatewayUrl,
    ...(dependencies.caseApiUrl ? { caseApiUrl: dependencies.caseApiUrl } : {}),
    envelopeBrokerUrl: dependencies.controlPlaneUrl,
    executionGrant: request.executionGrant,
    serviceToken: dependencies.serviceToken,
  }, dependencies.saver);
  try {
    const output = await compiled.invoke({ input: request.input, values: {} }, {
      configurable: { thread_id: request.runId, checkpoint_ns: request.planDigest },
      recursionLimit: request.plan.execution.maxTransitions,
      maxConcurrency: request.plan.execution.maxConcurrency,
      // The deadline and an explicit cancellation both stop the graph; whichever
      // arrives first wins.
      signal: cancellation
        ? AbortSignal.any([AbortSignal.timeout(timeoutMs), cancellation])
        : AbortSignal.timeout(timeoutMs),
    });
    const checkpoint = await dependencies.saver?.getTuple({
      configurable: { thread_id: request.runId, checkpoint_ns: request.planDigest },
    });
    const checkpointId = checkpoint?.checkpoint.id ?? null;
    await state.markCheckpoint(fenced, { checkpointId, nodeId: null });
    return {
      contractVersion: "runtime.result.v1",
      invocationId: request.invocationId,
      runId: request.runId,
      status: "completed",
      output: output.output ?? output.values,
      errorCode: null,
      checkpointId,
      providerMetadata: dependencies.providerMetadata ?? { host: "local_http" },
    };
  } catch (error) {
    const errorCode = cancellation?.aborted
      ? "runtime.cancelled"
      : error instanceof Error ? error.message : "runtime.unhandled";
    return {
      contractVersion: "runtime.result.v1",
      invocationId: request.invocationId,
      runId: request.runId,
      status: errorCode.includes("denied") ? "denied" : "failed",
      output: null,
      errorCode,
      checkpointId: null,
      providerMetadata: dependencies.providerMetadata ?? { host: "local_http" },
    };
  }
}
