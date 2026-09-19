.PHONY: compile fixtures check up down demo demo-case demo-kyc-e2e logs trace

compile:
	cargo build --release --locked -p harness-compiler
	./target/release/harnessc compile domains/kyc --out artifacts/plans/kyc.plan.json
	./target/release/harnessc compile domains/invoice --out artifacts/plans/invoice.plan.json

fixtures:
	cargo build --release --locked -p harness-compiler
	./target/release/harnessc compile packages/contracts/test-fixtures/cross-compiler \
		--out packages/contracts/test-fixtures/cross-compiler.plan.json

check: compile
	cargo test --workspace
	pnpm check

up: compile
	docker compose up --build -d

down:
	docker compose down

demo: compile
	./scripts/demo.sh

demo-case:
	./scripts/demo-case-store.sh

demo-kyc-e2e: compile
	./scripts/demo-kyc-e2e.sh

logs:
	docker compose logs -f control-api case-api capability-gateway runtime-dispatcher runtime-host-local control-ui

trace:
	@test -n "$(RUN_ID)" || (echo "usage: make trace RUN_ID=RUN-..." >&2; exit 1)
	./scripts/verify-trace.sh "$(RUN_ID)"
