# Harness Author Plane POC

The author plane keeps mutable authoring state separate from executable runtime state. Authors edit a `DomainPackage` and Ladder workflow in a draft. Compilation emits the same immutable, content-addressed `HarnessPlan` contract consumed by the LangGraph runtime.

## Lifecycle

`DRAFT → COMPILED → EVALUATED → APPROVED → PUBLISHED`

- Saving source validates YAML and contracts and resets a non-published package to `DRAFT`.
- Compilation resolves embedded and active gateway capabilities, produces permission envelopes, and binds model-profile digests.
- Evaluation records digest-bound topology, authority, case-write, budget, and runtime-compatibility checks.
- Approval records the actor. Publication admits the exact compiled plan to the runtime registry.
- Published source is immutable. Every source or lifecycle mutation writes an authoring event.

## Case-write contract

A node may declare canonical case-store intent in `config.caseWrites`. This is metadata in the compiled plan; it does not grant direct PostgreSQL access.

```yaml
config:
  caseWrites:
    - commandType: SubmitDecisionRecommendation
      when: success
      payloadSchema:
        type: object
        required: [recommendation, rationale]
        properties:
          recommendation:
            type: string
            enum: [APPROVE, REVIEW, REJECT]
          rationale: { type: string }
```

The compiler accepts only the canonical `BusinessCommand` vocabulary and requires a JSON Schema object for each payload. PostgreSQL JSONB stores the resulting command payload without weakening command validation or allowing generated SQL.

## Capability boundary

The Gateway catalog registers versioned capability contracts and adapter bindings. Registration makes a capability resolvable during compilation; it does not authorize a run. Runtime authority remains limited to the capability IDs and effects embedded in that plan's signed permission envelopes.

## Agent and skill registries

Agents and skills are reusable authoring contracts, not runtime authority. An agent records its role, system prompt, model-profile ID, schemas, and stable skill references. A skill records reusable instructions and optional capability references. Definitions can be authored in the control surface or imported from a GitHub repository containing an agent manifest, prompt files, and `SKILL.md` files.

Attaching an agent to a node updates `workflow.yaml` with `agentRef`, `agentVersion`, `skillRefs`, `modelProfileId`, `runtimeTarget`, prompt, and schemas. Authors may replace an eligible node or insert a new agent node after the selection. Insert mode rewires outgoing edges deterministically. The model profile is also added to `package.yaml`; an optional primary capability adds a package binding but remains subject to normal gateway resolution and compilation. `runtimeTarget` accepts `local_http` (the local LangGraph host) or `azure_foundry` (the hosted-agent adapter). The dispatcher resolves that target from the compiled plan and uses its environment default when none is declared. Because isolation occurs at invocation scope, compilation rejects mixed runtime targets within one POC harness.

GitHub import is intentionally bounded to `github.com`, candidate authoring files, six directory levels, 180 KB per file, and 30 files per import. `GITHUB_TOKEN` or `GH_TOKEN` may be configured for private repositories and rate limits. Imported provider model names are normalized to a portable model profile unless the manifest already names a `model.*` profile.

## Local APIs

- `GET|POST /v1/authoring/drafts`
- `GET|PUT /v1/authoring/drafts/:draftId`
- `POST /v1/authoring/drafts/:draftId/{validate|compile|evaluate|approve|publish}`
- `GET /v1/authoring/templates`
- `GET|POST /v1/authoring/agents`
- `GET|POST /v1/authoring/skills`
- `POST /v1/authoring/import/github`
- `POST /v1/authoring/drafts/:draftId/agents/:agentId/attach`
- `GET|POST /v1/capabilities` on the capability gateway

The control surface proxies these contracts under `/v1/authoring/*` and `/v1/gateway/registry`. The PostgreSQL schema `harness_control` stores drafts, events, agents, and skills; `harness_gateway` stores the capability catalog.
