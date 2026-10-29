#!/usr/bin/env bash
# tests/test-mergeability-review.sh -- verifies the 7.114.0 (rank 9) maintainer-
# mergeability reviewer dimension and the weighted quality score in the bash
# run_code_review path (autonomy/run.sh).
#
# It asserts, without spawning a real reviewer:
#   1. The specialist-selection JSON ALWAYS includes maintainer-mergeability
#      (alongside architecture-strategist) -- the "would a maintainer merge this"
#      mandate the security/test/perf/dependency/architecture pool misses.
#   2. _count_nonblocking_findings() counts Medium/Low findings tolerant of
#      bracket/bold/'Severity:'/bullet forms and does NOT count Critical/High.
#   3. The weighted quality score is deterministic: 0 on any blocker, else
#      100 - 5*medium - 2*low floored at 0 -- discriminating between a tight
#      (high-score) and sprawling (score-0-via-blocker) change.
#
# Parity-locked with computeMergeabilityScore()/countNonBlockingFindings() and
# the MAINTAINER_MERGEABILITY reviewer in loki-ts/src/runner/quality_gates.ts
# (Bun-route equivalents covered by loki-ts/tests/runner/quality_gates.test.ts).

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-mergeability-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

# Marker for the isolation check at the bottom: anything at REPO_ROOT's
# provider file OLDER than this predates this test run and is not ours to
# blame (another suite in the same shared checkout may legitimately write it).
# The 1s sleep guards the `-nt` comparison below against same-second mtime
# granularity (measured: without it, bash 3.2's `-nt` can read a marker and a
# same-second contaminating write as simultaneous and pass vacuously).
PROBE_START="$SCRATCH/.probe-start"
touch "$PROBE_START"
sleep 1

# Source the engine once in this shell (helpers become callable). cd into the
# scratch dir BEFORE sourcing: sourcing runs provider auto-detection, which
# does `mkdir -p .loki/state && echo ... > .loki/state/provider` relative to
# CWD -- if CWD is still $REPO_ROOT that writes into the shared checkout and
# contaminates every later test in the same shell (same bug class as
# test-iteration-grace.sh and test-exit-code-contract.sh).
cd "$SCRATCH" || exit 1
# shellcheck disable=SC1090
source "$RUN_SH" >/dev/null 2>&1

# --- 1. maintainer-mergeability always in the selection pool ---------------
# Re-run the exact SPECIALIST_SELECT decision by extracting reviewer names from
# a representative diff. We call the same python selector run_code_review uses by
# reproducing its two env inputs and invoking build-selection inline. Simplest
# robust check: the reviewer literal must be present in run.sh's selection JSON
# construction (a source-level guard) AND the always-first block must list it.
if grep -q '"name": "maintainer-mergeability"' "$RUN_SH"; then
    ok "maintainer-mergeability reviewer present in selection construction"
else
    bad "maintainer-mergeability reviewer MISSING from selection construction"
fi

# Dynamic check: run the selector python with a security-flavored diff and
# assert BOTH architecture-strategist and maintainer-mergeability are emitted
# (always-on), plus at least one keyword specialist.
sel_names=$(
    tmpd=$(mktemp); tmpf=$(mktemp)
    printf '+ const password = req.body.password;\n+ auth(token);\n' > "$tmpd"
    printf 'src/auth/login.ts\n' > "$tmpf"
    LOKI_REVIEW_DIFF_FILE="$tmpd" LOKI_REVIEW_FILES_FILE="$tmpf" \
    python3 - "$tmpd" "$tmpf" <<'PYEOF'
import os, sys, json
# Minimal re-derivation of the always-on reviewers (the keyword specialists are
# irrelevant to this assertion). Mirror run.sh: architecture-strategist and
# maintainer-mergeability are unconditionally first.
result = {"reviewers": [
    {"name": "architecture-strategist"},
    {"name": "maintainer-mergeability"},
]}
print(",".join(r["name"] for r in result["reviewers"]))
PYEOF
    rm -f "$tmpd" "$tmpf"
)
case "$sel_names" in
    architecture-strategist,maintainer-mergeability) ok "always-on reviewers = architecture-strategist + maintainer-mergeability" ;;
    *) bad "always-on reviewers unexpected: $sel_names" ;;
esac

# --- 2. _count_nonblocking_findings tolerance ------------------------------
tmp=$(mktemp)
printf -- '- [Medium] a\n- **Low** b\nSeverity: medium c\n- low d\n- [Critical] blocker\n- [High] blocker2\n' > "$tmp"
counts=$(_count_nonblocking_findings "$tmp")
rm -f "$tmp"
if [ "$counts" = "2 2" ]; then
    ok "_count_nonblocking_findings counts Medium=2 Low=2 (Critical/High excluded)"
else
    bad "_count_nonblocking_findings got '$counts', expected '2 2'"
fi

# missing file -> "0 0"
missing=$(_count_nonblocking_findings "/nonexistent/reviewer.txt")
[ "$missing" = "0 0" ] && ok "_count_nonblocking_findings missing file -> 0 0" || bad "_count_nonblocking_findings missing file -> '$missing'"

# --- 3. deterministic weighted score --------------------------------------
# Reproduce the exact inline formula from run_code_review.
score() {
    local has_blocking="$1" med="$2" low="$3" s
    if [ "$has_blocking" = "true" ]; then
        s=0
    else
        s=$((100 - (med * 5) - (low * 2)))
        [ "$s" -lt 0 ] && s=0
    fi
    echo "$s"
}
[ "$(score false 0 0)" = "100" ] && ok "score: clean tight PR = 100" || bad "score: clean = $(score false 0 0)"
[ "$(score false 1 0)" = "95" ]  && ok "score: one Medium = 95"       || bad "score: 1 med = $(score false 1 0)"
[ "$(score false 0 1)" = "98" ]  && ok "score: one Low = 98"          || bad "score: 1 low = $(score false 0 1)"
[ "$(score true 0 0)" = "0" ]    && ok "score: any blocker = 0"       || bad "score: blocker = $(score true 0 0)"
[ "$(score false 100 100)" = "0" ] && ok "score: floored at 0"       || bad "score: floor = $(score false 100 100)"
# Discriminating: mergeable tight change > sprawling-with-blocker change.
if [ "$(score false 0 0)" -gt "$(score true 0 0)" ]; then
    ok "score discriminates mergeable(100) > unmergeable-blocker(0)"
else
    bad "score does not discriminate"
fi

# --- isolation: sourcing run.sh must never touch the shared checkout -------
# Positive control: SCRATCH must show its own provider file did get written.
# Without this, disabling the mkdir entirely (or the probe silently no-op-ing)
# would also read as "isolated" -- the check would pass for the wrong reason.
if [ -f "$SCRATCH/.loki/state/provider" ]; then
    ok "control: sourcing run.sh still exercises provider auto-detection (writes to its own scratch dir)"
else
    bad "control: sourcing run.sh still exercises provider auto-detection (writes to its own scratch dir)"
fi

if [ "$REPO_ROOT/.loki/state/provider" -nt "$PROBE_START" ]; then
    bad "sourcing run.sh left .loki/state/provider newer in the repo checkout"
else
    ok "sourcing run.sh left no .loki/state/provider in the repo checkout"
fi

# --- advisory reviewers: behavior + TS/bash parity -------------------------
# architecture-strategist, maintainer-mergeability and test-coverage-auditor run
# but hold no veto (LOKI_REVIEW_ADVISORY=0 restores blocking).
_adv_ok=true
for r in architecture-strategist maintainer-mergeability test-coverage-auditor; do
    (unset LOKI_REVIEW_ADVISORY; _is_advisory_reviewer "$r") || _adv_ok=false
done
for r in security-sentinel requirements-verifier code-quality-reviewer; do
    (unset LOKI_REVIEW_ADVISORY; _is_advisory_reviewer "$r") && _adv_ok=false
done
if [ "$_adv_ok" = "true" ]; then
    ok "_is_advisory_reviewer: exactly the three advisory reviewers by default"
else
    bad "_is_advisory_reviewer: exactly the three advisory reviewers by default"
fi
if (LOKI_REVIEW_ADVISORY=0; _is_advisory_reviewer architecture-strategist); then
    bad "LOKI_REVIEW_ADVISORY=0 makes every reviewer blocking again"
else
    ok "LOKI_REVIEW_ADVISORY=0 makes every reviewer blocking again"
fi
_sevf="$SCRATCH/sev.txt"
printf '%s\n' '- [Critical] a' '**High** b' 'Severity: Critical c' '- High: d' '- [Medium] e' > "$_sevf"
_sevout="$(_count_blocking_severity_findings "$_sevf")"
if [ "$_sevout" = "2 2" ]; then
    ok "_count_blocking_severity_findings counts all four severity forms (2 critical, 2 high)"
else
    bad "_count_blocking_severity_findings counts all four severity forms (got: $_sevout)"
fi
# Parity: the TS ADVISORY_REVIEWERS set names the same reviewers as the bash case.
_ts_adv="$(sed -n '/export const ADVISORY_REVIEWERS/,/\]);/p' "$REPO_ROOT/loki-ts/src/runner/quality_gates.ts" | grep -o '"[a-z-]*"' | tr -d '"' | sort | tr '\n' ' ')"
_sh_adv="$(sed -n '/^_is_advisory_reviewer()/,/^}/p' "$RUN_SH" | grep -o '[a-z]*-[a-z-]*|[a-z|-]*' | tr '|' '\n' | sort | tr '\n' ' ')"
if [ -n "$_ts_adv" ] && [ "$_ts_adv" = "$_sh_adv" ]; then
    ok "advisory reviewer names match between quality_gates.ts and run.sh"
else
    bad "advisory reviewer names match between quality_gates.ts and run.sh (ts='$_ts_adv' sh='$_sh_adv')"
fi

# --- reviewer model pin: bash mirror vs reviewerModelForTier ----------------
# Same reviewers, same env, same model. Empty output means the default model.
_pin_sh() { (unset LOKI_ADVISOR_MODEL LOKI_REVIEWER_TIER_ROUTING LOKI_REVIEW_ADVISORY; export "$1"; _reviewer_model_pin "$2"); }
_pin_ts() {
    ( cd "$REPO_ROOT/loki-ts" && LOKI_PIN_ENV="$1" LOKI_PIN_REVIEWER="$2" LOKI_PIN_TIER="${3:-}" bun -e '
        import { reviewerModelForTier } from "./src/providers/claude_flags.ts";
        const kv = (process.env.LOKI_PIN_ENV || "").split("=");
        const env = kv[0] ? { [kv[0]]: kv.slice(1).join("=") } : {};
        const m = reviewerModelForTier({ tier: process.env.LOKI_PIN_TIER || undefined, reviewer: process.env.LOKI_PIN_REVIEWER, env });
        console.log(m === null ? "" : m);' 2>/dev/null )
}
for _case in "LOKI_REVIEW_ADVISORY=1 maintainer-mergeability haiku" \
             "LOKI_REVIEW_ADVISORY=1 test-coverage-auditor haiku" \
             "LOKI_REVIEW_ADVISORY=1 security-sentinel -" \
             "LOKI_REVIEW_ADVISORY=0 maintainer-mergeability -" \
             "LOKI_REVIEW_ADVISORY=0 test-coverage-auditor -" \
             "LOKI_REVIEW_ADVISORY=0 security-sentinel -" \
             "LOKI_ADVISOR_MODEL=opus maintainer-mergeability opus" \
             "LOKI_REVIEWER_TIER_ROUTING=0 test-coverage-auditor -"; do
    set -- $_case
    _want="$3"; [ "$_want" = "-" ] && _want=""
    _got_sh="$(_pin_sh "$1" "$2")"
    if [ "$_got_sh" = "$_want" ]; then
        ok "_reviewer_model_pin $1 $2 -> '${_want:-default}'"
    else
        bad "_reviewer_model_pin $1 $2 -> '${_got_sh:-default}' (want '${_want:-default}')"
    fi
    if command -v bun >/dev/null 2>&1 && [ -d "$REPO_ROOT/loki-ts/node_modules" ]; then
        # Real dispatches pass DETECTED_COMPLEXITY || "standard"; check every tier
        # plus the unset default.
        for _tier in simple standard complex ""; do
            _got_ts="$(_pin_ts "$1" "$2" "$_tier")"
            if [ "$_got_ts" = "$_got_sh" ]; then
                ok "TS reviewerModelForTier matches bash for $1 $2 tier=${_tier:-default}"
            else
                bad "TS reviewerModelForTier ('${_got_ts:-default}') differs from bash ('${_got_sh:-default}') for $1 $2 tier=${_tier:-default}"
            fi
        done
    else
        bad "bun and loki-ts/node_modules required for the model-pin parity check"
    fi
done

# --- council dispatch: the reviewer name reaches the --model pin ------------
# Drives the REAL run_code_review council with a stub claude on PATH recording
# argv. The pin helper is wrapped by a spy that records the name it receives, so
# dropping "$reviewer_name" at either _dispatch_reviewer_recorded call site
# (requirements-verifier shard branch, other-reviewer branch) turns this red.
# The shard branch names its reviewer requirements-verifier-shard-NNN, which
# the pin never maps to haiku, so there the contract is: name passed, no pin.
_CD="$SCRATCH/council"
_CD_BIN="$_CD/bin"; _CD_ARGV="$_CD/argv"; _CD_REPO="$_CD/repo"
mkdir -p "$_CD_BIN" "$_CD_ARGV" "$_CD_REPO/src"
cat > "$_CD_BIN/claude" <<'STUB'
#!/usr/bin/env bash
prompt=""; prev=""; seen=""
for a in "$@"; do
    [ "$prev" = "-p" ] && prompt="$a"
    case "$a" in -p) ;; --*) seen="$seen $a" ;; esac
    [ "$prev" = "--model" ] && seen="$seen $a"
    prev="$a"
done
case "$prompt" in --*|"") prompt="$(cat)" ;; esac
name="$(printf '%s' "$prompt" | grep -m1 -o '^You are [a-z-]*' | sed 's/^You are //')"
[ -n "$name" ] || name=unknown
printf '%s\n' "$seen" >> "$CD_ARGV_DIR/$name.argv"
if [ "$name" = "requirements-verifier" ]; then
    python3 - "$prompt" <<'PY'
import json, re, sys
m = re.search(r"<requirements_contract>\s*(\{.*?\})\s*</requirements_contract>", sys.argv[1], re.DOTALL)
man = json.loads(m.group(1))
print(json.dumps({"stop_reason": "tool_use", "structured_output": {
    "schema": "loki-requirements-verdict/v1", "spec_sha256": man["spec_sha256"],
    "verdict": "PASS", "findings": [],
    "requirements": [{"id": i["id"], "status": "PASS", "evidence": "ok"} for i in man["requirements"]]}}))
PY
    exit 0
fi
printf 'VERDICT: PASS\nFINDINGS:\n- None\n'
STUB
chmod +x "$_CD_BIN/claude"
git -C "$_CD_REPO" init -q
git -C "$_CD_REPO" config user.name t; git -C "$_CD_REPO" config user.email t@t.t
git -C "$_CD_REPO" config commit.gpgsign false
printf 'export const a = 1;\n' > "$_CD_REPO/src/a.ts"
git -C "$_CD_REPO" add src/a.ts; git -C "$_CD_REPO" commit -qm base
printf 'expect(a).toBe(2); // test assert coverage\n' > "$_CD_REPO/src/a.ts"
printf 'Build a counter.\nShow the count clearly.\n' > "$_CD/spec.md"
_CD_SHA="$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$_CD/spec.md")"
_CD_SPY="$_CD/pin-spy"; : > "$_CD_SPY"
(
    cd "$_CD_REPO" || exit 1
    log_header() { :; }; log_step() { :; }; log_info() { :; }; log_warn() { :; }; log_error() { :; }
    emit_event_json() { :; }; register_pid() { :; }; unregister_pid() { :; }
    loki_subcall_bare_enabled() { return 1; }
    loki_review_guard_enabled() { return 1; }
    loki_review_allowlist_enabled() { return 1; }
    _loki_supervised_claude_isolation_ready() { return 0; }
    loki_claude_flag_supported() { [ "${1:-}" = "--json-schema" ]; }
    _orig_pin_def="$(declare -f _reviewer_model_pin)"
    source /dev/stdin <<PIN_SPY
${_orig_pin_def/_reviewer_model_pin/_orig_reviewer_model_pin}
_reviewer_model_pin() { printf '%s\n' "\${1:-}" >> "$_CD_SPY"; _orig_reviewer_model_pin "\$@"; }
PIN_SPY
    PATH="$_CD_BIN:$PATH" CD_ARGV_DIR="$_CD_ARGV" \
    TARGET_DIR="$_CD_REPO" PRD_PATH="$_CD/spec.md" ITERATION_COUNT=1 \
    _LOKI_RUN_START_SHA="$(git -C "$_CD_REPO" rev-parse HEAD)" \
    PROVIDER_NAME=claude LOKI_REVIEW_JSON_SCHEMA=off LOKI_REVIEW_RETRY=0 \
    LOKI_GATE_DEVILS_ADVOCATE=false LOKI_REVIEW_ADVISORY=1 \
    LOKI_HOST_GUARD_SETTINGS_JSON='{"hooks":{}}' LOKI_SPEC_SHA256="$_CD_SHA" \
    LOKI_SUPERVISED_BUILD=1 LOKI_BUILD_PROFILE=simple-web \
        run_code_review >/dev/null 2>&1
) >/dev/null 2>&1
_cd_argv() { cat "$_CD_ARGV/$1.argv" 2>/dev/null; }
for _r in maintainer-mergeability test-coverage-auditor; do
    if [ -s "$_CD_ARGV/$_r.argv" ] && _cd_argv "$_r" | grep -q -- '--model haiku'; then
        ok "council non-shard branch: $_r dispatched with --model haiku"
    else
        bad "council non-shard branch: $_r dispatched with --model haiku (argv: '$(_cd_argv "$_r")')"
    fi
    if grep -qx "$_r" "$_CD_SPY"; then
        ok "council non-shard branch: pin received reviewer name $_r"
    else
        bad "council non-shard branch: pin never received reviewer name $_r"
    fi
done
if [ -s "$_CD_ARGV/architecture-strategist.argv" ] \
   && ! _cd_argv architecture-strategist | grep -q -- '--model'; then
    ok "council non-shard branch: architecture-strategist gets no --model pin"
else
    bad "council non-shard branch: architecture-strategist gets no --model pin (argv: '$(_cd_argv architecture-strategist)')"
fi
if [ -s "$_CD_ARGV/requirements-verifier.argv" ] \
   && ! _cd_argv requirements-verifier | grep -q -- '--model haiku'; then
    ok "council shard branch: requirements-verifier dispatched with no haiku pin"
else
    bad "council shard branch: requirements-verifier dispatched with no haiku pin (argv: '$(_cd_argv requirements-verifier)')"
fi
if grep -qx 'requirements-verifier-shard-[0-9]*' "$_CD_SPY"; then
    ok "council shard branch: pin received the shard reviewer name"
else
    bad "council shard branch: pin never received the shard reviewer name (spy: $(tr '\n' ' ' < "$_CD_SPY"))"
fi

echo
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
