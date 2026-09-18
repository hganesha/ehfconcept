use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::{Path, PathBuf}};
use walkdir::WalkDir;

const LGIR_REV: &str = "fec01bf0fa5ff259c071439d63ad71c9979668f9";

#[derive(Parser)]
#[command(name = "harnessc", version)]
struct Cli { #[command(subcommand)] command: Command }

#[derive(Subcommand)]
enum Command {
    Compile {
        package_dir: PathBuf,
        #[arg(short, long)] out: PathBuf,
        #[arg(long, default_value = "config/model-profiles.json")] model_profiles: PathBuf,
    },
    Validate { package_dir: PathBuf },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Package {
    api_version: String,
    kind: String,
    metadata: PackageMetadata,
    workflow: String,
    budgets: Value,
    #[serde(default)] model_profiles: Vec<String>,
    capabilities: Vec<Capability>,
    #[serde(default)] bindings: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct PackageMetadata { name: String, version: String, domain: String, objective: String }

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Capability {
    id: String,
    kind: String,
    effect: String,
    adapter_binding_id: String,
    #[serde(default)] input_schema: Value,
    #[serde(default)] output_schema: Value,
    timeout_ms: u64,
    #[serde(default = "one")] max_attempts: u32,
    #[serde(default)] idempotent: bool,
}
fn one() -> u32 { 1 }

fn canonical(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(map.into_iter()
            .map(|(key, value)| (key, canonical(value)))
            .collect::<BTreeMap<_, _>>().into_iter().collect()),
        Value::Array(values) => Value::Array(values.into_iter().map(canonical).collect()),
        other => other,
    }
}

fn digest(value: &Value) -> String {
    hex::encode(Sha256::digest(serde_json::to_vec(&canonical(value.clone())).unwrap()))
}

fn dependency_manifest(root: &Path) -> Result<Vec<Value>> {
    let mut files = WalkDir::new(root).into_iter().filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file()).collect::<Vec<_>>();
    files.sort_by_key(|entry| entry.path().to_owned());
    files.into_iter().map(|entry| {
        let relative = entry.path().strip_prefix(root)?.to_string_lossy().replace('\\', "/");
        let bytes = fs::read(entry.path())?;
        Ok(json!({ "path": relative, "digest": hex::encode(Sha256::digest(bytes)) }))
    }).collect()
}

fn load_package(dir: &Path) -> Result<(Package, String)> {
    let source = fs::read_to_string(dir.join("package.yaml")).context("read package.yaml")?;
    let package: Package = serde_yaml_ng::from_str(&source).context("parse package.yaml")?;
    if package.api_version != "harness.factory/domain-package-v1" || package.kind != "DomainPackage" {
        bail!("package.contract_unsupported");
    }
    let workflow = fs::read_to_string(dir.join(&package.workflow)).context("read workflow")?;
    Ok((package, workflow))
}

fn compile(dir: &Path, profiles_path: &Path) -> Result<Value> {
    let (package, workflow_source) = load_package(dir)?;
    let analysis = lgir_core::analyze(&workflow_source, None);
    if !analysis.ok {
        bail!("LGIR validation failed:\n{}", serde_json::to_string_pretty(&analysis.diagnostics)?);
    }
    let workflow = analysis.normalized.context("LGIR returned no normalized workflow")?;
    let capability_by_id = package.capabilities.iter().map(|item| (item.id.as_str(), item)).collect::<BTreeMap<_, _>>();
    let mut envelopes = Vec::new();
    let nodes = workflow.spec.nodes.iter().map(|node| {
        let binding = package.bindings.get(&node.id);
        let mut config = serde_json::to_value(&node.config).unwrap_or(json!({}));
        if let Some(capability_id) = binding {
            config.as_object_mut().unwrap().insert("capabilityId".into(), json!(capability_id));
            let capability = capability_by_id.get(capability_id.as_str()).with_context(|| format!("binding capability missing: {capability_id}"))?;
            let unsigned = json!({ "nodeId": node.id, "capabilities": [capability.id], "effects": [capability.effect] });
            envelopes.push(json!({
                "nodeId": node.id,
                "capabilities": [capability.id],
                "effects": [capability.effect],
                "digest": digest(&unsigned),
            }));
        }
        Ok(json!({
            "id": node.id, "kind": node.kind, "name": if node.name.is_empty() { &node.id } else { &node.name },
            "summary": node.summary, "prompt": node.prompt,
            "inputSchema": node.input_schema, "outputSchema": node.output_schema, "config": config,
        }))
    }).collect::<Result<Vec<Value>>>()?;
    let edges = workflow.spec.edges.iter().map(|edge| json!({
        "id": edge.id, "from": edge.from, "to": edge.to, "kind": edge.kind,
        "condition": edge.condition, "sourcePath": edge.source_path, "targetPath": edge.target_path,
    })).collect::<Vec<_>>();
    let registry: Value = serde_json::from_str(&fs::read_to_string(profiles_path).context("read model profiles")?)?;
    let profiles = registry.get("profiles").and_then(Value::as_array).context("model profiles invalid")?;
    let model_profiles = package.model_profiles.iter().map(|id| {
        let profile = profiles.iter().find(|item| item.get("id").and_then(Value::as_str) == Some(id))
            .with_context(|| format!("model profile missing: {id}"))?;
        Ok(json!({ "id": id, "digest": digest(profile) }))
    }).collect::<Result<Vec<Value>>>()?;
    let dependencies = dependency_manifest(dir)?;
    let package_digest = digest(&Value::Array(dependencies.clone()));
    let content = json!({
        "apiVersion": "harness.factory/plan-v1", "kind": "HarnessPlan", "packageDigest": package_digest,
        "compiler": { "name": "harnessc", "version": env!("CARGO_PKG_VERSION"), "lgirCoreRevision": LGIR_REV },
        "metadata": package.metadata,
        "execution": { "engine": { "kind": "langgraph-js", "adapterVersion": "harness-langgraph-v1", "profile": "poc-v1" }, "maxTransitions": 200, "maxConcurrency": workflow.spec.policies.max_concurrency, "durability": "sync" },
        "budgets": package.budgets,
        "schemas": { "input": workflow.spec.inputs, "output": workflow.spec.outputs },
        "modelProfiles": model_profiles, "capabilities": package.capabilities,
        "permissionEnvelopes": envelopes,
        "graph": { "apiVersion": "ladder.dev/v1alpha1", "name": workflow.metadata.name, "nodes": nodes, "edges": edges, "nodeOrder": analysis.node_order },
        "dependencyManifest": dependencies,
    });
    let plan_digest = digest(&content);
    let mut plan = content.as_object().unwrap().clone();
    plan.insert("planId".into(), json!(format!("{}@{}:{}", package.metadata.name, package.metadata.version, &plan_digest[..12])));
    plan.insert("planDigest".into(), json!(plan_digest));
    Ok(Value::Object(plan))
}

fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Compile { package_dir, out, model_profiles } => {
            let plan = compile(&package_dir, &model_profiles)?;
            if let Some(parent) = out.parent() { fs::create_dir_all(parent)?; }
            fs::write(&out, format!("{}\n", serde_json::to_string_pretty(&plan)?))?;
            println!("{}", plan["planDigest"].as_str().unwrap_or_default());
        }
        Command::Validate { package_dir } => {
            let (_, source) = load_package(&package_dir)?;
            let analysis = lgir_core::analyze(&source, None);
            println!("{}", serde_json::to_string_pretty(&analysis)?);
            if !analysis.ok { bail!("LGIR validation failed"); }
        }
    }
    Ok(())
}
