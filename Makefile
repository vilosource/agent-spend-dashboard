# Local lab Makefile.
# Per docs/strategy/local-lab-STRATEGY.md §5.5.
#
# Most verbs are thin wrappers around `docker compose` in
# deploy/docker-compose/, with the seeder + bridge added by
# compose.override.yml.

COMPOSE_DIR := deploy/docker-compose
COMPOSE     := docker compose --project-directory $(COMPOSE_DIR) \
                              -f $(COMPOSE_DIR)/compose.yml \
                              -f $(COMPOSE_DIR)/compose.override.yml

.PHONY: help lab lab-up lab-down reset seed psql smoke logs ps wait-healthy clean

help: ## Show this help.
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-18s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

lab: lab-up wait-healthy ## Bring the lab up (Postgres + Grafana + api + SPA + lab IdP; Collector + bridge as regression fixtures), wait for healthy.
	@echo
	@echo "Lab is up:"
	@echo "  Grafana:   http://localhost:7000  (anonymous viewer; admin/admin to log in)"
	@echo "  API + SPA: http://localhost:7080  (/v1/traces is the OTLP ingest path)"
	@echo "  lab IdP:   http://localhost:7019  (identities: lab-admin / lab-user / lab-viewer — no passwords)"
	@echo
	@echo "  Note: MSAL.js needs an https:// authority, so the SPA login button doesn't"
	@echo "  work against the HTTP lab IdP. The API does — 'make smoke' or:"
	@echo "    curl -s -X POST http://localhost:7019/lab/token -d user=lab-admin@example.invalid"
	@echo
	@echo "  For Postgres:  make psql  (no host port mapping by design)"
	@echo
	@echo "  Regression fixtures (lab-only — exercise the standard OTel pipeline):"
	@echo "    Collector OTLP/HTTP:  http://localhost:7018"
	@echo "    bridge:                tails Collector JSONL → Postgres (catches OTel-pipeline regressions only)"
	@echo
	@echo "Next: 'make seed' for synthetic data, 'make smoke' for a fast auth + ingest check."

lab-up: ## docker compose up -d
	$(COMPOSE) up -d --build postgres collector bridge grafana api idp

lab-down: ## docker compose down (keeps volumes)
	$(COMPOSE) down

reset: ## docker compose down -v + lab-up + seed (full clean restart)
	$(COMPOSE) down -v
	$(MAKE) lab
	$(MAKE) seed

seed: ## Run the synthetic emitter against the local Collector.
	$(COMPOSE) run --rm seeder

psql: ## Open psql against the lab Postgres.
	$(COMPOSE) exec postgres psql -U token_tracker -d token_tracker

smoke: ## Fast end-to-end check of the running lab (auth + /v1/traces ingest; no browser/LLM). Requires `make lab`.
	@bash scripts/smoke.sh

logs: ## Tail logs (use S=<service> to scope, e.g. make logs S=bridge).
	@$(COMPOSE) logs -f $(S)

ps: ## docker compose ps
	$(COMPOSE) ps

wait-healthy: ## Wait up to 60s for postgres to be healthy and core services running.
	@echo "Waiting for postgres healthcheck and core services to start..."
	@for i in $$(seq 1 60); do \
		PG_OK=$$($(COMPOSE) ps --format json postgres 2>/dev/null | grep -o '"Health":"healthy"' || true); \
		COL_OK=$$($(COMPOSE) ps --format json collector 2>/dev/null | grep -oE '"State":"running"' || true); \
		if [ -n "$$PG_OK" ] && [ -n "$$COL_OK" ]; then \
			echo "  ready."; \
			exit 0; \
		fi; \
		printf "."; \
		sleep 1; \
	done; \
	echo " timeout."; \
	exit 1

clean: ## Stop everything and remove volumes (irreversible).
	$(COMPOSE) down -v --remove-orphans
