import { describe, expect, it } from "vitest";
import { contextFromTraceReference, errorType } from "./index.js";
import { trace } from "@opentelemetry/api";

describe("telemetry safety helpers", () => {
  it("reconstructs only valid W3C span context", () => {
    const valid = contextFromTraceReference({
      traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1,
    });
    expect(trace.getSpanContext(valid)?.traceId).toBe("a".repeat(32));
    expect(trace.getSpanContext(contextFromTraceReference({ traceId: "bad", spanId: "bad", traceFlags: 1 }))).toBeUndefined();
  });

  it("does not expose exception messages", () => {
    expect(errorType(new TypeError("customer name and secret"))).toBe("TypeError");
  });
});
