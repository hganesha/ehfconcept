import { describe, expect, it } from "vitest";
import { createRuntimeProviderFromEnv, LocalHttpRuntimeProvider } from "./index.js";

describe("runtime provider configuration", () => {
  it("builds a stable local execution profile", () => {
    const provider = new LocalHttpRuntimeProvider("http://runtime/invocations", "local-token");
    expect(provider.kind).toBe("local_http");
    expect(provider.executionProfileDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects incomplete Azure configuration", () => {
    expect(() => createRuntimeProviderFromEnv({ RUNTIME_PROVIDER: "azure_foundry" })).toThrow(
      "runtime.config_missing:FOUNDRY_AGENT_INVOCATION_ENDPOINT",
    );
  });
});
