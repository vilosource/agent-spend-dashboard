#!/usr/bin/env bash
# check-tests-with-source.sh
#
# Soft floor: if a PR adds or modifies packages/*/src/**/*.ts files,
# we expect a corresponding *.test.ts change in the same PR.
#
# Exits 0 (clean) or 1 (warning condition met).
# In CI we treat the exit code as a hard fail; locally use as a check.
#
# Skips:
#  - Pure deletions
#  - Files that are themselves tests
#  - index.ts files that are pure re-exports (heuristic: all lines start
#    with `export` or are blank/comment)
#  - .d.ts files
#  - .generated.ts files
#  - Anything under packages/_template (template doesn't ship)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

BASE_REF="${1:-${BASE_REF:-origin/main}}"

if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
   echo "test-coverage check: $BASE_REF not found, skipping"
   exit 0
fi

CHANGED=$(git diff --name-status "$BASE_REF"...HEAD -- 'packages/*/src/**/*.ts' || true)
if [[ -z "$CHANGED" ]]; then
   echo "test-coverage check: no source changes, clean"
   exit 0
fi

violations=0

while IFS=$'\t' read -r status file; do
   [[ -z "$status" ]] && continue
   # Skip deletions
   [[ "$status" == "D" ]] && continue
   # Skip non-source
   [[ "$file" == *.test.ts ]] && continue
   [[ "$file" == *.d.ts ]] && continue
   [[ "$file" == *.generated.ts ]] && continue
   [[ "$file" == packages/_template/* ]] && continue

   # Skip pure re-export index.ts files
   if [[ "$(basename "$file")" == "index.ts" ]]; then
      non_export=$(grep -cvE '^(export |//|/\*|\*|$)' "$file" 2>/dev/null || echo 0)
      [[ "$non_export" -eq 0 ]] && continue
   fi

   # Determine the expected test file
   dir=$(dirname "$file")
   stem=$(basename "$file" .ts)
   expected_test="$dir/${stem}.test.ts"

   # Did the PR touch the expected test file?
   if echo "$CHANGED" | awk -F'\t' '{print $2}' | grep -qx "$expected_test"; then
      continue
   fi
   # Or any test file in the same directory?
   sibling_tests=$(echo "$CHANGED" | awk -F'\t' '{print $2}' | grep "^${dir}/.*\\.test\\.ts$" || true)
   if [[ -n "$sibling_tests" ]]; then
      continue
   fi

   echo "test-coverage check: source change has no corresponding test change"
   echo "  changed: $file"
   echo "  expected: $expected_test (or any *.test.ts in $dir/)"
   violations=$((violations + 1))
done <<< "$CHANGED"

if (( violations > 0 )); then
   echo
   echo "$violations source file(s) changed without a matching test change."
   echo "Add a sibling .test.ts that exercises the change, or document"
   echo "in the PR description why no test is needed."
   exit 1
fi

echo "test-coverage check: passed"
exit 0
