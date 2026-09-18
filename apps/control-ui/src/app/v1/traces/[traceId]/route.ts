import { NextResponse } from "next/server";
import type { NativeTraceSpan, NativeTraceView } from "@/lib/types";

export const dynamic = "force-dynamic";

type JaegerTag = { key: string; type: string; value: unknown };
type JaegerSpan = {
  spanID: string;
  operationName: string;
  processID: string;
  startTime: number;
  duration: number;
  references?: Array<{ refType: string; spanID: string }>;
  tags?: JaegerTag[];
};
type JaegerTrace = {
  traceID: string;
  spans: JaegerSpan[];
  processes: Record<string, { serviceName?: string }>;
};

function depthFor(spanId: string, parents: Map<string, string | null>): number {
  let depth = 0;
  let current = parents.get(spanId) ?? null;
  const visited = new Set<string>();
  while (current && !visited.has(current) && depth < 40) {
    visited.add(current);
    depth += 1;
    current = parents.get(current) ?? null;
  }
  return depth;
}

export async function GET(_request: Request, context: { params: Promise<{ traceId: string }> }) {
  const { traceId } = await context.params;
  if (!/^[a-f0-9]{16,32}$/i.test(traceId)) {
    return NextResponse.json({ error: "TRACE_ID_INVALID" }, { status: 400 });
  }
  const jaegerBase = (process.env.JAEGER_API_INTERNAL_URL ?? "http://127.0.0.1:16686").replace(/\/$/, "");
  const publicBase = (process.env.TRACE_VIEWER_PUBLIC_URL ?? "http://localhost:16686").replace(/\/$/, "");
  try {
    const response = await fetch(`${jaegerBase}/api/traces/${encodeURIComponent(traceId)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return NextResponse.json({ error: "TRACE_NOT_FOUND" }, { status: response.status === 404 ? 404 : 502 });
    const payload = await response.json() as { data?: JaegerTrace[] };
    const trace = payload.data?.[0];
    if (!trace?.spans.length) return NextResponse.json({ error: "TRACE_NOT_FOUND" }, { status: 404 });
    const ordered = trace.spans.toSorted((left, right) => left.startTime - right.startTime);
    const startMicros = ordered[0]!.startTime;
    const endMicros = Math.max(...ordered.map((span) => span.startTime + span.duration));
    const parents = new Map(ordered.map((span) => [span.spanID, span.references?.find((ref) => ref.refType === "CHILD_OF")?.spanID ?? null]));
    const spans: NativeTraceSpan[] = ordered.map((span) => {
      const tags = Object.fromEntries((span.tags ?? []).map((tag) => [tag.key, tag.value]));
      const status = tags.error === true || tags["otel.status_code"] === "ERROR" ? "error" : "ok";
      return {
        spanId: span.spanID,
        parentSpanId: parents.get(span.spanID) ?? null,
        operationName: span.operationName,
        serviceName: trace.processes[span.processID]?.serviceName ?? span.processID,
        startTime: new Date(span.startTime / 1000).toISOString(),
        startOffsetMs: (span.startTime - startMicros) / 1000,
        durationMs: span.duration / 1000,
        depth: depthFor(span.spanID, parents),
        status,
        tags,
      };
    });
    const view: NativeTraceView = {
      generatedAt: new Date().toISOString(),
      traceId: trace.traceID,
      startedAt: new Date(startMicros / 1000).toISOString(),
      durationMs: (endMicros - startMicros) / 1000,
      spanCount: spans.length,
      services: [...new Set(spans.map((span) => span.serviceName))].toSorted(),
      rawViewerUrl: `${publicBase}/trace/${trace.traceID}`,
      spans,
    };
    return NextResponse.json(view);
  } catch (error) {
    return NextResponse.json({ error: "TRACE_QUERY_FAILED", message: error instanceof Error ? error.message : "Unknown error" }, { status: 502 });
  }
}
