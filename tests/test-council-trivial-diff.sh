#!/usr/bin/env bash
# A-133: council_evidence_gate skips the persistence, auth and tenant
# probes on a trivial diff (at most 2 files, at most 20 changed lines, no test,
# CI, auth, security or route file) and records the skip as not proven, never as
# a pass. Drives the REAL gate over fixtures under the run-owned temp dir; an
# unhealthy serveable app makes every non-trivial case BLOCK, so the probe is
# observable. Every git call on a fixture is `git -C "$FIX"`.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
COUNCIL_SH="$REPO_ROOT/autonomy/completion-council.sh"
# shellcheck source=../eval/loki10/lib-tmp.sh
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 2
trap 'loki_run_tmp_cleanup' EXIT
T="$LOKI_RUN_TMP"
PASS=0 FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1 ($2)"; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }

# mk <setup-fn>: fresh repo with a base commit of sum.js, green tests, a serveable
# app whose health probe FAILS; the setup fn then edits the tree. Echoes the dir.
mk() {

    local FIX; FIX="$(mktemp -d "$T/fx.XXXXXX")"
    mkdir -p "$FIX"
    git -C "$FIX" init -q
    git -C "$FIX" config user.email t@example.invalid
    git -C "$FIX" config user.name t
    git -C "$FIX" config commit.gpgsign false
    printf '.loki/\n' > "$FIX/.gitignore"
    printf 'function sum(a) {\n  return a.length;\n}\n' > "$FIX/sum.js"
    git -C "$FIX" add .gitignore sum.js
    git -C "$FIX" commit -q -m base
    git -C "$FIX" rev-parse HEAD > "$FIX.base"
    mkdir -p "$FIX/.loki/quality" "$FIX/.loki/app-runner" "$FIX/.loki/council"
    printf '%s\n' '{"runner":"vitest","pass":true,"status":"passed","passed_count":1,"failed_count":0}' > "$FIX/.loki/quality/test-results.json"
    printf '%s\n' '{"status":"running","primary_service":"web","url":"http://localhost:3000"}' > "$FIX/.loki/app-runner/state.json"
    printf '%s\n' '{"ok": true, "checked_at": "t"}' > "$FIX/.loki/app-runner/health.json"
    mkdir -p "$FIX/.loki/verification"
    printf '%s\n' '{"persistence":{"attempted":true,"proven":false,"reason":"sentinel_gone_after_reload"},"auth":{"attempted":false,"proven":false,"reason":"no_auth"}}' > "$FIX/.loki/verification/functional-proof.json"
    "$1" "$FIX"
    echo "$FIX"
}
# gate <dir> [ENV=val]: prints PASS or BLOCK; warn lines land in <dir>.warn
gate() {
    local FIX="$1"; shift
    (
        cd "$FIX" || exit 99
        log_info() { :; }; log_error() { :; }; log_success() { :; }; log_header() { :; }
        log_warn() { printf '%s\n' "$*" >> "$FIX.warn"; }
        record_trust_event_bash() { :; }
        # shellcheck disable=SC1090
        source "$COUNCIL_SH" >/dev/null 2>&1 || exit 98
        export COUNCIL_STATE_DIR="$FIX/.loki/council" TARGET_DIR="$FIX" ITERATION_COUNT=3
        export _LOKI_RUN_START_SHA; _LOKI_RUN_START_SHA="$(cat "$FIX.base")"
        export LOKI_TEST_PROVENANCE=0 __LOKI_CLAUDE_HELP_CACHE=__no_claude__
        for kv in "$@"; do export "${kv?}"; done
        if council_evidence_gate; then echo PASS; else echo BLOCK; fi
    )
}
detail() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1/.loki/council/evidence-gate-details.json" 2>/dev/null; }

one_line() { printf 'function sum(a) {\n  return a.length + 0;\n}\n' > "$1/sum.js"; }
many_lines() { seq 1 30 > "$1/sum.js"; }
three_files() { one_line "$1"; echo a > "$1/a.txt"; echo b > "$1/b.txt"; }
touch_test() { one_line "$1"; printf 'test("x", () => {});\n' > "$1/sum.test.js"; }
touch_auth() { one_line "$1"; mkdir -p "$1/src/auth"; printf 'x\n' > "$1/src/auth/login.js"; }
new_route() { mkdir -p "$1/routes"; printf 'router.get("/u", h);\n' > "$1/routes/users.js"; }
touch_ci() { one_line "$1"; mkdir -p "$1/.github/workflows"; printf 'on: push\n' > "$1/.github/workflows/ci.yml"; }
tests_red() { one_line "$1"; printf '%s\n' '{"runner":"vitest","pass":false,"status":"failed","passed_count":0,"failed_count":1}' > "$1/.loki/quality/test-results.json"; }

d="$(mk one_line)"
r="$(gate "$d")"
[ "$r" = PASS ] && ok "1-file 1-line diff: probes skipped, gate passes" || bad "trivial diff" "got $r, want PASS"
grep -q 'app-boot\|persistence not proven\|auth enforcement\|tenant isolation' "$d.warn" 2>/dev/null \
    && bad "trivial diff prints probe lines" "$(cat "$d.warn")" || ok "no probe lines printed on a trivial diff"
[ "$(detail "$d" "d['boot']['inconclusive']")" = "False" ] \
    && ok "boot axis is never skipped (it only reads health.json)" || bad "boot skipped" "$(detail "$d" "d['boot']")"
for axis in persistence auth authorization; do
    [ "$(detail "$d" "d['$axis']['inconclusive'], d['$axis']['reason']")" = "True trivial_diff" ] \
        && ok "$axis recorded as not proven: trivial_diff" || bad "$axis record" "$(detail "$d" "d['$axis']")"
done

health_bad() { one_line "$1"; printf '%s\n' '{"ok": false, "checked_at": "t"}' > "$1/.loki/app-runner/health.json"; }
touch_pkg() { printf '{"scripts":{"start":"node x.js"}}\n' > "$1/package.json"; }
touch_docker() { printf 'FROM node:20\n' > "$1/Dockerfile"; }
touch_sql() { mkdir -p "$1/migrations"; printf 'alter table t add c int;\n' > "$1/migrations/001.sql"; }

d="$(mk health_bad)"
r="$(gate "$d")"
[ "$r" = BLOCK ] && ok "trivial diff + health.json ok:false still BLOCKs" || bad "boot block on trivial diff" "got $r, want BLOCK"

for c in many_lines three_files touch_test touch_auth new_route touch_ci touch_pkg touch_docker touch_sql; do
    d="$(mk "$c")"
    r="$(gate "$d")"
    [ "$r" = BLOCK ] && ok "$c: probes still run (BLOCK on disproven persistence)" || bad "$c" "got $r, want BLOCK"
done

d="$(mk one_line)"
r="$(gate "$d" LOKI_EVIDENCE_TRIVIAL_SKIP=0)"
[ "$r" = BLOCK ] && ok "LOKI_EVIDENCE_TRIVIAL_SKIP=0 restores the probes" || bad "opt-out" "got $r, want BLOCK"

d="$(mk tests_red)"
r="$(gate "$d")"
[ "$r" = BLOCK ] && ok "red tests still block a trivial diff" || bad "red tests on trivial diff" "got $r, want BLOCK"

echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
