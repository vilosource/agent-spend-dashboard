# scripts/lib/scenario-helpers.sh — sourced by scripts/scenario into
# the scenario subshell. Provides the verbs scenarios call inside their
# prepare / stimulate / observe phases.
#
# Conventions:
#   - Every helper writes a one-line trace to $SCENARIO_RUN_DIR/log.
#   - Assertions update SCENARIO_PASS_COUNT / SCENARIO_FAIL_COUNT and
#     return non-zero on miss; the harness reads these in its verdict.
#   - Helpers shell out to the lab's existing infra (Postgres container,
#     scenario image) instead of reimplementing it. If a helper drifts
#     from the lab's truth, fix the lab — never paper over it here.

SCENARIO_PASS_COUNT=0
SCENARIO_FAIL_COUNT=0
SCENARIO_USER_EMAIL=""
SCENARIO_TOKEN=""

_log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$SCENARIO_RUN_DIR/log"; }

# ── token / user setup (called in prepare) ──────────────────────────────

# scenario_use_user <email> [label]
#
# Forge a session JWT for the user and mint a fresh per-machine bearer
# via /api/me/tokens. Stashes the bearer in $SCENARIO_TOKEN and the
# email in $SCENARIO_USER_EMAIL so scenarios don't re-state them.
scenario_use_user() {
  local email="${1:?scenario_use_user: missing email}"
  local label="${2:-${SCENARIO_NAME}-${SCENARIO_RUN_ID##*-}}"
  SCENARIO_USER_EMAIL="$email"
  SCENARIO_TOKEN="$(scripts/scenario mint "$email" "$label")"
  [[ -n "$SCENARIO_TOKEN" ]] || { _log "FAIL: token mint returned empty"; SCENARIO_FAIL_COUNT=$((SCENARIO_FAIL_COUNT+1)); return 1; }
  _log "minted bearer for $email (label=$label, jwt=${#SCENARIO_TOKEN}b)"
}

# scenario_pre_count
#
# Snapshot how many rows already exist for $SCENARIO_USER_EMAIL.
# observe() helpers compare against this to count just-landed rows.
scenario_pre_count() {
  SCENARIO_PRE_ROW_COUNT="$(_pg_count_rows "$SCENARIO_USER_EMAIL")"
  _log "pre-count for $SCENARIO_USER_EMAIL: $SCENARIO_PRE_ROW_COUNT"
}

# ── stimulus (called in stimulate) ──────────────────────────────────────

# scenario_run_pi <prompt> [-- <extra-pi-args>...]
#
# Runs one `pi -p` invocation inside the scenario container, joined to
# the lab compose network so PI_USAGE_ENDPOINT=http://api:8080 reaches
# the live API. Captures stdout/stderr to $SCENARIO_RUN_DIR/pi-stdout
# and pi-stderr.
scenario_run_pi() {
  local prompt="${1:?scenario_run_pi: missing prompt}"
  shift || true
  [[ -n "$SCENARIO_TOKEN" ]] || { _log "FAIL: no token — call scenario_use_user first"; SCENARIO_FAIL_COUNT=$((SCENARIO_FAIL_COUNT+1)); return 1; }

  _log "pi -p (provider=${PI_PROVIDER:-zai}, model=${PI_MODEL:-glm-4.6}): ${prompt:0:80}"

  docker run --rm \
    --network "$LAB_NETWORK" \
    -v "$REPORTER_DIST:/opt/reporter/dist:ro" \
    -e "ZAI_API_KEY=$ZAI_API_KEY" \
    -e "PI_USAGE_ENDPOINT=http://api:8080" \
    -e "PI_USAGE_TOKEN=$SCENARIO_TOKEN" \
    -e "PI_USAGE_VERBOSE=1" \
    -e "PI_PROVIDER=${PI_PROVIDER:-zai}" \
    -e "PI_MODEL=${PI_MODEL:-glm-4.6}" \
    "$SCENARIO_IMAGE" "$prompt" "$@" \
    > "$SCENARIO_RUN_DIR/pi-stdout" \
    2> "$SCENARIO_RUN_DIR/pi-stderr"
  local rc=$?
  if (( rc != 0 )); then
    _log "FAIL: pi exited non-zero ($rc); see pi-stderr"
    SCENARIO_FAIL_COUNT=$((SCENARIO_FAIL_COUNT+1))
    return 1
  fi
  _log "pi exit=0; reporter flushed (session_shutdown)"
}

# ── observation (called in observe) ─────────────────────────────────────

# Wait up to 10 seconds for at least <n> new rows to arrive for the
# scenario user. The reporter flushes on session_shutdown but Postgres
# COMMIT and the API insert are still asynchronous w.r.t. the docker
# run returning, so a small poll loop is robust.
_wait_for_rows() {
  local want="$1"
  local pre="${SCENARIO_PRE_ROW_COUNT:-0}"
  local need=$((pre + want))
  local cur
  for _ in $(seq 1 20); do
    cur="$(_pg_count_rows "$SCENARIO_USER_EMAIL")"
    if (( cur >= need )); then
      printf '%s' "$cur"
      return 0
    fi
    sleep 0.5
  done
  printf '%s' "$cur"
  return 1
}

# assert_new_rows <min>
#
# Pass if the scenario user has at least <min> NEW rows since
# scenario_pre_count was taken.
assert_new_rows() {
  local want="${1:?assert_new_rows: missing min}"
  local cur
  if cur="$(_wait_for_rows "$want")"; then
    local delta=$((cur - SCENARIO_PRE_ROW_COUNT))
    _log "PASS: $delta new rows for $SCENARIO_USER_EMAIL (>= $want expected)"
    SCENARIO_PASS_COUNT=$((SCENARIO_PASS_COUNT+1))
    return 0
  fi
  local delta=$((cur - SCENARIO_PRE_ROW_COUNT))
  _log "FAIL: expected >= $want new rows, got $delta (cur=$cur, pre=$SCENARIO_PRE_ROW_COUNT)"
  SCENARIO_FAIL_COUNT=$((SCENARIO_FAIL_COUNT+1))
  return 1
}

# assert_latest_row_field <field> <expected>
#
# Read the field value from the newest row for the scenario user and
# compare to <expected> (exact string match). Useful for verifying
# provider, model, harness_name, etc.
assert_latest_row_field() {
  local field="${1:?assert_latest_row_field: missing field}"
  local expected="${2:?assert_latest_row_field: missing expected}"
  local got
  got="$(_pg_query "SELECT $field FROM agent_spend_logs
                     WHERE user_id = '${SCENARIO_USER_EMAIL//\'/\'\'}'
                  ORDER BY ts DESC LIMIT 1" | tr -d ' \n')"
  if [[ "$got" == "$expected" ]]; then
    _log "PASS: latest.$field = '$got'"
    SCENARIO_PASS_COUNT=$((SCENARIO_PASS_COUNT+1))
    return 0
  fi
  _log "FAIL: latest.$field expected '$expected' got '$got'"
  SCENARIO_FAIL_COUNT=$((SCENARIO_FAIL_COUNT+1))
  return 1
}

# assert_latest_row_field_nonempty <field>
#
# For numeric / opaque fields where we just want to know "the reporter
# populated it" (e.g., session_id, harness_version, input_tokens > 0).
assert_latest_row_field_nonempty() {
  local field="${1:?assert_latest_row_field_nonempty: missing field}"
  local got
  got="$(_pg_query "SELECT $field::text FROM agent_spend_logs
                     WHERE user_id = '${SCENARIO_USER_EMAIL//\'/\'\'}'
                  ORDER BY ts DESC LIMIT 1" | tr -d ' \n')"
  if [[ -n "$got" && "$got" != "0" && "$got" != "" ]]; then
    _log "PASS: latest.$field is populated ('$got')"
    SCENARIO_PASS_COUNT=$((SCENARIO_PASS_COUNT+1))
    return 0
  fi
  _log "FAIL: latest.$field empty/zero (got '$got')"
  SCENARIO_FAIL_COUNT=$((SCENARIO_FAIL_COUNT+1))
  return 1
}

# ── primitives ──────────────────────────────────────────────────────────

_pg_count_rows() {
  local email="$1"
  _pg_query "SELECT COUNT(*) FROM agent_spend_logs
              WHERE user_id = '${email//\'/\'\'}'" | tr -d ' \n'
}

_pg_query() {
  local sql="$1"
  docker exec -i "$PG_CONTAINER" \
    psql -U agent_spend -d agent_spend -At -c "$sql" 2>/dev/null
}
