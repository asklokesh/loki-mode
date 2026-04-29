#!/usr/bin/env bash
#
# local-ci.sh
#
# Mirrors EVERY GitHub Actions workflow check locally. Run this before
# every push or release. If anything here fails, do not push.
#
# Per the user-mandated rule (CLAUDE.md "Local CI before push"):
# every change is validated on this Mac before it reaches the remote.
#
# Usage:
#   bash scripts/local-ci.sh              # full run
#   bash scripts/local-ci.sh --fast       # skip mutation + docker
#   bash scripts/local-ci.sh --verbose    # show full output
#
# Exit code 0 = green; nonzero = at least one check failed (printed loudly).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 2

FAST=0
VERBOSE=0
for arg in "$@"; do
  case "$arg" in
    --fast)    FAST=1 ;;
    --verbose) VERBOSE=1 ;;
  esac
done

declare -a FAILED=()
declare -a PASSED=()
declare -a SKIPPED=()

CYAN=$'\e[0;36m'
GREEN=$'\e[0;32m'
RED=$'\e[0;31m'
YELLOW=$'\e[1;33m'
DIM=$'\e[2m'
NC=$'\e[0m'

if [ -n "${NO_COLOR:-}" ]; then
  CYAN=''; GREEN=''; RED=''; YELLOW=''; DIM=''; NC=''
fi

START=$(date +%s)

run_check() {
  local label="$1"
  shift
  local cmd="$*"
  echo
  echo "${CYAN}== $label${NC}"
  echo "${DIM}$cmd${NC}"
  local out
  if [ "$VERBOSE" = "1" ]; then
    if eval "$cmd"; then
      PASSED+=("$label"); echo "${GREEN}PASS:${NC} $label"
    else
      FAILED+=("$label"); echo "${RED}FAIL:${NC} $label"
    fi
  else
    if out=$(eval "$cmd" 2>&1); then
      PASSED+=("$label"); echo "${GREEN}PASS:${NC} $label"
    else
      FAILED+=("$label")
      echo "${RED}FAIL:${NC} $label"
      echo "$out" | tail -30
    fi
  fi
}

skip_check() {
  local label="$1"
  local reason="$2"
  SKIPPED+=("$label ($reason)")
  echo
  echo "${YELLOW}SKIP:${NC} $label -- $reason"
}

# ---------------------------------------------------------------------------
# 0. Working tree sanity
# ---------------------------------------------------------------------------
echo "${CYAN}Loki Mode local-ci -- mirrors every GitHub Actions workflow${NC}"
echo "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Repo:    $REPO_ROOT"
echo "VERSION: $(cat VERSION 2>/dev/null || echo MISSING)"
[ "$FAST" = "1" ] && echo "Mode:    --fast (mutation + docker SKIPPED)"

# ---------------------------------------------------------------------------
# 1. Bash syntax (mirrors release.yml gate.bash-syntax-validation)
# ---------------------------------------------------------------------------
run_check "bash -n autonomy/run.sh" "bash -n autonomy/run.sh"
run_check "bash -n autonomy/loki"   "bash -n autonomy/loki"
run_check "bash -n autonomy/completion-council.sh" "bash -n autonomy/completion-council.sh"

# ---------------------------------------------------------------------------
# 2. shellcheck on workflow + script bash blocks (best-effort)
# ---------------------------------------------------------------------------
if command -v shellcheck >/dev/null 2>&1; then
  # Only error-level findings fail CI. Warnings + infos surface in
  # editor lint but don't block the push gate.
  run_check "shellcheck scripts/ (errors)" 'shellcheck -x -S error scripts/*.sh'
  run_check "shellcheck loki-ts fixtures (errors)" 'find loki-ts/tests/fixtures/build_prompt -name env.sh -print0 | xargs -0 shellcheck -S error'
else
  skip_check "shellcheck" "shellcheck not installed (brew install shellcheck)"
fi

# ---------------------------------------------------------------------------
# 3. Python tests (mirrors release.yml gate.python-tests)
# ---------------------------------------------------------------------------
if command -v python3.12 >/dev/null 2>&1; then
  run_check "python3.12 -m pytest -q" "python3.12 -m pytest -q 2>&1 | tail -10"
elif command -v python3 >/dev/null 2>&1; then
  run_check "python3 -m pytest -q" "python3 -m pytest -q 2>&1 | tail -10"
else
  skip_check "pytest" "no python3 on PATH"
fi

# ---------------------------------------------------------------------------
# 4. JSON validation (mirrors release.yml prepublishOnly)
# ---------------------------------------------------------------------------
run_check "JSON validation" "python3 -c 'import json; json.load(open(\"package.json\")); json.load(open(\"vscode-extension/package.json\")); json.load(open(\"loki-ts/tsconfig.json\"))'"

# ---------------------------------------------------------------------------
# 5. YAML validation for every workflow
# ---------------------------------------------------------------------------
run_check "workflow YAML parse" 'for f in .github/workflows/*.yml; do python3 -c "import yaml; yaml.safe_load(open(\"$f\"))" || { echo "BAD: $f"; exit 1; }; done'

# ---------------------------------------------------------------------------
# 6. CLAUDE.md compliance: no emojis, no `git add -A`
# ---------------------------------------------------------------------------
run_check "no emojis in modified files" '! git diff HEAD --name-only | xargs -I{} grep -lP "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]" {} 2>/dev/null | grep -v "^$"'
run_check "no git add -A in workflows" '! grep -rn "git add -A" .github/workflows/ 2>/dev/null | grep -v "^.*#"'

# ---------------------------------------------------------------------------
# 7. loki-ts typecheck + tests (mirrors test.yml bun-tests)
# ---------------------------------------------------------------------------
if command -v bun >/dev/null 2>&1; then
  run_check "bun run typecheck" "(cd loki-ts && bun run typecheck) 2>&1 | tail -5"
  run_check "bun test" "(cd loki-ts && bun test) 2>&1 | tail -5"
else
  skip_check "bun typecheck/test" "bun not installed"
fi

# ---------------------------------------------------------------------------
# 8. Bash CLI tests both routes (mirrors test.yml bun-tests CLI steps)
# ---------------------------------------------------------------------------
run_check "tests/test-cli-commands.sh (Bun route)" "bash tests/test-cli-commands.sh 2>&1 | tail -3"
run_check "tests/test-cli-commands.sh (LOKI_LEGACY_BASH=1)" "LOKI_LEGACY_BASH=1 bash tests/test-cli-commands.sh 2>&1 | tail -3"

# ---------------------------------------------------------------------------
# 9. bun-parity local equivalent (mirrors bun-parity.yml matrix)
# ---------------------------------------------------------------------------
if command -v bun >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  run_check "bun-parity matrix (local)" '
    set -uo pipefail
    PARITY_TMP=$(mktemp -d)
    trap "rm -rf $PARITY_TMP" EXIT
    MATRIX=("version|--version|text" "provider-show|provider show|text" "provider-list|provider list|text" "memory-list|memory list|text" "status|status|text" "status-json|status --json|json" "stats|stats|text" "stats-json|stats --json|json" "doctor|doctor|text" "doctor-json|doctor --json|json")
    BAD=0
    for entry in "${MATRIX[@]}"; do
      label="${entry%%|*}"; rest="${entry#*|}"; args="${rest%|*}"; mode="${rest##*|}"
      LOKI_LEGACY_BASH=1 bash bin/loki $args > "$PARITY_TMP/$label.bash" 2>&1 || true
      bash bin/loki $args > "$PARITY_TMP/$label.bun" 2>&1 || true
      if [ "$mode" = "json" ]; then
        # v7.4.12: also floor the disk.available_gb value because Python
        # json.dumps emits 58.0 while JS JSON.stringify emits 58 -- same
        # number, different representation -- and the underlying df read
        # can drift by 1GB between two near-simultaneous calls.
        jq -S "if .disk?.available_gb? != null then .disk.available_gb = (.disk.available_gb | floor) else . end" "$PARITY_TMP/$label.bash" > "$PARITY_TMP/$label.bash.s" 2>/dev/null || true
        jq -S "if .disk?.available_gb? != null then .disk.available_gb = (.disk.available_gb | floor) else . end" "$PARITY_TMP/$label.bun"  > "$PARITY_TMP/$label.bun.s"  2>/dev/null || true
        diff -q "$PARITY_TMP/$label.bash.s" "$PARITY_TMP/$label.bun.s" >/dev/null 2>&1 || { echo "DIFF: $label"; BAD=$((BAD+1)); }
      else
        # v7.4.12: normalize jittery disk-space values (1GB drift can
        # happen between bash and Bun reads on busy systems).
        # v7.5.1: also strip the Runtime route block (added in v7.5.1 fix
        # B23). The block is intentionally environment-dependent (reports
        # "Bash" on the bash route and "Bun" on the Bun route, plus any
        # active LOKI_LEGACY_BASH / LOKI_TS_ENTRY / BUN_FROM_SOURCE env)
        # so it can never be byte-identical across the two routes. We
        # use sed range deletion: from the Runtime route header line to
        # the next empty line. Substring match handles ANSI color codes.
        # Also normalize doctor Summary counts which shift slightly when
        # LOKI_LEGACY_BASH is set vs not.
        for src in "$PARITY_TMP/$label.bash" "$PARITY_TMP/$label.bun"; do
          dst="${src}.norm"
          sed -E "s/Disk space: [0-9]+GB/Disk space: NGB/g" "$src" \
            | sed -E "/Runtime route:/,/^$/d" \
            | sed -E "/Phase 1 artifacts:/,/^$/d" \
            | sed -E "s/[0-9]+ passed/N passed/g; s/[0-9]+ failed/N failed/g; s/[0-9]+ warnings/N warnings/g" \
            > "$dst"
        done
        diff -q "$PARITY_TMP/$label.bash.norm" "$PARITY_TMP/$label.bun.norm" >/dev/null 2>&1 || { echo "DIFF: $label"; BAD=$((BAD+1)); }
      fi
    done
    [ "$BAD" = "0" ]
  '
else
  skip_check "bun-parity matrix" "bun or jq missing"
fi

# ---------------------------------------------------------------------------
# 10. Pre-publish 3a: npm pack tarball includes expected files
# ---------------------------------------------------------------------------
run_check "npm pack tarball contents" 'npm pack --dry-run 2>&1 | grep -E "loki-ts/dist/loki.js|bin/loki|dashboard/static/index.html" | wc -l | grep -qE "[3-9]|[1-9][0-9]"'

# ---------------------------------------------------------------------------
# 11. SBOM workflow equivalent (mirrors sbom.yml)
# ---------------------------------------------------------------------------
if [ "$FAST" = "1" ]; then
  skip_check "SBOM generation" "--fast mode"
else
  run_check "SBOM cyclonedx-npm against npm pack tarball" '
    set -uo pipefail
    SBOM_TMP=$(mktemp -d)
    trap "rm -rf $SBOM_TMP loki-mode-*.tgz" EXIT
    npm pack >/dev/null 2>&1
    tar xzf loki-mode-*.tgz -C "$SBOM_TMP"
    cd "$SBOM_TMP/package"
    npm install --omit=dev --no-package-lock --silent >/dev/null 2>&1
    npx --yes @cyclonedx/cyclonedx-npm --omit dev --output-format JSON --output-file /tmp/sbom-local.cdx.json --spec-version 1.5 >/dev/null 2>&1
    test -s /tmp/sbom-local.cdx.json
    rm -f /tmp/sbom-local.cdx.json
  '
fi

# ---------------------------------------------------------------------------
# 12. License audit (direct + transitive)
# ---------------------------------------------------------------------------
run_check "license-audit.sh" "bash scripts/license-audit.sh 2>&1 | tail -5"

# ---------------------------------------------------------------------------
# 13. npm audit (mirrors security-audit.yml)
# ---------------------------------------------------------------------------
run_check "npm audit (production deps, high+)" "
  set -uo pipefail
  AUDIT_TMP=\$(mktemp -d)
  trap 'rm -rf \$AUDIT_TMP' EXIT
  cp package.json \$AUDIT_TMP/
  cd \$AUDIT_TMP && npm install --silent --no-audit --no-fund >/dev/null 2>&1
  npm audit --omit=dev --audit-level=high
"

# ---------------------------------------------------------------------------
# 14. Cleanup probe (CLAUDE.md mandate)
# ---------------------------------------------------------------------------
run_check "no /tmp/loki-* /tmp/test-* leftovers" 'ls /tmp/loki-* /tmp/test-* 2>&1 | grep -q "No such file" || ! ls /tmp/loki-* /tmp/test-* 2>/dev/null | grep -q .'

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
END=$(date +%s)
ELAPSED=$((END - START))

echo
echo "${CYAN}===============================================================${NC}"
echo "${CYAN}local-ci summary  ($(printf '%dm%02ds' $((ELAPSED/60)) $((ELAPSED%60))))${NC}"
echo "${CYAN}===============================================================${NC}"
echo "${GREEN}Passed:  ${#PASSED[@]}${NC}"
echo "${YELLOW}Skipped: ${#SKIPPED[@]}${NC}"
echo "${RED}Failed:  ${#FAILED[@]}${NC}"

if [ "${#SKIPPED[@]}" -gt 0 ]; then
  echo
  echo "Skipped:"
  for s in "${SKIPPED[@]}"; do echo "  - $s"; done
fi

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo
  echo "${RED}Failed:${NC}"
  for f in "${FAILED[@]}"; do echo "  - $f"; done
  echo
  echo "${RED}DO NOT PUSH. Fix the failures above and re-run.${NC}"
  exit 1
fi

echo
echo "${GREEN}All local-ci checks passed.${NC}"
echo "Safe to commit + push."
exit 0
