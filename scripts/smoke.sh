#!/usr/bin/env bash
#
# scripts/smoke.sh — fast end-to-end check of the lab (no browser, no LLM key).
#
# Requires the lab to be up (`make lab`). Verifies the things the auth rewrite
# touched, all over HTTP + one psql query:
#   - the API boots against the new TOKEN_TRACKER_OIDC_* config (/health)
#   - it reaches the lab IdP, fetches its JWKs, and verifies access tokens
#   - role mapping: a TokenTracker.Admin token -> role "admin"; .User -> "user"
#   - the unauthenticated / bad-token paths -> 401 with the right error
#   - POST /v1/traces ingests an OTLP span, and the row's user_id comes from
#     the verified token (the span's agent.user.id is ignored — D8)
#
# Run:  make smoke   (or: bash scripts/smoke.sh)
#
# Env knobs: LAB_API (default http://localhost:7080), LAB_IDP
#            (default http://localhost:7019), PG_CONTAINER
#            (default token-tracker-postgres-1).
set -uo pipefail

LAB_API="${LAB_API:-http://localhost:7080}"
LAB_IDP="${LAB_IDP:-http://localhost:7019}"
PG_CONTAINER="${PG_CONTAINER:-token-tracker-postgres-1}"

PASS=0 FAIL=0
ok()   { printf '  \033[32mok  \033[0m %s\n' "$*"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL + 1)); }
_json_field() { python3 -c 'import sys,json; print(json.load(sys.stdin).get(sys.argv[1],""))' "$1" 2>/dev/null; }
_status() { curl -sS -o /dev/null -w '%{http_code}' "$@" 2>/dev/null || echo "000"; }
_pg() { docker exec -i "$PG_CONTAINER" psql -U token_tracker -d token_tracker -At -c "$1" 2>/dev/null; }

echo "== lab smoke — API $LAB_API, IdP $LAB_IDP =="

# --- get tokens from the lab IdP's /lab/token shortcut ---
ADMIN="$(curl -sS -X POST "$LAB_IDP/lab/token" -d 'user=lab-admin@example.invalid' 2>/dev/null | _json_field access_token)"
USER="$(curl -sS -X POST "$LAB_IDP/lab/token" -d 'user=lab-user@example.invalid' 2>/dev/null | _json_field access_token)"
if [[ -z "$ADMIN" || -z "$USER" ]]; then
	echo "  could not get tokens from the lab IdP at $LAB_IDP — is the lab up? (make lab)" >&2
	exit 1
fi
ok "lab IdP issued admin + user access tokens"

# 1. /health
if curl -sf "$LAB_API/health" 2>/dev/null | grep -q '"status":"ok"'; then ok "/health -> {status:ok}"; else bad "/health (is the api container up + healthy?)"; fi

# 2. /api/me with the admin token -> role admin
ME_ADMIN="$(curl -sS "$LAB_API/api/me" -H "Authorization: Bearer $ADMIN" 2>/dev/null)"
if grep -q '"role":"admin"' <<<"$ME_ADMIN" && grep -q 'lab-admin@example.invalid' <<<"$ME_ADMIN"; then
	ok "/api/me (admin token) -> role=admin, email=lab-admin@example.invalid"
else bad "/api/me (admin token): $ME_ADMIN"; fi

# 3. /api/me with the user token -> role user
ME_USER="$(curl -sS "$LAB_API/api/me" -H "Authorization: Bearer $USER" 2>/dev/null)"
if grep -q '"role":"user"' <<<"$ME_USER" && grep -q 'lab-user@example.invalid' <<<"$ME_USER"; then
	ok "/api/me (user token) -> role=user, email=lab-user@example.invalid"
else bad "/api/me (user token): $ME_USER"; fi

# 4. no token -> 401 "no token"
if [[ "$(_status "$LAB_API/api/me")" == "401" ]] && curl -sS "$LAB_API/api/me" 2>/dev/null | grep -q '"no token"'; then
	ok "/api/me (no token) -> 401 {error:\"no token\"}"
else bad "/api/me (no token) didn't 401 with {error:\"no token\"}"; fi

# 5. garbage token -> 401 "invalid token"
if [[ "$(_status "$LAB_API/api/me" -H 'Authorization: Bearer not.a.jwt')" == "401" ]] \
	&& curl -sS "$LAB_API/api/me" -H 'Authorization: Bearer not.a.jwt' 2>/dev/null | grep -q '"invalid token"'; then
	ok "/api/me (garbage token) -> 401 {error:\"invalid token\"}"
else bad "/api/me (garbage token) didn't 401 with {error:\"invalid token\"}"; fi

# 6. POST /v1/traces with the user token — and the span lies about its user_id
OTLP='{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"smoke"}}]},"scopeSpans":[{"scope":{"name":"smoke"},"spans":[{"startTimeUnixNano":"1700000000000000000","attributes":[
{"key":"agent.harness.name","value":{"stringValue":"smoke"}},
{"key":"gen_ai.request.model","value":{"stringValue":"glm-4.6"}},
{"key":"gen_ai.response.model","value":{"stringValue":"glm-4.6"}},
{"key":"gen_ai.provider.name","value":{"stringValue":"z.ai"}},
{"key":"agent.api.dialect","value":{"stringValue":"anthropic-messages"}},
{"key":"agent.machine.id","value":{"stringValue":"11111111-1111-1111-1111-111111111111"}},
{"key":"agent.session.id","value":{"stringValue":"22222222-2222-2222-2222-222222222222"}},
{"key":"gen_ai.usage.input_tokens","value":{"intValue":1}},
{"key":"gen_ai.usage.output_tokens","value":{"intValue":1}},
{"key":"agent.cost.input.usd","value":{"doubleValue":0}},
{"key":"agent.cost.output.usd","value":{"doubleValue":0}},
{"key":"agent.cost.total.usd","value":{"doubleValue":0}},
{"key":"agent.user.id","value":{"stringValue":"forged@example.invalid"}}
]}]}]}]}'
TRACES="$(curl -sS -X POST "$LAB_API/v1/traces" -H "Authorization: Bearer $USER" -H 'content-type: application/json' --data "$OTLP" 2>/dev/null)"
if grep -q 'partialSuccess' <<<"$TRACES"; then ok "POST /v1/traces (user token) -> partialSuccess"; else bad "POST /v1/traces: $TRACES"; fi

# 7. the row landed with user_id from the token, not from agent.user.id
if command -v docker >/dev/null 2>&1; then
	ROW_USER="$(_pg "SELECT user_id FROM usage_log WHERE harness_name = 'smoke' ORDER BY id DESC LIMIT 1")"
	if [[ "$ROW_USER" == "lab-user@example.invalid" ]]; then
		ok "usage_log: latest smoke row user_id=lab-user@example.invalid (agent.user.id=forged@… ignored — D8)"
	else bad "usage_log latest smoke row user_id is '$ROW_USER' (expected lab-user@example.invalid)"; fi
else
	echo "  (skipped the usage_log check — docker not on PATH; run \`make psql\` and look for harness_name='smoke')"
fi

echo
echo "== $PASS passed, $FAIL failed =="
[[ "$FAIL" -eq 0 ]]
