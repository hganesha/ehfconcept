import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import {
  runtimeInvocationResultSchema,
  runtimeInvocationSchema,
  stableDigest,
  type RuntimeInvocation,
  type RuntimeInvocationResult,
  type RuntimeProviderKind,
} from "@ehf/contracts";
import { injectTraceContext } from "@ehf/telemetry";

export interface RuntimeProvider {
  readonly kind: RuntimeProviderKind;
  readonly executionProfileDigest: string;
  invoke(request: RuntimeInvocation, signal: AbortSignal): Promise<RuntimeInvocationResult>;
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
