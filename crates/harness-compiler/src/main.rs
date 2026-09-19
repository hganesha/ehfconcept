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
    #[serde(default)] skills: Vec<Value>,
    #[serde(default)] agents: Vec<Value>,
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
    #[serde(default = "empty_object")] input_schema: Value,
    #[serde(default = "empty_object")] output_schema: Value,
    timeout_ms: u64,
    #[serde(default = "one")] max_attempts: u32,
    #[serde(default)] idempotent: bool,
}
fn one() -> u32 { 1 }
fn empty_object() -> Value { json!({}) }

/// Fill the array-valued defaults declared by the plan contract.
///
/// The emitted plan must already be schema-complete. `HarnessPlan` is validated with
/// zod on the way in, and zod applies defaults during parsing -- so a document that
/// omits an optional-with-default key parses into a *different* value than the one the
/// compiler digested, and the plan then fails digest verification at admission. Emitting
/// the defaults here keeps exactly one canonical form of a plan.
fn fill_array_defaults(value: &mut Value, keys: &[&str]) {
    let Some(object) = value.as_object_mut() else { return };
    for key in keys {
        object.entry(*key).or_insert_with(|| json!([]));
    }
}

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

/// Node configuration carried by the authoring source but not modelled by `lgir-core`.
///
/// `lgir_core::NodeConfig` is a closed struct: deserializing a node drops every key it
/// does not declare. That is correct for Ladder Graph's own semantics, but the harness
/// layers authority-bearing declarations on top of the same `config` block --
/// `caseWrites` (which canonical BusinessCommands a node may submit), `agentRef`,
/// `skillRefs`, `runtimeTarget`. Compiling through the normalizer alone silently
/// discarded all of them, so a plan would validate, admit, and run while quietly having
/// no case-write authority at all.
///
/// The modelled key set is read back off the normalized value rather than hard-coded, so
/// a later `lgir-core` revision that starts modelling one of these keys takes ownership
/// of it automatically and normalization keeps winning.
fn merge_extension_config(normalized: &mut Value, source: Option<&Value>) {
    let Some(Value::Object(source_config)) = source else { return };
    let Some(target) = normalized.as_object_mut() else { return };
    for (key, value) in source_config {
        if target.contains_key(key) { continue; }
        target.insert(key.clone(), value.clone());
    }
}

/// Per-node `config` blocks exactly as the author wrote them, keyed by node id.
fn source_node_configs(workflow_source: &str) -> Result<BTreeMap<String, Value>> {
    let document: Value = serde_yaml_ng::from_str(workflow_source).context("parse workflow for extension config")?;
    let nodes = document.get("spec").and_then(|spec| spec.get("nodes")).and_then(Value::as_array);
    let mut configs = BTreeMap::new();
    for node in nodes.unwrap_or(&Vec::new()) {
        let Some(id) = node.get("id").and_then(Value::as_str) else { continue };
        if let Some(config) = node.get("config") {
            configs.insert(id.to_string(), config.clone());
        }
    }
    Ok(configs)
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
    let source_configs = source_node_configs(&workflow_source)?;
    let capability_by_id = package.capabilities.iter().map(|item| (item.id.as_str(), item)).collect::<BTreeMap<_, _>>();
    let mut envelopes = Vec::new();
    let nodes = workflow.spec.nodes.iter().map(|node| {
        let binding = package.bindings.get(&node.id);
        let mut config = serde_json::to_value(&node.config).unwrap_or(json!({}));
        merge_extension_config(&mut config, source_configs.get(&node.id));
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
    // A plan carries only the capabilities a node can actually reach. Everything else the
    // package declares stays out of the executable artifact: the permission envelopes are
    // the authority, and an unreachable definition in the plan is only blast radius.
    let mut skills = package.skills.clone();
    for skill in &mut skills { fill_array_defaults(skill, &["allowedCapabilityIds"]); }
    let mut agents = package.agents.clone();
    for agent in &mut agents { fill_array_defaults(agent, &["skillIds", "caseWrites"]); }
    let bound_capability_ids = package.bindings.values().collect::<std::collections::BTreeSet<_>>();
    let capabilities = package.capabilities.iter()
        .filter(|capability| bound_capability_ids.contains(&capability.id))
        .collect::<Vec<_>>();
    let dependencies = dependency_manifest(dir)?;
    let package_digest = digest(&Value::Array(dependencies.clone()));
    let content = json!({
        "apiVersion": "harness.factory/plan-v1", "kind": "HarnessPlan", "packageDigest": package_digest,
        "compiler": { "name": "harnessc", "version": env!("CARGO_PKG_VERSION"), "lgirCoreRevision": LGIR_REV },
        "metadata": package.metadata,
        "execution": { "engine": { "kind": "langgraph-js", "adapterVersion": "harness-langgraph-v1", "profile": "poc-v1" }, "maxTransitions": 200, "maxConcurrency": workflow.spec.policies.max_concurrency, "durability": "sync" },
        "budgets": package.budgets,
        "schemas": { "input": workflow.spec.inputs, "output": workflow.spec.outputs },
        "modelProfiles": model_profiles,
        "skills": skills, "agents": agents,
        "capabilities": capabilities,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_config_keys_the_normalizer_does_not_model() {
        // The regression: lgir-core's NodeConfig is a closed struct, so compiling through
        // it alone dropped caseWrites/agentRef/skillRefs/runtimeTarget and produced a plan
        // with no case-write authority that still validated and ran.
        let mut normalized = json!({ "operation": "", "expression": "" });
        let source = json!({
            "operation": "should-not-override",
            "caseWrites": [{ "commandType": "AddSubject" }],
            "agentRef": "agent.kyc.policy.v1",
            "runtimeTarget": "local_http",
        });
        merge_extension_config(&mut normalized, Some(&source));
        assert_eq!(normalized["operation"], json!(""), "normalization must win for modelled keys");
        assert_eq!(normalized["agentRef"], json!("agent.kyc.policy.v1"));
        assert_eq!(normalized["runtimeTarget"], json!("local_http"));
        assert_eq!(normalized["caseWrites"][0]["commandType"], json!("AddSubject"));
    }

    #[test]
    fn reads_source_config_per_node() {
        let configs = source_node_configs(
            "spec:\n  nodes:\n    - id: a\n      config:\n        agentRef: x\n    - id: b\n",
        ).expect("parse");
        assert_eq!(configs["a"]["agentRef"], json!("x"));
        assert!(!configs.contains_key("b"), "a node without config contributes nothing");
    }

    #[test]
    fn fills_contract_defaults_so_parsing_is_a_no_op() {
        let mut agent = json!({ "id": "agent.a" });
        fill_array_defaults(&mut agent, &["skillIds", "caseWrites"]);
        assert_eq!(agent["skillIds"], json!([]));
        assert_eq!(agent["caseWrites"], json!([]));

        let mut existing = json!({ "skillIds": ["s1"] });
        fill_array_defaults(&mut existing, &["skillIds"]);
        assert_eq!(existing["skillIds"], json!(["s1"]), "an authored value is never replaced");
    }

    #[test]
    fn canonical_ordering_matches_utf8_byte_order() {
        // The TypeScript side re-digests plans with a code-unit sort; these must agree.
        let value = canonical(json!({ "Zebra": 1, "apple": 2, "Apple": 3, "a_b": 4, "aB": 5 }));
        assert_eq!(
            serde_json::to_string(&value).unwrap(),
            r#"{"Apple":3,"Zebra":1,"aB":5,"a_b":4,"apple":2}"#,
        );
    }
}
