"use client";

import { useState } from "react";
import { Bot, GitFork, Minus, PackageCheck, Plus } from "lucide-react";
import type { AgentRegistryItemView, ModelTierProfileView, SkillRegistryItemView } from "@/lib/types";

type Feedback = { tone: "ok" | "error"; text: string };
const emptyAgent = { id: "", name: "", description: "", role: "", prompt: "", modelProfileId: "model.standard.v1", runtimeTarget: "local_http" as "local_http" | "azure_foundry", skillIds: [] as string[], caseWrites: "[]" };
const emptySkill = { id: "", name: "", description: "", instructions: "", capabilityIds: "" };

function ToggleButton({ open, label, onClick }: { open: boolean; label: string; onClick: () => void }) {
  const Icon = open ? Minus : Plus;
  return <button className="btn btn-ghost" aria-expanded={open} onClick={onClick}><Icon className="h-3.5 w-3.5" />{open ? "Close" : label}</button>;
}

export function AgentAuthoringPanel({ agents, skills, profiles, busy, onBusy, onFeedback, onRefresh }: {
  agents: AgentRegistryItemView[]; skills: SkillRegistryItemView[]; profiles: ModelTierProfileView[]; busy: boolean;
  onBusy: (value: boolean) => void; onFeedback: (value: Feedback) => void; onRefresh: () => Promise<void>;
}) {
  const [githubUrl, setGithubUrl] = useState("");
  const [agentOpen, setAgentOpen] = useState(false);
  const [skillOpen, setSkillOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [agentForm, setAgentForm] = useState(emptyAgent);
  const [skillForm, setSkillForm] = useState(emptySkill);

  const createAgent = async () => {
    onBusy(true);
    try {
      const caseWrites = JSON.parse(agentForm.caseWrites) as unknown;
      if (!Array.isArray(caseWrites)) throw new Error("Case writes must be a JSON array.");
      const response = await fetch("/v1/authoring/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...agentForm, caseWrites, inputSchema: { type: "object" }, outputSchema: { type: "object" }, source: { type: "manual" }, version: "0.1.0", status: "active" }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.message ?? body.error);
      setAgentForm(emptyAgent); setAgentOpen(false); await onRefresh();
      onFeedback({ tone: "ok", text: `Agent ${body.agent.name} registered for ${body.agent.runtimeTarget}.` });
    } catch (error) { onFeedback({ tone: "error", text: error instanceof Error ? error.message : "Agent registration failed" }); } finally { onBusy(false); }
  };

  const createSkill = async () => {
    onBusy(true);
    try {
      const allowedCapabilityIds = skillForm.capabilityIds.split(",").map((value) => value.trim()).filter(Boolean);
      const response = await fetch("/v1/authoring/skills", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: skillForm.id, name: skillForm.name, description: skillForm.description, instructions: skillForm.instructions, allowedCapabilityIds, source: { type: "manual" }, version: "0.1.0", status: "active" }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.message ?? body.error);
      setSkillForm(emptySkill); setSkillOpen(false); await onRefresh();
      onFeedback({ tone: "ok", text: `Skill ${body.skill.name} registered and available to agents.` });
    } catch (error) { onFeedback({ tone: "error", text: error instanceof Error ? error.message : "Skill registration failed" }); } finally { onBusy(false); }
  };

  const importGithub = async () => {
    onBusy(true);
    try {
      const response = await fetch("/v1/authoring/import/github", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: githubUrl }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.message ?? body.error);
      setGithubUrl(""); setImportOpen(false); await onRefresh();
      onFeedback({ tone: "ok", text: `Imported ${body.agent.agent.name} and ${body.skills.length} skill contracts from GitHub.` });
    } catch (error) { onFeedback({ tone: "error", text: error instanceof Error ? error.message : "GitHub import failed" }); } finally { onBusy(false); }
  };

  return <div className="space-y-5">
    <section className="card card-flush">
      <div className="panel-head"><div><h2 className="flex items-center gap-2 text-[13px] font-bold"><GitFork className="h-4 w-4 text-evergreen" />GitHub import</h2><p className="mono mt-0.5 text-[11px] text-ink-3">Agent manifests · prompts · SKILL.md</p></div><ToggleButton open={importOpen} label="Import repository" onClick={() => setImportOpen((value) => !value)} /></div>
      {importOpen ? <div className="border-t border-line bg-surface-2 p-4"><p className="text-xs text-ink-2">Repository content is inspected and converted into governed registry contracts.</p><div className="mt-3 flex flex-col gap-2 md:flex-row"><input aria-label="Repository URL" className="field mono flex-1" value={githubUrl} onChange={(event) => setGithubUrl(event.target.value)} placeholder="https://github.com/org/agent-repo" /><button className="btn btn-primary" disabled={busy || !githubUrl} onClick={() => void importGithub()}><GitFork className="h-3.5 w-3.5" />Inspect & import</button></div></div> : null}
    </section>

    <div className="grid gap-5 xl:grid-cols-2">
      <section className="card card-flush h-fit">
        <div className="panel-head"><div><h2 className="flex items-center gap-2 text-[13px] font-bold"><Bot className="h-4 w-4 text-evergreen" />Agent registry</h2><p className="mono mt-0.5 text-[11px] text-ink-3">{agents.length} reusable contracts</p></div><ToggleButton open={agentOpen} label="Create agent" onClick={() => setAgentOpen((value) => !value)} /></div>
        {agentOpen ? <div className="border-y border-line bg-surface-2 p-4"><h3 className="text-xs font-bold">New agent contract</h3><div className="mt-3 grid gap-3 md:grid-cols-2">{([['id','Agent ID','agent.kyc.reviewer.v1'],['name','Name','KYC reviewer'],['description','Description','Reviews screening evidence'],['role','Role','Senior KYC analyst']] as const).map(([key,label,placeholder]) => <label key={key} className="block text-[11px] font-semibold">{label}<input className="field mt-1" value={agentForm[key]} onChange={(event) => setAgentForm({ ...agentForm, [key]: event.target.value })} placeholder={placeholder} /></label>)}<label className="block text-[11px] font-semibold">Model profile<select className="field mt-1" value={agentForm.modelProfileId} onChange={(event) => setAgentForm({ ...agentForm, modelProfileId: event.target.value })}>{profiles.map((profile) => <option key={profile.tierId} value={profile.tierId}>{profile.tierId} · {profile.resolvedOpenRouterModel}</option>)}</select></label><label className="block text-[11px] font-semibold">Runtime target<select className="field mt-1" value={agentForm.runtimeTarget} onChange={(event) => setAgentForm({ ...agentForm, runtimeTarget: event.target.value as "local_http" | "azure_foundry" })}><option value="local_http">Local LangGraph runtime</option><option value="azure_foundry">Azure Foundry hosted agent</option></select></label></div><label className="mt-3 block text-[11px] font-semibold">System prompt<textarea className="field mt-1 min-h-28 resize-y" value={agentForm.prompt} onChange={(event) => setAgentForm({ ...agentForm, prompt: event.target.value })} placeholder="Review the supplied evidence and return..." /></label><label className="mt-3 block text-[11px] font-semibold">Default case writes (JSON array)<textarea className="field mono mt-1 min-h-36 resize-y" spellCheck={false} value={agentForm.caseWrites} onChange={(event) => setAgentForm({ ...agentForm, caseWrites: event.target.value })} placeholder='[{"commandType":"SubmitDecisionRecommendation","when":"success","payload":{},"payloadSchema":{"type":"object"}}]' /></label>{skills.length ? <fieldset className="mt-3"><legend className="text-[11px] font-semibold">Skills</legend><div className="mt-2 flex flex-wrap gap-2">{skills.map(({ skill }) => <label key={skill.id} className="chip cursor-pointer"><input type="checkbox" checked={agentForm.skillIds.includes(skill.id)} onChange={(event) => setAgentForm({ ...agentForm, skillIds: event.target.checked ? [...agentForm.skillIds, skill.id] : agentForm.skillIds.filter((id) => id !== skill.id) })} />{skill.name}</label>)}</div></fieldset> : null}<p className="mt-3 text-[10.5px] text-ink-3">Runtime target and default case-write contracts are persisted into workflow.yaml when the agent is attached.</p><button className="btn btn-primary mt-3" disabled={busy || profiles.length === 0 || !profiles.some((profile) => profile.tierId === agentForm.modelProfileId) || !agentForm.id || !agentForm.name || !agentForm.description || !agentForm.role || !agentForm.prompt} onClick={() => void createAgent()}><Bot className="h-3.5 w-3.5" />Register agent</button></div> : null}
        <div className="divide-y divide-line">{agents.map(({ agent }) => { const profile = profiles.find((item) => item.tierId === agent.modelProfileId); return <div key={agent.id} className="p-4"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-bold">{agent.name}</span><span className={`chip ${profile ? "" : "chip-danger"}`}>{agent.modelProfileId}</span><span className="chip">{agent.runtimeTarget === "azure_foundry" ? "Azure Foundry" : "Local LangGraph"}</span><span className="chip chip-ok">{agent.status}</span></div><p className="mt-1.5 text-xs text-ink-2">{agent.description}</p><p className="mono mt-2 text-[10.5px] text-ink-3">{profile ? `${profile.resolvedOpenRouterModel} · ` : "unresolved profile · "}{agent.id} · {agent.skillIds.length} skills · {agent.caseWrites.length} case writes</p></div>; })}{agents.length === 0 ? <p className="p-6 text-center text-xs text-ink-3">Use + Create agent or import a repository.</p> : null}</div>
      </section>

      <section className="card card-flush h-fit">
        <div className="panel-head"><div><h2 className="flex items-center gap-2 text-[13px] font-bold"><PackageCheck className="h-4 w-4 text-evergreen" />Skill registry</h2><p className="mono mt-0.5 text-[11px] text-ink-3">{skills.length} instruction contracts</p></div><ToggleButton open={skillOpen} label="Create skill" onClick={() => setSkillOpen((value) => !value)} /></div>
        {skillOpen ? <div className="border-y border-line bg-surface-2 p-4"><h3 className="text-xs font-bold">New skill contract</h3><div className="mt-3 grid gap-3 md:grid-cols-2">{([['id','Skill ID','skill.kyc.evidence-review.v1'],['name','Name','Evidence review'],['description','Description','Review evidence provenance']] as const).map(([key,label,placeholder]) => <label key={key} className="block text-[11px] font-semibold">{label}<input className="field mt-1" value={skillForm[key]} onChange={(event) => setSkillForm({ ...skillForm, [key]: event.target.value })} placeholder={placeholder} /></label>)}<label className="block text-[11px] font-semibold">Allowed capability IDs<input className="field mono mt-1" value={skillForm.capabilityIds} onChange={(event) => setSkillForm({ ...skillForm, capabilityIds: event.target.value })} placeholder="screening.search.v1, evidence.read.v1" /></label></div><label className="mt-3 block text-[11px] font-semibold">Instructions<textarea className="field mt-1 min-h-28 resize-y" value={skillForm.instructions} onChange={(event) => setSkillForm({ ...skillForm, instructions: event.target.value })} placeholder="Check provenance, freshness, and contradictions before deciding." /></label><button className="btn btn-primary mt-3" disabled={busy || !skillForm.id || !skillForm.name || !skillForm.description || !skillForm.instructions} onClick={() => void createSkill()}><PackageCheck className="h-3.5 w-3.5" />Register skill</button></div> : null}
        <div className="divide-y divide-line">{skills.map(({ skill }) => <div className="p-4" key={skill.id}><div className="flex flex-wrap items-center gap-2"><p className="text-xs font-bold">{skill.name}</p><span className="chip chip-ok">{skill.status}</span></div><p className="mt-1 text-xs text-ink-2">{skill.description}</p><p className="mono mt-1 text-[10.5px] text-ink-3">{skill.id} · {skill.allowedCapabilityIds.length} capabilities</p></div>)}{skills.length === 0 ? <p className="p-5 text-xs text-ink-3">Use + Create skill or import SKILL.md from GitHub.</p> : null}</div>
      </section>
    </div>
  </div>;
}
