#!/usr/bin/env bash

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPROOT="$(mktemp -d -t loki-dependency-setup.XXXXXX)"
PASS=0
FAIL=0
cleanup() { rm -rf "$TMPROOT" 2>/dev/null || true; }
trap cleanup EXIT
ok() { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1"; }
assert_success() { local label="$1"; shift; if "$@"; then ok "$label"; else bad "$label"; fi; }
assert_failure() { local label="$1"; shift; if "$@"; then bad "$label"; else ok "$label"; fi; }

log_info() { :; }
log_warn() { :; }
_loki_with_deadline() { shift; "$@"; }
source "$ROOT/autonomy/lib/dependency-setup.sh"

FAKE_BIN="$TMPROOT/bin"
mkdir -p "$FAKE_BIN"
apply_fake_npm() {
    local exit_code="$1"
    printf '%s\n' '#!/usr/bin/env bash' \
        'printf "%s\\n" "$*" >> "$FAKE_NPM_CALLS"' \
        'rm -rf node_modules' \
        'mkdir -p node_modules' \
        'printf '\''{"lockfileVersion":3,"packages":{"node_modules/fake-dependency":{"version":"1.0.0"}}}\n'\'' > node_modules/.package-lock.json' \
        "if [ $exit_code -eq 0 ]; then mkdir -p node_modules/fake-dependency; fi" \
        "exit $exit_code" > "$FAKE_BIN/npm"
    chmod +x "$FAKE_BIN/npm"
}

export PATH="$FAKE_BIN:$PATH"
export FAKE_NPM_CALLS="$TMPROOT/npm-calls"

PROJECT="$TMPROOT/project"
mkdir -p "$PROJECT"
printf '%s\n' '{"name":"fixture","scripts":{"build":"true"}}' > "$PROJECT/package.json"
printf '%s\n' '{"name":"fixture","lockfileVersion":3,"packages":{}}' > "$PROJECT/package-lock.json"

apply_fake_npm 0
TARGET_DIR="$PROJECT" assert_success "cold reproducible install succeeds" loki_prepare_project_dependencies
if grep -qx 'ci --ignore-scripts --no-audit --no-fund' "$FAKE_NPM_CALLS"; then
    ok "npm lifecycle scripts are disabled"
else
    bad "npm invocation did not use the safe reproducible argv"
fi
python3 - "$PROJECT/.loki/quality/dependency-setup.json" <<'PYEOF'
import json
import sys
record = json.load(open(sys.argv[1], encoding="utf-8"))
assert record["status"] == "verified"
assert record["exit_code"] == 0
assert record["input_sha256"]
assert record["lifecycle_scripts"] == "disabled"
PYEOF
if [ "$?" -eq 0 ]; then ok "verified setup evidence is structured"; else bad "setup evidence is invalid"; fi

: > "$FAKE_NPM_CALLS"
TARGET_DIR="$PROJECT" assert_success "unchanged lockfile reuses installation" loki_prepare_project_dependencies
if [ ! -s "$FAKE_NPM_CALLS" ]; then ok "reuse does not reinstall"; else bad "reuse unexpectedly reinstalled"; fi

cp "$PROJECT/package-lock.json" "$TMPROOT/original-package-lock.json"
printf '%s\n' '{"name":"fixture","lockfileVersion":3,"packages":{},"dependencies":{"new-dependency":"1.0.0"}}' > "$PROJECT/package-lock.json"
apply_fake_npm 42
TARGET_DIR="$PROJECT" assert_failure "failed changed lock install blocks verification" loki_prepare_project_dependencies
if [ ! -e "$PROJECT/.loki/state/dependency-input.sha256" ]; then
    ok "failed install leaves no reusable marker"
else
    bad "failed install retained a stale marker"
fi

cp "$TMPROOT/original-package-lock.json" "$PROJECT/package-lock.json"
: > "$FAKE_NPM_CALLS"
apply_fake_npm 0
TARGET_DIR="$PROJECT" assert_success "restored old lock forces a correct reinstall" loki_prepare_project_dependencies
if [ "$(wc -l < "$FAKE_NPM_CALLS" | tr -d ' ')" = "1" ] \
    && [ -d "$PROJECT/node_modules/fake-dependency" ]; then
    ok "restored lock does not false-reuse the partial installation"
else
    bad "restored lock did not repair the partial installation"
fi

rm -rf "$PROJECT/node_modules/fake-dependency"
: > "$FAKE_NPM_CALLS"
TARGET_DIR="$PROJECT" assert_success "missing installed package invalidates marker" loki_prepare_project_dependencies
if [ "$(wc -l < "$FAKE_NPM_CALLS" | tr -d ' ')" = "1" ]; then
    ok "partial installation is repaired once"
else
    bad "partial installation was falsely reused"
fi

FAILED="$TMPROOT/failed"
mkdir -p "$FAILED"
printf '%s\n' '{"name":"fixture"}' > "$FAILED/package.json"
printf '%s\n' '{"name":"fixture","lockfileVersion":3,"packages":{}}' > "$FAILED/package-lock.json"
apply_fake_npm 42
TARGET_DIR="$FAILED" assert_failure "installer failure blocks verification" loki_prepare_project_dependencies
if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); raise SystemExit(0 if d["status"] == "failed" and d["exit_code"] == 42 else 1)' "$FAILED/.loki/quality/dependency-setup.json"; then
    ok "installer failure evidence records the exact exit"
else
    bad "installer failure evidence lost the exit"
fi

MISSING_LOCK="$TMPROOT/missing-lock"
mkdir -p "$MISSING_LOCK"
printf '%s\n' '{"name":"fixture"}' > "$MISSING_LOCK/package.json"
TARGET_DIR="$MISSING_LOCK" assert_failure "missing lockfile fails closed" loki_prepare_project_dependencies

NON_NODE="$TMPROOT/non-node"
mkdir -p "$NON_NODE"
TARGET_DIR="$NON_NODE" assert_success "non-Node project is not applicable" loki_prepare_project_dependencies
if python3 -c 'import json,sys; raise SystemExit(0 if json.load(open(sys.argv[1]))["status"] == "not_applicable" else 1)' "$NON_NODE/.loki/quality/dependency-setup.json"; then
    ok "non-Node evidence is explicit"
else
    bad "non-Node evidence is missing"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
