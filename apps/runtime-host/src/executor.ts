import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import {
  runtimeInvocationSchema,
  type RuntimeInvocation,
  type RuntimeInvocationResult,
} from "@ehf/contracts";
import { updateRunNode, type Database } from "@ehf/persistence";
import { lowerHarnessPlan } from "@ehf/runtime-langgraph";

export type RuntimeExecutorDependencies = {
  db: Database;
  saver: PostgresSaver;
  gatewayUrl: string;
  caseApiUrl?: string;
  envelopeBrokerUrl: string;
  serviceToken: string;
  providerMetadata?: Record<string, string>;
};

export async function executeRuntimeInvocation(
  raw: unknown,
  dependencies: RuntimeExecutorDependencies,
): Promise<RuntimeInvocationResult> {
  const request = runtimeInvocationSchema.parse(raw);
  const remainingMs = new Date(request.deadlineAt).getTime() - Date.now();
  if (remainingMs <= 0) throw new Error("runtime.deadline_exceeded");
  const timeoutMs = Math.min(remainingMs, request.plan.budgets.maxDurationMs);
  const compiled = lowerHarnessPlan(request.plan, {
    db: dependencies.db,
    plan: request.plan,
    runId: request.runId,
    runAttempt: request.attempt,
    workerId: request.workerId,
    fencingEpoch: request.fencingEpoch,
    gatewayUrl: dependencies.gatewayUrl,
    ...(dependencies.caseApiUrl ? { caseApiUrl: dependencies.caseApiUrl } : {}),
    envelopeBrokerUrl: dependencies.envelopeBrokerUrl,
    // The grant travels with the invocation and is scoped to it; the runtime never holds
    // a durable credential that could authorize a different run.
    executionGrant: request.executionGrant,
    serviceToken: dependencies.serviceToken,
  }, dependencies.saver);
  try {
    const output = await compiled.invoke({ input: request.input, values: {} }, {
      configurable: { thread_id: request.runId, checkpoint_ns: request.planDigest },
      recursionLimit: request.plan.execution.maxTransitions,
      maxConcurrency: request.plan.execution.maxConcurrency,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const checkpoint = await dependencies.saver.getTuple({
      configurable: { thread_id: request.runId, checkpoint_ns: request.planDigest },
    });
    const checkpointId = checkpoint?.checkpoint.id ?? null;
    await updateRunNode(dependencies.db, {
      runId: request.runId,
      workerId: request.workerId,
      fencingEpoch: request.fencingEpoch,
      nodeId: null,
      checkpointId,
    });
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
    const errorCode = error instanceof Error ? error.message : "runtime.unhandled";
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
