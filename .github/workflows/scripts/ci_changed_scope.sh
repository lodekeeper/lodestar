#!/usr/bin/env bash
# Reads changed file paths on stdin and prints the job groups they need as GITHUB_OUTPUT lines.
# Any path not known to be TypeScript-only enables the Zig jobs, as does an empty list.
set -euo pipefail

run_zig=false
count=0

while IFS= read -r file; do
  [ -n "$file" ] || continue
  count=$((count + 1))
  case "$file" in
    packages/* | types/* | configs/* | docs/* | dashboards/* | specrefs/*) ;;
    vitest.config.ts | tsconfig*.json | lerna.json | spec-tests-version.json) ;;
    .wordlist.txt | .pyspelling.yml | .benchrc.yaml | .codecov.yml | default.env | .env.test) ;;
    */*) run_zig=true ;;
    *.md) ;;
    *) run_zig=true ;;
  esac
done

if [ "$count" -eq 0 ]; then
  run_zig=true
fi

echo "run_zig=$run_zig"
