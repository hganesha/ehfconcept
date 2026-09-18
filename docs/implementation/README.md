# Foundation and KYC implementation package

This package implements the requested **planning deliverable**, with USA scope confirmed by the user. It does not deploy Azure resources or implement the application.

Start with `implementation-plan.md` or the PDF in the package's `pdf` folder. The plan covers a proposed East US 2 / Central US architecture, foundation and KYC work packages, a U.S. policy overlay, a 20-week gated roadmap, security, evidence, testing, operations and recovery.

| File | Purpose |
| --- | --- |
| implementation-plan.md | Editable master plan, with source references and assumptions |
| ../plans/azure-poc-migration-plan.md | Modular plan to move the working POC to Static Web Apps, Container Apps, PostgreSQL Flexible Server, Entra identity, Azure Monitor, GitHub OIDC, and the existing Foundry Hosted Agent runtime |
| ../plans/runtime-isolation-azure-migration.md | Local runtime isolation, provider-neutral configuration, and Foundry deployment/registry/promotion steps |
| config/foundation.azure.yaml | Detailed proposed Azure settings: regions, subnets, identity, SKUs, networking, compute, storage, messaging and operations |
| config/kyc.domain.yaml | Eight KYC roles, capabilities, budgets, lifecycle, policy inputs, gates and human review |
| delivery-backlog.csv | 25 work packages, effort, owners, dependencies and acceptance evidence |
| examples/apim-command-policy.xml | Illustrative Entra authentication and managed-identity routing policy |
| examples/command-transaction.txt | Transaction, outbox, idempotency and evidence-boundary algorithm |
| validation-report.md | Checks performed and practical limits |

YAML uses a **planning schema**, not an Azure-native deployment format. Convert it into tested Bicep modules and environment parameters during implementation. The APIM XML is a partial example requiring named values, backend registration, and complete authorization/schema policies. `UNSET` and `REPLACE_WITH_*` values are deliberate unresolved inputs; they cannot be deployed as-is.

Confirmed: USA scope. Proposed: exact regions, capacity, customer launch cohorts, schedule and service targets. Still required: institution/product-specific rules, vendor choices, retention schedule, exact model deployments/quotas, tenant details and operational ownership.

The production plan requires human-confirmed approval/decline during pilot. It separates deterministic policy enforcement from model interpretation, and preserves the source documents' Case/ledger/contract authority boundaries.
