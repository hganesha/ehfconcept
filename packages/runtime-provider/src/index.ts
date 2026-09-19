import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import {
  runtimeInvocationResultSchema,
  runtimeInvocationSchema,
  runtimeInvocationStatusSchema,
  stableDigest,
  type RuntimeInvocation,
  type RuntimeInvocationResult,
  type RuntimeInvocationStatus,
  type RuntimeProviderKind,
} from "@ehf/contracts";
import { injectTraceContext } from "@ehf/telemetry";

export interface RuntimeProvider {
  readonly kind: RuntimeProviderKind;
  readonly executionProfileDigest: string;
  invoke(request: RuntimeInvocation, signal: AbortSignal): Promise<RuntimeInvocationResult>;
  /**
   * What the provider believes happened to an invocation.
   *
   * A dispatcher that timed out or lost its connection cannot distinguish an invocation
   * that is still running from one that finished with a result it never received. That
   * distinction decides whether retrying is safe, so it cannot be guessed.
   */
  getStatus(invocationId: string, signal?: AbortSignal): Promise<RuntimeInvocationStatus>;
  /**
   * Ask the provider to stop an invocation.
   *
   * Cancellation is best-effort by nature: it cannot unmake an effect the runtime has
   * already committed. The durable record distinguishes requested from effective
   * cancellation; this call only carries the request.
   */
  cancel(invocationId: string, reason: string, signal?: AbortSignal): Promise<void>;
}

function unknownStatus(invocationId: string): RuntimeInvocationStatus {
  return {
    contractVersion: "runtime.status.v1",
    invocationId,
    state: "unknown",
    providerMetadata: {},
  };
}

async function fetchStatus(input: {
  endpoint: string;
  token: string;
  invocationId: string;
  fetchImpl: Fetch;
  signal?: AbortSignal | undefined;
}): Promise<RuntimeInvocationStatus> {
  const headers: Record<string, string> = { authorization: `Bearer ${input.token}` };
  injectTraceContext(headers);
  const response = await input.fetchImpl(`${input.endpoint}/${encodeURIComponent(input.invocationId)}`, {
    method: "GET",
    headers,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  // A provider that cannot answer leaves the outcome genuinely unknown; reporting it as
  // failed would licence a retry that may duplicate an effect already committed.
  if (!response.ok) return unknownStatus(input.invocationId);
  const parsed = runtimeInvocationStatusSchema.safeParse(await response.json());
  return parsed.success ? parsed.data : unknownStatus(input.invocationId);
}

async function postCancel(input: {
  endpoint: string;
  token: string;
  invocationId: string;
  reason: string;
  fetchImpl: Fetch;
  signal?: AbortSignal | undefined;
}): Promise<void> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.token}`,
    "content-type": "application/json",
  };
  injectTraceContext(headers);
  const response = await input.fetchImpl(`${input.endpoint}/${encodeURIComponent(input.invocationId)}/cancel`, {
    method: "POST",
    headers,
    body: JSON.stringify({ reason: input.reason }),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`runtime.cancel_http_${response.status}`);
  }
}

type Fetch = typeof globalThis.fetch;

async function postInvocation(input: {
  endpoint: string;
  token: string;
  request: RuntimeInvocation;
  signal: AbortSignal;
  fetchImpl: Fetch;
  wrapMessage?: boolean;
}): Promise<RuntimeInvocationResult> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.token}`,
    "content-type": "application/json",
  };
  injectTraceContext(headers);
  const response = await input.fetchImpl(input.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(input.wrapMessage ? { message: input.request } : input.request),
    signal: input.signal,
  });
  const body = await response.json() as unknown;
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body
      ? String((body as { error: unknown }).error)
      : `runtime.provider_http_${response.status}`;
    throw new Error(message);
  }
  const candidate = body && typeof body === "object" && "result" in body
    ? (body as { result: unknown }).result
    : body;
  return runtimeInvocationResultSchema.parse(candidate);
}

export class LocalHttpRuntimeProvider implements RuntimeProvider {
  readonly kind = "local_http" as const;
  readonly executionProfileDigest: string;

  constructor(
    private readonly endpoint: string,
    private readonly authToken: string,
    private readonly fetchImpl: Fetch = globalThis.fetch,
  ) {
    this.executionProfileDigest = stableDigest({
      contractVersion: "runtime.invocation.v1",
      provider: this.kind,
      endpoint,
    });
  }

  invoke(request: RuntimeInvocation, signal: AbortSignal): Promise<RuntimeInvocationResult> {
    runtimeInvocationSchema.parse(request);
    return postInvocation({
      endpoint: this.endpoint,
      token: this.authToken,
      request,
      signal,
      fetchImpl: this.fetchImpl,
    });
  }

  getStatus(invocationId: string, signal?: AbortSignal): Promise<RuntimeInvocationStatus> {
    return fetchStatus({
      endpoint: this.statusEndpoint(), token: this.authToken, invocationId,
      fetchImpl: this.fetchImpl, signal,
    });
  }

  cancel(invocationId: string, reason: string, signal?: AbortSignal): Promise<void> {
    return postCancel({
      endpoint: this.statusEndpoint(), token: this.authToken, invocationId, reason,
      fetchImpl: this.fetchImpl, signal,
    });
  }

  /** Sibling of the invocation endpoint: .../invocations -> .../invocations */
  private statusEndpoint(): string {
    return this.endpoint.replace(/\/$/, "");
  }
}

export class AzureFoundryRuntimeProvider implements RuntimeProvider {
  readonly kind = "azure_foundry" as const;
  readonly executionProfileDigest: string;

  constructor(
    private readonly endpoint: string,
    private readonly agentName: string,
    private readonly agentVersion: string,
    private readonly credential: TokenCredential = new DefaultAzureCredential(),
    private readonly tokenScope = "https://ai.azure.com/.default",
    private readonly fetchImpl: Fetch = globalThis.fetch,
  ) {
    this.executionProfileDigest = stableDigest({
      contractVersion: "runtime.invocation.v1",
      provider: this.kind,
      endpoint,
      agentName,
      agentVersion,
    });
  }

  async invoke(request: RuntimeInvocation, signal: AbortSignal): Promise<RuntimeInvocationResult> {
    runtimeInvocationSchema.parse(request);
    const accessToken = await this.credential.getToken(this.tokenScope, { abortSignal: signal });
    if (!accessToken?.token) throw new Error("runtime.azure_token_missing");
    return postInvocation({
      endpoint: this.endpoint,
      token: accessToken.token,
      request,
      signal,
      fetchImpl: this.fetchImpl,
      wrapMessage: true,
    });
  }

  async getStatus(invocationId: string, signal?: AbortSignal): Promise<RuntimeInvocationStatus> {
    const token = await this.token(signal);
    return fetchStatus({
      endpoint: this.endpoint.replace(/\/$/, ""), token, invocationId,
      fetchImpl: this.fetchImpl, signal,
    });
  }

  async cancel(invocationId: string, reason: string, signal?: AbortSignal): Promise<void> {
    const token = await this.token(signal);
    await postCancel({
      endpoint: this.endpoint.replace(/\/$/, ""), token, invocationId, reason,
      fetchImpl: this.fetchImpl, signal,
    });
  }

  private async token(signal?: AbortSignal): Promise<string> {
    const accessToken = await this.credential.getToken(this.tokenScope, signal ? { abortSignal: signal } : {});
    if (!accessToken?.token) throw new Error("runtime.azure_token_missing");
    return accessToken.token;
  }
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`runtime.config_missing:${name}`);
  return value;
}

export function createRuntimeProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { credential?: TokenCredential; fetchImpl?: Fetch } = {},
): RuntimeProvider {
  const kind = env.RUNTIME_PROVIDER ?? "local_http";
  if (kind === "local_http") {
    return new LocalHttpRuntimeProvider(
      env.RUNTIME_LOCAL_ENDPOINT ?? "http://runtime-host-local:8088/invocations",
      requiredEnv(env, "RUNTIME_HOST_AUTH_TOKEN"),
      options.fetchImpl,
    );
  }
  if (kind === "azure_foundry") {
    return new AzureFoundryRuntimeProvider(
      requiredEnv(env, "FOUNDRY_AGENT_INVOCATION_ENDPOINT"),
      requiredEnv(env, "FOUNDRY_AGENT_NAME"),
      requiredEnv(env, "FOUNDRY_AGENT_VERSION"),
      options.credential,
      env.FOUNDRY_TOKEN_SCOPE ?? "https://ai.azure.com/.default",
      options.fetchImpl,
    );
  }
  throw new Error(`runtime.provider_unsupported:${kind}`);
}
