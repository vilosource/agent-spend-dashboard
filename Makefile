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

.PHONY: help lab lab-up lab-down reset seed psql logs ps wait-healthy clean

help: ## Show this help.
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-18s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

lab: lab-up wait-healthy ## Bring the lab up (Postgres + Collector + bridge + Grafana + api + Dex), wait for healthy.
	@echo
	@echo "Lab is up:"
	@echo "  Grafana:   http://localhost:7000  (anonymous viewer; admin/admin to log in)"
	@echo "  API:       http://localhost:7080  (login at /auth/login → Dex)"
	@echo
	@echo "  For Postgres:  make psql  (no host port mapping by design)"
	@echo "  Collector OTLP/HTTP (transitional, retires at 0.3.8):  http://localhost:7018"
	@echo "  Dex (lab IdP, transitional):  http://idp.localhost:7019"
	@echo
	@echo "  Lab users:   lab-admin@example.invalid / lab"
	@echo "               lab-user@example.invalid  / lab"
	@echo
	@echo "Run 'make seed' to populate with synthetic data."

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
	$(COMPOSE) exec postgres psql -U agent_spend -d agent_spend

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
