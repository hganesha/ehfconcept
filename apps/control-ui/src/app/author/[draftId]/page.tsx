"use client";

import { use, useMemo, useState } from "react";
import Link from "next/link";
import { Activity, Bot, Boxes, CheckCircle2, Code2, ExternalLink, GitBranch, Play, Save, ShieldCheck, Wrench } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { AgentAuthoringPanel } from "@/components/agent-authoring-panel";
import { CategoryGraph } from "@/components/category-graph";
import { DigestValue, JsonViewer, LocalTimestamp, SkeletonBlock, StaleDataBanner } from "@/components/primitives";
import { usePolledResource } from "@/lib/use-polled-resource";
import type { AgentRegistryItemView, AuthoringDraftView, AuthoringStatus, CapabilityRegistryItemView, ExplorerGraphEdge, ExplorerGraphNode, ModelTierProfileView, SkillRegistryItemView } from "@/lib/types";

const STAGES: AuthoringStatus[] = ["DRAFT", "COMPILED", "EVALUATED", "APPROVED", "PUBLISHED"];
type Tab = "canvas" | "agents" | "source" | "capabilities" | "release";
type JsonMap = Record<string, unknown>;

function object(value: unknown): value is JsonMap { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function graphCategory(kind: string) { return ({ input: "Input", output: "Output", agent: "Agents", evaluate: "Agents", tool: "Capabilities", condition: "Policy gates", transform: "Orchestration", join: "Orchestration", aggregator: "Orchestration" } as Record<string, string>)[kind] ?? "Orchestration"; }

function draftGraph(draft: AuthoringDraftView): { nodes: ExplorerGraphNode[]; edges: ExplorerGraphEdge[]; categories: string[] } {
  const spec = object(draft.parsedWorkflow.spec) ? draft.parsedWorkflow.spec : {};
  const rawNodes = Array.isArray(spec.nodes) ? spec.nodes.filter(object) : [];
  const rawEdges = Array.isArray(spec.edges) ? spec.edges.filter(object) : [];
  const nodes = rawNodes.map((node) => ({ id: String(node.id ?? ""), label: String(node.name ?? node.id ?? "Node"), subtitle: String(node.kind ?? "transform"), category: graphCategory(String(node.kind ?? "transform")), status: Array.isArray((object(node.config) ? node.config.caseWrites : undefined)) ? `${(node.config as JsonMap).caseWrites instanceof Array ? ((node.config as JsonMap).caseWrites as unknown[]).length : 0} case writes` : undefined, data: node }));
  const edges = rawEdges.map((edge, index) => ({ id: String(edge.id ?? `edge-${index}`), from: String(edge.from ?? ""), to: String(edge.to ?? ""), label: String(edge.condition ?? edge.kind ?? "data") }));
  const categoryOrder = ["Input", "Orchestration", "Agents", "Capabilities", "Policy gates", "Output"];
  return { nodes, edges, categories: categoryOrder.filter((category) => nodes.some((node) => node.category === category)) };
}

function Lifecycle({ status }: { status: AuthoringStatus }) { const current = STAGES.indexOf(status); return <ol className="grid grid-cols-5 gap-2">{STAGES.map((stage, index) => <li key={stage} className={`rounded-lg border p-2 text-center text-[10.5px] font-bold ${index < current ? "border-[#bcd9c7] bg-mint text-evergreen" : index === current ? "border-evergreen bg-evergreen text-white" : "border-line bg-surface-2 text-ink-3"}`}>{index < current ? "✓ " : ""}{stage}</li>)}</ol>; }

export default function AuthorDraftPage({ params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = use(params);
  const resource = usePolledResource<AuthoringDraftView>(`/v1/authoring/drafts/${encodeURIComponent(decodeURIComponent(draftId))}`, 5000, true);
  const registry = usePolledResource<{ items: CapabilityRegistryItemView[] }>("/v1/gateway/registry", 5000, true);
  const agents = usePolledResource<{ items: AgentRegistryItemView[] }>("/v1/authoring/agents", 5000, true);
  const skills = usePolledResource<{ items: SkillRegistryItemView[] }>("/v1/authoring/skills", 5000, true);
  const profiles = usePolledResource<{ items: ModelTierProfileView[] }>("/v1/gateway/profiles", 5000, true);
  const [tab, setTab] = useState<Tab>("canvas");
  const [packageSource, setPackageSource] = useState<string | null>(null);
  const [workflowSource, setWorkflowSource] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [capabilityForm, setCapabilityForm] = useState({ id: "", kind: "tool", effect: "read", adapterBindingId: "simulator:", description: "", owner: "platform-team" });
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [newAgentNodeId, setNewAgentNodeId] = useState("");
  const [caseWritesEdit, setCaseWritesEdit] = useState<{ key: string; source: string } | null>(null);
  const draft = resource.data;
  const graph = useMemo(() => draft ? draftGraph(draft) : { nodes: [], edges: [], categories: [] }, [draft]);
  const selectedNode = graph.nodes.find((node) => node.id === (selectedNodeId ?? graph.nodes[0]?.id)) ?? null;
  const selectedNodeConfig = selectedNode && object(selectedNode.data.config) ? selectedNode.data.config : {};
  const caseWritesEditKey = `${draft?.revision ?? 0}:${selectedNode?.id ?? ""}`;
  const caseWritesSource = caseWritesEdit?.key === caseWritesEditKey
    ? caseWritesEdit.source
    : JSON.stringify(Array.isArray(selectedNodeConfig.caseWrites) ? selectedNodeConfig.caseWrites : [], null, 2);

  const save = async () => {
    if (!draft) return; setBusy(true); setMessage(null);
    try { const response = await fetch(`/v1/authoring/drafts/${encodeURIComponent(draft.draftId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: draft.revision, packageSource: packageSource ?? draft.packageSource, workflowSource: workflowSource ?? draft.workflowSource }) }); const body = await response.json(); if (!response.ok) throw new Error(body.message ?? body.error); setPackageSource(null); setWorkflowSource(null); setMessage({ tone: "ok", text: body.diagnostics?.some((item: { severity: string }) => item.severity === "error") ? "Saved with validation errors." : "Sources saved and validation passed." }); await resource.refresh(); } catch (cause) { setMessage({ tone: "error", text: cause instanceof Error ? cause.message : "Save failed" }); } finally { setBusy(false); }
  };
  const advance = async (action: "compile" | "evaluate" | "approve" | "publish") => {
    if (!draft) return; setBusy(true); setMessage(null);
    try { const response = await fetch(`/v1/authoring/drafts/${encodeURIComponent(draft.draftId)}/${action}`, { method: "POST" }); const body = await response.json(); if (!response.ok) throw new Error(body.message ?? body.error); setMessage({ tone: "ok", text: `${action[0]?.toUpperCase()}${action.slice(1)} completed.` }); await resource.refresh(); } catch (cause) { setMessage({ tone: "error", text: cause instanceof Error ? cause.message : `${action} failed` }); } finally { setBusy(false); }
  };
  const registerCapability = async () => {
    setBusy(true); setMessage(null);
    try { const response = await fetch("/v1/gateway/registry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...capabilityForm, inputSchema: { type: "object" }, outputSchema: { type: "object" }, timeoutMs: 15000, maxAttempts: 1, idempotent: capabilityForm.effect === "read" || capabilityForm.effect === "none", dataClasses: [], status: "active" }) }); const body = await response.json(); if (!response.ok) throw new Error(body.message ?? body.error); setMessage({ tone: "ok", text: `Capability ${capabilityForm.id} registered. Bind it in package.yaml to grant it to a node.` }); setCapabilityForm((current) => ({ ...current, id: "", description: "" })); await registry.refresh(); } catch (cause) { setMessage({ tone: "error", text: cause instanceof Error ? cause.message : "Registration failed" }); } finally { setBusy(false); }
  };
  const refreshAgentRegistry = async () => { await Promise.all([agents.refresh(), skills.refresh()]); };
  const attachAgent = async (mode: "replace" | "insert-after") => {
    if (!draft || !selectedNode || !selectedAgentId) return; setBusy(true); setMessage(null);
    try {
      const response = await fetch(`/v1/authoring/drafts/${encodeURIComponent(draft.draftId)}/agents/${encodeURIComponent(selectedAgentId)}/attach`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: draft.revision, nodeId: selectedNode.id, mode, ...(mode === "insert-after" && newAgentNodeId ? { newNodeId: newAgentNodeId } : {}) }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.message ?? body.error);
      setSelectedNodeId(body.attachedNodeId); setNewAgentNodeId(""); setMessage({ tone: "ok", text: `Agent attached to ${body.attachedNodeId}; workflow.yaml is now the source of truth.` }); await resource.refresh();
    } catch (cause) { setMessage({ tone: "error", text: cause instanceof Error ? cause.message : "Agent attachment failed" }); } finally { setBusy(false); }
  };
  const saveCaseWrites = async () => {
    if (!draft || !selectedNode) return; setBusy(true); setMessage(null);
    try {
      const caseWrites = JSON.parse(caseWritesSource) as unknown;
      if (!Array.isArray(caseWrites)) throw new Error("Case writes must be a JSON array.");
      const response = await fetch(`/v1/authoring/drafts/${encodeURIComponent(draft.draftId)}/nodes/${encodeURIComponent(selectedNode.id)}/case-writes`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: draft.revision, caseWrites }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.message ?? body.error);
      setMessage({ tone: "ok", text: `Saved ${caseWrites.length} case-write contract${caseWrites.length === 1 ? "" : "s"} on ${selectedNode.id}.` }); await resource.refresh();
    } catch (cause) { setMessage({ tone: "error", text: cause instanceof Error ? cause.message : "Case-write update failed" }); } finally { setBusy(false); }
  };

  return <AppShell title={draft?.name ?? "Domain authoring"} breadcrumb={[{ label: "Author Plane", href: "/author" }, { label: draft?.status ?? "Draft" }]} readiness={resource.hasRefreshError ? "Degraded" : "Ready"} runtimeMode="OpenRouter" fixture={false} lastRefreshedAt={resource.lastRefreshedAt} isRefreshing={resource.isRefreshing} hasRefreshError={resource.hasRefreshError} onManualRefresh={resource.refresh}>
    {resource.hasRefreshError && resource.errorMessage ? <StaleDataBanner errorMessage={resource.errorMessage} lastValidAt={resource.lastRefreshedAt} onRetry={resource.refresh} /> : null}
    {resource.isLoadingInitial && !draft ? <SkeletonBlock className="h-[42rem]" /> : !draft ? <section className="card p-8 text-center">Draft not found.</section> : <div className="space-y-5">
      <section className="card p-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-bold">{draft.name}</h2><span className="chip chip-active">{draft.status}</span><span className="chip chip-mono">{draft.domain} · v{draft.version}</span></div><p className="mono mt-2 text-[11px] text-ink-3">{draft.draftId} · source revision {draft.revision}</p></div>{draft.publishedPlanDigest ? <Link className="btn btn-primary" href={`/harnesses/${encodeURIComponent(draft.publishedPlanDigest)}`}>Open published harness <ExternalLink className="h-3.5 w-3.5" /></Link> : null}</div><div className="mt-4 border-t border-line pt-4"><Lifecycle status={draft.status} /></div></section>
      {message ? <div className={`rounded-lg border p-3 text-xs ${message.tone === "ok" ? "border-[#bcd9c7] bg-mint text-evergreen" : "border-danger/30 bg-danger-soft text-danger"}`}>{message.text}</div> : null}
      <div role="tablist" className="scroll-x flex gap-1 border-b border-line">{([{ id: "canvas", label: "Draft canvas", icon: GitBranch }, { id: "agents", label: "Agents & skills", icon: Bot }, { id: "source", label: "Domain sources", icon: Code2 }, { id: "capabilities", label: "Capabilities", icon: Wrench }, { id: "release", label: "Compile & release", icon: ShieldCheck }] as const).map((item) => <button key={item.id} role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)} className={`inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-xs font-semibold ${tab === item.id ? "border-evergreen text-evergreen" : "border-transparent text-ink-2"}`}><item.icon className="h-3.5 w-3.5" />{item.label}</button>)}</div>

      {tab === "canvas" ? <div className="grid grid-cols-1 gap-5 2xl:grid-cols-[minmax(0,1fr)_390px]">
        <CategoryGraph nodes={graph.nodes} edges={graph.edges} categories={graph.categories} selectedNodeId={selectedNode?.id ?? null} onSelectNode={setSelectedNodeId} title="Editable domain workflow" />
        <aside className="card h-fit overflow-hidden">
          <div className="panel-head"><div><h2 className="text-[13px] font-bold">Node & case-write inspector</h2><p className="mono mt-0.5 text-[11px] text-ink-3">Draft source projection</p></div></div>
          {selectedNode ? <div className="space-y-4 p-4">
            <div><span className="eyebrow">{selectedNode.category}</span><h3 className="mt-1 text-sm font-bold">{selectedNode.label}</h3><p className="mono mt-1 text-[10.5px] text-ink-3">{selectedNode.id}</p></div>
            {selectedNode.subtitle !== "output" ? <div className="rounded-lg border border-line bg-surface-2 p-3">
              <p className="flex items-center gap-2 text-xs font-bold"><Bot className="h-3.5 w-3.5 text-evergreen" />Attach registered agent</p>
              <select aria-label="Registered agent" className="field mt-2" value={selectedAgentId} onChange={(event) => setSelectedAgentId(event.target.value)}><option value="">Select an agent…</option>{(agents.data?.items ?? []).map(({ agent }) => { const profile = profiles.data?.items.find((item) => item.tierId === agent.modelProfileId); return <option key={agent.id} value={agent.id} disabled={!profile?.enabled}>{agent.name} · {agent.modelProfileId}{profile ? ` · ${profile.resolvedOpenRouterModel}` : " · unresolved"} · {agent.caseWrites.length} writes</option>; })}</select>
              <input aria-label="New agent node ID" className="field mono mt-2" value={newAgentNodeId} onChange={(event) => setNewAgentNodeId(event.target.value)} placeholder={`${selectedNode.id}-agent (optional)`} />
              <div className="mt-2 grid grid-cols-2 gap-2"><button className="btn btn-ghost" disabled={busy || !selectedAgentId || selectedNode.subtitle === "input" || draft.status === "PUBLISHED"} onClick={() => void attachAgent("replace")}>Replace node</button><button className="btn btn-primary" disabled={busy || !selectedAgentId || draft.status === "PUBLISHED"} onClick={() => void attachAgent("insert-after")}>Insert after</button></div>
              <p className="mt-2 text-[10.5px] text-ink-3">Writes the agent, skills, model profile, schemas, and default case writes into the draft sources.</p>
            </div> : null}
            <div className="rounded-lg border border-line p-3">
              <div className="flex items-center justify-between gap-2"><div><p className="text-xs font-bold">Case writes</p><p className="mt-0.5 text-[10.5px] text-ink-3">Canonical commands emitted by this node</p></div><button className="btn btn-primary btn-xs" disabled={busy || draft.status === "PUBLISHED"} onClick={() => void saveCaseWrites()}><Save className="h-3.5 w-3.5" />Save</button></div>
              <textarea aria-label="Node case writes JSON" className="field mono mt-2 min-h-52 resize-y text-[10.5px]" spellCheck={false} value={caseWritesSource} onChange={(event) => setCaseWritesEdit({ key: caseWritesEditKey, source: event.target.value })} />
              <p className="mt-2 text-[10px] text-ink-3">JSON array · each entry requires commandType, payload, and payloadSchema.</p>
            </div>
            <JsonViewer data={selectedNode.data} label="Node contract" maxHeight="max-h-[28rem]" />
            <button className="btn btn-ghost w-full" onClick={() => setTab("source")}><Code2 className="h-3.5 w-3.5" />Open full workflow YAML</button>
          </div> : null}
        </aside>
      </div> : null}

      {tab === "agents" ? <AgentAuthoringPanel agents={agents.data?.items ?? []} skills={skills.data?.items ?? []} profiles={(profiles.data?.items ?? []).filter((profile) => profile.enabled)} busy={busy} onBusy={setBusy} onFeedback={setMessage} onRefresh={refreshAgentRegistry} /> : null}

      {tab === "source" ? <section className="card card-flush"><div className="panel-head"><div><h2 className="text-[13px] font-bold">Portable package sources</h2><p className="mono mt-0.5 text-[11px] text-ink-3">DomainPackage + Ladder Workflow · YAML</p></div><button className="btn btn-primary" disabled={busy || draft.status === "PUBLISHED"} onClick={() => void save()}><Save className="h-3.5 w-3.5" />Save & validate</button></div><div className="grid gap-4 p-4 xl:grid-cols-2"><label className="text-xs font-semibold text-ink-2">package.yaml<textarea aria-label="package.yaml source" spellCheck={false} className="field mono mt-2 min-h-[34rem] resize-y leading-relaxed" value={packageSource ?? draft.packageSource} onChange={(event) => setPackageSource(event.target.value)} /></label><label className="text-xs font-semibold text-ink-2">workflow.yaml<textarea aria-label="workflow.yaml source" spellCheck={false} className="field mono mt-2 min-h-[34rem] resize-y leading-relaxed" value={workflowSource ?? draft.workflowSource} onChange={(event) => setWorkflowSource(event.target.value)} /></label></div></section> : null}

      {tab === "capabilities" ? <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]"><section className="card card-flush"><div className="panel-head"><div><h2 className="text-[13px] font-bold">Gateway capability catalog</h2><p className="mono mt-0.5 text-[11px] text-ink-3">Registration is separate from plan authority</p></div></div><div className="divide-y divide-line">{(registry.data?.items ?? []).map((item) => <div key={item.capability.id} className="p-4"><div className="flex flex-wrap items-center gap-2"><span className="font-mono-code text-xs font-bold">{item.capability.id}</span><span className="chip">{item.capability.kind}</span><span className="chip chip-warn">{item.capability.effect}</span><span className="chip chip-ok">{item.capability.status}</span></div><p className="mt-2 text-xs text-ink-2">{item.capability.description}</p><p className="mono mt-1 text-[10.5px] text-ink-3">{item.capability.adapterBindingId} · {item.capability.owner}</p></div>)}{(registry.data?.items.length ?? 0) === 0 ? <p className="p-6 text-center text-xs text-ink-3">No separately registered capabilities. Embedded package capabilities still compile normally.</p> : null}</div></section><section className="card h-fit p-4"><h2 className="text-sm font-bold">Register capability</h2><p className="mt-1 text-xs text-ink-2">Registers a versioned gateway contract. Bind its ID in package.yaml before compilation.</p><div className="mt-4 space-y-3"><label className="block text-[11px] font-semibold">Capability ID<input className="field mt-1" value={capabilityForm.id} onChange={(event) => setCapabilityForm({ ...capabilityForm, id: event.target.value })} placeholder="screening.vendor.search.v1" /></label><label className="block text-[11px] font-semibold">Description<input className="field mt-1" value={capabilityForm.description} onChange={(event) => setCapabilityForm({ ...capabilityForm, description: event.target.value })} /></label><label className="block text-[11px] font-semibold">Adapter binding<input className="field mono mt-1" value={capabilityForm.adapterBindingId} onChange={(event) => setCapabilityForm({ ...capabilityForm, adapterBindingId: event.target.value })} /></label><div className="grid grid-cols-2 gap-2"><label className="block text-[11px] font-semibold">Kind<select className="field mt-1" value={capabilityForm.kind} onChange={(event) => setCapabilityForm({ ...capabilityForm, kind: event.target.value })}><option value="tool">tool</option><option value="model">model</option><option value="deterministic">deterministic</option></select></label><label className="block text-[11px] font-semibold">Effect<select className="field mt-1" value={capabilityForm.effect} onChange={(event) => setCapabilityForm({ ...capabilityForm, effect: event.target.value })}>{["none", "read", "reversible", "paid", "external", "destructive"].map((effect) => <option key={effect}>{effect}</option>)}</select></label></div><button className="btn btn-primary w-full" disabled={busy || !capabilityForm.id || !capabilityForm.description} onClick={() => void registerCapability()}><Wrench className="h-3.5 w-3.5" />Register in gateway</button></div></section></div> : null}

      {tab === "release" ? <div className="space-y-5"><section className="card p-5"><h2 className="text-sm font-bold">Lifecycle controls</h2><p className="mt-1 text-xs text-ink-2">Each transition is explicit and persisted. Editing source resets the package to DRAFT; published source is immutable.</p><div className="mt-4 flex flex-wrap gap-2"><button className="btn btn-primary" disabled={busy || draft.status !== "DRAFT"} onClick={() => void advance("compile")}><Boxes className="h-3.5 w-3.5" />Validate & compile</button><button className="btn btn-primary" disabled={busy || draft.status !== "COMPILED"} onClick={() => void advance("evaluate")}><Play className="h-3.5 w-3.5" />Run evaluation gates</button><button className="btn btn-primary" disabled={busy || draft.status !== "EVALUATED"} onClick={() => void advance("approve")}><CheckCircle2 className="h-3.5 w-3.5" />Approve</button><button className="btn btn-primary" disabled={busy || draft.status !== "APPROVED"} onClick={() => void advance("publish")}><ShieldCheck className="h-3.5 w-3.5" />Publish immutable plan</button></div></section><div className="grid gap-5 xl:grid-cols-2"><section className="card card-flush"><div className="panel-head"><div><h2 className="text-[13px] font-bold">Compiler diagnostics</h2><p className="mono mt-0.5 text-[11px] text-ink-3">{draft.diagnostics.length} findings</p></div></div><div className="divide-y divide-line">{draft.diagnostics.map((item, index) => <div key={`${item.code}-${index}`} className="p-3"><div className="flex items-center gap-2"><span className={`chip ${item.severity === "error" ? "chip-danger" : item.severity === "warning" ? "chip-warn" : "chip-ok"}`}>{item.severity}</span><span className="font-mono-code text-[11px] font-bold">{item.code}</span></div><p className="mt-1.5 text-xs text-ink-2">{item.message}</p><p className="mono mt-1 text-[10px] text-ink-3">{item.path}</p></div>)}{draft.diagnostics.length === 0 ? <p className="p-5 text-xs text-ink-3">Save or compile to produce diagnostics.</p> : null}</div></section><section className="card card-flush"><div className="panel-head"><div><h2 className="text-[13px] font-bold">Evaluation attestation</h2><p className="mono mt-0.5 text-[11px] text-ink-3">Bound to exact plan digest</p></div></div>{draft.evaluationReport ? <div className="divide-y divide-line">{draft.evaluationReport.checks.map((check) => <div key={check.id} className="p-3"><p className="flex items-center gap-2 text-xs font-bold"><CheckCircle2 className={`h-3.5 w-3.5 ${check.passed ? "text-evergreen" : "text-danger"}`} />{check.label}</p><p className="mt-1 text-[11.5px] text-ink-2">{check.detail}</p></div>)}</div> : <p className="p-5 text-xs text-ink-3">Compile the package, then run evaluation gates.</p>}</section></div>{draft.compiledPlan ? <><CategoryGraph nodes={draft.compiledPlan.nodes.map((node) => ({ id: node.id, label: node.name, subtitle: node.modelTier || node.capabilityId || node.primitive, category: graphCategory(node.primitive), status: node.caseWrites.length ? `${node.caseWrites.length} case writes` : node.effectClass, data: node as unknown as JsonMap }))} edges={draft.compiledPlan.edges.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to, label: edge.conditionLabel || edge.mappingSummary }))} categories={["Input", "Orchestration", "Agents", "Capabilities", "Policy gates", "Output"].filter((category) => draft.compiledPlan?.nodes.some((node) => graphCategory(node.primitive) === category))} selectedNodeId={selectedNodeId} onSelectNode={setSelectedNodeId} title="Immutable compiled canvas" /><section className="card p-4"><div className="flex flex-wrap items-center gap-2"><span className="text-xs font-semibold">Plan digest</span><DigestValue digest={draft.compiledPlan.planDigest} full /></div></section></> : null}</div> : null}

      <section className="card card-flush"><div className="panel-head"><div><h2 className="flex items-center gap-2 text-[13px] font-bold"><Activity className="h-4 w-4 text-evergreen" />Authoring audit trail</h2><p className="mono mt-0.5 text-[11px] text-ink-3">Source and lifecycle events</p></div></div><div className="divide-y divide-line">{draft.events?.map((event) => <div key={event.eventId} className="flex flex-wrap items-center justify-between gap-2 p-3 text-xs"><div><span className="font-mono-code font-bold">{event.eventType}</span><span className="ml-2 text-ink-3">revision {event.revision} · {event.actor}</span></div><LocalTimestamp iso={event.occurredAt} /></div>)}</div></section>
    </div>}
  </AppShell>;
}
