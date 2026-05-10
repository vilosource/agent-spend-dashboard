#!/usr/bin/env bash
#
# Container entrypoint for lab/scenario/.
#
# Wires up pi's settings.json to load the bind-mounted reporter, then
# execs `pi -p` with whatever args the harness passed. All identity /
# auth / endpoint config flows in via env vars set by scripts/scenario.
#
# The container is one-shot per scenario invocation: pi runs once,
# the reporter flushes on session_shutdown, the container exits.
set -euo pipefail

REPORTER_DIST="${REPORTER_DIST:-/opt/reporter/dist}"
SETTINGS_DIR="${HOME}/.pi/agent"
SETTINGS_FILE="${SETTINGS_DIR}/settings.json"

if [[ ! -d "${REPORTER_DIST}/extension" ]]; then
  echo "scenario-entrypoint: reporter dist missing at ${REPORTER_DIST}/extension" >&2
  echo "  bind-mount the host's pi-usage-reporter dist there (see lab/scenario/README.md)." >&2
  exit 64
fi

mkdir -p "${SETTINGS_DIR}"
cat > "${SETTINGS_FILE}" <<JSON
{
  "extensions": ["${REPORTER_DIST}/extension"]
}
JSON

# Sanity: pi reads provider keys from env. Surface a clear message if
# the operator forgot, otherwise pi prompts interactively (which hangs
# in a non-tty container). Keep this list aligned with pi's
# packages/ai/src/env-api-keys.ts.
case "${PI_PROVIDER:-zai}" in
  zai)            : "${ZAI_API_KEY:?scenario-entrypoint: ZAI_API_KEY not set}" ;;
  anthropic)      : "${ANTHROPIC_API_KEY:?scenario-entrypoint: ANTHROPIC_API_KEY not set}" ;;
  github-copilot) : "${COPILOT_GITHUB_TOKEN:?scenario-entrypoint: COPILOT_GITHUB_TOKEN not set}" ;;
esac

exec pi -p \
  --provider "${PI_PROVIDER:-zai}" \
  --model "${PI_MODEL:-glm-4.6}" \
  "$@"
