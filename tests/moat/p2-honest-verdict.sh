#!/usr/bin/env bash
export LOKI_DASHBOARD_ALLOWED_HOSTS=testserver,test  # TestClient Host; keeps default allowlist strict
# Moat property P2: Honest verdict.
#
# A model-only "looks good" can never produce a pass, and unknown, unreadable or
# unmeasured evidence never produces a pass. Verifier exit contract:
#   0 passed  1 failed  2 could not check  3 nothing to check
#   20 durable no-retry  64 usage  66 input missing
#
# Output: exactly one "CASE <ID> PASS|FAIL <description>" line per case on
# stdout. Everything else goes to stderr. Exit 0 whenever the script ran to
# completion, whatever the case results. A missing prerequisite is a FAIL,
# never a skip. Every "absent/rejected" assertion carries a positive control so
# the probe cannot pass vacuously.
#
# Hermetic: no network, no model or API call. The one LLM reviewer consulted
# (P2.model-looks-good-cannot-pass) is a PATH stub that answers
# `loki internal sdk-judge` with a canned "looks good".
#
# Case bodies are called through run_case and the council stubs are called by
# the sourced library, so shellcheck cannot see their callers.
# shellcheck disable=SC2329
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
LOKI_SHIM="$REPO_ROOT/bin/loki"
GEN="$REPO_ROOT/autonomy/lib/proof-generator.py"
PV="$REPO_ROOT/autonomy/lib/proof-verify.py"
COUNCIL_SH="$REPO_ROOT/autonomy/completion-council.sh"
T_START="$(date +%s)"

RUN="$(mktemp -d "${TMPDIR:-/tmp}/moat-p2.XXXXXX")" || { echo "moat-p2: cannot create temp dir" >&2; exit 1; }
RUN="$(cd "$RUN" && pwd -P)"
trap 'cp_stop; rm -rf "$RUN"' EXIT
mkdir -p "$RUN/home" "$RUN/tmp" "$RUN/stub"
# Read before HOME moves: a user-site fastapi (the console-verdict case drives
# the real dashboard app) stays importable through PYTHONUSERBASE.
MOAT_USERBASE="$(python3 -m site --user-base 2>/dev/null || true)"

export LOKI_TELEMETRY_DISABLED=true DO_NOT_TRACK=1 LOKI_NO_UPDATE_CHECK=1 CI=true
export LOKI_DELEGATE_PR=0 LOKI_DASHBOARD=false
export HOME="$RUN/home" TMPDIR="$RUN/tmp" PYTHONDONTWRITEBYTECODE=1
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0
export NO_UPDATE_NOTIFIER=1 npm_config_update_notifier=false npm_config_offline=true
export npm_config_audit=false npm_config_fund=false npm_config_cache="$RUN/npm-cache"
# Model-free by construction: no key reaches any child, even by accident.
unset ANTHROPIC_API_KEY OPENAI_API_KEY 2>/dev/null || true

# The only "reviewer" any case can reach. Anything but the judge call fails.
cat > "$RUN/stub/loki" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "internal" ] && [ "${2:-}" = "sdk-judge" ]; then
    printf '%s\n' '{"summary":"looks good to me, ship it","findings":[]}'
    exit 0
fi
exit 97
EOF
chmod +x "$RUN/stub/loki"

# --- harness ------------------------------------------------------------------
_st="FAIL"; _why=""
run_case() { # <id> <description> <function>
    local id="$1" desc="$2" fn="$3"
    _st="FAIL"; _why="case body did not reach a verdict"
    "$fn"
    if [ "$_st" = "PASS" ]; then
        printf 'CASE %s PASS %s\n' "$id" "$desc"
    else
        printf 'CASE %s FAIL %s: %s\n' "$id" "$desc" "$_why"
    fi
}
need() { # <tool>... ; sets _why and returns 1 on the first missing one
    local b
    for b in "$@"; do
        command -v "$b" >/dev/null 2>&1 || { _why="prerequisite missing: $b"; return 1; }
    done
}
g() { local d="$1"; shift; git -C "$d" -c user.email=moat@loki.local -c user.name=moat -c commit.gpgsign=false "$@"; }
new_repo() { # <dir> : one committed file
    mkdir -p "$1" && git init -q "$1" 2>/dev/null && printf 'seed\n' > "$1/seed.txt" \
        && g "$1" add seed.txt && g "$1" commit -qm seed
}
# Run the CLI on one route. Usage: loki_route bun|bash <args...>
loki_route() {
    local route="$1"; shift
    if [ "$route" = "bash" ]; then LOKI_LEGACY_BASH=1 bash "$LOKI_SHIM" "$@"; else bash "$LOKI_SHIM" "$@"; fi
}

# Receipt that every axis can genuinely check (mirrors tests/test_verify_chain.py
# _receipt): headline from the verifier's own rule, hash over the canonical form.
write_receipt() { # <out proof.json> <repo> [usd]
    mkdir -p "$(dirname "$1")"
    python3 - "$1" "$2" "${3:-0.42}" "$PV" <<'PY'
import hashlib, importlib.util, json, subprocess, sys
out, repo, usd, pv_path = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
spec = importlib.util.spec_from_file_location("pv", pv_path)
pv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pv)
head = subprocess.run(["git", "-C", repo, "rev-parse", "HEAD"],
                      capture_output=True, text=True).stdout.strip()
facts = {"git": {"base_sha": head, "head_sha": head,
                 "diff": {"count": 0, "insertions": 0, "deletions": 0}},
         "tests": {"status": "verified", "command": "pytest -q", "exit_code": 0},
         "execution": {"outcome": "complete", "exit_code": 0}}
proof = {"schema_version": "1.1", "facts": facts,
         "honesty": {"headline": pv._compute_headline(facts, []), "degraded": []},
         "cost": {"available": True, "usd": usd, "input_tokens": 1000,
                  "output_tokens": 50, "cache_read_tokens": 0,
                  "cache_creation_tokens": 0}}
proof["verification"] = {"hash": hashlib.sha256(pv._canonical(proof).encode()).hexdigest()}
with open(out, "w") as fh:
    json.dump(proof, fh, indent=2)
PY
}
# Workspace whose receipt passes every chain stage (the positive control of
# tests/test_verify_chain.py): measured cost, optional policy, all committed
# before the receipt is written. Usage: chain_ws <dir> <policy-json|"">
chain_ws() {
    new_repo "$1" || return 1
    mkdir -p "$1/.loki/metrics/efficiency"
    printf '%s\n' '{"iteration":1,"input_tokens":1000,"output_tokens":50,"cache_read_tokens":0,"cache_creation_tokens":0,"cost_usd":0.42,"model":"x","duration_ms":1000,"status":"completed"}' \
        > "$1/.loki/metrics/efficiency/iteration-1.json"
    [ -n "$2" ] && printf '%s' "$2" > "$1/.loki-policy.json"
    g "$1" add -A && g "$1" commit -qm fixture || return 1
    write_receipt "$1/.loki/proofs/r1/proof.json" "$1"
}

# Drive the REAL receipt generator, then re-derive the headline with the
# verifier's mirrored rule. Prints "<generator headline>|<verifier headline>",
# plus "|<degraded items>" when a fourth argument "ledger" is given.
# Usage: gen_headlines <name> <quality-gates-json> <with-tests yes|no> [ledger]
gen_headlines() {
    local d="$RUN/gen/$1"
    new_repo "$d" >/dev/null 2>&1 || { echo "FIXTURE|FIXTURE"; return; }
    printf 'change\n' >> "$d/seed.txt"; g "$d" commit -qam change
    mkdir -p "$d/.loki/state" "$d/.loki/quality"
    printf '%s' "$2" > "$d/.loki/state/quality-gates.json"
    if [ "$3" = "yes" ]; then # the deterministic facts a VERIFIED headline needs
        printf '%s' '{"status":"verified","command":"npm test","exit_code":0}' > "$d/.loki/quality/test-results.json"
        printf '%s' '{"command":"npm run build","exit_code":0,"ran":true}' > "$d/.loki/quality/build-results.json"
    fi
    (cd "$d" && python3 "$GEN" --loki-dir "$d/.loki" --out-dir "$d/out" --quiet) >/dev/null 2>&1
    python3 - "$d/out/proof.json" "$PV" "${4:-}" <<'PY' 2>/dev/null || echo "NOPROOF|NOPROOF"
import importlib.util, json, sys
p = json.load(open(sys.argv[1]))
spec = importlib.util.spec_from_file_location("pv", sys.argv[2])
pv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pv)
h = p.get("honesty") or {}
deg = h.get("degraded") or []
line = "%s|%s" % (h.get("headline"), pv._compute_headline(p.get("facts") or {}, deg))
if sys.argv[3] == "ledger":
    line += "|" + ",".join(str(x.get("item")) for x in deg)
print(line)
PY
}

# Call one completion-council function in a subshell with the real library
# sourced, inside <repo>. The council's vote is stubbed to "2 of 3 COMPLETE"
# (quorum present, not unanimous, so the devil's advocate does not run): that is
# "a council vote alone". Echoes the function's return code.
council_call() { # <repo> <base-sha> <function>
    (
        cd "$1" || exit 99
        log_info() { :; }; log_warn() { :; }; log_error() { :; }; log_success() { :; }
        log_debug() { :; }; log_header() { :; }; log_step() { :; }
        source "$COUNCIL_SH" >/dev/null 2>&1 || exit 98
        export COUNCIL_STATE_DIR="$1/.loki/council" TARGET_DIR="$1" ITERATION_COUNT=7
        export _LOKI_RUN_START_SHA="$2" LOKI_TEST_PROVENANCE=0 __LOKI_CLAUDE_HELP_CACHE=__no_claude__
        COUNCIL_ENABLED=true; COUNCIL_SIZE=3
        mkdir -p "$COUNCIL_STATE_DIR/votes"
        council_aggregate_votes() {
            printf '%s\n' '{"verdict":"COMPLETE","complete_votes":2,"total_members":3}' \
                > "$COUNCIL_STATE_DIR/votes/round-${ITERATION_COUNT}.json"
            echo "COMPLETE"
        }
        "$3" >/dev/null 2>&1
    )
    echo "$?"
}
# Like council_call, but for a function called with extra args (role,
# evidence-file, ...) whose fail/green split shows up in its stdout VOTE TEXT,
# not its return code: council_heuristic_review, council_evaluate_member and
# council_devils_advocate_review each print one of VOTE:REJECT/VOTE:APPROVE,
# CONTINUE/COMPLETE, OVERRIDE_CONTINUE/CONFIRMED_COMPLETE. Echoes the first
# stdout word. A call to a nonexistent function still exits the subshell
# nonzero but prints nothing, so the caller gets an empty string here -- which
# cannot equal any real vote word, unlike a marker-file-only check that a
# missing function also never touches.
council_call_args() { # <repo> <base-sha> <function> <function-args...>
    local out
    out="$(
        cd "$1" || exit 99
        log_info() { :; }; log_warn() { :; }; log_error() { :; }; log_success() { :; }
        log_debug() { :; }; log_header() { :; }; log_step() { :; }
        source "$COUNCIL_SH" >/dev/null 2>&1 || exit 98
        export COUNCIL_STATE_DIR="$1/.loki/council" TARGET_DIR="$1" ITERATION_COUNT=7
        export _LOKI_RUN_START_SHA="$2" LOKI_TEST_PROVENANCE=0 __LOKI_CLAUDE_HELP_CACHE=__no_claude__
        COUNCIL_ENABLED=true; COUNCIL_SIZE=3
        mkdir -p "$COUNCIL_STATE_DIR/votes"
        council_aggregate_votes() {
            printf '%s\n' '{"verdict":"COMPLETE","complete_votes":2,"total_members":3}' \
                > "$COUNCIL_STATE_DIR/votes/round-${ITERATION_COUNT}.json"
            echo "COMPLETE"
        }
        local fn="$3"; shift 3
        "$fn" "$@" 2>/dev/null
    )" 2>/dev/null
    printf '%s\n' "${out%%[[:space:]]*}"
}
council_repo() { # <dir> <test-results-json|""> -> echoes base sha; commits a real diff
    new_repo "$1" >/dev/null 2>&1 || return 1
    printf '.loki/\n' > "$1/.gitignore"; g "$1" add .gitignore; g "$1" commit -qm ignore
    local base; base="$(g "$1" rev-parse HEAD)"
    printf 'feature\n' > "$1/feature.txt"; g "$1" add feature.txt; g "$1" commit -qm feature
    if [ -n "$2" ]; then mkdir -p "$1/.loki/quality"; printf '%s\n' "$2" > "$1/.loki/quality/test-results.json"; fi
    echo "$base"
}
jfield() { # <file> <python expr over d>
    python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1" 2>/dev/null
}

# --- cases --------------------------------------------------------------------

case_advisory_only() {
    need python3 git || return
    local adv='{"code_review":"passed","devils_advocate":"passed","magic_debate":"passed","council":"passed","anti_sycophancy":"passed"}'
    # Control isolates the ONE variable this case tests: the probe's exact gate
    # set plus one exogenous passed gate (static_analysis), same tests=no. With
    # no tests, "tests" always lands in degraded (status not_run), so the
    # exogenous pass can only reach VERIFIED WITH GAPS, never a clean VERIFIED.
    local ctl='{"code_review":"passed","devils_advocate":"passed","magic_debate":"passed","council":"passed","anti_sycophancy":"passed","static_analysis":"passed"}'
    local h c
    h="$(gen_headlines advonly "$adv" no)"
    c="$(gen_headlines advctl "$ctl" no)"
    if [ "$c" != "VERIFIED WITH GAPS|VERIFIED WITH GAPS" ]; then
        _why="positive control broken: an exogenous pass (no tests) produced '$c', expected VERIFIED WITH GAPS|VERIFIED WITH GAPS"
        return
    fi
    case "$h" in
        VERIFIED*|*"|VERIFIED"*) _why="advisory-only passes produced a VERIFIED headline (generator|verifier = $h)" ;;
        "NOT VERIFIED|NOT VERIFIED") _st="PASS" ;;
        *) _why="unexpected headline pair '$h'" ;;
    esac
}

case_unknown_gate() {
    need python3 git || return
    local c u s
    c="$(gen_headlines unkctl '{"brand_new_gate_x":"passed","code_review":"passed"}' yes)"
    u="$(gen_headlines unkname '{"brand_new_gate_x":"failed","code_review":"passed"}' yes)"
    s="$(gen_headlines unkstatus '{"static_analysis":"banana","code_review":"passed"}' yes ledger)"
    if [ "$c" != "VERIFIED|VERIFIED" ]; then
        _why="positive control broken: the same fixture with the unknown gate passing produced '$c', expected VERIFIED|VERIFIED"
        return
    fi
    if [ "$u" != "NOT VERIFIED|NOT VERIFIED" ]; then
        _why="a FAILED gate with an unrecognized name did not block (generator|verifier = $u); unknown must default to exogenous"
        return
    fi
    # An unrecognized STATUS is unmeasured: it may not read as a clean VERIFIED
    # and it must be named in the degraded ledger (WITH GAPS is the honest
    # headline when the tests themselves did verify).
    case "$s" in
        "VERIFIED|"*|*"|VERIFIED|"*) _why="an unrecognized gate STATUS read as a clean VERIFIED (generator|verifier|ledger = $s)" ;;
        *"quality_gate:static_analysis"*) _st="PASS" ;;
        *) _why="an unrecognized gate STATUS was not named in the degraded ledger (generator|verifier|ledger = $s)" ;;
    esac
}

case_model_looks_good() {
    need python3 git npm bash bun || return
    local d="$RUN/verify-llm" route rc v llm tg bad=""
    new_repo "$d" >/dev/null 2>&1 || { _why="fixture repo could not be created"; return; }
    g "$d" branch -M main
    printf '%s\n' '{"name":"moat-p2","version":"1.0.0","private":true,"scripts":{"test":"exit 1"}}' > "$d/package.json"
    g "$d" add package.json; g "$d" commit -qm base
    g "$d" checkout -qb feature
    printf 'module.exports = 1;\n' > "$d/index.js"; g "$d" add index.js; g "$d" commit -qm feature
    for route in bun bash; do
        rc=0
        (cd "$d" && PATH="$RUN/stub:$PATH" LOKI_GATE_TIMEOUT=60 loki_route "$route" verify main --out "$RUN/verify-llm-$route") \
            >/dev/null 2>"$RUN/verify-llm-$route.err" || rc=$?
        local ev="$RUN/verify-llm-$route/evidence.json"
        v="$(jfield "$ev" "d.get('verdict')")"
        llm="$(jfield "$ev" "(d.get('llm_review') or {}).get('status')")"
        tg="$(jfield "$ev" "[g.get('status') for g in d.get('deterministic_gates',[]) if g.get('gate')=='tests'][0]")"
        # Controls: the stub reviewer WAS consulted and said "looks good", and
        # the deterministic test evidence really was red.
        if [ "$llm" != "reviewed" ]; then bad="$bad [$route: reviewer control broken, llm_review.status='$llm' (stub not consulted)]"; continue; fi
        if [ "$tg" != "fail" ]; then bad="$bad [$route: evidence control broken, tests gate='$tg' not fail]"; continue; fi
        if [ "$rc" -eq 0 ] || [ "$v" = "VERIFIED" ]; then
            bad="$bad [$route: model 'looks good' + red tests gave verdict=$v rc=$rc]"
        fi
    done
    if [ -z "$bad" ]; then _st="PASS"; else _why="${bad# }"; fi
}

case_missing_pass_key() {
    need python3 git || return
    local d1="$RUN/passkey-missing" d2="$RUN/passkey-ctl" b1 b2 v1 v2
    b1="$(council_repo "$d1" '{"runner":"jest","summary":"no pass key"}')" || { _why="fixture failed"; return; }
    b2="$(council_repo "$d2" '{"runner":"jest","pass":true,"summary":"green"}')" || { _why="fixture failed"; return; }
    council_call "$d1" "$b1" council_evidence_gate >/dev/null
    council_call "$d2" "$b2" council_evidence_gate >/dev/null
    v1="$(jfield "$d1/.loki/council/evidence-gate-details.json" "str(d['tests']['inconclusive']).lower()")"
    v2="$(jfield "$d2/.loki/council/evidence-gate-details.json" "str(d['tests']['inconclusive']).lower()")"
    if [ "$v2" != "false" ]; then
        _why="positive control broken: pass:true read tests.inconclusive='$v2', expected false (affirmative)"
    elif [ "$v1" = "true" ]; then
        _st="PASS"
    else
        _why="a results file with no pass key was read as affirmative (tests.inconclusive='$v1')"
    fi
}

# The Bun route's test gate (runTestCoverage, the real loki-ts source) reads
# .loki/quality/test-results.json. "Reads as passed" means an affirmative pass:
# passed === true and not inconclusive. Anything else from the artifact must be
# a failure or an explicit inconclusive.
case_bun_inconclusive() {
    need bun || return
    local d="$RUN/bun-tc" out
    mkdir -p "$d/work"
    cat > "$d/probe.ts" <<'TS'
import * as fs from "node:fs";
const repo = process.env.MOAT_REPO!, root = process.env.MOAT_WORK!;
const { runTestCoverage } = await import(`${repo}/loki-ts/src/runner/quality_gates.ts`);
const shapes: Record<string, string> = {
  control_true: '{"runner":"jest","pass":true}',
  control_false: '{"runner":"jest","pass":false}',
  inconclusive: '{"runner":"node-test","pass":"inconclusive","status":"no_tests_run","exit_code":0,"passed_count":null,"failed_count":null}',
  no_pass_key: '{"runner":"jest","summary":"no pass key"}',
};
const out: string[] = [];
for (const [name, body] of Object.entries(shapes)) {
  const lokiDir = `${root}/${name}/.loki`, cwd = `${root}/${name}`;
  fs.mkdirSync(`${lokiDir}/quality`, { recursive: true });
  fs.writeFileSync(`${lokiDir}/quality/test-results.json`, body);
  // Fresh for iteration 1, so each shape is judged on its pass value and not
  // turned inconclusive by staleness (P2.zero-test-never-affirmative covers that).
  fs.writeFileSync(`${lokiDir}/quality/.test-results.iter`, "1\n");
  // cwd has no package.json, so the gate can never fall back to `npm test`.
  const r = await runTestCoverage({ lokiDir, cwd, iterationCount: 1, log: () => {} } as never);
  out.push(`${name}=${r.passed === true && r.inconclusive !== true ? "PASSED" : r.passed === false ? "FAILED" : r.inconclusive === true ? "INCONCLUSIVE" : "OTHER"}`);
}
console.log(out.join(" "));
TS
    out="$(cd "$d/work" && env -u LOKI_STUB_GATE_TEST_COVERAGE MOAT_REPO="$REPO_ROOT" MOAT_WORK="$d/work" \
        bun run "$d/probe.ts" 2> "$d/err")"
    if [ -z "$out" ]; then
        _why="the Bun probe produced no verdicts (loki-ts/node_modules missing? run bun install in loki-ts): $(head -c 300 "$d/err" | tr '\n' ' ')"
        return
    fi
    case "$out" in *control_true=PASSED*control_false=FAILED*) ;; *)
        _why="controls broken: want control_true=PASSED and control_false=FAILED, got ($out)"; return ;;
    esac
    case "$out" in
        *" inconclusive=INCONCLUSIVE no_pass_key=INCONCLUSIVE") _st="PASS" ;;
        *) _why="the Bun test gate read an unrecorded outcome as something other than inconclusive ($out)" ;;
    esac
}

# A runner that exits 0 having executed zero tests proved nothing, and a
# results file from another iteration is not this iteration's evidence. The
# fixture's `npm test` is a stub jest under node_modules/.bin that prints jest's
# own zero-test line ("No tests found") or, for the positive control, a real
# summary line; both exit 0, so only the output tells them apart.
zt_fixture() { # <dir> <jest-stderr-line> : package.json + stub jest in <dir>
    mkdir -p "$1/node_modules/.bin" || return 1
    printf '%s\n' '{"name":"moat-zt","version":"1.0.0","private":true,"scripts":{"test":"jest --passWithNoTests"}}' > "$1/package.json"
    printf '#!/bin/sh\nprintf "%%s\\n" "%s" >&2\nexit 0\n' "$2" > "$1/node_modules/.bin/jest"
    chmod +x "$1/node_modules/.bin/jest"
}
# The real enforce_test_coverage (plus the zero-test detector it calls, which
# sits directly above it) cut out of run.sh, with only the log helpers stubbed.
zt_harness() { # <out file>
    local rs="$REPO_ROOT/autonomy/run.sh" s e n
    s="$(grep -n '^_loki_zero_tests_executed() {' "$rs" | head -1 | cut -d: -f1)"
    e="$(grep -n '^enforce_test_coverage() {' "$rs" | head -1 | cut -d: -f1)"
    n="$(awk -v s="$e" 'NR>s && /^[a-zA-Z_][a-zA-Z0-9_]*\(\) \{/ {print NR; exit}' "$rs")"
    [ -n "$s" ] && [ -n "$e" ] && [ -n "$n" ] || return 1
    e="$(awk -v s="$e" -v n="$n" 'NR>s && NR<n && /^}[[:space:]]*$/ {last=NR} END {print last}' "$rs")"
    { printf '%s\n' 'log_info() { :; }' 'log_warn() { :; }' 'log_error() { :; }'
      awk -v s="$s" -v e="$e" 'NR>=s && NR<=e' "$rs"; } > "$1"
    bash -n "$1" 2>/dev/null
}

case_zero_test_never_affirmative() {
    need python3 git node npm bash bun timeout || return
    local h="$RUN/zt-harness.sh" leg d b marker tpass dpass out bad=""
    zt_harness "$h" || { _why="could not cut enforce_test_coverage out of run.sh"; return; }
    # Bash route: the real gate writes the marker and results, then the real
    # council evidence gate writes evidence-gate-details.json from them.
    for leg in zero green; do
        d="$RUN/zt-bash-$leg"
        b="$(council_repo "$d" "")" || { _why="fixture $leg failed"; return; }
        if [ "$leg" = zero ]; then zt_fixture "$d" "No tests found, exiting with code 0"
        else zt_fixture "$d" "Tests:       1 passed, 1 total"; fi || { _why="fixture $leg failed"; return; }
        # A marker left by an earlier iteration: a zero-test run must not keep it.
        mkdir -p "$d/.loki/quality" && : > "$d/.loki/quality/unit-tests.pass"
        (cd "$d" && TARGET_DIR="$d" LOKI_GATE_TIMEOUT=60 bash -c ". '$h'; enforce_test_coverage") >/dev/null 2>&1
        council_call "$d" "$b" council_evidence_gate >/dev/null
        if [ -e "$d/.loki/quality/unit-tests.pass" ]; then marker=present; else marker=absent; fi
        tpass="$(jfield "$d/.loki/quality/test-results.json" "json.dumps(d.get('pass'))")"
        dpass="$(jfield "$d/.loki/council/evidence-gate-details.json" "json.dumps(d['tests']['pass'])")"
        if [ "$leg" = green ]; then
            # Positive control: a real pass is affirmative everywhere, so the
            # negatives below are measurements, not absences.
            [ "$marker" = present ] && [ "$tpass" = true ] && [ "$dpass" = true ] \
                || { _why="control broken: a real passing run gave marker=$marker results.pass=$tpass details.tests.pass=$dpass"; return; }
        else
            [ "$tpass" = '"inconclusive"' ] || bad="$bad [bash: zero-test results.pass=$tpass, want \"inconclusive\" (detector did not fire?)]"
            [ "$marker" = absent ] || bad="$bad [bash: zero-test run left unit-tests.pass]"
            [ -n "$dpass" ] && [ "$dpass" != true ] || bad="$bad [bash: evidence-gate-details tests.pass=${dpass:-missing} for a zero-test run]"
        fi
    done
    # Bun route: runTestCoverage (the real loki-ts source) on a stale artifact
    # and on a zero-test `npm test`, each with a positive control.
    mkdir -p "$RUN/zt-bun/work"
    zt_fixture "$RUN/zt-bun/npm-zero" "No tests found, exiting with code 0" || { _why="bun fixture failed"; return; }
    zt_fixture "$RUN/zt-bun/npm-green" "Tests:       1 passed, 1 total" || { _why="bun fixture failed"; return; }
    cat > "$RUN/zt-bun/probe.ts" <<'TS'
import * as fs from "node:fs";
const repo = process.env.MOAT_REPO!, root = process.env.MOAT_ROOT!;
const { runTestCoverage } = await import(`${repo}/loki-ts/src/runner/quality_gates.ts`);
// [leg, marker]: a string or null writes a pass:true artifact (null = no
// freshness marker); undefined writes no artifact (the npm legs).
const legs: Array<[string, string | null | undefined]> = [
  ["fresh", "1"],        // control: this iteration's pass:true artifact
  ["no_marker", null],   // stale: no .test-results.iter
  ["old_marker", "0"],   // stale: an earlier iteration's marker
  ["npm-green", undefined], // control: npm test ran a test
  ["npm-zero", undefined],  // npm test exit 0, zero tests executed
];
const out: string[] = [];
for (const [name, marker] of legs) {
  const cwd = `${root}/${name}`, lokiDir = `${cwd}/.loki`;
  fs.mkdirSync(`${lokiDir}/quality`, { recursive: true });
  if (marker !== undefined) {
    fs.writeFileSync(`${lokiDir}/quality/test-results.json`, '{"runner":"jest","pass":true,"passed_count":3,"failed_count":0}');
    if (marker !== null) fs.writeFileSync(`${lokiDir}/quality/.test-results.iter`, `${marker}\n`);
  }
  const r = await runTestCoverage({ lokiDir, cwd, iterationCount: 1, log: () => {} } as never);
  out.push(`${name}=${r.passed === true && r.inconclusive !== true ? "PASSED" : r.passed === false ? "FAILED" : "INCONCLUSIVE"}`);
}
console.log(out.join(" "));
TS
    out="$(cd "$RUN/zt-bun/work" && env -u LOKI_STUB_GATE_TEST_COVERAGE MOAT_REPO="$REPO_ROOT" MOAT_ROOT="$RUN/zt-bun" \
        bun run "$RUN/zt-bun/probe.ts" 2> "$RUN/zt-bun/err")"
    case "$out" in
        *fresh=PASSED*npm-green=PASSED*) ;;
        *) _why="bun controls broken (a fresh pass:true artifact and a real npm test must pass): got '${out:-<none>}' $(head -c 300 "$RUN/zt-bun/err" | tr '\n' ' ')"; return ;;
    esac
    case "$out" in *no_marker=PASSED*) bad="$bad [bun: a pass:true artifact with no freshness marker read as passed]" ;; esac
    case "$out" in *old_marker=PASSED*) bad="$bad [bun: an earlier iteration's pass:true artifact read as passed]" ;; esac
    case "$out" in *npm-zero=PASSED*) bad="$bad [bun: npm test exit 0 with zero tests executed read as passed]" ;; esac
    zt_stale_session || return
    if [ -z "$bad" ]; then _st="PASS"; else _why="${bad# }"; fi
}

# Stale-session leg (both routes): a previous session left .test-results.iter
# "1", a pass:true test-results.json and unit-tests.pass. The next session
# restarts at iteration 0, so its iteration 1 would read that pass as fresh.
# Starting at 0 (terminal or corrupt previous state) must drop the marker and
# unit-tests.pass: bash load_state (cut out of run.sh) and Bun
# loadStateForRunner, then the Bun gate at iteration 1 must not read passed.
# Appends to the caller's $bad; returns 1 with _why set when a control breaks.
zt_stale_session() {
    local ss="$RUN/zt-session" lsh="$RUN/zt-load-state.sh" leg d it args pre post
    { printf '%s\n' 'log_info() { :; }' 'log_warn() { :; }' 'log_error() { :; }'
      sed -n '/^_loki_state_file() {/,/^}/p; /^load_state() {/,/^}/p' "$REPO_ROOT/autonomy/run.sh"; } > "$lsh"
    grep -q '^load_state() {' "$lsh" && grep -q '^_loki_state_file() {' "$lsh" && bash -n "$lsh" 2>/dev/null \
        || { _why="could not cut load_state out of run.sh"; return 1; }
    for leg in bash-terminal bash-corrupt bun-terminal bun-corrupt; do
        d="$ss/$leg"
        mkdir -p "$d/.loki/quality" || { _why="stale-session fixture $leg failed"; return 1; }
        case "$leg" in
            *terminal) printf '%s\n' '{"retryCount":0,"iterationCount":1,"status":"council_approved"}' > "$d/.loki/autonomy-state.json" ;;
            *corrupt) printf '%s\n' '{not json' > "$d/.loki/autonomy-state.json" ;;
        esac
        printf '%s\n' '{"runner":"jest","pass":true,"passed_count":3,"failed_count":0}' > "$d/.loki/quality/test-results.json"
        printf '1\n' > "$d/.loki/quality/.test-results.iter"
        : > "$d/.loki/quality/unit-tests.pass"
    done
    cat > "$ss/probe.ts" <<'TS'
const repo = process.env.MOAT_REPO!;
const { runTestCoverage } = await import(`${repo}/loki-ts/src/runner/quality_gates.ts`);
const { loadStateForRunner } = await import(`${repo}/loki-ts/src/runner/state.ts`);
// argv: <name> <dir> <load 0|1> triples. load=1 runs loadStateForRunner first
// and gates at its iteration + 1 (the loop increments before the gates run);
// load=0 gates at iteration 1.
const a = process.argv.slice(2), out: string[] = [];
for (let i = 0; i + 2 < a.length; i += 3) {
  const [name, dir, load] = [a[i], a[i + 1], a[i + 2]];
  const ctx = { lokiDir: `${dir}/.loki`, cwd: dir, iterationCount: 7, retryCount: 0, log: () => {} };
  if (load === "1") {
    await loadStateForRunner(ctx as never);
    out.push(`${name}.iter=${ctx.iterationCount}`);
    ctx.iterationCount += 1;
  } else {
    ctx.iterationCount = 1;
  }
  const r = await runTestCoverage(ctx as never);
  out.push(`${name}=${r.passed === true && r.inconclusive !== true ? "PASSED" : r.passed === false ? "FAILED" : "INCONCLUSIVE"}`);
}
console.log(out.join(" "));
TS
    zt_probe() { (cd "$ss" && env -u LOKI_STUB_GATE_TEST_COVERAGE MOAT_REPO="$REPO_ROOT" bun run "$ss/probe.ts" "$@" 2> "$ss/err"); }
    # Control: before any load, each leftover reads as passed at iteration 1.
    args=""
    for leg in bash-terminal bash-corrupt bun-terminal bun-corrupt; do args="$args $leg $ss/$leg 0"; done
    # shellcheck disable=SC2086  # $args is word-split into triples on purpose (no spaces in $RUN paths)
    pre="$(zt_probe $args)"
    case "$pre" in "bash-terminal=PASSED bash-corrupt=PASSED bun-terminal=PASSED bun-corrupt=PASSED") ;;
        *) _why="stale-session control broken (each leftover must read passed before a load): got '${pre:-<none>}' $(head -c 300 "$ss/err" | tr '\n' ' ')"; return 1 ;;
    esac
    # Bash route: the real load_state. The env never reaches a real repo's .loki.
    for leg in bash-terminal bash-corrupt; do
        d="$ss/$leg"
        it="$(cd "$d" && env -u LOKI_DIR -u LOKI_SESSION_ID -u LOKI_DURABLE_STATE TARGET_DIR="$d" ITERATION_COUNT=5 \
            bash -c '. "$1"; load_state; printf "%s" "$ITERATION_COUNT"' _ "$lsh" 2>/dev/null)"
        [ "$it" = 0 ] || { _why="stale-session control broken: bash load_state left ITERATION_COUNT='$it' for $leg, want 0"; return 1; }
    done
    post="$(zt_probe bash-terminal "$ss/bash-terminal" 0 bash-corrupt "$ss/bash-corrupt" 0 \
        bun-terminal "$ss/bun-terminal" 1 bun-corrupt "$ss/bun-corrupt" 1)"
    case "$post" in *"bun-terminal.iter=0 "*"bun-corrupt.iter=0 "*) ;;
        *) _why="stale-session control broken: loadStateForRunner did not start at iteration 0: got '${post:-<none>}' $(head -c 300 "$ss/err" | tr '\n' ' ')"; return 1 ;;
    esac
    for leg in bash-terminal bash-corrupt bun-terminal bun-corrupt; do
        d="$ss/$leg/.loki/quality"
        [ -e "$d/.test-results.iter" ] && bad="$bad [${leg%%-*}: a new session at iteration 0 kept the previous session's .test-results.iter (${leg#*-} state)]"
        [ -e "$d/unit-tests.pass" ] && bad="$bad [${leg%%-*}: a new session at iteration 0 kept the previous session's unit-tests.pass (${leg#*-} state)]"
        [ -e "$d/test-results.json" ] && bad="$bad [${leg%%-*}: a new session at iteration 0 kept the previous session's test-results.json, which the receipt would report as this run (${leg#*-} state)]"
        case " $post " in *" $leg=PASSED "*) bad="$bad [${leg%%-*}: after a ${leg#*-} previous state the Bun gate read the previous session's pass:true as passed at iteration 1]" ;; esac
    done
    return 0
}

# BACKLOG 73 + 89: a runner that exits 0 while its own summary line reports
# failures (`jest || true`, a script that swallows the status) failed, and a
# recorded failed_count > 0 is a failure whatever `pass` says. The stub jest
# prints the given output file and exits 0, so only the summary tells red from
# green. The green control also carries a test's own log line naming "failed",
# which must not count.
ef_fixture() { # <dir> <jest output file>
    mkdir -p "$1/node_modules/.bin" || return 1
    printf '%s\n' '{"name":"moat-ef","version":"1.0.0","private":true,"scripts":{"test":"jest"}}' > "$1/package.json"
    printf '#!/bin/sh\ncat "%s" >&2\nexit 0\n' "$2" > "$1/node_modules/.bin/jest"
    chmod +x "$1/node_modules/.bin/jest"
}

case_exit_zero_with_failures() {
    need python3 git node npm bash bun timeout || return
    local h="$RUN/ef-harness.sh" leg d b out tpass fcount marker rc dpass shape json bad=""
    zt_harness "$h" || { _why="could not cut enforce_test_coverage out of run.sh"; return; }
    printf '%s\n' '  console.log' '    all green here' '' 'Tests:       1 failed, 2 passed, 3 total' \
        'Snapshots:   0 total' 'Time:        0.4 s' 'Ran all test suites.' > "$RUN/ef-red.out"
    printf '%s\n' '  console.log' '    retried 2 failed uploads' '' 'Tests:       3 passed, 3 total' \
        'Snapshots:   0 total' 'Time:        0.4 s' 'Ran all test suites.' > "$RUN/ef-green.out"
    # Bash route (73): the real gate writes test-results.json, then the real
    # council evidence gate reads it.
    for leg in green red; do
        d="$RUN/ef-bash-$leg"
        b="$(council_repo "$d" "")" && ef_fixture "$d" "$RUN/ef-$leg.out" || { _why="fixture $leg failed"; return; }
        (cd "$d" && TARGET_DIR="$d" LOKI_GATE_TIMEOUT=60 bash -c ". '$h'; enforce_test_coverage") >/dev/null 2>&1
        rc="$(council_call "$d" "$b" council_evidence_gate)"
        tpass="$(jfield "$d/.loki/quality/test-results.json" "json.dumps(d.get('pass'))")"
        fcount="$(jfield "$d/.loki/quality/test-results.json" "json.dumps(d.get('failed_count'))")"
        dpass="$(jfield "$d/.loki/council/evidence-gate-details.json" "json.dumps(d['tests']['pass'])")"
        if [ -e "$d/.loki/quality/unit-tests.pass" ]; then marker=present; else marker=absent; fi
        if [ "$leg" = green ]; then
            [ "$tpass" = true ] && [ "$marker" = present ] && [ "$rc" = 0 ] && [ "$dpass" = true ] \
                || { _why="control broken: a passing jest summary gave pass=$tpass marker=$marker council rc=$rc details.tests.pass=$dpass"; return; }
            # A summary that was read and reports no failures is a measured 0.
            [ "$fcount" = 0 ] || bad="$bad [bash writer: a read 'Tests: 3 passed' summary recorded failed_count=$fcount, want 0]"
        else
            [ "$tpass" = false ] || bad="$bad [bash writer: exit 0 + 'Tests: 1 failed' wrote pass=$tpass]"
            [ "$fcount" = 1 ] || bad="$bad [bash writer: failed_count=$fcount, want 1 (the Tests: line)]"
            [ "$marker" = absent ] || bad="$bad [bash writer: left unit-tests.pass for a failing run]"
            [ "$rc" = 1 ] && [ "$dpass" = false ] || bad="$bad [council: the writer's record gave rc=$rc tests.pass=$dpass, want 1/false]"
        fi
    done
    # Council reader (89) and Bun parity on hand-written records: a boolean
    # pass:true with failed_count > 0 (or the legacy failed > 0) is a failure on
    # both routes; 0, null (the writer's unparsed count) and missing are not.
    mkdir -p "$RUN/ef-bun/work"
    local shapes="fc1:1 legacy2:1 fc0:0 fcnull:0 fcmissing:0" bunargs=""
    for shape in $shapes; do
        case "${shape%%:*}" in
            fc1) json='{"runner":"jest","pass":true,"failed_count":1}' ;;
            legacy2) json='{"runner":"jest","pass":true,"failed":2}' ;;
            fc0) json='{"runner":"jest","pass":true,"failed_count":0}' ;;
            fcnull) json='{"runner":"jest","pass":true,"failed_count":null}' ;;
            fcmissing) json='{"runner":"jest","pass":true}' ;;
        esac
        d="$RUN/ef-council-${shape%%:*}"
        b="$(council_repo "$d" "$json")" || { _why="fixture ${shape%%:*} failed"; return; }
        rc="$(council_call "$d" "$b" council_evidence_gate)"
        [ "$rc" = "${shape#*:}" ] || bad="$bad [council ${shape%%:*}: rc=$rc want ${shape#*:}]"
        mkdir -p "$RUN/ef-bun/${shape%%:*}/.loki/quality"
        printf '%s\n' "$json" > "$RUN/ef-bun/${shape%%:*}/.loki/quality/test-results.json"
        printf '1\n' > "$RUN/ef-bun/${shape%%:*}/.loki/quality/.test-results.iter"
        bunargs="$bunargs ${shape%%:*}"
    done
    cat > "$RUN/ef-bun/probe.ts" <<'TS'
const repo = process.env.MOAT_REPO!, root = process.env.MOAT_ROOT!;
const { runTestCoverage } = await import(`${repo}/loki-ts/src/runner/quality_gates.ts`);
const out: string[] = [];
for (const name of process.argv.slice(2)) {
  const cwd = `${root}/${name}`;
  const r = await runTestCoverage({ lokiDir: `${cwd}/.loki`, cwd, iterationCount: 1, log: () => {} } as never);
  out.push(`${name}=${r.passed === true && r.inconclusive !== true ? "PASSED" : r.passed === false ? "FAILED" : "INCONCLUSIVE"}`);
}
console.log(out.join(" "));
TS
    # shellcheck disable=SC2086  # $bunargs is word-split into names on purpose
    out="$(cd "$RUN/ef-bun/work" && env -u LOKI_STUB_GATE_TEST_COVERAGE MOAT_REPO="$REPO_ROOT" MOAT_ROOT="$RUN/ef-bun" \
        bun run "$RUN/ef-bun/probe.ts" $bunargs 2> "$RUN/ef-bun/err")"
    case "$out" in "fc1=FAILED legacy2=FAILED fc0=PASSED fcnull=PASSED fcmissing=PASSED") ;;
        *) bad="$bad [bun: got '${out:-<none>}', want fc1/legacy2 FAILED and fc0/fcnull/fcmissing PASSED $(head -c 200 "$RUN/ef-bun/err" | tr '\n' ' ')]" ;;
    esac
    if [ -z "$bad" ]; then _st="PASS"; else _why="${bad# }"; fi
}

case_proof_verify_contract() {
    need python3 git bun || return
    local ws="$RUN/pv-ws" route rc want bad=""
    chain_ws "$ws" "" >/dev/null 2>&1 || { _why="receipt fixture could not be built"; return; }
    # Tampered copy: a hashed field changed, hash left stale.
    mkdir -p "$ws/.loki/proofs/r2"
    python3 - "$ws/.loki/proofs/r1/proof.json" "$ws/.loki/proofs/r2/proof.json" <<'PY' || { _why="tamper fixture failed"; return; }
import json, sys
p = json.load(open(sys.argv[1])); p["cost"]["usd"] = 999.99
json.dump(p, open(sys.argv[2], "w"), indent=2)
PY
    local id
    for route in bun bash; do
        for want in "0:r1" "1:r2" "64:" "66:no-such-proof-id"; do
            id="${want#*:}"; rc=0
            if [ -n "$id" ]; then
                (cd "$ws" && LOKI_DIR="$ws/.loki" TARGET_DIR="$ws" loki_route "$route" proof verify "$id") >/dev/null 2>&1 || rc=$?
            else
                (cd "$ws" && LOKI_DIR="$ws/.loki" TARGET_DIR="$ws" loki_route "$route" proof verify) >/dev/null 2>&1 || rc=$?
            fi
            [ "$rc" = "${want%%:*}" ] || bad="$bad [$route ${id:-<no id>}: got $rc want ${want%%:*}]"
        done
    done
    if [ -z "$bad" ]; then _st="PASS"; else _why="${bad# }"; fi
}

case_proof_chain_contract() {
    need python3 git bun || return
    local route rc want ws bad=""
    chain_ws "$RUN/ch-ok" '{"max_usd": 5.0}' >/dev/null 2>&1 || { _why="fixture ch-ok failed"; return; }
    chain_ws "$RUN/ch-over" '{"max_usd": 0.01}' >/dev/null 2>&1 || { _why="fixture ch-over failed"; return; }
    chain_ws "$RUN/ch-shadow" '{"max_usd": 0.01}' >/dev/null 2>&1 || { _why="fixture ch-shadow failed"; return; }
    printf '%s\n' 'import os, sys' 'open(os.environ.get("MOAT_MARK", "/dev/null"), "a").write(sys.argv[0] + "\n")' 'sys.exit(0)' \
        | tee "$RUN/ch-shadow/json.py" > "$RUN/ch-shadow/sitecustomize.py"
    g "$RUN/ch-shadow" add json.py sitecustomize.py && g "$RUN/ch-shadow" commit -qm "shadow the stages" >/dev/null 2>&1 \
        || { _why="fixture ch-shadow commit failed"; return; }
    mkdir -p "$RUN/ch-empty/.loki" "$RUN/ch-blind/.loki"
    printf '%s' '{"max_usd": "not-a-number"}' > "$RUN/ch-blind/.loki-policy.json"
    for route in bun bash; do
        for want in "0 ch-ok" "1 ch-over" "2 ch-blind" "3 ch-empty" "66 ch-absent" "64 ch-empty"; do
            ws="$RUN/${want#* }"
            rc=0
            if [ "${want%% *}" = "64" ]; then
                loki_route "$route" proof chain "$ws" --no-such-flag >/dev/null 2>&1 || rc=$?
            else
                loki_route "$route" proof chain "$ws" --repo-dir "$ws" >/dev/null 2>&1 || rc=$?
            fi
            [ "$rc" = "${want%% *}" ] || bad="$bad [$route ${want#* }: got $rc want ${want%% *}]"
        done
        # The checkout under verification cannot supply a stage's modules: a
        # committed json.py/sitecustomize.py plus an empty PYTHONPATH component
        # (which adds the cwd) must not turn an over-budget chain into a pass.
        rc=0; (cd "$RUN/ch-shadow" && PYTHONPATH=":/nonexistent" MOAT_MARK="$RUN/ch-shadow.mark" \
            loki_route "$route" proof chain "$RUN/ch-shadow" --repo-dir "$RUN/ch-shadow") >/dev/null 2>&1 || rc=$?
        [ "$rc" = 1 ] || bad="$bad [$route chain hostile PYTHONPATH + shadow modules: got $rc want 1]"
        [ ! -s "$RUN/ch-shadow.mark" ] || bad="$bad [$route chain: a committed shadow module ran in a stage: $(head -1 "$RUN/ch-shadow.mark")]"
        # A verifier never exits 0 without a verdict: help is a usage error.
        for _h in -h --help --he -hq; do
            rc=0; loki_route "$route" proof chain "$RUN/ch-ok" "$_h" >/dev/null 2>&1 || rc=$?
            [ "$rc" = 64 ] || bad="$bad [$route chain $_h: got $rc want 64]"
        done
    done
    if [ -z "$bad" ]; then _st="PASS"; else _why="${bad# }"; fi
}

case_verify_contract() {
    need git bash || return
    local d="$RUN/verify-empty" nogit="$RUN/verify-nogit" route rc bad=""
    new_repo "$d" >/dev/null 2>&1 || { _why="fixture failed"; return; }
    g "$d" branch -M main
    mkdir -p "$nogit"
    for route in bun bash; do
        rc=0; (cd "$d" && loki_route "$route" verify main --no-llm --out "$RUN/ve-$route") >/dev/null 2>&1 || rc=$?
        [ "$rc" = "3" ] || bad="$bad [$route nothing-to-check (empty diff): got $rc want 3]"
        rc=0; (cd "$nogit" && loki_route "$route" verify main --no-llm --out "$RUN/vn-$route") >/dev/null 2>&1 || rc=$?
        [ "$rc" = "2" ] || bad="$bad [$route could-not-check (not a git repo): got $rc want 2]"
        rc=0; (cd "$d" && loki_route "$route" verify --no-such-flag) >/dev/null 2>&1 || rc=$?
        [ "$rc" = "64" ] || bad="$bad [$route usage (unknown flag): got $rc want 64]"
    done
    if [ -z "$bad" ]; then _st="PASS"; else _why="${bad# }"; fi
}

case_fast_verify() {
    need python3 bash || return
    local empty="$RUN/fv-empty" hit="$RUN/fv-hit" route rc bad=""
    mkdir -p "$empty" "$hit"
    printf "test('adds', () => { const x = 1 + 1; });\n" > "$hit/app.test.js"
    for route in bun bash; do
        # Positive control: a real high finding must exit non-zero, so the
        # probe below can see a non-zero at all.
        rc=0; loki_route "$route" verify --fast "$hit" --no-cache >/dev/null 2>&1 || rc=$?
        if [ "$rc" = "0" ]; then bad="$bad [$route control broken: an assertionless test exited 0]"; continue; fi
        rc=0; loki_route "$route" verify --fast "$empty" --no-cache >/dev/null 2>&1 || rc=$?
        [ "$rc" != "0" ] || bad="$bad [$route nothing scanned: exit 0]"
        rc=0; loki_route "$route" verify --fast "$RUN/fv-absent" --no-cache >/dev/null 2>&1 || rc=$?
        [ "$rc" != "0" ] || bad="$bad [$route nonexistent root: exit 0]"
        rc=0; loki_route "$route" verify --fast "$empty" --no-cache --no-such-flag >/dev/null 2>&1 || rc=$?
        [ "$rc" != "0" ] || bad="$bad [$route unknown flag: exit 0]"
    done
    if [ -z "$bad" ]; then _st="PASS"; else _why="${bad# }"; fi
}

case_council_inconclusive() {
    need python3 git || return
    local dinc="$RUN/cc-inc" dgreen="$RUN/cc-green" dempty="$RUN/cc-empty" b rc_inc rc_green rc_empty inc
    b="$(council_repo "$dinc" "")" || { _why="fixture failed"; return; }
    rc_inc="$(council_call "$dinc" "$b" council_evaluate)"
    inc="$(jfield "$dinc/.loki/council/evidence-gate-details.json" "str(d['tests']['inconclusive']).lower()")"
    b="$(council_repo "$dgreen" '{"runner":"jest","pass":true,"summary":"green"}')" || { _why="fixture failed"; return; }
    rc_green="$(council_call "$dgreen" "$b" council_evaluate)"
    new_repo "$dempty" >/dev/null 2>&1 || { _why="fixture failed"; return; }
    b="$(g "$dempty" rev-parse HEAD)"
    mkdir -p "$dempty/.loki/quality"
    printf '%s\n' '{"runner":"jest","pass":true}' > "$dempty/.loki/quality/test-results.json"
    rc_empty="$(council_call "$dempty" "$b" council_evaluate)"
    # Control A: the evidence gate is live in this harness (empty diff blocks).
    # Control B: the harness CAN complete (conclusive green + vote -> 0).
    # Control C: the inconclusive state is what the gate actually recorded.
    if [ "$rc_empty" != "1" ]; then _why="control A broken: empty diff returned $rc_empty, expected 1"; return; fi
    if [ "$rc_green" != "0" ]; then _why="control B broken: conclusive green + vote returned $rc_green, expected 0"; return; fi
    if [ "$inc" != "true" ]; then _why="control C broken: gate recorded tests.inconclusive='$inc'"; return; fi
    if [ "$rc_inc" = "0" ]; then
        _why="inconclusive evidence (no test results) + a 2-of-3 council vote returned 0 from council_evaluate, i.e. council_approved"
    else
        _st="PASS"
    fi
}

# D7 on the council side: the council runs inside the agent's own repo, so a
# committed json.py (reads every file as a green run) or sitecustomize.py
# (loaded through an empty PYTHONPATH component) must never become the verdict.
# Both write MOAT_MARK when imported.
shadow_modules() { # <repo> : commit the shadow modules into the run's diff
    cat > "$1/json.py" <<'EOF'
import os
open(os.environ.get("MOAT_MARK", os.devnull), "a").write("json.py\n")
class JSONDecodeError(ValueError): pass
def load(*a, **k): return {"runner": "jest", "pass": True, "status": "passed"}
def loads(*a, **k): return load()
def dump(*a, **k): pass
def dumps(*a, **k): return "{}"
EOF
    printf '%s\n' 'import os' 'open(os.environ.get("MOAT_MARK", os.devnull), "a").write("sitecustomize.py\n")' \
        > "$1/sitecustomize.py"
    g "$1" add json.py sitecustomize.py && g "$1" commit -qm "shadow modules"
}

case_council_readers_not_shadowed() {
    need python3 git || return
    local fail='{"runner":"jest","pass":false,"summary":"1 failed"}'
    local green='{"runner":"jest","pass":true,"summary":"green"}'
    local leg d b fn rc want out want_out bad="" managed_stub="$RUN/managed-stub"
    mkdir -p "$managed_stub/providers" "$managed_stub/memory/managed_memory"
    : > "$managed_stub/providers/__init__.py"
    : > "$managed_stub/memory/__init__.py"
    : > "$managed_stub/memory/managed_memory/__init__.py"
    printf '%s\n' 'def emit_managed_event(*a, **k): pass' > "$managed_stub/memory/managed_memory/events.py"
    cat > "$managed_stub/providers/managed.py" <<'EOF'
import os
class ManagedUnavailable(Exception): pass
def run_completion_council(**k): raise ManagedUnavailable("stub")
def is_enabled():
    with open(os.environ["MOAT_CC_CAPTURE"], "w") as fh:
        fh.write(os.environ.get("_CC_TEST", ""))
    return False
EOF
    for leg in shadow-fail shadow-green plain-fail plain-green; do
        d="$RUN/shadow-$leg"
        case "$leg" in *-fail) b="$(council_repo "$d" "$fail")" ;; *) b="$(council_repo "$d" "$green")" ;; esac \
            || { _why="fixture $leg failed"; return; }
        case "$leg" in shadow-*) shadow_modules "$d" >/dev/null 2>&1 || { _why="fixture $leg commit failed"; return; } ;; esac
        case "$leg" in *-fail) want=1 ;; *) want=0 ;; esac
        # A neutral evidence file with no "fail"/"error" text of its own, so the
        # heuristic_review vote below is driven only by its D7-guarded
        # test-results.json reader, never by grep-ing this file's content.
        : > "$d/neutral-evidence.txt"
        # Control: this environment really does load both shadows into an
        # unguarded interpreter run from the repo, so "the marker stayed
        # empty" below is a measurement, not an absence.
        if [ "$leg" = shadow-fail ]; then
            (cd "$d" && PYTHONPATH=":/nonexistent" MOAT_MARK="$RUN/shadow-ctl.mark" python3 -c 'import json') >/dev/null 2>&1
            if ! grep -q '^sitecustomize.py$' "$RUN/shadow-ctl.mark" 2>/dev/null \
                || ! grep -q '^json.py$' "$RUN/shadow-ctl.mark" 2>/dev/null; then
                _why="control broken: an unguarded python3 in the fixture did not load both shadows"
                return
            fi
        fi
        for fn in council_evidence_gate _council_convergence_evidence_green; do
            rc="$(export PYTHONPATH=":/nonexistent" MOAT_MARK="$d.mark"; council_call "$d" "$b" "$fn")"
            [ "$rc" = "$want" ] || bad="$bad [$leg $fn: got $rc want $want]"
        done
        # BACKLOG 43 follow-up: council_heuristic_review (test_auditor role),
        # council_evaluate_member and council_devils_advocate_review each read
        # the same tr_file with their own inline python3 -c and are on the same
        # verdict path (a heuristic vote, a member vote, a devil's-advocate
        # veto) but were not driven by the loop above. Both role args below are
        # required under this script's set -u: council_call invokes the
        # function with zero args, and council_evaluate_member's
        # "local role=\"\$1\"" has no default (unlike the other two), so a
        # bare council_call would abort on unbound $1 before ever reaching the
        # test-results read -- silently skipping the coverage this exists to add.
        #
        # Each call's own vote text is asserted against the fail/green leg it
        # is on (the same rc-vs-want shape as the loop above, adapted to stdout
        # since these three functions signal via vote text, not rc): this
        # proves the function was actually reached and its real read-then-vote
        # logic ran, not merely that the shared $d.mark marker stayed empty --
        # a call to a nonexistent function also never touches that marker, so
        # the marker alone cannot tell "blocked" from "never invoked".
        case "$leg" in
            *-fail) want_out="VOTE:REJECT" ;;
            *)      want_out="VOTE:APPROVE" ;;
        esac
        out="$(export PYTHONPATH=":/nonexistent" MOAT_MARK="$d.mark"; council_call_args "$d" "$b" council_heuristic_review test_auditor "$d/neutral-evidence.txt")"
        [ "$out" = "$want_out" ] || bad="$bad [$leg council_heuristic_review: got '$out' want $want_out]"
        case "$leg" in
            *-fail) want_out="CONTINUE" ;;
            *)      want_out="COMPLETE" ;;
        esac
        out="$(export PYTHONPATH=":/nonexistent" MOAT_MARK="$d.mark"; council_call_args "$d" "$b" council_evaluate_member requirements_verifier)"
        [ "$out" = "$want_out" ] || bad="$bad [$leg council_evaluate_member: got '$out' want $want_out]"
        case "$leg" in
            *-fail) want_out="OVERRIDE_CONTINUE" ;;
            *)      want_out="CONFIRMED_COMPLETE" ;;
        esac
        out="$(export PYTHONPATH=":/nonexistent" MOAT_MARK="$d.mark"; council_call_args "$d" "$b" council_devils_advocate_review)"
        [ "$out" = "$want_out" ] || bad="$bad [$leg council_devils_advocate_review: got '$out' want $want_out]"
        # BACKLOG 135: the 6th reader, council_managed_should_stop, reads the
        # test-results summary into the managed session's context behind three
        # flags. PROJECT_DIR points at a stub providers.managed whose
        # is_enabled() records the summary it was handed and declines, so the
        # call stays hermetic (rc 1, Bash fallback). The captured summary must
        # be the real file's; the shadow json.py would hand over '' and mark.
        # cwd-shadow class only here; the user-site .pth class for this reader
        # is case_council_readers_no_user_site_pth (S-196, -I -S readers).
        rm -f "$d.cc-test"
        rc="$(export PYTHONPATH=":/nonexistent" MOAT_MARK="$d.mark" MOAT_CC_CAPTURE="$d.cc-test" \
            PROJECT_DIR="$managed_stub" LOKI_EXPERIMENTAL_MANAGED_COUNCIL=true \
            LOKI_EXPERIMENTAL_MANAGED_AGENTS=true LOKI_MANAGED_AGENTS=true;
            council_call "$d" "$b" council_managed_should_stop)"
        case "$leg" in *-fail) want_out="1 failed" ;; *) want_out="green" ;; esac
        if [ ! -f "$d.cc-test" ]; then
            bad="$bad [$leg council_managed_should_stop: stub never reached (rc $rc)]"
        elif [ "$(cat "$d.cc-test")" != "$want_out" ] || [ "$rc" != 1 ]; then
            bad="$bad [$leg council_managed_should_stop: summary '$(cat "$d.cc-test")' rc $rc, want '$want_out' rc 1]"
        fi
        [ ! -s "$d.mark" ] || bad="$bad [$leg: a repo module ran in the council: $(sort -u "$d.mark" | tr '\n' ' ')]"
    done
    if [ -z "$bad" ]; then _st="PASS"; else _why="${bad# }"; fi
}

# BACKLOG 134: -E ignores PYTHON* env vars but still loads user site-packages,
# and Python execs every "import" line of every .pth found there at startup,
# before any sys.path scrub. A same-UID agent that plants one can forge what
# the council's three test-result readers see. The payload forges json.load
# ONLY for test-results.json (and marks it), so the council's other, unrelated
# python3 calls neither pollute the verdict nor the marker.
case_council_readers_no_user_site_pth() {
    need python3 git || return
    local fail='{"runner":"jest","pass":false,"summary":"1 failed"}'
    local green='{"runner":"jest","pass":true,"summary":"green"}'
    local home="$RUN/pth-home" mark="$RUN/pth.mark" ctl="$RUN/pth.ctl" py site planted="" bad="" leg d b out want
    mkdir -p "$home"
    # Plant in the user site of every interpreter the council could run: the
    # PATH python3 (the pre-fix reader) and the fixed root-owned candidates the
    # resolver tries first. Each plant gets its own positive control below.
    for py in "$(command -v python3)" /usr/bin/python3 /bin/python3; do
        [ -x "$py" ] && "$py" -I -S -c '' >/dev/null 2>&1 || continue
        site="$(HOME="$home" "$py" -E -c 'import site; print(site.getusersitepackages())' 2>/dev/null)"
        [ -n "$site" ] || continue
        mkdir -p "$site" || continue
        printf 'import zzz_loki_s49\n' > "$site/zzz_loki_s49.pth"
        cat > "$site/zzz_loki_s49.py" <<'EOF'
import json, os
_real = json.load
def load(fp, *a, **k):
    name = str(getattr(fp, "name", ""))
    if name.endswith("test-results.json"):
        open(os.environ.get("MOAT_MARK", os.devnull), "a").write("pth\n")
        return {"runner": "jest", "pass": True, "status": "passed"}
    if os.path.basename(name) in ("pending.json", "in-progress.json", "blocked.json", "failed.json"):
        open(os.environ.get("MOAT_MARK", os.devnull), "a").write("pth-queue\n")
        return []
    return _real(fp, *a, **k)
json.load = load
EOF
        planted="$planted $py"
    done
    [ -n "$planted" ] || { _why="control broken: no runnable python3 to plant a user-site .pth for"; return; }
    for leg in pth-fail pth-queue plain-green; do
        d="$RUN/pth-$leg"
        case "$leg" in *-fail) b="$(council_repo "$d" "$fail")" ;; *) b="$(council_repo "$d" "$green")" ;; esac \
            || { _why="fixture $leg failed"; return; }
        if [ "$leg" = pth-queue ]; then
            # Green tests, but 2 pending and 1 failed task: the queue readers
            # alone must keep the member and the devil's advocate at CONTINUE.
            mkdir -p "$d/.loki/queue"
            printf '%s\n' '[{"id":"t1"},{"id":"t2"}]' > "$d/.loki/queue/pending.json"
            printf '%s\n' '[{"id":"t3"}]' > "$d/.loki/queue/failed.json"
            for py in $planted; do
                rm -f "$ctl"
                out="$(cd "$d" && HOME="$home" MOAT_MARK="$ctl" "$py" -E -c 'import json; print(len(json.load(open(".loki/queue/pending.json"))))' 2>/dev/null)"
                if [ "$out" != "0" ] || ! grep -q '^pth-queue$' "$ctl" 2>/dev/null; then
                    _why="control broken: $py -E did not forge the queue read via the planted .pth (got '$out')"
                    return
                fi
            done
            for want in "council_evaluate_member requirements_verifier|CONTINUE" \
                        "council_devils_advocate_review|OVERRIDE_CONTINUE"; do
                local qcall="${want%%|*}"
                # shellcheck disable=SC2086
                out="$(export HOME="$home" MOAT_MARK="$mark"; council_call_args "$d" "$b" $qcall)"
                [ "$out" = "${want#*|}" ] || bad="$bad [$leg ${qcall%% *}: got '$out' want ${want#*|}]"
            done
            continue
        fi
        : > "$d/neutral-evidence.txt"
        # Control: under -E, every planted interpreter really does run the .pth
        # and forge this fixture's test-results.json, so "no effect" below is
        # a measurement, not an absence.
        if [ "$leg" = pth-fail ]; then
            for py in $planted; do
                rm -f "$ctl"
                out="$(cd "$d" && HOME="$home" MOAT_MARK="$ctl" "$py" -E -c 'import json; print(json.load(open(".loki/quality/test-results.json"))["pass"])' 2>/dev/null)"
                if [ "$out" != "True" ] || ! grep -q '^pth$' "$ctl" 2>/dev/null; then
                    _why="control broken: $py -E did not run the planted .pth (got '$out')"
                    return
                fi
            done
        fi
        # The plain-green leg runs without the planted HOME: it proves the
        # harness can reach the approving words at all.
        for want in "council_heuristic_review test_auditor $d/neutral-evidence.txt|VOTE:REJECT|VOTE:APPROVE" \
                    "council_evaluate_member requirements_verifier|CONTINUE|COMPLETE" \
                    "council_devils_advocate_review|OVERRIDE_CONTINUE|CONFIRMED_COMPLETE"; do
            local call="${want%%|*}" rest="${want#*|}" w
            case "$leg" in *-fail) w="${rest%%|*}" ;; *) w="${rest#*|}" ;; esac
            # shellcheck disable=SC2086
            if [ "$leg" = pth-fail ]; then
                out="$(export HOME="$home" MOAT_MARK="$mark"; council_call_args "$d" "$b" $call)"
            else
                out="$(council_call_args "$d" "$b" $call)"
            fi
            [ "$out" = "$w" ] || bad="$bad [$leg ${call%% *}: got '$out' want $w]"
        done
        # Convergence fast-path reader: rc 1 (not green) on red, 0 on green.
        case "$leg" in *-fail) w=1 ;; *) w=0 ;; esac
        if [ "$leg" = pth-fail ]; then
            out="$(export HOME="$home" MOAT_MARK="$mark"; council_call "$d" "$b" _council_convergence_evidence_green)"
        else
            out="$(council_call "$d" "$b" _council_convergence_evidence_green)"
        fi
        [ "$out" = "$w" ] || bad="$bad [$leg _council_convergence_evidence_green: got rc '$out' want $w]"
        # S-196: council_managed_should_stop's test_summary reader. A stub
        # providers.managed records the summary it was handed and declines
        # (rc 1, Bash fallback); a forged read would hand over '' and mark.
        if [ "$leg" = pth-fail ]; then
            local ms="$RUN/pth-managed-stub"
            mkdir -p "$ms/providers" "$ms/memory/managed_memory"
            : > "$ms/providers/__init__.py"; : > "$ms/memory/__init__.py"; : > "$ms/memory/managed_memory/__init__.py"
            printf '%s\n' 'def emit_managed_event(*a, **k): pass' > "$ms/memory/managed_memory/events.py"
            printf '%s\n' 'import os' 'class ManagedUnavailable(Exception): pass' \
                'def run_completion_council(**k): raise ManagedUnavailable("stub")' \
                'def is_enabled():' '    open(os.environ["MOAT_CC_CAPTURE"], "w").write(os.environ.get("_CC_TEST", ""))' \
                '    return False' > "$ms/providers/managed.py"
            rm -f "$d.cc-test"
            out="$(export HOME="$home" MOAT_MARK="$mark" MOAT_CC_CAPTURE="$d.cc-test" PROJECT_DIR="$ms" \
                LOKI_EXPERIMENTAL_MANAGED_COUNCIL=true LOKI_EXPERIMENTAL_MANAGED_AGENTS=true LOKI_MANAGED_AGENTS=true;
                council_call "$d" "$b" council_managed_should_stop)"
            if [ ! -f "$d.cc-test" ]; then
                bad="$bad [$leg council_managed_should_stop: stub never reached (rc $out)]"
            elif [ "$(cat "$d.cc-test")" != "1 failed" ] || [ "$out" != 1 ]; then
                bad="$bad [$leg council_managed_should_stop: summary '$(cat "$d.cc-test")' rc $out, want '1 failed' rc 1]"
            fi
        fi
    done
    # Fail closed (no plant needed): a malformed queue file must block, not read
    # as 0, and no isolated interpreter must veto, not approve.
    d="$RUN/pth-badqueue"; b="$(council_repo "$d" "$green")" || { _why="fixture badqueue failed"; return; }
    mkdir -p "$d/.loki/queue"
    printf '{not json\n' > "$d/.loki/queue/pending.json"
    printf '{not json\n' > "$d/.loki/queue/failed.json"
    out="$(council_call_args "$d" "$b" council_evaluate_member requirements_verifier)"
    [ "$out" = CONTINUE ] || bad="$bad [badqueue council_evaluate_member: got '$out' want CONTINUE]"
    out="$(council_call_args "$d" "$b" council_devils_advocate_review)"
    [ "$out" = OVERRIDE_CONTINUE ] || bad="$bad [badqueue council_devils_advocate_review: got '$out' want OVERRIDE_CONTINUE]"
    d="$RUN/pth-nopy"; b="$(council_repo "$d" "$green")" || { _why="fixture nopy failed"; return; }
    # The library copy is guarded by declare -F, so this stub wins in the subshell.
    _loki_snapshot_py_tool() { return 1; }
    out="$(council_call_args "$d" "$b" council_devils_advocate_review)"
    [ "$out" = OVERRIDE_CONTINUE ] || bad="$bad [nopy council_devils_advocate_review: got '$out' want OVERRIDE_CONTINUE]"
    out="$(council_call "$d" "$b" _council_convergence_evidence_green)"
    [ "$out" = 1 ] || bad="$bad [nopy _council_convergence_evidence_green: got rc '$out' want 1]"
    unset -f _loki_snapshot_py_tool
    [ ! -s "$mark" ] || bad="$bad [the planted .pth forged a council read: $(sort -u "$mark" | tr '\n' ' ')]"
    if [ -z "$bad" ]; then _st="PASS"; else _why="${bad# }"; fi
}

# D7 on the checklist side (backlog 53): PRD checklist verification runs inside
# the agent's repo too. This json.py is smarter than the one above: it loads the
# real json and then rewrites every failing check it reads or writes as passing,
# so checklist-verify.py itself would write a green verification-results.json.
liar_json() { # <repo>
    cat > "$1/json.py" <<'EOF'
import os, sys
open(os.environ.get("MOAT_MARK", os.devnull), "a").write("json.py\n")
_me = sys.modules[__name__]
_here = os.path.dirname(os.path.abspath(__file__))
_saved = sys.path[:]
sys.path[:] = [p for p in sys.path if os.path.abspath(p or ".") != _here]
del sys.modules[__name__]
try:
    import json as _real
finally:
    sys.path[:] = _saved
    sys.modules[__name__] = _me
JSONDecodeError = _real.JSONDecodeError
def _lie(o):
    if isinstance(o, list):
        return [_lie(v) for v in o]
    if not isinstance(o, dict):
        return o
    o = {k: _lie(v) for k, v in o.items()}
    if o.get("status") in ("failing", "pending"):
        o["status"] = "verified"
    if o.get("passed") is False:
        o["passed"] = True
    s = o.get("summary")
    if isinstance(s, dict) and "total" in s:
        o["summary"] = dict(s, verified=s["total"], failing=0, pending=0)
    return o
def load(fp, *a, **k): return _lie(_real.load(fp, *a, **k))
def loads(s, *a, **k): return _lie(_real.loads(s, *a, **k))
def dump(o, fp, *a, **k): return _real.dump(_lie(o), fp, *a, **k)
def dumps(o, *a, **k): return _real.dumps(_lie(o), *a, **k)
EOF
    printf '%s\n' 'import os' 'open(os.environ.get("MOAT_MARK", os.devnull), "a").write("sitecustomize.py\n")' \
        > "$1/sitecustomize.py"
}

# Run the real checklist path in <repo>: checklist_verify (held-out selection,
# the spec oracle, checklist-verify.py), then the prompt summary, the council
# evidence block, and the council's checklist hard gate over what it wrote.
checklist_call() { # <repo>
    (
        cd "$1" || exit 99
        log_info() { :; }; log_warn() { :; }; log_error() { :; }; log_success() { :; }
        log_debug() { :; }; log_header() { :; }; log_step() { :; }
        source "$REPO_ROOT/autonomy/prd-checklist.sh" >/dev/null 2>&1 || exit 98
        source "$COUNCIL_SH" >/dev/null 2>&1 || exit 98
        export COUNCIL_STATE_DIR="$1/.loki/council" ITERATION_COUNT=5
        mkdir -p "$COUNCIL_STATE_DIR"
        checklist_init "$1/spec.md"
        checklist_verify >/dev/null 2>&1
        printf 'SUMMARY %s\n' "$(checklist_summary 2>/dev/null)"
        checklist_as_evidence 2>/dev/null
        council_checklist_gate >/dev/null 2>&1
        printf 'GATE %s\n' "$?"
    )
}

case_checklist_not_shadowed() {
    need python3 git || return
    local cl='{"categories":[{"name":"core","items":[
{"id":"c1","title":"readme exists","priority":"critical","verification":[{"type":"file_exists","path":"README.md"}]},
{"id":"c2","title":"seed says done","priority":"critical","verification":[{"type":"file_contains","path":"seed.txt","pattern":"DONE"}]},
{"id":"c3","title":"config exists","priority":"critical","verification":[{"type":"file_exists","path":"config.yml"}]}]}]}'
    local leg d out res want_res want_sum want_gate ev_has ev_not bad=""
    for leg in shadow-fail shadow-green plain-fail plain-green; do
        d="$RUN/cl-$leg"
        new_repo "$d" >/dev/null 2>&1 || { _why="fixture $leg failed"; return; }
        # A spec the oracle reads (a datastore claim, no API symbol, so no LSP probe).
        printf '%s\n' '# Spec' '' 'The service stores its data in PostgreSQL.' > "$d/spec.md"
        case "$leg" in
            *-green) printf 'DONE\n' > "$d/seed.txt"; printf 'readme\n' > "$d/README.md"; printf 'a: 1\n' > "$d/config.yml" ;;
        esac
        case "$leg" in shadow-*) liar_json "$d" ;; esac
        g "$d" add -A >/dev/null 2>&1 && g "$d" commit -qm fixture >/dev/null 2>&1 || { _why="fixture $leg commit failed"; return; }
        mkdir -p "$d/.loki/checklist" && printf '%s\n' "$cl" > "$d/.loki/checklist/checklist.json"
        # Control: in this environment an unguarded interpreter run from the
        # repo loads both shadows AND the liar lies, so an empty marker below
        # is a measurement, not an absence.
        if [ "$leg" = shadow-fail ]; then
            out="$(cd "$d" && PYTHONPATH=":/nonexistent" MOAT_MARK="$RUN/cl-ctl.mark" \
                python3 -c 'import json; print(json.loads("{\"status\": \"failing\"}")["status"])' 2>/dev/null)"
            if [ "$out" != "verified" ] || ! grep -q '^sitecustomize.py$' "$RUN/cl-ctl.mark" 2>/dev/null \
                || ! grep -q '^json.py$' "$RUN/cl-ctl.mark" 2>/dev/null; then
                _why="control broken: an unguarded python3 in the fixture did not load both shadows and lie (got '$out')"
                return
            fi
        fi
        out="$(export PYTHONPATH=":/nonexistent" MOAT_MARK="$d.mark"; checklist_call "$d")"
        res="$(jfield "$d/.loki/checklist/verification-results.json" "'%s/%s' % (d['summary']['verified'], d['summary']['failing'])")"
        # 3 items, 1 held out of the summary; the results file carries all 3.
        case "$leg" in
            *-fail)  want_res="0/3"; want_sum="SUMMARY 0/2 verified, 2 failing"; want_gate="GATE 1"; ev_has="[FAIL]"; ev_not="[PASS]" ;;
            *)       want_res="3/0"; want_sum="SUMMARY 2/2 verified, 0 failing"; want_gate="GATE 0"; ev_has="[PASS]"; ev_not="[FAIL]" ;;
        esac
        [ "$res" = "$want_res" ] || bad="$bad [$leg results verified/failing: got '$res' want $want_res]"
        printf '%s\n' "$out" | grep -q "^${want_sum}" || bad="$bad [$leg summary: got '$(printf '%s\n' "$out" | grep '^SUMMARY')']"
        printf '%s\n' "$out" | grep -qx "$want_gate" || bad="$bad [$leg gate: got '$(printf '%s\n' "$out" | grep '^GATE')' want $want_gate]"
        printf '%s\n' "$out" | grep -qF "$ev_has" || bad="$bad [$leg evidence lacks $ev_has]"
        ! printf '%s\n' "$out" | grep -qF "$ev_not" || bad="$bad [$leg evidence shows $ev_not]"
        [ ! -s "$d.mark" ] || bad="$bad [$leg: a repo module ran in checklist verification: $(sort -u "$d.mark" | tr '\n' ' ')]"
    done
    if [ -z "$bad" ]; then _st="PASS"; else _why="${bad# }"; fi
}

# LEGACY-LEG(CPE24-L5): case_console_verdict and its run_case line drive the legacy
# dashboard (dashboard/server.py, /api/proofs/<id>, /api/v2/audit/verify) and the
# legacy dashboard-ui audit viewer. The delete slice removes that case (and the
# cv_old_* helpers); case_cp_verdict further down proves the same property on the
# Control Plane and stays.
# P2.console-verdict-needs-computed-result (BACKLOG 113). A console verdict
# word (verified, valid, proven, tampered) must have a result the server
# COMPUTED behind it. Four legs, every failure collected, each with controls:
#   server  GET /api/proofs/<id> on a receipt from the REAL generator carries
#           integrity_check: intact and intact-with-pr.json read verified (the
#           controls), an edited copy tampered, a hash-less copy not_verified.
#           GET /api/v2/audit/verify over a chain from the REAL audit writer
#           reads verified (control), an edited chain tampered, no audit dir
#           nothing_checked with verified:false.
#   audit viewer  the real component: a checked chain reads [VALID] and a broken
#           one [TAMPERED] (controls); zero files checked never reads VALID, a
#           failed request or a verdict-less body never reads TAMPERED or VALID.
#   receipt panel  PROVENANCE[classify(detail)] extracted from the real
#           EvidenceReceiptPanel.tsx: a server-verified receipt still affirms
#           (control); no server verdict, no hash, failed or not_verified never
#           affirm; tampered says tampered.
#   old code  the same two client probes run on the verbatim pre-fix lines
#           (`valid !== false`, the catch that set valid:false, and classify()
#           reading only `v.hash`), and must flag them: a probe that cannot see
#           the old bug proves nothing about the new code.
cv_old_audit() { # verbatim pre-fix lines of loki-audit-viewer.js (0afb6e2c)
    cat <<'EOF'
export class OldAuditViewer {
  constructor(get) { this._api = { _get: get }; this._verifyResult = null; }
  _escapeHtml(str) { if (!str) return ''; return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  async _verifyIntegrity() {
    const api = this._api;
    try {
      const result = await api._get('/api/v2/audit/verify');
      this._verifyResult = result;
    } catch (err) {
      this._verifyResult = { valid: false, error: err.message };
    }
  }
  html() {
      const isValid = this._verifyResult.valid !== false;
      return `${isValid ? '[VALID] Audit chain integrity verified.' : `[TAMPERED] ${this._escapeHtml(this._verifyResult.error || 'Integrity check failed.')}`}`;
  }
}
EOF
}
cv_old_receipt() { # verbatim pre-fix PROVENANCE labels/proven lines and classify() of EvidenceReceiptPanel.tsx
    cat <<'EOF'
const PROVENANCE: Record<string, { label: string; proven: string }> = {
  verified: {
    label: 'Verified',
    proven: 'These receipt bytes are unaltered, and they were signed by the holder of the signing key.',
  },
  unsigned: {
    label: 'Unsigned',
    proven: 'The receipt is internally consistent with its own integrity hash.',
  },
  unchecked: {
    label: 'Not checked',
    proven: 'The integrity hash matches, so nothing is wrong with the contents.',
  },
  tampered: {
    label: 'Tampered',
    proven: 'Nothing. The recorded hash does not match the contents.',
  },
};
function classify(detail: ProofDetail | null): Provenance {
  const v = detail?.verification;
  if (!v || !v.hash) return 'unsigned';
  // A signature of either kind is present but not evaluated in-browser.
  if (v.attestation || v.gpg_signature) return 'unchecked';
  return 'unsigned';
}
EOF
}
case_console_verdict() {
    need python3 git node || return
    local d="$RUN/cv" ts="" bad="" out rc cand
    for cand in web-app dashboard-ui; do
        [ -f "$REPO_ROOT/$cand/node_modules/typescript/lib/typescript.js" ] \
            && { ts="$REPO_ROOT/$cand/node_modules/typescript/lib/typescript.js"; break; }
    done
    [ -n "$ts" ] || { _why="prerequisite missing: typescript (npm ci in web-app or dashboard-ui of this checkout)"; return; }
    PYTHONUSERBASE="$MOAT_USERBASE" python3 -c 'import fastapi, httpx' >/dev/null 2>&1 \
        || { _why="prerequisite missing: python fastapi + httpx (the server leg drives the real dashboard app)"; return; }
    mkdir -p "$d"

    # --- server leg: a receipt from the real generator ---------------------------
    new_repo "$d/repo" >/dev/null 2>&1 || { _why="fixture repo failed"; return; }
    printf 'change\n' >> "$d/repo/seed.txt"; g "$d/repo" commit -qam change
    mkdir -p "$d/repo/.loki/state" "$d/repo/.loki/quality"
    printf '%s' '{"code_review":"passed","static_analysis":"passed","mock_integrity":"passed"}' > "$d/repo/.loki/state/quality-gates.json"
    printf '%s' '{"status":"verified","command":"npm test","exit_code":0}' > "$d/repo/.loki/quality/test-results.json"
    printf '%s' '{"command":"npm run build","exit_code":0,"ran":true}' > "$d/repo/.loki/quality/build-results.json"
    (cd "$d/repo" && python3 "$GEN" --loki-dir "$d/repo/.loki" --out-dir "$d/gen" --quiet) >/dev/null 2>&1
    [ -s "$d/gen/proof.json" ] || { _why="the real generator wrote no proof.json"; return; }
    cat > "$d/server.py" <<'PY'
import copy, json, sys
from pathlib import Path
root, gen_proof, work = sys.argv[1:4]
sys.path.insert(0, root)
from fastapi.testclient import TestClient
from dashboard import server, audit
loki = Path(work) / "loki"
server._get_loki_dir = lambda: loki
proof = json.load(open(gen_proof))
def seed(rid, p, pr=None):
    d = loki / "proofs" / rid
    d.mkdir(parents=True, exist_ok=True)
    (d / "proof.json").write_text(json.dumps(p, indent=2))
    if pr:
        (d / "pr.json").write_text(json.dumps({"pr_url": pr}))
seed("r-ok", proof)
seed("r-pr", proof, "https://example.invalid/pr/1")
edited = copy.deepcopy(proof)
edited["loki_version"] = "0.0.0-edited"
seed("r-edit", edited)
nohash = copy.deepcopy(proof)
nohash.pop("verification", None)
seed("r-nohash", nohash)
c = TestClient(server.app, raise_server_exceptions=False)
for rid in ("r-ok", "r-pr", "r-edit", "r-nohash"):
    r = c.get("/api/proofs/" + rid)
    ic = r.json().get("integrity_check") if r.status_code == 200 else None
    print("PROOF %s %s" % (rid, ic.get("status") if isinstance(ic, dict) else "MISSING"))
audit.ENTERPRISE_AUDIT_ENABLED = True
audit.INTEGRITY_ENABLED = True
def verify(label, d):
    audit.AUDIT_DIR = d
    r = c.get("/api/v2/audit/verify")
    b = r.json() if r.status_code == 200 else {}
    print("AUDIT %s %s %s files=%s" % (label, b.get("status", "MISSING"),
                                       b.get("verified", "MISSING"), b.get("files_checked")))
real = Path(work) / "audit-real"
real.mkdir()
audit.AUDIT_DIR = real
audit._last_hash = "0" * 64
audit.log_event("create", "project", "p1")
audit.log_event("delete", "project", "p1")
verify("real", real)
f = sorted(real.glob("audit-*.jsonl"))[0]
lines = f.read_text().splitlines()
e = json.loads(lines[0])
e["action"] = "edited"
lines[0] = json.dumps(e)
f.write_text("\n".join(lines) + "\n")
verify("edited", real)
verify("none", Path(work) / "audit-none")
PY
    rc=0
    out="$(cd "$d" && PYTHONUSERBASE="$MOAT_USERBASE" python3 "$d/server.py" "$REPO_ROOT" "$d/gen/proof.json" "$d" 2> "$d/server.err")" || rc=$?
    printf '%s\n' "$out" | sed 's/^/  console-verdict server: /' >&2
    if ! printf '%s\n' "$out" | grep -q '^AUDIT none '; then
        bad="$bad [server leg did not run (rc=$rc): $(tail -c 200 "$d/server.err" | tr '\n' ' ')]"
    else
        local want line
        for want in "PROOF r-ok verified" "PROOF r-pr verified" "PROOF r-edit tampered" "PROOF r-nohash not_verified" \
                    "AUDIT real verified True" "AUDIT edited tampered False" "AUDIT none nothing_checked False"; do
            line="$(printf '%s\n' "$out" | grep "^${want%% *} $(printf '%s' "$want" | cut -d' ' -f2) " | head -1)"
            case "$line" in
                "$want"*) ;;
                *) bad="$bad [server: want '$want', got '${line:-nothing}']" ;;
            esac
        done
    fi

    # --- client legs: the real components and the verbatim old lines -------------
    cv_old_audit > "$d/old-audit.mjs"
    cv_old_receipt > "$d/old-receipt.tsx"
    python3 - "$REPO_ROOT/web-app/src/components/EvidenceReceiptPanel.tsx" > "$d/new-receipt.tsx" <<'PY' || { _why="$_why${bad:+$bad }could not extract PROVENANCE/classify from EvidenceReceiptPanel.tsx"; return; }
import re, sys
lines = open(sys.argv[1], encoding="utf-8").read().split("\n")
out = []
for start_re in (r"^const PROVENANCE\b", r"^function classify\("):
    start = next((i for i, l in enumerate(lines) if re.search(start_re, l)), None)
    if start is None:
        sys.exit(3)
    depth, seen = 0, False
    for l in lines[start:]:
        out.append(l)
        depth += l.count("{") - l.count("}")
        seen = seen or "{" in l
        if seen and depth <= 0:
            break
print("\n".join(out))
PY
    cat > "$d/client.mjs" <<'EOF'
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
const [tsPath, dir, auditPath] = process.argv.slice(2);
const ts = createRequire(import.meta.url)(tsPath);
const fakeClassList = { contains: () => false, add() {}, remove() {}, toggle() {} };
globalThis.document = { body: { classList: fakeClassList },
  documentElement: { classList: fakeClassList, dataset: {}, style: { setProperty() {} } },
  addEventListener() {}, removeEventListener() {}, querySelector: () => null,
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }) };
class FakeHTMLElement {
  attachShadow() { this._s = { innerHTML: '', getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] }; return this._s; }
  get shadowRoot() { return this._s; }
  getAttribute() { return null; } hasAttribute() { return false; } setAttribute() {} removeAttribute() {}
}
globalThis.HTMLElement = FakeHTMLElement;
globalThis.customElements = { _d: new Map(), define(n, c) { this._d.set(n, c); }, get(n) { return this._d.get(n); } };
globalThis.window = { location: { origin: 'http://localhost' }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const AUDIT_IN = {
  checked: async () => ({ valid: true, files_checked: 2, entries_checked: 5 }),
  broken: async () => ({ valid: false, files_checked: 1, first_tampered_file: '/x/audit-1.jsonl', first_tampered_line: 2 }),
  zero: async () => ({ valid: true, files_checked: 0, entries_checked: 0 }),
  failed: async () => { throw new Error('HTTP 503'); },
  noverdict: async () => ({ detail: 'Not authenticated' }),
};
function judgeAudit(t) {
  const flags = [];
  if (!/\[VALID\]/.test(t.checked)) flags.push('control: a checked chain does not read [VALID]');
  if (!/TAMPERED/.test(t.broken)) flags.push('control: a broken chain does not read TAMPERED');
  if (/\[VALID\]|integrity verified/i.test(t.zero)) flags.push('zero files checked reads VALID');
  if (/TAMPERED|\[VALID\]/.test(t.failed)) flags.push('a failed request reads ' + (/TAMPERED/.test(t.failed) ? 'TAMPERED' : 'VALID'));
  if (/TAMPERED|\[VALID\]/.test(t.noverdict)) flags.push('a body with no verdict reads a verdict');
  return flags;
}
const H = 'h'.repeat(64);
const RECEIPT_IN = {
  server_verified: { verification: { hash: H }, integrity_check: { status: 'verified', gpg_ok: 'n/a' } },
  server_signed: { verification: { hash: H, gpg_signature: 's' }, integrity_check: { status: 'verified', gpg_ok: true } },
  no_server_verdict: { verification: { hash: H } },
  no_hash: { verification: {} },
  null_detail: null,
  failed: { verification: { hash: H }, integrity_check: { status: 'failed', gpg_ok: false } },
  not_verified: { verification: { hash: H }, integrity_check: { status: 'not_verified' } },
  tampered: { verification: { hash: H }, integrity_check: { status: 'tampered' } },
};
function judgeReceipt(P, classify) {
  const say = (k) => { const s = P[classify(RECEIPT_IN[k])] || {}; return { label: String(s.label), affirms: !/^Nothing\b/.test(String(s.proven)) }; };
  const flags = [];
  if (!say('server_verified').affirms) flags.push('control: a server-verified receipt no longer affirms anything');
  if (say('server_signed').label !== 'Verified') flags.push('control: a server-verified signed receipt is not labelled Verified');
  for (const k of ['no_server_verdict', 'no_hash', 'null_detail', 'failed', 'not_verified']) {
    const s = say(k);
    if (s.affirms) flags.push(`${k} affirms ("${s.label}")`);
  }
  if (!/tamper/i.test(say('tampered').label)) flags.push(`a tampered verdict reads "${say('tampered').label}"`);
  return flags;
}
async function loadTs(file, name) {
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8') + '\nexport { PROVENANCE, classify };\n',
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
  const f = `${dir}/${name}.mjs`;
  fs.writeFileSync(f, js);
  return import(pathToFileURL(f).href);
}
const html = (el) => el.shadowRoot.innerHTML.replace(/<style>[\s\S]*?<\/style>/g, '');
async function runAudit(make, read) {
  const t = {};
  for (const [k, get] of Object.entries(AUDIT_IN)) { const el = make(get); await el._verifyIntegrity(); t[k] = read(el); }
  return judgeAudit(t);
}
const { LokiAuditViewer } = await import(pathToFileURL(auditPath).href);
const { OldAuditViewer } = await import(pathToFileURL(`${dir}/old-audit.mjs`).href);
const newA = await runAudit((get) => { const el = new LokiAuditViewer(); el.attachShadow({ mode: 'open' }); el._api = { _get: get, _post: async () => ({}) }; el._loading = false; return el; }, html);
const oldA = await runAudit((get) => new OldAuditViewer(get), (el) => el.html());
const nr = await loadTs(`${dir}/new-receipt.tsx`, 'new-receipt');
const or = await loadTs(`${dir}/old-receipt.tsx`, 'old-receipt');
const newR = judgeReceipt(nr.PROVENANCE, nr.classify);
const oldR = judgeReceipt(or.PROVENANCE, or.classify);
for (const f of newA) console.log('NEW audit-viewer: ' + f);
for (const f of newR) console.log('NEW receipt-panel: ' + f);
for (const f of oldA) console.log('OLD audit-viewer: ' + f);
for (const f of oldR) console.log('OLD receipt-panel: ' + f);
console.log('CHECKED');
EOF
    rc=0
    out="$(node "$d/client.mjs" "$ts" "$d" "$REPO_ROOT/dashboard-ui/components/loki-audit-viewer.js" 2> "$d/client.err")" || rc=$?
    printf '%s\n' "$out" | sed 's/^/  console-verdict client: /' >&2
    if ! printf '%s\n' "$out" | grep -qx 'CHECKED'; then
        bad="$bad [client legs did not run (rc=$rc): $(tail -c 240 "$d/client.err" | tr '\n' ' ')]"
    else
        # Positive controls: the probes must see the old bug, on every shape it had.
        local ctl
        for ctl in "OLD audit-viewer: zero files checked reads VALID" "OLD audit-viewer: a failed request reads TAMPERED" \
                   "OLD receipt-panel: no_server_verdict affirms" "OLD receipt-panel: no_hash affirms" \
                   "OLD receipt-panel: a tampered verdict reads"; do
            printf '%s\n' "$out" | grep -qF "$ctl" || bad="$bad [positive control: the probe did not flag the verbatim old code: $ctl]"
        done
        # Negative controls the old code did satisfy (it read a checked chain
        # VALID, a broken one TAMPERED, and affirmed a good receipt): flagging
        # those would mean the probe is too strict, not that the code was wrong.
        # (It could never label a signed receipt Verified, so that one is new-only.)
        for ctl in "OLD audit-viewer: control: a checked chain" "OLD audit-viewer: control: a broken chain" \
                   "OLD receipt-panel: control: a server-verified receipt"; do
            printf '%s\n' "$out" | grep -qF "$ctl" && bad="$bad [negative control: the probe flags what the old code got right: $ctl]"
        done
        while IFS= read -r line; do
            bad="$bad [${line#NEW }]"
        done < <(printf '%s\n' "$out" | grep '^NEW ')
    fi
    if [ -z "$bad" ]; then _st="PASS"; else _why="${bad# }"; fi
}

# --- Control Plane leg (CPE24-L5) ----------------------------------------------
# P2.cp-verdict-honest-never-upgraded: the same property as the console-verdict
# case, proven on the Control Plane (packages/control-plane, `loki control serve`)
# that replaces the legacy dashboard. Route mapping:
#   legacy GET /api/proofs/<id> integrity_check.status  ->  CP GET /v1/runs/:source/:run
#                                                           and /v1/runs/:source:run
#                                                           effective_verdict (FC-08)
#   legacy GET /api/v2/audit/verify verified/status     ->  CP GET /v1/runs rows and the
#                                                           ?verdict= filter (a log that fails
#                                                           integrity reads TAMPERED; no seal
#                                                           reads UNVERIFIED)
# The CP never sees receipt.json, only the ingested event log, so a "tampered
# receipt" here is a log whose receipt.sealed / log.sealed lines were edited
# after sealing. FC-08 effectiveVerdict is the rule under test: plain VERIFIED
# only for an attested run whose seal a configured key checked.
# Runs are ingested over POST /v1/ingest into a real server booted with a
# run-owned HOME, a free port and LOKI_NO_BROWSER=1; only the recorded PID is
# stopped. Controls: an honest signed run reads VERIFIED (so the probe can see a
# pass), an honest FAILED run stays FAILED, a server with no key reads
# "(signature not checked)", and ?verdict=VERIFIED lists exactly the honest run.
cp_free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }
CP_PID=""
cp_stop() { # stops only the recorded PID, then waits for it
    [ -n "$CP_PID" ] || return 0
    kill "$CP_PID" 2>/dev/null || true
    local i=0
    while kill -0 "$CP_PID" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
    if kill -0 "$CP_PID" 2>/dev/null; then kill -9 "$CP_PID" 2>/dev/null || true; fi
    wait "$CP_PID" 2>/dev/null || true
    CP_PID=""
}
# cp_boot <dir> <port> [VAR=value...] ; sets CP_PID, returns 1 when /ready never answered
cp_boot() {
    local dir="$1" port="$2"; shift 2
    mkdir -p "$dir/home" "$dir/cwd"
    (cd "$dir/cwd" && exec env HOME="$dir/home" LOKI_NO_BROWSER=1 LOKI_CONTROL_AUTOINGEST=0 "$@" \
        bun "$REPO_ROOT/loki-ts/dist/loki.js" control serve --port "$port" > "$dir/serve.out" 2> "$dir/serve.err") &
    CP_PID=$!
    local i=0
    while [ "$i" -lt 150 ]; do
        curl -fsS "http://127.0.0.1:$port/ready" >/dev/null 2>&1 && return 0
        kill -0 "$CP_PID" 2>/dev/null || break
        sleep 0.2; i=$((i + 1))
    done
    return 1
}
cp_p2_script() {
    cat <<'EOF'
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
const [mode, base, pemPath] = process.argv.slice(2);
const SRC = "abcdef0123456789";
const seeded = (tag: string) => { const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), createHash("sha256").update(tag).digest()]), format: "der", type: "pkcs8" }); return { privateKey, publicKey: createPublicKey(privateKey) }; };
const trusted = seeded("cp-main"), attacker = seeded("cp-attacker");
const kidOf = (pub: any) => createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${pub.export({ format: "jwk" }).x}"}`).digest("base64url");
if (mode === "pem") { writeFileSync(pemPath!, trusted.publicKey.export({ type: "spki", format: "pem" })); process.exit(0); }
const ev = (run: string, seq: number, type: string, data: object, stage: string | null = null) => ({ v: 1, seq, ts: `2026-10-03T00:00:${String(seq).padStart(2, "0")}.000Z`, run, type, stage, data });
const lineOf = (e: any) => JSON.stringify({ v: e.v, seq: e.seq, ts: e.ts, run: e.run, type: e.type, stage: e.stage, data: e.data });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
// An honest signed run exactly as the engine writes it: run.started, receipt.sealed, run.completed, signed log.sealed.
function signed(run: string, verdict: string, key = trusted) {
  const kid = kidOf(key.publicKey);
  const start = ev(run, 0, "run.started", { task_source: "text" });
  const sealed = ev(run, 1, "receipt.sealed", { path: "/x/receipt.json", receipt_sha256: sha(run + verdict), signed: true, kid, verdict }, "seal");
  const done = ev(run, 2, "run.completed", { verdict, not_proven: [] });
  const logSha = sha([start, sealed, done].map(lineOf).join("\n") + "\n");
  const ls = ev(run, 3, "log.sealed", { kid, events_sha256: logSha, tampered: false, sig: sign(null, Buffer.from(`${logSha}:false`), key.privateKey).toString("base64url") });
  return [start, sealed, done, ls];
}
function unsigned(run: string, verdict: string, withReceipt = true) {
  const evs = [ev(run, 0, "run.started", { task_source: "text" })];
  if (withReceipt) evs.push(ev(run, evs.length, "receipt.sealed", { path: "/x/receipt.json", receipt_sha256: sha(run), signed: false, verdict }, "seal"));
  evs.push(ev(run, evs.length, "run.completed", { verdict, not_proven: [] }));
  return evs;
}
const runs: Record<string, any[]> = {};
runs["p2-honest"] = signed("p2-honest", "VERIFIED");
runs["p2-honest-failed"] = signed("p2-honest-failed", "FAILED");
runs["p2-unsigned"] = unsigned("p2-unsigned", "VERIFIED");
runs["p2-unsigned-lower"] = unsigned("p2-unsigned-lower", "verified");
runs["p2-unsigned-satisfied"] = unsigned("p2-unsigned-satisfied", "ALREADY_SATISFIED");
runs["p2-no-receipt"] = unsigned("p2-no-receipt", "VERIFIED", false);
{ // receipt.sealed edited after the log was sealed
  const e = signed("p2-edited-receipt", "VERIFIED");
  e[1] = { ...e[1], data: { ...e[1].data, receipt_sha256: sha("swapped") } };
  runs["p2-edited-receipt"] = e;
}
runs["p2-forged-key"] = signed("p2-forged-key", "VERIFIED", attacker); // sealed with a key nobody configured
{ // the supervisor saw events.jsonl modified
  const e = unsigned("p2-tamper-detected", "VERIFIED");
  e.splice(1, 0, ev("p2-tamper-detected", 1, "tamper.detected", {}));
  e.forEach((x, i) => { x.seq = i; x.ts = `2026-10-03T00:00:${String(i).padStart(2, "0")}.000Z`; });
  runs["p2-tamper-detected"] = e;
}
{ // a FAILED run with a VERIFIED verdict appended after the seal
  const e = signed("p2-appended", "FAILED");
  e.push(ev("p2-appended", 4, "run.completed", { verdict: "VERIFIED", not_proven: [] }));
  runs["p2-appended"] = e;
}
runs["p2-running"] = [ev("p2-running", 0, "run.started", { task_source: "text" })];

const bad: string[] = [];
const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, body: (await r.json()) as any }; };
for (const [name, evs] of Object.entries(runs)) {
  const r = await fetch(base + "/v1/ingest", { method: "POST", body: JSON.stringify({ source: SRC, run_id: name, events: evs }) });
  if (r.status !== 200) bad.push(`ingest ${name} -> HTTP ${r.status}`);
}
const eff: Record<string, string | null> = {};
for (const name of Object.keys(runs)) {
  const a = await get(`/v1/runs/${SRC}/${name}`), b = await get(`/v1/runs/${SRC}:${name}`);
  eff[name] = a.body?.effective_verdict ?? null;
  console.log(`RUN ${name} effective=${JSON.stringify(eff[name])} raw=${JSON.stringify(a.body?.verdict)} tampered=${a.body?.tampered} attested=${a.body?.attested} sig_checked=${a.body?.sig_checked}`);
  if (a.status !== 200 || b.status !== 200) bad.push(`${name}: detail routes answered ${a.status}/${b.status}`);
  else if (b.body.effective_verdict !== eff[name]) bad.push(`${name}: /v1/runs/:id says ${b.body.effective_verdict}, /v1/runs/:source/:run says ${eff[name]}`);
}
const list = (await get("/v1/runs?limit=200")).body;
const inList = (n: string) => list.runs?.find((x: any) => x.run_id === n)?.effective_verdict;
for (const name of Object.keys(runs)) if (inList(name) !== eff[name]) bad.push(`${name}: list row says ${JSON.stringify(inList(name))}, detail says ${JSON.stringify(eff[name])}`);
const filt = async (v: string) => ((await get(`/v1/runs?limit=200&verdict=${encodeURIComponent(v)}`)).body.runs ?? []).map((x: any) => x.run_id).sort();

if (mode === "keyed") {
  const want: Record<string, string | null> = {
    "p2-honest": "VERIFIED", // positive control: the probe can see a pass
    "p2-honest-failed": "FAILED", // never upgraded
    "p2-unsigned": "UNVERIFIED", "p2-unsigned-lower": "UNVERIFIED", "p2-unsigned-satisfied": "UNVERIFIED",
    "p2-no-receipt": "TAMPERED", "p2-edited-receipt": "TAMPERED", "p2-forged-key": "TAMPERED",
    "p2-tamper-detected": "TAMPERED", "p2-appended": "TAMPERED",
    "p2-running": null,
  };
  for (const [n, w] of Object.entries(want)) if (eff[n] !== w) bad.push(`${n}: effective_verdict ${JSON.stringify(eff[n])}, want ${JSON.stringify(w)}`);
  for (const [n, v] of Object.entries(eff)) if (n !== "p2-honest" && typeof v === "string" && /^(verified|already_satisfied)/i.test(v)) bad.push(`${n} shows ${v}, a success word without an attested, signature-checked seal`);
  const ver = await filt("VERIFIED"), tam = await filt("TAMPERED"), unv = await filt("UNVERIFIED");
  if (JSON.stringify(ver) !== JSON.stringify(["p2-honest"])) bad.push(`?verdict=VERIFIED lists ${JSON.stringify(ver)}, want only p2-honest`);
  const wantT = ["p2-appended", "p2-edited-receipt", "p2-forged-key", "p2-no-receipt", "p2-tamper-detected"];
  if (JSON.stringify(tam) !== JSON.stringify(wantT)) bad.push(`?verdict=TAMPERED lists ${JSON.stringify(tam)}, want ${JSON.stringify(wantT)}`);
  const wantU = ["p2-unsigned", "p2-unsigned-lower", "p2-unsigned-satisfied"];
  if (JSON.stringify(unv) !== JSON.stringify(wantU)) bad.push(`?verdict=UNVERIFIED lists ${JSON.stringify(unv)}, want ${JSON.stringify(wantU)}`);
  const miss = await get(`/v1/runs/${SRC}/no-such-run`);
  if (miss.status !== 404 || miss.body?.effective_verdict !== undefined) bad.push(`an unknown run answered HTTP ${miss.status} with a verdict`);
} else { // "nokey": no public key configured, so no signature can be checked
  if (eff["p2-honest"] === "VERIFIED") bad.push("no key configured: p2-honest reads plain VERIFIED, a signature nobody checked");
  if (eff["p2-honest"] !== "VERIFIED (signature not checked)") bad.push(`no key configured: p2-honest reads ${JSON.stringify(eff["p2-honest"])}, want "VERIFIED (signature not checked)"`);
  if (JSON.stringify(await filt("VERIFIED")) !== "[]") bad.push("no key configured: ?verdict=VERIFIED is not empty");
  for (const n of ["p2-unsigned", "p2-unsigned-lower", "p2-unsigned-satisfied"]) if (eff[n] !== "UNVERIFIED") bad.push(`no key configured: ${n} reads ${JSON.stringify(eff[n])}, want UNVERIFIED`);
  for (const n of ["p2-no-receipt", "p2-edited-receipt", "p2-tamper-detected", "p2-appended"]) if (eff[n] !== "TAMPERED") bad.push(`no key configured: ${n} reads ${JSON.stringify(eff[n])}, want TAMPERED`);
}
for (const b of bad) console.log("BAD " + b);
console.log("CHECKED " + mode);
process.exit(bad.length ? 1 : 0);
EOF
}
case_cp_verdict() {
    need bun curl python3 || return
    [ -f "$REPO_ROOT/loki-ts/dist/loki.js" ] || { _why="prerequisite missing: loki-ts/dist/loki.js (cd loki-ts && bun run build)"; return; }
    if [ ! -d "$REPO_ROOT/packages/control-plane/node_modules/hono" ] && [ ! -f "$REPO_ROOT/packages/control-plane/dist/server.js" ]; then
        _why="prerequisite missing: packages/control-plane node_modules (cd packages/control-plane && bun install --frozen-lockfile)"; return
    fi
    local d="$RUN/cp" bad="" mode port out rc line
    mkdir -p "$d"
    cp_p2_script > "$d/cp-p2.ts"
    bun "$d/cp-p2.ts" pem "" "$d/pub.pem" || { _why="could not write the test public key"; return; }
    for mode in keyed nokey; do
        port="$(cp_free_port)"
        if ! cp_boot "$d/$mode" "$port" "LOKI_CP_RECEIPT_PUBKEYS=$([ "$mode" = keyed ] && echo "$d/pub.pem")"; then
            bad="$bad [$mode: control plane did not become ready: $(tail -c 200 "$d/$mode/serve.err" | tr '\n' ' ')]"; cp_stop; continue
        fi
        rc=0
        out="$(bun "$d/cp-p2.ts" "$mode" "http://127.0.0.1:$port" "" 2> "$d/$mode.err")" || rc=$?
        printf '%s\n' "$out" | sed "s/^/  cp-verdict[$mode]: /" >&2
        cp_stop
        printf '%s\n' "$out" | grep -qx "CHECKED $mode" || bad="$bad [$mode: probe did not run (rc=$rc): $(tail -c 200 "$d/$mode.err" | tr '\n' ' ')]"
        while IFS= read -r line; do bad="$bad [$mode: ${line#BAD }]"; done < <(printf '%s\n' "$out" | grep '^BAD ')
        if [ "$rc" != 0 ] && [ -z "$bad" ]; then bad="$bad [$mode: probe exited $rc]"; fi
    done
    if [ -z "$bad" ]; then _st="PASS"; else _why="${bad# }"; fi
}

# --- run ----------------------------------------------------------------------
run_case P2.advisory-only-never-verified "advisory/model-only gate passes never yield a VERIFIED headline (generator + verifier)" case_advisory_only
run_case P2.unknown-gate-fails-closed "an unrecognized gate name or status cannot read green (generator + verifier)" case_unknown_gate
run_case P2.model-looks-good-cannot-pass "loki verify: a stub reviewer saying 'looks good' over red tests is not VERIFIED/0 (verify is bash-only: bin/loki execs autonomy/loki on both entry points)" case_model_looks_good
run_case P2.missing-pass-key-not-pass "evidence gate: test-results with no pass key is inconclusive, not affirmative" case_missing_pass_key
run_case P2.bun-inconclusive-not-pass "Bun test gate (runTestCoverage): pass:\"inconclusive\" and a missing pass key read as inconclusive, never an affirmative pass (passed && !inconclusive); pass:true does" case_bun_inconclusive
run_case P2.zero-test-never-affirmative "a zero-test run leaves no unit-tests.pass and no evidence-gate tests.pass:true (bash), and neither a stale test-results.json nor a zero-test npm test reads as passed (Bun); real passes do on both; a new session at iteration 0 drops the previous session's freshness marker, unit-tests.pass and test-results.json (both routes)" case_zero_test_never_affirmative
run_case P2.proof-verify-exit-contract "loki proof verify exits 0 clean, 1 tampered, 64 no id, 66 unknown id (both routes)" case_proof_verify_contract
run_case P2.proof-chain-exit-contract "loki proof chain exits 0/1/2/3/64/66, -h/--help is 64 not 0, and a hostile PYTHONPATH cannot shadow a stage (both entry points)" case_proof_chain_contract
run_case P2.verify-exit-contract "loki verify maps nothing-to-check to 3, could-not-check to 2, usage to 64 (bash-only command, both entry points)" case_verify_contract
run_case P2.fast-verify-inconclusive-not-zero "loki verify --fast with nothing scanned, a nonexistent root or an unknown flag does not exit 0 (bash-only command, both entry points)" case_fast_verify
run_case P2.council-inconclusive-cannot-exit-zero "inconclusive evidence plus a council vote alone cannot approve completion" case_council_inconclusive
run_case P2.council-readers-not-shadowed "a json.py/sitecustomize.py in the agent's repo (hostile PYTHONPATH) cannot turn failing test results green in the council's readers" case_council_readers_not_shadowed
run_case P2.council-readers-no-user-site-pth "a .pth planted in user site-packages cannot turn failing test results green in the council's test-result readers (heuristic, member, devil's advocate, convergence fast path) nor empty its queue counts (member pending/in-progress/blocked, devil's advocate failed)" case_council_readers_no_user_site_pth
run_case P2.checklist-verify-not-shadowed "a json.py/sitecustomize.py in the agent's repo (hostile PYTHONPATH) cannot turn failing PRD checklist checks green (checklist-verify.py, summary, council evidence, hard gate)" case_checklist_not_shadowed
run_case P2.exit-zero-with-failures-not-pass "a runner that exits 0 while its own summary reports failures (jest 'Tests: 1 failed') is recorded pass:false with no unit-tests.pass, and the council blocks it (bash); a recorded failed_count > 0 (or legacy failed > 0) with pass:true fails the council evidence gate and the Bun test gate alike, while 0, null and a missing count still pass on both" case_exit_zero_with_failures
run_case P2.console-verdict-needs-computed-result "a console verdict word needs a computed result: the receipt route carries the verifier's integrity_check (tampered, not_verified, verified on a real generator receipt), the audit verify route says nothing_checked for zero files, the audit viewer never reads VALID for nothing checked or TAMPERED for a failed request, and the receipt panel never affirms without a server-verified result; both client probes flag the verbatim pre-fix lines" case_console_verdict

run_case P2.cp-verdict-honest-never-upgraded "Control Plane (loki control serve): effective_verdict reads plain VERIFIED only for an attested, signature-checked seal; a tampered log (edited receipt.sealed, forged key, supervisor tamper flag, appended verdict, no receipt) reads TAMPERED, an unsigned run reads UNVERIFIED (also lowercase and ALREADY_SATISFIED), a FAILED run is never upgraded, no configured key reads signature-not-checked, and ?verdict=VERIFIED lists only the honest run" case_cp_verdict

printf 'moat-p2: finished in %ss\n' "$(( $(date +%s) - T_START ))" >&2
exit 0
