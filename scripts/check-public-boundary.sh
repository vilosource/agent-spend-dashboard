#!/usr/bin/env bash
# check-public-boundary.sh
#
# Enforces the public/private boundary defined in
# docs/strategy/public-boundary-STRATEGY.md
#
# Searches the repository for forbidden patterns. Exits 0 if clean,
# 1 if any forbidden pattern is found. Files listed in .boundary-allowlist
# are exempt; each exemption must include a one-line comment explaining why.
#
# Run locally:           bash scripts/check-public-boundary.sh
# Run in CI:             same; invoked from .github/workflows/boundary.yml
# Run with verbose:      VERBOSE=1 bash scripts/check-public-boundary.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

VERBOSE="${VERBOSE:-0}"
RED=$'\033[0;31m'
YELLOW=$'\033[0;33m'
GREEN=$'\033[0;32m'
RESET=$'\033[0m'

# ----- Pattern denylist ---------------------------------------------------
#
# Each entry: <category>|<perl-compatible regex>|<message>
# Patterns are matched case-insensitively unless they contain uppercase.
# We use ripgrep if available (faster) and fall back to grep -P / grep -E.
#
# When adding a pattern, also document it in
# docs/strategy/public-boundary-STRATEGY.md §6.

PATTERNS=(
  # Organization names other than the maintainer (vilosource).
  # Note: 'viloforge' on its own is allowed (it is the company persona /
  # git committer); only viloforge.com (the FQDN) is forbidden.
  'org-name|optiscan|Specific organization name (any variant: optiscan, optiscan-group, optiscangroup, etc.). Optiscan-specific values belong in a private deployment repo.'

  # FQDNs and internal-DNS suffixes
  'fqdn|viloforge\.com|Real Vilosource FQDN. Use <organization-collector-host> or *.example.com placeholders instead.'
  'fqdn-internal|\.internal\.[a-z0-9-]+\.[a-z]{2,}|Internal FQDN. Use placeholders.'
  'dns-suffix|\b[a-z0-9-]+\.(internal|corp|lan|intranet)\b|Internal-DNS suffix. Use placeholders.'

  # Cloud account / project IDs (rough, will catch UUIDs and AWS account IDs)
  'aws-account|\b[0-9]{12}\b(?=.*aws|.*amazon)|Looks like an AWS account ID. Use a placeholder.'
  'azure-sub|/subscriptions/[0-9a-f-]{36}/|Looks like an Azure subscription path. Use a placeholder.'

  # Tokens / keys
  'aws-key|AKIA[0-9A-Z]{16}|Looks like an AWS access key.'
  'github-token|gh[pousr]_[A-Za-z0-9]{36}|Looks like a GitHub token.'
  'openai-key|sk-[A-Za-z0-9]{32,}|Looks like an OpenAI / Anthropic-style API key.'
  'jwt|eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}|Looks like a JWT. Use <token> or eyJ...placeholder...XXX.'
  'pem|-----BEGIN [A-Z ]+PRIVATE KEY-----|PEM private key.'
  'azure-storage-key|AccountKey=[A-Za-z0-9+/]{40,}|Azure storage account key.'
  'pg-creds|postgres(ql)?://[^:/@\s<>\${}]+:[^@/\s<>\${}]+@|Postgres URL with embedded credentials. Use ${DATABASE_URL} or <user>:<pass> placeholders.'

  # Vault paths
  'vault-path|secret/data/(?!example|<)[a-z0-9_-]+|Looks like a real Vault path.'
)

# ----- Allowlist ---------------------------------------------------------

ALLOWLIST_FILE=".boundary-allowlist"
declare -a ALLOWLIST=()
if [[ -f "$ALLOWLIST_FILE" ]]; then
  while IFS= read -r line; do
    # Strip comments and whitespace
    line="${line%%#*}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" ]] && continue
    ALLOWLIST+=("$line")
  done < "$ALLOWLIST_FILE"
fi

is_allowlisted() {
  local file="$1"
  for entry in "${ALLOWLIST+"${ALLOWLIST[@]}"}"; do
    # Exact match or glob
    if [[ "$file" == "$entry" ]] || [[ "$file" == $entry ]]; then
      return 0
    fi
  done
  return 1
}

# ----- Tool selection ----------------------------------------------------

if command -v rg >/dev/null 2>&1; then
  GREP_CMD=(rg --no-heading --line-number --color never --hidden -i \
    --glob '!.git' \
    --glob '!node_modules' \
    --glob '!dist' \
    --glob '!build' \
    --glob '!coverage' \
    --glob '!.boundary-allowlist' \
    --glob '!scripts/check-public-boundary.sh' \
    --glob '!docs/strategy/public-boundary-STRATEGY.md')
else
  # Fallback: grep -rPnEi
  GREP_CMD=(grep -rPnEi \
    --binary-files=without-match \
    --exclude-dir=.git \
    --exclude-dir=node_modules \
    --exclude-dir=dist \
    --exclude-dir=build \
    --exclude-dir=coverage \
    --exclude=.boundary-allowlist \
    --exclude=check-public-boundary.sh \
    --exclude=public-boundary-STRATEGY.md)
fi

# ----- Run ---------------------------------------------------------------

violations=0
checked=0

for entry in "${PATTERNS[@]}"; do
  IFS='|' read -r category regex message <<< "$entry"
  [[ "$VERBOSE" == "1" ]] && printf "%s[checking]%s %s\n" "$YELLOW" "$RESET" "$category"

  matches=$("${GREP_CMD[@]}" "$regex" . 2>/dev/null || true)
  [[ -z "$matches" ]] && continue

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    file="${line%%:*}"
    file="${file#./}"
    if is_allowlisted "$file"; then
      [[ "$VERBOSE" == "1" ]] && printf "  %s[allowlisted]%s %s\n" "$GREEN" "$RESET" "$file"
      continue
    fi
    if (( violations == 0 )); then
      printf "%sBoundary check FAILED:%s\n\n" "$RED" "$RESET" >&2
    fi
    violations=$((violations + 1))
    printf "  %s[%s]%s %s\n" "$RED" "$category" "$RESET" "$line" >&2
    printf "    %s\n\n" "$message" >&2
  done <<< "$matches"
  checked=$((checked + 1))
done

if (( violations > 0 )); then
  printf "%s%d boundary violation(s) found across %d pattern categories.%s\n" \
    "$RED" "$violations" "$checked" "$RESET" >&2
  printf "See docs/strategy/public-boundary-STRATEGY.md for the rules.\n" >&2
  printf "If a match is intentional, add the file path to .boundary-allowlist with a one-line comment.\n" >&2
  exit 1
fi

printf "%sBoundary check passed.%s All %d pattern categories clean.\n" \
  "$GREEN" "$RESET" "${#PATTERNS[@]}"
exit 0
