import { parse as parseYaml } from "yaml";
import { agentRegistrationSchema, skillRegistrationSchema, type AgentRegistration, type SkillRegistration } from "@ehf/contracts";

type RepoRef = { owner: string; repo: string; revision?: string };
type RepoFile = { path: string; content: string };
type JsonMap = Record<string, unknown>;

function object(value: unknown): value is JsonMap { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90) || "imported"; }

export function parseGithubRepository(value: string): RepoRef {
  const normalized = value.match(/^https?:\/\//) ? value : `https://github.com/${value}`;
  const url = new URL(normalized);
  if (url.hostname !== "github.com") throw new Error("authoring.github_host_required");
  const [owner, rawRepo] = url.pathname.split("/").filter(Boolean);
  const repo = rawRepo?.replace(/\.git$/, "");
  if (!owner || !repo) throw new Error("authoring.github_repository_invalid");
  const treeIndex = url.pathname.split("/").filter(Boolean).indexOf("tree");
  const revision = treeIndex >= 0 ? url.pathname.split("/").filter(Boolean)[treeIndex + 1] : undefined;
  return { owner, repo, ...(revision ? { revision } : {}) };
}

function splitFrontmatter(content: string): { attributes: JsonMap; body: string } {
  if (!content.startsWith("---\n")) return { attributes: {}, body: content.trim() };
  const end = content.indexOf("\n---", 4);
  if (end < 0) return { attributes: {}, body: content.trim() };
  const parsed = parseYaml(content.slice(4, end));
  return { attributes: object(parsed) ? parsed : {}, body: content.slice(end + 4).trim() };
}

function candidateScore(path: string): number {
  const lower = path.toLowerCase();
  if (lower.endsWith("skill.md")) return 100;
  if (/(^|\/)(agent|assistant|manifest)\.(ya?ml|json)$/.test(lower)) return 98;
  if (/(system[_-]?prompt|agents\.md|claude\.md)/.test(lower)) return 92;
  if (/(^|\/)(skills|agents|prompts)\//.test(lower) && /\.(md|ya?ml|json)$/.test(lower)) return 80;
  return 0;
}

function parseManifest(file: RepoFile | undefined): JsonMap {
  if (!file) return {};
  try {
    const value = file.path.endsWith(".json") ? JSON.parse(file.content) : parseYaml(file.content);
    return object(value) ? value : {};
  } catch { return {}; }
}

export function buildAgentBundleFromFiles(repo: RepoRef, revision: string, files: RepoFile[]): { agent: AgentRegistration; skills: SkillRegistration[] } {
  const repositoryUrl = `https://github.com/${repo.owner}/${repo.repo}`;
  const manifestFile = [...files].sort((a, b) => candidateScore(b.path) - candidateScore(a.path)).find((file) => /(^|\/)(agent|assistant|manifest)\.(ya?ml|json)$/i.test(file.path));
  const manifest = parseManifest(manifestFile);
  const skillFiles = files.filter((file) => file.path.toLowerCase().endsWith("skill.md") || /(^|\/)skills\/.*\.md$/i.test(file.path));
  const skills = skillFiles.map((file) => {
    const { attributes, body } = splitFrontmatter(file.content);
    const name = String(attributes.name ?? file.path.split("/").slice(-2, -1)[0] ?? file.path.split("/").pop()?.replace(/\.md$/i, "") ?? "Imported skill");
    const description = String(attributes.description ?? body.split("\n").find((line) => line.trim() && !line.startsWith("#")) ?? `Imported from ${file.path}`);
    const capabilityValue = attributes.allowedCapabilityIds ?? attributes.capabilities;
    const allowedCapabilityIds = Array.isArray(capabilityValue) ? capabilityValue.filter((item): item is string => typeof item === "string") : [];
    return skillRegistrationSchema.parse({
      id: `skill.${slug(repo.owner)}.${slug(repo.repo)}.${slug(name)}.v1`, name, description, instructions: body || description,
      allowedCapabilityIds, source: { type: "github", url: repositoryUrl, path: file.path, revision }, version: String(attributes.version ?? "0.1.0"), status: "active",
    });
  });
  const promptFile = files.find((file) => /(system[_-]?prompt|agents\.md|claude\.md)/i.test(file.path));
  const prompt = String(manifest.prompt ?? manifest.instructions ?? manifest.system_prompt ?? promptFile?.content ?? `Act as the ${repo.repo} domain agent.`).trim();
  const rawModelProfile = String(manifest.modelProfileId ?? manifest.model_profile_id ?? "model.standard.v1");
  const modelProfileId = rawModelProfile.startsWith("model.") ? rawModelProfile : "model.standard.v1";
  const runtimeValue = String(manifest.runtimeTarget ?? manifest.runtime_target ?? manifest.runtime ?? "local_http");
  const runtimeTarget = runtimeValue === "azure_foundry" ? "azure_foundry" : "local_http";
  const name = String(manifest.name ?? repo.repo.replace(/[-_]+/g, " "));
  const role = String(manifest.role ?? manifest.persona ?? manifest.description ?? `${name} agent`);
  const primaryCapabilityId = manifest.primaryCapabilityId ?? manifest.capabilityId ?? manifest.capability_id;
  const caseWritesValue = manifest.caseWrites ?? manifest.case_writes ?? (object(manifest.config) ? manifest.config.caseWrites : undefined);
  const agent = agentRegistrationSchema.parse({
    id: String(manifest.id ?? `agent.${slug(repo.owner)}.${slug(repo.repo)}.v1`), name,
    description: String(manifest.description ?? `Imported from ${repo.owner}/${repo.repo}`), role, prompt, modelProfileId, runtimeTarget,
    skillIds: skills.map((skill) => skill.id), ...(typeof primaryCapabilityId === "string" ? { primaryCapabilityId } : {}),
    caseWrites: Array.isArray(caseWritesValue) ? caseWritesValue : [],
    inputSchema: object(manifest.inputSchema ?? manifest.input_schema) ? manifest.inputSchema ?? manifest.input_schema : { type: "object" },
    outputSchema: object(manifest.outputSchema ?? manifest.output_schema) ? manifest.outputSchema ?? manifest.output_schema : { type: "object" },
    source: { type: "github", url: repositoryUrl, ...(manifestFile ? { path: manifestFile.path } : {}), revision },
    version: String(manifest.version ?? "0.1.0"), status: "active",
  });
  return { agent, skills };
}

export async function importAgentBundle(url: string): Promise<{ agent: AgentRegistration; skills: SkillRegistration[] }> {
  const repo = parseGithubRepository(url);
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "ehf-author-plane" };
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const metaResponse = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}`, { headers });
  if (!metaResponse.ok) throw new Error(`authoring.github_repository_unavailable:${metaResponse.status}`);
  const metadata = await metaResponse.json() as { default_branch?: string };
  const revision = repo.revision ?? metadata.default_branch ?? "main";
  const treeResponse = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/git/trees/${encodeURIComponent(revision)}?recursive=1`, { headers });
  if (!treeResponse.ok) throw new Error(`authoring.github_tree_unavailable:${treeResponse.status}`);
  const tree = await treeResponse.json() as { tree?: Array<{ path?: string; type?: string; size?: number }> };
  const paths = (tree.tree ?? []).filter((item) => item.type === "blob" && item.path && candidateScore(item.path) > 0 && (item.size ?? 0) <= 180_000 && item.path.split("/").length <= 7)
    .sort((a, b) => candidateScore(b.path ?? "") - candidateScore(a.path ?? "")).slice(0, 30).map((item) => item.path as string);
  if (!paths.length) throw new Error("authoring.github_no_agent_files");
  const files = (await Promise.all(paths.map(async (path): Promise<RepoFile | null> => {
    const response = await fetch(`https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${revision}/${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return response.ok ? { path, content: await response.text() } : null;
  }))).filter((file): file is RepoFile => Boolean(file));
  return buildAgentBundleFromFiles(repo, revision, files);
}
