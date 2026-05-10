# lab/scenario/scenarios/01-pi-zai-real-turn.sh
#
# The "real data" smoke. Drives a real `pi -p` turn against z.ai's GLM
# inside the scenario container, with pi-usage-reporter loaded as a pi
# extension pointing at the lab API. Asserts that a row lands in
# agent_spend_logs scoped to the scenario user.
#
# What this proves end-to-end:
#   - Token mgmt API (0.3.10) issues a usable bearer.
#   - Reporter runs, emits an OTLP span on session_shutdown.
#   - API's /v1/traces (0.3.7) accepts the span.
#   - identity comes from the JWT, not from agent.user.id (D8/D13).
#   - Span attributes carry real provider/model/token counts from z.ai.
#
# Cost: one z.ai turn (typically << $0.01 on glm-4.6).
#
# Pre-req: lab-admin@example.invalid has logged into the SPA at least
#   once so the row exists in users (lab bootstrap rule). If not, run
#   `make lab` then visit http://localhost:7080 and log in.

intent "real pi+zai turn lands a real row in agent_spend_logs"

prepare() {
  scenario_use_user "lab-admin@example.invalid"
  scenario_pre_count
}

stimulate() {
  scenario_run_pi "Reply with exactly the word 'ready' (no other text)."
}

observe() {
  assert_new_rows 1
  assert_latest_row_field          "provider"     "zai"
  assert_latest_row_field          "model"        "glm-4.6"
  assert_latest_row_field          "harness_name" "pi"
  assert_latest_row_field_nonempty "session_id"
  assert_latest_row_field_nonempty "input_tokens"
  assert_latest_row_field_nonempty "output_tokens"
}
